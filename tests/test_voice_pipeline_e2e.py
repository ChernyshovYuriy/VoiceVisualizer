import json
import sys
import time
from pathlib import Path

import numpy as np
import pytest

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.analyzer import Analyzer, FrameInfo, FRAME_LENGTH, HOP_LENGTH, N_MELS, SR
from core.buffer import RollingBuffer
from core.live_state import LiveState

RNG = np.random.default_rng(12345)


def make_sine(freq_hz: float, duration_s: float = 0.25, amplitude: float = 0.5) -> np.ndarray:
    """Deterministic pure sine helper used to probe amplitude-dependent preprocessing."""
    t = np.arange(int(SR * duration_s), dtype=np.float32) / SR
    return (amplitude * np.sin(2 * np.pi * freq_hz * t)).astype(np.float32)


def make_vocal_like(
        f0: float = 220.0,
        duration_s: float = 0.35,
        amplitude: float = 0.35,
        n_harmonics: int = 6,
) -> np.ndarray:
    """Simple voiced harmonic stack with a gentle envelope for deterministic tests."""
    t = np.arange(int(SR * duration_s), dtype=np.float32) / SR
    env = np.hanning(len(t)).astype(np.float32)
    signal = np.zeros_like(t)
    for h in range(1, n_harmonics + 1):
        signal += (amplitude / h) * np.sin(2 * np.pi * f0 * h * t)
    return (signal * env).astype(np.float32)


def make_silence(duration_s: float = 0.25) -> np.ndarray:
    return np.zeros(int(SR * duration_s), dtype=np.float32)


def iter_chunks(signal: np.ndarray, hop: int = HOP_LENGTH):
    """Yield hop-sized chunks as the realtime callback would."""
    for start in range(0, len(signal), hop):
        chunk = signal[start:start + hop]
        if len(chunk):
            yield chunk


def iter_frames(signal: np.ndarray, frame_length: int = FRAME_LENGTH, hop: int = HOP_LENGTH):
    """Yield analysis frames, padding the tail so direct _process mirrors rolling-context behavior."""
    if len(signal) == 0:
        return
    for start in range(0, len(signal), hop):
        frame = signal[start:start + frame_length]
        if len(frame) < frame_length:
            padded = np.zeros(frame_length, dtype=np.float32)
            padded[: len(frame)] = frame.astype(np.float32, copy=False)
            frame = padded
        yield frame.astype(np.float32, copy=False)


def wait_for(predicate, timeout_s: float = 8.0, poll_s: float = 0.01) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(poll_s)
    return False


def assert_finite_array(values, *, name: str):
    arr = np.asarray(values, dtype=np.float64)
    assert np.isfinite(arr).all(), f"{name} must stay finite for WS JSON payloads"


class PipelineHarness:
    """Bridges Analyzer -> RollingBuffer -> LiveState using the repo's real callback shape."""

    def __init__(self):
        self.buffer = RollingBuffer()
        self.state = LiveState()
        self.frames: list[FrameInfo] = []

        def on_frame(info: FrameInfo) -> None:
            mel_latest = self.buffer.snapshot()[0][-1]
            self.state.update_from_frame(info, mel_latest)
            self.frames.append(info)

        self.analyzer = Analyzer(self.buffer, on_frame)

    def process_frames_direct(self, signal: np.ndarray, *, as_int16: bool = False) -> None:
        """Deterministic path through Analyzer._process for most assertions."""
        for frame in iter_frames(signal):
            payload = frame
            if as_int16:
                payload = np.clip(frame, -1.0, 1.0)
                payload = (payload * 32767.0).astype(np.int16)
            self.analyzer._process(payload)

    def push_signal_threaded(self, signal: np.ndarray, *, as_int16: bool = False) -> None:
        for pos, chunk in enumerate(iter_chunks(signal)):
            payload = chunk
            if as_int16:
                payload = np.clip(chunk, -1.0, 1.0)
                payload = (payload * 32767.0).astype(np.int16)
            self.analyzer.push_chunk(pos, payload)

    def wait_for_frames(self, minimum: int = 1, timeout_s: float = 8.0) -> None:
        assert wait_for(lambda: len(self.frames) >= minimum, timeout_s=timeout_s), (
            f"Timed out waiting for {minimum} analyzed frames; got {len(self.frames)}"
        )

    def snapshot(self) -> dict:
        snap = self.state.snapshot()
        # This mirrors the WS layer contract: state.snapshot() must be JSON serializable.
        json.dumps(snap)
        return snap


