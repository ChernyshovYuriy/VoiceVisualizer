"""
analyzer.py
Background thread that consumes audio chunks and computes per-frame features.
Emits results via a caller-supplied callback (thread-safe via Qt signal bridge).
"""

from __future__ import annotations
import math
import queue
import threading
from dataclasses import dataclass

import numpy as np
import librosa

from core.buffer import RollingBuffer
from utils.note_utils import hz_to_note_name, hz_to_vocal_range, centroid_to_timbre

SR = 22_050
FRAME_LENGTH = 2048
HOP_LENGTH = 512
N_MELS = 64
FMIN = 80.0
FMAX = 4_000.0

# Build the mel filterbank once (shape: N_MELS × (FRAME_LENGTH//2 + 1))
_MEL_FB = librosa.filters.mel(sr=SR, n_fft=FRAME_LENGTH, n_mels=N_MELS, fmin=FMIN, fmax=FMAX)

# Hanning window for STFT
_WINDOW = np.hanning(FRAME_LENGTH).astype(np.float32)

# Frequency axis for centroid computation
_FREQS = np.linspace(0.0, SR / 2, FRAME_LENGTH // 2 + 1, dtype=np.float32)


@dataclass
class FrameInfo:
    pitch_hz: float
    note_name: str
    loudness_db: float
    centroid_hz: float
    timbre: str
    vocal_range: str
    peak_bin: int
    peak_value: float
    peaks: list[dict]
    onset: float
    energy: float
    pitch_confidence: float


class Analyzer:
    """
    Runs analysis in a daemon thread.
    Call push_chunk() from the audio callback; connect on_frame to a Qt signal.
    """

    def __init__(self, buffer: RollingBuffer, on_frame) -> None:
        self._buffer = buffer
        self._on_frame = on_frame          # callable(FrameInfo) – must be thread-safe
        self._queue: queue.Queue = queue.Queue(maxsize=80)
        self._ctx = np.zeros(FRAME_LENGTH, dtype=np.float32)  # rolling audio context
        self._prev_mel = np.zeros(N_MELS, dtype=np.float32)
        self._prev_pitch = float("nan")
        self._thread = threading.Thread(target=self._loop, daemon=True, name="analyzer")
        self._thread.start()

    def push_chunk(self, position: int, chunk: np.ndarray) -> None:
        """Called from the sounddevice audio callback. Must not block."""
        try:
            self._queue.put_nowait((position, chunk))
        except queue.Full:
            pass  # drop frame rather than stall the audio callback

    def _loop(self) -> None:
        while True:
            try:
                _pos, chunk = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            n = len(chunk)
            self._ctx = np.roll(self._ctx, -n)
            self._ctx[-n:] = chunk
            try:
                self._process(self._ctx.copy())
            except Exception:
                pass  # never crash the thread

    def _estimate_pitch_confidence(self, spectrum: np.ndarray, pitch: float) -> float:
        if not np.isfinite(pitch) or pitch <= 0.0:
            return 0.0
        idx = int(round(pitch / (SR / FRAME_LENGTH)))
        if idx <= 1 or idx >= len(spectrum):
            return 0.0
        lo = max(0, idx - 2)
        hi = min(len(spectrum), idx + 3)
        local = spectrum[lo:hi]
        signal = float(np.max(local))
        noise = float(np.mean(spectrum[max(0, idx - 12):min(len(spectrum), idx + 13)])) + 1e-6
        conf = (signal - noise) / (signal + noise)
        return float(np.clip((conf + 0.15) / 0.9, 0.0, 1.0))

    def _pick_peaks(self, mel_norm: np.ndarray) -> list[dict]:
        peaks: list[tuple[int, float]] = []
        for i in range(1, len(mel_norm) - 1):
            val = float(mel_norm[i])
            if val < 0.18:
                continue
            if val >= mel_norm[i - 1] and val >= mel_norm[i + 1]:
                peaks.append((i, val))
        if not peaks:
            idx = int(np.argmax(mel_norm))
            return [{"bin": idx, "value": float(mel_norm[idx])}]
        peaks.sort(key=lambda x: x[1], reverse=True)
        out: list[dict] = []
        used: list[int] = []
        for idx, val in peaks:
            if any(abs(idx - u) <= 2 for u in used):
                continue
            out.append({"bin": idx, "value": float(val)})
            used.append(idx)
            if len(out) >= 3:
                break
        return out

    def _process(self, frame: np.ndarray) -> None:
        spectrum = np.abs(np.fft.rfft(frame * _WINDOW, n=FRAME_LENGTH)).astype(np.float32)
        mel = (_MEL_FB @ spectrum).astype(np.float32)

        # ── Per-frame relative normalization ──────────────────
        # Normalize mel to spectral SHAPE (peak bin = 1.0) then
        # scale by loudness so quiet frames are dimmer.
        # This gives proper contrast between frequency bands
        # instead of saturating everything to ~1.0.
        mel_peak = float(np.max(mel))
        if mel_peak > 1e-6:
            mel_shape = (mel / mel_peak).astype(np.float32)
        else:
            mel_shape = np.zeros(N_MELS, dtype=np.float32)

        rms = float(np.sqrt(np.mean(frame ** 2)))
        loudness_db = 20.0 * math.log10(rms + 1e-10)

        # Map loudness to 0–1 scale: -55 dB → 0, -10 dB → 1
        loud_scale = float(np.clip((loudness_db + 55.0) / 45.0, 0.0, 1.0))
        mel_norm = (mel_shape * loud_scale).astype(np.float32)

        try:
            f0 = librosa.yin(
                frame,
                fmin=librosa.note_to_hz("C2"),
                fmax=librosa.note_to_hz("C7"),
                sr=SR,
                frame_length=FRAME_LENGTH,
            )
            pitch = float(f0[0]) if len(f0) > 0 else float("nan")
            if not (50.0 < pitch < 2_000.0):
                pitch = float("nan")
        except Exception:
            pitch = float("nan")

        pitch_conf = self._estimate_pitch_confidence(spectrum, pitch)
        if pitch_conf < 0.12:
            pitch = float("nan")

        rms = float(np.sqrt(np.mean(frame ** 2)))
        loudness_db = 20.0 * math.log10(rms + 1e-10)

        spec_sum = float(np.sum(spectrum))
        centroid_hz = float(np.dot(_FREQS, spectrum) / (spec_sum + 1e-10))

        onset = float(np.mean(np.maximum(mel_norm - self._prev_mel, 0.0)))
        onset = float(np.clip(onset * 3.5, 0.0, 1.0))

        energy = float(np.mean(mel_norm))
        peak_bin = int(np.argmax(mel_norm))
        peak_val = float(mel_norm[peak_bin])
        peaks = self._pick_peaks(mel_norm)

        self._buffer.push(mel_norm, pitch, loudness_db, centroid_hz)
        info = FrameInfo(
            pitch_hz=pitch,
            note_name=hz_to_note_name(pitch),
            loudness_db=loudness_db,
            centroid_hz=centroid_hz,
            timbre=centroid_to_timbre(centroid_hz),
            vocal_range=hz_to_vocal_range(pitch),
            peak_bin=peak_bin,
            peak_value=peak_val,
            peaks=peaks,
            onset=onset,
            energy=energy,
            pitch_confidence=pitch_conf,
        )
        self._prev_mel = mel_norm
        self._prev_pitch = pitch
        self._on_frame(info)
