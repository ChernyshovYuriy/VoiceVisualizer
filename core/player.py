"""
player.py
Loads an audio/video file and streams it through sounddevice.
Tracks playback position and forwards every block to the analyzer.

Heavy media preparation can be done off the UI thread with
Player.prepare_source(), then applied on the main thread with
Player.load_prepared().
"""

from __future__ import annotations
import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import librosa
import sounddevice as sd

SR = 22_050
HOP = 512

AUDIO_EXT = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".avi", ".webm"}


@dataclass(slots=True)
class PreparedSource:
    y: np.ndarray
    duration: float
    cleanup_path: Optional[Path] = None


class Player:
    def __init__(self, on_chunk: Callable[[int, np.ndarray], None]) -> None:
        self._on_chunk = on_chunk
        self._y: Optional[np.ndarray] = None
        self._pos = 0
        self._duration = 0.0
        self._lock = threading.Lock()
        self._stream: Optional[sd.OutputStream] = None
        self._playing = False
        self._on_end: Optional[Callable] = None
        self._tmp_wav: Optional[Path] = None  # temp file from video extraction

    # ── public ────────────────────────────────────────────────────────────────

    def load(self, path: Path) -> float:
        """
        Synchronous helper kept for backward compatibility.
        Prefer prepare_source() in a worker thread plus load_prepared() on the UI thread.
        """
        prepared = self.prepare_source(path)
        return self.load_prepared(prepared)

    def load_prepared(self, prepared: PreparedSource) -> float:
        """Apply already prepared media data to the player."""
        self.stop()
        self._cleanup_tmp()
        with self._lock:
            self._y = prepared.y
            self._pos = 0
            self._duration = prepared.duration
        self._tmp_wav = prepared.cleanup_path
        return prepared.duration

    @classmethod
    def prepare_source(cls, path: Path) -> PreparedSource:
        """
        Heavy media preparation path intended to be called from a worker thread.
        For video files, extracts audio via ffmpeg first.
        Returns decoded mono audio in memory.
        """
        suffix = path.suffix.lower()
        cleanup_path: Optional[Path] = None
        if suffix in VIDEO_EXT:
            audio_path = cls._extract_audio(path)
            cleanup_path = audio_path
        elif suffix in AUDIO_EXT:
            audio_path = path
        else:
            raise ValueError(
                f"Unsupported format '{suffix}'. "
                f"Audio: {sorted(AUDIO_EXT)}  Video: {sorted(VIDEO_EXT)}"
            )

        y, _ = librosa.load(str(audio_path), sr=SR, mono=True)
        return PreparedSource(
            y=np.asarray(y, dtype=np.float32),
            duration=len(y) / SR,
            cleanup_path=cleanup_path,
        )

    def play(self, on_end: Optional[Callable] = None) -> None:
        if self._y is None:
            return
        self._on_end = on_end
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
        self._playing = True
        self._stream = sd.OutputStream(
            samplerate=SR,
            channels=1,
            dtype="float32",
            blocksize=HOP,
            callback=self._callback,
            finished_callback=self._finished,
        )
        self._stream.start()

    def pause(self) -> None:
        self._playing = False
        if self._stream:
            self._stream.stop()

    def resume(self) -> None:
        if self._y is not None and not self._playing:
            self.play(self._on_end)

    def stop(self) -> None:
        self._playing = False
        if self._stream:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None
        with self._lock:
            self._pos = 0

    def seek(self, seconds: float) -> None:
        with self._lock:
            if self._y is not None:
                self._pos = int(np.clip(seconds * SR, 0, len(self._y) - 1))

    @property
    def current_time(self) -> float:
        with self._lock:
            return self._pos / SR

    @property
    def duration(self) -> float:
        return self._duration

    @property
    def is_playing(self) -> bool:
        return self._playing

    # ── internals ─────────────────────────────────────────────────────────────

    def _callback(
        self,
        outdata: np.ndarray,
        frames: int,
        time,
        status,
    ) -> None:
        with self._lock:
            if self._y is None:
                outdata[:] = 0
                return
            end = min(self._pos + frames, len(self._y))
            chunk = self._y[self._pos:end]
            n = len(chunk)
            outdata[:n, 0] = chunk
            if n < frames:
                outdata[n:, 0] = 0
            pos_snap = self._pos
            self._pos = end

        self._on_chunk(pos_snap, chunk)

        if end >= len(self._y):
            raise sd.CallbackStop()

    def _finished(self) -> None:
        self._playing = False
        if self._on_end:
            self._on_end()

    @staticmethod
    def _extract_audio(video_path: Path) -> Path:
        if not shutil.which("ffmpeg"):
            raise RuntimeError(
                "ffmpeg is not installed or not on PATH. "
                "Install ffmpeg to open video files."
            )
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.close()
        out = Path(tmp.name)
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", str(video_path),
                "-vn",
                "-acodec", "pcm_s16le",
                "-ar", str(SR),
                "-ac", "1",
                str(out),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
        )
        if result.returncode != 0:
            raise RuntimeError(
                "ffmpeg audio extraction failed.\n"
                + result.stderr.decode(errors="replace")[-1000:]
            )
        return out

    def _cleanup_tmp(self) -> None:
        if self._tmp_wav and self._tmp_wav.exists():
            try:
                self._tmp_wav.unlink()
            except OSError:
                pass
        self._tmp_wav = None

    def __del__(self) -> None:
        self.stop()
        self._cleanup_tmp()