def assert_payload_contract(payload: dict) -> None:
    required_keys = {
        "mel", "pitch", "loudness", "note", "timbre", "range", "centroid",
        "onset", "energy", "pitchConf", "peaks",
        "melHist", "pitchHist", "loudHist", "centroidHist", "onsetHist",
    }
    assert required_keys <= set(payload.keys())

    # Fixed-size mel vector is a rendering invariant for the visualizer.
    assert len(payload["mel"]) == N_MELS
    assert_finite_array(payload["mel"], name="mel")
    assert_finite_array(payload["pitchHist"], name="pitchHist")
    assert_finite_array(payload["loudHist"], name="loudHist")
    assert_finite_array(payload["centroidHist"], name="centroidHist")
    assert_finite_array(payload["onsetHist"], name="onsetHist")

    # These bounds protect shader/UI code that assumes normalized real-time controls.
    assert 0.0 <= float(payload["onset"]) <= 1.0
    assert float(payload["energy"]) >= 0.0
    assert 0.0 <= float(payload["pitchConf"]) <= 1.0

    assert isinstance(payload["peaks"], list)
    for peak in payload["peaks"]:
        assert isinstance(peak, dict)
        assert {"bin", "value"} <= set(peak)
        assert 0 <= int(peak["bin"]) < N_MELS
        assert float(peak["value"]) >= 0.0
        assert np.isfinite(float(peak["value"]))

    for hist_name in ("melHist", "pitchHist", "loudHist", "centroidHist", "onsetHist"):
        assert isinstance(payload[hist_name], list)

    for mel_frame in payload["melHist"]:
        assert len(mel_frame) == N_MELS
        assert_finite_array(mel_frame, name="melHist frame")

    payload_bytes = len(json.dumps(payload).encode("utf-8"))
    assert payload_bytes < 50 * 1024, f"Payload grew to {payload_bytes} bytes"


@pytest.fixture(scope="module", autouse=True)
def warm_analyzer_path():
    """Pay librosa/FFT warmup cost once so the threaded smoke test has stable timing."""
    harness = PipelineHarness()
    harness.process_frames_direct(make_sine(220.0, duration_s=0.12, amplitude=0.2))
    assert harness.frames, "Warmup should produce at least one frame"


