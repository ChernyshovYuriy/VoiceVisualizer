import json
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.analyzer import Analyzer, FrameInfo, FRAME_LENGTH, HOP_LENGTH, N_MELS, SR, FMIN, FMAX
from core.buffer import RollingBuffer
from core.live_state import LiveState

RNG = np.random.default_rng(20260410)


def make_sine(freq_hz: float, duration_s: float = 0.35, amplitude: float = 0.4) -> np.ndarray:
    t = np.arange(int(SR * duration_s), dtype=np.float32) / SR
    return (amplitude * np.sin(2 * np.pi * freq_hz * t)).astype(np.float32)


def make_dual_tone(freq_a: float, freq_b: float, duration_s: float = 0.35, amplitude: float = 0.35) -> np.ndarray:
    t = np.arange(int(SR * duration_s), dtype=np.float32) / SR
    sig = amplitude * np.sin(2 * np.pi * freq_a * t)
    sig += amplitude * np.sin(2 * np.pi * freq_b * t)
    sig *= 0.5
    return sig.astype(np.float32)


def make_silence(duration_s: float = 0.25) -> np.ndarray:
    return np.zeros(int(SR * duration_s), dtype=np.float32)


def make_step_attack(duration_s: float = 0.45, attack_at_s: float = 0.15, freq_hz: float = 220.0,
                     amplitude: float = 0.35) -> np.ndarray:
    n = int(SR * duration_s)
    attack_at = int(SR * attack_at_s)
    out = np.zeros(n, dtype=np.float32)
    tail_t = np.arange(n - attack_at, dtype=np.float32) / SR
    out[attack_at:] = amplitude * np.sin(2 * np.pi * freq_hz * tail_t)
    return out.astype(np.float32)


def mel_bin_center_hz(bin_index: int) -> float:
    frac = float(bin_index) / max(1, (N_MELS - 1))
    return FMIN + frac * (FMAX - FMIN)


def iter_frames(signal: np.ndarray, frame_length: int = FRAME_LENGTH, hop: int = HOP_LENGTH):
    if len(signal) == 0:
        return
    for start in range(0, len(signal), hop):
        frame = signal[start:start + frame_length]
        if len(frame) < frame_length:
            padded = np.zeros(frame_length, dtype=np.float32)
            padded[: len(frame)] = frame.astype(np.float32, copy=False)
            frame = padded
        yield frame.astype(np.float32, copy=False)


def iter_chunks(signal: np.ndarray, hop: int = HOP_LENGTH):
    for start in range(0, len(signal), hop):
        chunk = signal[start:start + hop]
        if len(chunk):
            yield start, chunk


def wait_for(predicate, timeout_s: float = 8.0, poll_s: float = 0.01) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(poll_s)
    return False


def assert_finite_array(values, *, name: str):
    arr = np.asarray(values, dtype=np.float64)
    assert np.isfinite(arr).all(), f"{name} must remain finite"


class PipelineHarness:
    def __init__(self):
        self.buffer = RollingBuffer()
        self.state = LiveState()
        self.frames: list[FrameInfo] = []

        def on_frame(info: FrameInfo) -> None:
            mel_latest = self.buffer.snapshot()[0][-1]
            self.state.update_from_frame(info, mel_latest)
            self.frames.append(info)

        self.analyzer = Analyzer(self.buffer, on_frame)

    def process_frames_direct(self, signal: np.ndarray) -> None:
        for frame in iter_frames(signal):
            self.analyzer._process(frame)

    def push_signal_threaded(self, signal: np.ndarray) -> None:
        for pos, chunk in iter_chunks(signal):
            self.analyzer.push_chunk(pos, chunk)

    def wait_for_frames(self, minimum: int = 1, timeout_s: float = 8.0) -> None:
        assert wait_for(lambda: len(self.frames) >= minimum, timeout_s=timeout_s), (
            f"Timed out waiting for {minimum} analyzed frames; got {len(self.frames)}"
        )

    def snapshot(self) -> dict:
        snap = self.state.snapshot()
        json.dumps(snap)
        return snap


@pytest.fixture(scope="module", autouse=True)
def warmup_once():
    harness = PipelineHarness()
    harness.process_frames_direct(make_sine(220.0, duration_s=0.12, amplitude=0.2))
    assert harness.frames