class TestVoicePipelineE2E:
    def test_happy_path_e2e_payload_is_json_ready(self):
        harness = PipelineHarness()
        harness.process_frames_direct(make_vocal_like(f0=220.0, amplitude=0.35, duration_s=0.45))

        payload = harness.snapshot()
        assert_payload_contract(payload)

        # The visualizer depends on these histories to animate over time.
        assert len(payload["melHist"]) >= 1
        assert len(payload["pitchHist"]) >= 1
        assert payload["note"]
        assert payload["timbre"]

    def test_threaded_chunk_stream_reaches_live_state(self):
        harness = PipelineHarness()
        signal = make_vocal_like(f0=260.0, amplitude=0.30, duration_s=0.40)
        expected_min_frames = max(1, len(list(iter_chunks(signal))) - 1)
        harness.push_signal_threaded(signal)
        harness.wait_for_frames(minimum=expected_min_frames)

        payload = harness.snapshot()
        assert_payload_contract(payload)
        assert len(payload["melHist"]) >= 1

    def test_quiet_vs_loud_changes_energy_without_breaking_mel_shape(self):
        quiet = PipelineHarness()
        quiet.process_frames_direct(make_sine(220.0, amplitude=0.03, duration_s=0.30))
        quiet_payload = quiet.snapshot()

        loud = PipelineHarness()
        loud.process_frames_direct(make_sine(220.0, amplitude=0.60, duration_s=0.30))
        loud_payload = loud.snapshot()

        quiet_mel = np.asarray(quiet_payload["mel"], dtype=np.float32)
        loud_mel = np.asarray(loud_payload["mel"], dtype=np.float32)

        # Mel magnitudes should rise with amplitude because analyzer scales spectral shape by loudness.
        assert float(np.mean(loud_mel)) > float(np.mean(quiet_mel))
        assert float(loud_payload["energy"]) > float(quiet_payload["energy"])

        # Per-frame normalization should keep the dominant bin at or below 1 after loudness scaling.
        assert 0.0 <= float(np.max(quiet_mel)) <= 1.0
        assert 0.0 <= float(np.max(loud_mel)) <= 1.0

    def test_nan_inf_inputs_are_sanitized_and_payload_stays_finite(self):
        harness = PipelineHarness()
        bad = make_sine(330.0, amplitude=0.25, duration_s=0.30)
        bad[:8] = np.array([np.nan, np.inf, -np.inf, np.nan, np.inf, 0.0, -np.inf, np.nan], dtype=np.float32)
        harness.process_frames_direct(bad)

        payload = harness.snapshot()
        assert_payload_contract(payload)
        assert_finite_array(payload["mel"], name="mel after nan/inf sanitization")

    def test_silence_produces_near_zero_energy_and_sane_onset(self):
        harness = PipelineHarness()
        harness.process_frames_direct(make_silence(duration_s=0.35))

        payload = harness.snapshot()
        mel = np.asarray(payload["mel"], dtype=np.float32)

        # Silence should not light up the renderer or fake transient activity.
        assert float(np.max(mel)) < 1e-6
        assert float(payload["energy"]) < 1e-6
        assert 0.0 <= float(payload["onset"]) <= 1e-6
        assert payload["pitch"] == 0.0

    def test_int16_chunks_still_produce_finite_outputs(self):
        harness = PipelineHarness()
        harness.process_frames_direct(make_vocal_like(f0=260.0, amplitude=0.4, duration_s=0.35), as_int16=True)

        payload = harness.snapshot()
        assert_payload_contract(payload)

    def test_histories_grow_and_cap_at_configured_limits(self):
        harness = PipelineHarness()
        long_signal = np.concatenate(
            [
                make_vocal_like(f0=220.0, amplitude=0.25, duration_s=0.45),
                make_vocal_like(f0=330.0, amplitude=0.28, duration_s=0.45),
                make_vocal_like(f0=440.0, amplitude=0.30, duration_s=0.45),
            ]
        ).astype(np.float32)
        harness.process_frames_direct(long_signal)

        payload = harness.snapshot()

        # These max lengths are part of the WS payload budget and visual smoothing behavior.
        assert 1 <= len(payload["melHist"]) <= 10
        assert 1 <= len(payload["pitchHist"]) <= 30
        assert 1 <= len(payload["loudHist"]) <= 30
        assert 1 <= len(payload["centroidHist"]) <= 30
        assert 1 <= len(payload["onsetHist"]) <= 30

    def test_stress_burst_keeps_invariants_and_peak_bins_valid(self):
        harness = PipelineHarness()

        segments = []
        for i in range(40):
            freq = 180.0 + (i % 6) * 45.0
            amp = 0.10 + (i % 5) * 0.06
            segment = make_vocal_like(f0=freq, amplitude=amp, duration_s=0.05)
            noise = RNG.normal(0.0, 0.002, size=len(segment)).astype(np.float32)
            segments.append(segment + noise)
        stress_signal = np.concatenate(segments).astype(np.float32)

        harness.process_frames_direct(stress_signal)

        payload = harness.snapshot()
        assert_payload_contract(payload)

        # Peak bins drive visual accents, so bins must stay in-range even under rapid updates.
        for peak in payload["peaks"]:
            assert 0 <= peak["bin"] < N_MELS

        # RollingBuffer should remain finite under bursty traffic.
        mel_buf, pitch_buf, loud_buf, centroid_buf = harness.buffer.snapshot()
        assert np.isfinite(mel_buf).all()
        assert np.isfinite(loud_buf).all()
        assert np.isfinite(centroid_buf).all()
        assert np.isfinite(np.nan_to_num(pitch_buf, nan=0.0)).all()