class TestVoicePipelineAdversarial:
    def test_frequency_localization_moves_peak_bin_up_with_frequency(self):
        low = PipelineHarness()
        low.process_frames_direct(make_sine(140.0, amplitude=0.45, duration_s=0.30))
        low_peak = int(np.argmax(np.asarray(low.snapshot()["mel"], dtype=np.float32)))

        mid = PipelineHarness()
        mid.process_frames_direct(make_sine(600.0, amplitude=0.45, duration_s=0.30))
        mid_peak = int(np.argmax(np.asarray(mid.snapshot()["mel"], dtype=np.float32)))

        high = PipelineHarness()
        high.process_frames_direct(make_sine(1800.0, amplitude=0.45, duration_s=0.30))
        high_peak = int(np.argmax(np.asarray(high.snapshot()["mel"], dtype=np.float32)))

        # This proves the FFT->mel path is not reversed or grossly misindexed.
        assert low_peak < mid_peak < high_peak

        for expected_hz, peak_bin in ((140.0, low_peak), (600.0, mid_peak), (1800.0, high_peak)):
            approx_hz = mel_bin_center_hz(peak_bin)
            assert abs(approx_hz - expected_hz) < 900.0

    def test_dual_tone_produces_multiple_meaningful_peaks(self):
        harness = PipelineHarness()
        harness.process_frames_direct(make_dual_tone(220.0, 880.0, amplitude=0.45, duration_s=0.35))
        payload = harness.snapshot()

        peaks = payload["peaks"]
        # The visualizer should be able to accent more than one spectral region for compound tones.
        assert len(peaks) >= 2
        bins = sorted(int(p["bin"]) for p in peaks)
        assert bins[-1] - bins[0] >= 4

    def test_onset_spikes_on_attack_then_settles_in_sustain(self):
        harness = PipelineHarness()
        signal = np.concatenate([
            make_silence(0.10),
            make_sine(220.0, duration_s=0.20, amplitude=0.40),
            make_silence(0.10),
        ]).astype(np.float32)
        harness.process_frames_direct(signal)
        payload = harness.snapshot()
        onset_hist = np.asarray(payload["onsetHist"], dtype=np.float32)

        assert len(onset_hist) >= 4
        # The silence->tone edge should create a visible transient, and at least one sustain frame
        # should be quieter than that edge so the visualizer does not stay permanently in "attack" mode.
        assert float(np.max(onset_hist)) > 0.05
        positive = onset_hist[onset_hist > 1e-4]
        assert len(positive) >= 2
        assert float(np.min(positive)) < float(np.max(positive)) * 0.5
        assert 0.0 <= float(payload["onset"]) <= 1.0

    def test_loudness_is_monotonic_and_bounded_after_mapping(self):
        amplitudes = [0.02, 0.05, 0.12, 0.30]
        loudness = []
        energies = []
        max_mels = []

        for amp in amplitudes:
            harness = PipelineHarness()
            harness.process_frames_direct(make_sine(260.0, amplitude=amp, duration_s=0.30))
            payload = harness.snapshot()
            loudness.append(float(payload["loudness"]))
            energies.append(float(payload["energy"]))
            max_mels.append(float(np.max(np.asarray(payload["mel"], dtype=np.float32))))

        assert all(a < b for a, b in zip(loudness, loudness[1:]))
        assert all(a < b for a, b in zip(energies, energies[1:]))
        assert all(0.0 <= x <= 1.0 for x in max_mels)

    def test_pathological_numeric_inputs_stay_finite(self):
        harness = PipelineHarness()
        pathological = np.empty(FRAME_LENGTH * 2, dtype=np.float32)
        pathological[0::4] = np.nan
        pathological[1::4] = np.inf
        pathological[2::4] = -np.inf
        pathological[3::4] = 1e20

        harness.process_frames_direct(pathological)
        payload = harness.snapshot()

        assert_finite_array(payload["mel"], name="mel")
        assert_finite_array(payload["melHist"], name="melHist")
        assert np.isfinite(float(payload["energy"]))
        assert np.isfinite(float(payload["centroid"]))
        assert 0.0 <= float(payload["onset"]) <= 1.0

    def test_dc_offset_does_not_fake_pitch_or_break_payload(self):
        harness = PipelineHarness()
        dc = np.full(FRAME_LENGTH * 2, 0.25, dtype=np.float32)
        harness.process_frames_direct(dc)
        payload = harness.snapshot()

        assert_finite_array(payload["mel"], name="mel")
        # Constant offset should not look like a reliable pitched tone.
        assert float(payload["pitchConf"]) <= 0.20
        assert payload["pitch"] == 0.0

    def test_clipped_signal_does_not_break_peak_contract(self):
        harness = PipelineHarness()
        clipped = np.sign(make_sine(330.0, amplitude=1.0, duration_s=0.35)).astype(np.float32)
        harness.process_frames_direct(clipped)
        payload = harness.snapshot()

        assert 1 <= len(payload["peaks"]) <= 3
        for peak in payload["peaks"]:
            assert 0 <= int(peak["bin"]) < N_MELS
            assert float(peak["value"]) >= 0.0

    def test_noise_stream_keeps_histories_bounded_and_payload_small(self):
        harness = PipelineHarness()
        noise = RNG.normal(0.0, 0.08, size=FRAME_LENGTH * 24).astype(np.float32)
        harness.process_frames_direct(noise)
        payload = harness.snapshot()

        assert 1 <= len(payload["melHist"]) <= 10
        assert 1 <= len(payload["pitchHist"]) <= 30
        assert 1 <= len(payload["loudHist"]) <= 30
        assert len(json.dumps(payload).encode("utf-8")) < 50 * 1024
        assert_finite_array(payload["centroidHist"], name="centroidHist")
        assert_finite_array(payload["onsetHist"], name="onsetHist")

    def test_concurrent_snapshots_remain_json_serializable_during_updates(self):
        harness = PipelineHarness()
        signal = np.concatenate([
            make_step_attack(duration_s=0.25, attack_at_s=0.05, amplitude=0.30),
            make_dual_tone(220.0, 660.0, duration_s=0.25, amplitude=0.28),
            RNG.normal(0.0, 0.01, size=int(SR * 0.20)).astype(np.float32),
        ]).astype(np.float32)

        errors: list[str] = []
        stop = threading.Event()

        def reader() -> None:
            while not stop.is_set():
                try:
                    snap = harness.snapshot()
                    assert len(snap["mel"]) == N_MELS
                    for frame in snap["melHist"]:
                        assert len(frame) == N_MELS
                except Exception as exc:  # pragma: no cover - only used on failure
                    errors.append(repr(exc))
                    stop.set()
                    return

        reader_thread = threading.Thread(target=reader, daemon=True)
        reader_thread.start()
        harness.push_signal_threaded(signal)
        expected_min_frames = max(2, len(list(iter_chunks(signal))) // 2)
        harness.wait_for_frames(minimum=expected_min_frames, timeout_s=8.0)
        stop.set()
        reader_thread.join(timeout=2.0)

        assert not errors, f"Concurrent snapshot/read failed: {errors}"
        payload = harness.snapshot()
        assert len(payload["mel"]) == N_MELS
        assert_finite_array(payload["mel"], name="mel")
