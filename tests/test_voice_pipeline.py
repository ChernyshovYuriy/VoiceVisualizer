"""
test_voice_pipeline.py
Verify the full voice processing pipeline produces correct values for visualization.

Tests:
  1. Mel spectrum normalization and dynamic range
  2. Pitch detection accuracy for known vocal frequencies
  3. Loudness / RMS calculation
  4. Spectral centroid correctness
  5. Onset detection
  6. Peak picking
  7. Buffer accumulation
  8. LiveState snapshot completeness
  9. End-to-end: synthetic voice → FrameInfo → LiveState → WS payload
  10. Quiet vs loud signals produce proportional mel values
"""

import math
import json
import sys
import time
from pathlib import Path

import numpy as np
import pytest

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.analyzer import Analyzer, FrameInfo, SR, FRAME_LENGTH, HOP_LENGTH, N_MELS, _MEL_FB, _WINDOW, _FREQS
from core.buffer import RollingBuffer
from core.live_state import LiveState
from utils.note_utils import hz_to_note_name, hz_to_vocal_range, centroid_to_timbre

import librosa


# ── Helpers ──────────────────────────────────────────────────

def make_sine(freq_hz: float, duration_s: float = 0.2, amplitude: float = 0.5) -> np.ndarray:
    """Generate a pure sine tone at given frequency."""
    t = np.arange(int(SR * duration_s), dtype=np.float32) / SR
    return (amplitude * np.sin(2 * np.pi * freq_hz * t)).astype(np.float32)


def make_vocal_like(f0: float = 300, n_harmonics: int = 8, duration_s: float = 0.2, amplitude: float = 0.3) -> np.ndarray:
    """Generate a signal with harmonics resembling a human voice."""
    t = np.arange(int(SR * duration_s), dtype=np.float32) / SR
    signal = np.zeros_like(t)
    for h in range(1, n_harmonics + 1):
        # Harmonics decay roughly as 1/h for voice
        harmonic_amp = amplitude / h
        signal += harmonic_amp * np.sin(2 * np.pi * f0 * h * t)
    return signal.astype(np.float32)


def make_silence(duration_s: float = 0.2) -> np.ndarray:
    return np.zeros(int(SR * duration_s), dtype=np.float32)


def process_frame_directly(frame: np.ndarray) -> dict:
    """Run the analyzer's _process logic on a single frame without threading."""
    spectrum = np.abs(np.fft.rfft(frame * _WINDOW, n=FRAME_LENGTH)).astype(np.float32)
    mel = (_MEL_FB @ spectrum).astype(np.float32)

    # Per-frame relative normalization (matches analyzer.py)
    mel_peak = float(np.max(mel))
    if mel_peak > 1e-6:
        mel_shape = (mel / mel_peak).astype(np.float32)
    else:
        mel_shape = np.zeros(N_MELS, dtype=np.float32)

    rms = float(np.sqrt(np.mean(frame ** 2)))
    loudness_db = 20.0 * math.log10(rms + 1e-10)
    loud_scale = float(np.clip((loudness_db + 55.0) / 45.0, 0.0, 1.0))
    mel_norm = (mel_shape * loud_scale).astype(np.float32)

    mel_db = librosa.amplitude_to_db(mel, ref=1.0)  # kept for diagnostics

    try:
        f0 = librosa.yin(frame, fmin=librosa.note_to_hz("C2"),
                         fmax=librosa.note_to_hz("C7"), sr=SR, frame_length=FRAME_LENGTH)
        pitch = float(f0[0]) if len(f0) > 0 else float("nan")
        if not (50.0 < pitch < 2_000.0):
            pitch = float("nan")
    except Exception:
        pitch = float("nan")

    rms = float(np.sqrt(np.mean(frame ** 2)))
    loudness_db = 20.0 * math.log10(rms + 1e-10)

    spec_sum = float(np.sum(spectrum))
    centroid_hz = float(np.dot(_FREQS, spectrum) / (spec_sum + 1e-10))

    energy = float(np.mean(mel_norm))
    peak_bin = int(np.argmax(mel_norm))
    peak_val = float(mel_norm[peak_bin])

    return {
        "spectrum": spectrum,
        "mel": mel,
        "mel_db": mel_db,
        "mel_norm": mel_norm,
        "pitch": pitch,
        "loudness_db": loudness_db,
        "centroid_hz": centroid_hz,
        "energy": energy,
        "peak_bin": peak_bin,
        "peak_val": peak_val,
        "rms": rms,
    }


# ═══════════════════════════════════════════════════════════
# TEST 1: Mel normalization dynamic range
# ═══════════════════════════════════════════════════════════

class TestMelNormalization:
    """Verify mel_norm values are in usable range for visualization."""

    def test_loud_voice_mel_norm_has_high_values(self):
        """A loud vocal signal should produce mel_norm peaks well above 0.5."""
        signal = make_vocal_like(f0=300, amplitude=0.5)
        frame = signal[:FRAME_LENGTH]
        result = process_frame_directly(frame)

        peak = float(np.max(result["mel_norm"]))
        mean = float(np.mean(result["mel_norm"]))
        print(f"\n  Loud voice (amp=0.5): mel_norm peak={peak:.3f}, mean={mean:.3f}")
        print(f"  mel_norm distribution: min={np.min(result['mel_norm']):.3f}, "
              f"p25={np.percentile(result['mel_norm'], 25):.3f}, "
              f"p50={np.percentile(result['mel_norm'], 50):.3f}, "
              f"p75={np.percentile(result['mel_norm'], 75):.3f}, "
              f"max={peak:.3f}")
        assert peak > 0.5, f"Peak mel_norm too low for loud voice: {peak}"

    def test_medium_voice_mel_norm_has_visible_values(self):
        """A medium-volume voice should still produce visible mel_norm values."""
        signal = make_vocal_like(f0=300, amplitude=0.1)
        frame = signal[:FRAME_LENGTH]
        result = process_frame_directly(frame)

        peak = float(np.max(result["mel_norm"]))
        mean = float(np.mean(result["mel_norm"]))
        print(f"\n  Medium voice (amp=0.1): mel_norm peak={peak:.3f}, mean={mean:.3f}")
        print(f"  mel_db range: [{np.min(result['mel_db']):.1f}, {np.max(result['mel_db']):.1f}]")
        assert peak > 0.3, f"Peak mel_norm too low for medium voice: {peak}"

    def test_quiet_voice_mel_norm_still_nonzero(self):
        """A quiet voice should produce non-trivial mel_norm."""
        signal = make_vocal_like(f0=300, amplitude=0.02)
        frame = signal[:FRAME_LENGTH]
        result = process_frame_directly(frame)

        peak = float(np.max(result["mel_norm"]))
        print(f"\n  Quiet voice (amp=0.02): mel_norm peak={peak:.3f}, mean={np.mean(result['mel_norm']):.3f}")
        print(f"  mel_db range: [{np.min(result['mel_db']):.1f}, {np.max(result['mel_db']):.1f}]")
        assert peak > 0.1, f"Peak mel_norm too low for quiet voice: {peak}"

    def test_silence_mel_norm_near_zero(self):
        """Silence should produce mel_norm near zero."""
        frame = make_silence()[:FRAME_LENGTH]
        result = process_frame_directly(frame)

        peak = float(np.max(result["mel_norm"]))
        print(f"\n  Silence: mel_norm peak={peak:.3f}")
        assert peak < 0.05, f"Silence mel_norm too high: {peak}"

    def test_mel_norm_dynamic_range(self):
        """Verify there's meaningful difference between quiet and loud."""
        quiet = process_frame_directly(make_vocal_like(f0=300, amplitude=0.02)[:FRAME_LENGTH])
        loud = process_frame_directly(make_vocal_like(f0=300, amplitude=0.5)[:FRAME_LENGTH])

        quiet_peak = float(np.max(quiet["mel_norm"]))
        loud_peak = float(np.max(loud["mel_norm"]))
        ratio = loud_peak / (quiet_peak + 1e-6)
        print(f"\n  Dynamic range: quiet_peak={quiet_peak:.3f}, loud_peak={loud_peak:.3f}, ratio={ratio:.1f}x")
        assert ratio > 1.5, f"Not enough dynamic range: ratio={ratio}"

    def test_mel_norm_bin_distribution_for_voice(self):
        """Voice energy should concentrate in lower-mid mel bins, not spread evenly."""
        signal = make_vocal_like(f0=300, amplitude=0.3, n_harmonics=6)
        frame = signal[:FRAME_LENGTH]
        result = process_frame_directly(frame)
        mn = result["mel_norm"]

        low_energy = float(np.mean(mn[:16]))   # bins 0-15 (~80-400 Hz)
        mid_energy = float(np.mean(mn[16:32]))  # bins 16-31 (~400-1200 Hz)
        high_energy = float(np.mean(mn[32:48])) # bins 32-47 (~1200-2800 Hz)
        top_energy = float(np.mean(mn[48:64]))  # bins 48-63 (~2800-4000 Hz)

        print(f"\n  Bin distribution: low={low_energy:.3f}, mid={mid_energy:.3f}, "
              f"high={high_energy:.3f}, top={top_energy:.3f}")
        assert low_energy > top_energy, "Voice should have more low-freq than high-freq energy"


# ═══════════════════════════════════════════════════════════
# TEST 2: Pitch detection
# ═══════════════════════════════════════════════════════════

class TestPitchDetection:
    """Verify pitch detection for vocal frequencies."""

    @pytest.mark.parametrize("freq,note", [
        (220.0, "A3"),
        (261.6, "C4"),
        (329.6, "E4"),
        (440.0, "A4"),
        (523.3, "C5"),
    ])
    def test_pitch_detection_for_known_frequencies(self, freq, note):
        signal = make_sine(freq, duration_s=0.2, amplitude=0.4)
        frame = signal[:FRAME_LENGTH]
        result = process_frame_directly(frame)

        detected = result["pitch"]
        print(f"\n  Input: {freq} Hz ({note}), Detected: {detected:.1f} Hz")
        if not math.isnan(detected):
            error_pct = abs(detected - freq) / freq * 100
            print(f"  Error: {error_pct:.1f}%")
            assert error_pct < 8, f"Pitch detection error too high: {error_pct:.1f}%"

    def test_pitch_detection_with_harmonics(self):
        """Pitch should detect fundamental even with harmonics."""
        signal = make_vocal_like(f0=300, amplitude=0.3, n_harmonics=6)
        frame = signal[:FRAME_LENGTH]
        result = process_frame_directly(frame)

        detected = result["pitch"]
        print(f"\n  Vocal-like f0=300 Hz, Detected: {detected:.1f} Hz")
        if not math.isnan(detected):
            error_pct = abs(detected - 300) / 300 * 100
            assert error_pct < 15, f"Pitch detection error: {error_pct:.1f}%"

    def test_silence_no_pitch(self):
        frame = make_silence()[:FRAME_LENGTH]
        result = process_frame_directly(frame)
        assert math.isnan(result["pitch"]), "Silence should have no detected pitch"


# ═══════════════════════════════════════════════════════════
# TEST 3: Loudness
# ═══════════════════════════════════════════════════════════

class TestLoudness:
    def test_loudness_scales_with_amplitude(self):
        quiet = process_frame_directly(make_sine(300, amplitude=0.05)[:FRAME_LENGTH])
        medium = process_frame_directly(make_sine(300, amplitude=0.1)[:FRAME_LENGTH])
        loud = process_frame_directly(make_sine(300, amplitude=0.5)[:FRAME_LENGTH])

        print(f"\n  Loudness: quiet={quiet['loudness_db']:.1f}, "
              f"medium={medium['loudness_db']:.1f}, loud={loud['loudness_db']:.1f}")
        assert quiet["loudness_db"] < medium["loudness_db"] < loud["loudness_db"]

    def test_loudness_db_range_for_voice(self):
        """Typical voice should be in -40 to -5 dB range."""
        result = process_frame_directly(make_vocal_like(f0=300, amplitude=0.2)[:FRAME_LENGTH])
        db = result["loudness_db"]
        print(f"\n  Voice loudness: {db:.1f} dB")
        assert -50 < db < 0, f"Loudness out of expected range: {db}"


# ═══════════════════════════════════════════════════════════
# TEST 4: Spectral centroid
# ═══════════════════════════════════════════════════════════

class TestCentroid:
    def test_low_voice_lower_centroid_than_bright(self):
        """Lower fundamental → lower centroid."""
        low = process_frame_directly(make_vocal_like(f0=150, n_harmonics=4, amplitude=0.3)[:FRAME_LENGTH])
        high = process_frame_directly(make_vocal_like(f0=500, n_harmonics=4, amplitude=0.3)[:FRAME_LENGTH])

        print(f"\n  Centroid: f0=150→{low['centroid_hz']:.0f} Hz, f0=500→{high['centroid_hz']:.0f} Hz")
        assert low["centroid_hz"] < high["centroid_hz"]


# ═══════════════════════════════════════════════════════════
# TEST 5: RollingBuffer
# ═══════════════════════════════════════════════════════════

class TestRollingBuffer:
    def test_push_and_snapshot(self):
        buf = RollingBuffer(n_time=5, n_mels=4)
        mel = np.array([0.1, 0.2, 0.3, 0.4], dtype=np.float32)
        buf.push(mel, 440.0, -20.0, 1500.0)

        snap = buf.snapshot()
        mel_snap, pitch_snap, loud_snap, cent_snap = snap
        assert mel_snap.shape == (5, 4)
        assert float(mel_snap[-1, 0]) == pytest.approx(0.1, abs=1e-5)
        assert float(pitch_snap[-1]) == pytest.approx(440.0)
        assert float(loud_snap[-1]) == pytest.approx(-20.0)

    def test_rolling_window(self):
        buf = RollingBuffer(n_time=3, n_mels=2)
        for i in range(5):
            mel = np.array([i * 0.1, i * 0.2], dtype=np.float32)
            buf.push(mel, float(i), -10.0 * i, 1000.0)

        snap = buf.snapshot()
        # After 5 pushes into size-3 buffer, should have frames 2,3,4
        assert float(snap[0][-1, 0]) == pytest.approx(0.4, abs=1e-5)
        assert float(snap[1][-1]) == pytest.approx(4.0)


# ═══════════════════════════════════════════════════════════
# TEST 6: LiveState snapshot completeness
# ═══════════════════════════════════════════════════════════

class TestLiveState:
    def test_snapshot_has_all_new_fields(self):
        """Verify the expanded LiveState includes all fields the frontend needs."""
        state = LiveState()

        # Simulate update_from_frame
        info = FrameInfo(
            pitch_hz=440.0, note_name="A4", loudness_db=-18.0,
            centroid_hz=1500.0, timbre="Warm", vocal_range="Mixed",
            peak_bin=12, peak_value=0.8,
            peaks=[{"bin": 12, "value": 0.8}, {"bin": 25, "value": 0.5}],
            onset=0.4, energy=0.35, pitch_confidence=0.85,
        )
        mel = np.random.rand(64).astype(np.float32)
        state.update_from_frame(info, mel)

        snap = state.snapshot()
        print(f"\n  Snapshot keys: {sorted(snap.keys())}")

        # Original fields
        assert "mel" in snap and len(snap["mel"]) == 64
        assert snap["pitch"] == pytest.approx(440.0)
        assert snap["loudness"] == pytest.approx(-18.0)
        assert snap["note"] == "A4"
        assert snap["timbre"] == "Warm"
        assert snap["range"] == "Mixed"
        assert snap["centroid"] == pytest.approx(1500.0)

        # NEW fields that were being dropped
        assert "onset" in snap, "MISSING: onset"
        assert snap["onset"] == pytest.approx(0.4)
        assert "energy" in snap, "MISSING: energy"
        assert snap["energy"] == pytest.approx(0.35)
        assert "pitchConf" in snap, "MISSING: pitchConf"
        assert snap["pitchConf"] == pytest.approx(0.85)
        assert "peaks" in snap, "MISSING: peaks"
        assert len(snap["peaks"]) == 2

        # NEW history fields
        assert "melHist" in snap, "MISSING: melHist"
        assert "pitchHist" in snap, "MISSING: pitchHist"
        assert "loudHist" in snap, "MISSING: loudHist"
        assert "centroidHist" in snap, "MISSING: centroidHist"
        assert "onsetHist" in snap, "MISSING: onsetHist"

    def test_history_accumulates(self):
        state = LiveState()
        for i in range(5):
            info = FrameInfo(
                pitch_hz=200.0 + i * 20, note_name="C4", loudness_db=-20.0 + i,
                centroid_hz=1000.0, timbre="Warm", vocal_range="Mixed",
                peak_bin=10, peak_value=0.5, peaks=[{"bin": 10, "value": 0.5}],
                onset=0.1 * i, energy=0.2, pitch_confidence=0.7,
            )
            mel = np.ones(64, dtype=np.float32) * 0.1 * (i + 1)
            state.update_from_frame(info, mel)

        snap = state.snapshot()
        assert len(snap["pitchHist"]) == 5
        assert len(snap["melHist"]) == 5
        assert snap["pitchHist"][0] == pytest.approx(200.0)
        assert snap["pitchHist"][-1] == pytest.approx(280.0)
        print(f"\n  History lengths: pitch={len(snap['pitchHist'])}, mel={len(snap['melHist'])}")


# ═══════════════════════════════════════════════════════════
# TEST 7: End-to-end pipeline with synthetic voice
# ═══════════════════════════════════════════════════════════

class TestEndToEnd:
    """Full pipeline: audio → analyzer process → buffer → LiveState → payload."""

    def test_vocal_signal_produces_rich_payload(self):
        """A realistic vocal signal should produce a payload with all fields populated."""
        buf = RollingBuffer()
        state = LiveState()

        signal = make_vocal_like(f0=350, amplitude=0.3, n_harmonics=8, duration_s=0.5)

        # Feed multiple chunks through the pipeline (simulating analyzer._process)
        results = []
        prev_mel = np.zeros(N_MELS, dtype=np.float32)

        for start in range(0, len(signal) - FRAME_LENGTH, HOP_LENGTH):
            frame = signal[start:start + FRAME_LENGTH]
            if len(frame) < FRAME_LENGTH:
                break
            r = process_frame_directly(frame)

            # Compute onset (requires previous mel)
            onset = float(np.clip(np.mean(np.maximum(r["mel_norm"] - prev_mel, 0.0)) * 3.5, 0, 1))
            prev_mel = r["mel_norm"].copy()

            # Push to buffer
            buf.push(r["mel_norm"], r["pitch"], r["loudness_db"], r["centroid_hz"])

            # Estimate pitch confidence
            if not math.isnan(r["pitch"]):
                idx = int(round(r["pitch"] / (SR / FRAME_LENGTH)))
                if 1 < idx < len(r["spectrum"]):
                    lo = max(0, idx - 2)
                    hi = min(len(r["spectrum"]), idx + 3)
                    local = r["spectrum"][lo:hi]
                    sig = float(np.max(local))
                    noise = float(np.mean(r["spectrum"][max(0, idx - 12):min(len(r["spectrum"]), idx + 13)])) + 1e-6
                    conf = (sig - noise) / (sig + noise)
                    pitch_conf = float(np.clip((conf + 0.15) / 0.9, 0, 1))
                else:
                    pitch_conf = 0.0
            else:
                pitch_conf = 0.0

            # Build FrameInfo
            info = FrameInfo(
                pitch_hz=r["pitch"],
                note_name=hz_to_note_name(r["pitch"]),
                loudness_db=r["loudness_db"],
                centroid_hz=r["centroid_hz"],
                timbre=centroid_to_timbre(r["centroid_hz"]),
                vocal_range=hz_to_vocal_range(r["pitch"]),
                peak_bin=r["peak_bin"],
                peak_value=r["peak_val"],
                peaks=[{"bin": r["peak_bin"], "value": r["peak_val"]}],
                onset=onset,
                energy=r["energy"],
                pitch_confidence=pitch_conf,
            )
            mel_latest = buf.snapshot()[0][-1]
            state.update_from_frame(info, mel_latest)
            results.append(r)

        snap = state.snapshot()
        print(f"\n  Processed {len(results)} frames")
        print(f"  Final payload:")
        print(f"    mel: {len(snap['mel'])} bins, max={max(snap['mel']):.3f}, mean={sum(snap['mel'])/64:.3f}")
        print(f"    pitch: {snap['pitch']:.1f} Hz")
        print(f"    loudness: {snap['loudness']:.1f} dB")
        print(f"    centroid: {snap['centroid']:.0f} Hz")
        print(f"    note: {snap['note']}")
        print(f"    timbre: {snap['timbre']}")
        print(f"    range: {snap['range']}")
        print(f"    onset: {snap['onset']:.3f}")
        print(f"    energy: {snap['energy']:.3f}")
        print(f"    pitchConf: {snap['pitchConf']:.3f}")
        print(f"    peaks: {snap['peaks']}")
        print(f"    melHist: {len(snap['melHist'])} frames")
        print(f"    pitchHist: {len(snap['pitchHist'])} values")

        # ── Key assertions for visualization quality ──
        mel_max = max(snap["mel"])
        assert mel_max > 0.3, f"PROBLEM: mel values too low for visualization ({mel_max:.3f}). Voice will be invisible."
        assert snap["energy"] > 0.02, f"PROBLEM: energy too low ({snap['energy']:.3f})"
        assert snap["pitch"] > 0, "PROBLEM: no pitch detected"
        assert snap["pitchConf"] > 0, "PROBLEM: no pitch confidence"
        assert len(snap["melHist"]) > 0, "PROBLEM: no mel history"
        assert len(snap["pitchHist"]) > 0, "PROBLEM: no pitch history"

    def test_quiet_voice_still_produces_values(self):
        """Even a quiet voice should produce non-zero mel values."""
        signal = make_vocal_like(f0=300, amplitude=0.05, n_harmonics=6, duration_s=0.3)
        frame = signal[:FRAME_LENGTH]
        r = process_frame_directly(frame)

        mel_max = float(np.max(r["mel_norm"]))
        mel_mean = float(np.mean(r["mel_norm"]))
        print(f"\n  Quiet voice (amp=0.05):")
        print(f"    mel_norm max={mel_max:.3f}, mean={mel_mean:.3f}")
        print(f"    loudness: {r['loudness_db']:.1f} dB")
        print(f"    energy: {r['energy']:.3f}")

        # This is the critical check: if mel_max < 0.15, the creature will be nearly invisible
        if mel_max < 0.15:
            print(f"    ⚠ WARNING: mel values very low — visualization will be dim")
        assert mel_max > 0.05, f"Even quiet voice should have some mel energy: {mel_max}"


# ═══════════════════════════════════════════════════════════
# TEST 8: WS payload size estimate
# ═══════════════════════════════════════════════════════════

class TestPayloadSize:
    def test_payload_size_under_limit(self):
        """WS payload should stay under 50KB."""
        import json
        state = LiveState()
        for i in range(30):
            info = FrameInfo(
                pitch_hz=300.0, note_name="D4", loudness_db=-20.0,
                centroid_hz=1200.0, timbre="Warm", vocal_range="Mixed",
                peak_bin=10, peak_value=0.6,
                peaks=[{"bin": 10, "value": 0.6}, {"bin": 22, "value": 0.4}],
                onset=0.2, energy=0.3, pitch_confidence=0.75,
            )
            mel = np.random.rand(64).astype(np.float32) * 0.5
            state.update_from_frame(info, mel)

        snap = state.snapshot()
        payload = json.dumps(snap)
        size_kb = len(payload) / 1024
        print(f"\n  Payload size: {size_kb:.1f} KB ({len(payload)} bytes)")
        print(f"    mel: {len(json.dumps(snap['mel']))} bytes")
        print(f"    melHist: {len(json.dumps(snap['melHist']))} bytes")
        print(f"    pitchHist: {len(json.dumps(snap['pitchHist']))} bytes")
        assert size_kb < 50, f"Payload too large: {size_kb:.1f} KB"


# ═══════════════════════════════════════════════════════════
# TEST 9: note_utils correctness
# ═══════════════════════════════════════════════════════════

class TestNoteUtils:
    def test_note_names(self):
        assert hz_to_note_name(440.0) == "A4"
        assert hz_to_note_name(261.6) == "C4"
        assert hz_to_note_name(0) == "—"
        assert hz_to_note_name(float("nan")) == "—"

    def test_vocal_ranges(self):
        assert hz_to_vocal_range(100) == "Bass"
        assert hz_to_vocal_range(200) == "Chest"
        assert hz_to_vocal_range(350) == "Mixed"
        assert hz_to_vocal_range(500) == "Head"
        assert hz_to_vocal_range(800) == "Whistle"

    def test_timbre_labels(self):
        assert centroid_to_timbre(400) == "Dark"
        assert centroid_to_timbre(1000) == "Warm"
        assert centroid_to_timbre(2000) == "Bright"
        assert centroid_to_timbre(4000) == "Brilliant"


# ═══════════════════════════════════════════════════════════
# TEST 10: Real chunk→analyzer→buffer→LiveState→WS payload pipeline
# ═══════════════════════════════════════════════════════════

class TestChunkPipelineStress:
    """High-signal tests for the real threaded analyzer pipeline."""

    def test_full_chunk_pipeline_updates_state_and_payload(self):
        buf = RollingBuffer(n_time=64, n_mels=N_MELS)
        state = LiveState()
        frame_count = {"n": 0}

        def on_frame(info: FrameInfo) -> None:
            mel_latest = buf.snapshot()[0][-1]
            state.update_from_frame(info, mel_latest)
            frame_count["n"] += 1

        analyzer = Analyzer(buf, on_frame=on_frame)

        # Create a voice-like stream with changing loudness so preprocessing has work to do.
        signal = make_vocal_like(f0=280, n_harmonics=7, duration_s=1.2, amplitude=0.35)
        envelope = np.linspace(0.2, 1.0, len(signal), dtype=np.float32)
        signal = signal * envelope

        expected_chunks = 0
        for start in range(0, len(signal), HOP_LENGTH):
            chunk = signal[start:start + HOP_LENGTH]
            if len(chunk) < HOP_LENGTH:
                chunk = np.pad(chunk, (0, HOP_LENGTH - len(chunk)))
            analyzer.push_chunk(start, chunk.astype(np.float32))
            expected_chunks += 1

        deadline = time.time() + 2.5
        while frame_count["n"] < min(expected_chunks, 12) and time.time() < deadline:
            time.sleep(0.01)

        snap = state.snapshot()
        payload = json.loads(json.dumps(snap))

        assert frame_count["n"] > 0, "Analyzer thread did not process any chunks"
        assert len(payload["mel"]) == N_MELS
        assert len(payload["melHist"]) > 0
        assert len(payload["pitchHist"]) > 0
        assert payload["energy"] >= 0.0
        assert payload["onset"] >= 0.0
        assert max(payload["mel"]) > 0.1, "Mel bins stayed too small for visualization"
        assert len(payload["peaks"]) >= 1
        assert all(0 <= p["bin"] < N_MELS for p in payload["peaks"])
        assert all(p["value"] >= 0.0 for p in payload["peaks"])

    def test_pipeline_handles_burst_stress_and_keeps_payload_valid(self):
        """Push a burst of chunks faster than real-time and ensure payload remains sane."""
        buf = RollingBuffer(n_time=200, n_mels=N_MELS)
        state = LiveState()
        frame_count = {"n": 0}

        def on_frame(info: FrameInfo) -> None:
            mel_latest = buf.snapshot()[0][-1]
            state.update_from_frame(info, mel_latest)
            frame_count["n"] += 1

        analyzer = Analyzer(buf, on_frame=on_frame)
        rng = np.random.default_rng(42)

        # 500 chunks with mixed noise + harmonic content.
        for i in range(500):
            base = make_vocal_like(
                f0=180 + (i % 8) * 35,
                n_harmonics=5 + (i % 4),
                duration_s=HOP_LENGTH / SR,
                amplitude=0.05 + (i % 6) * 0.04,
            )[:HOP_LENGTH]
            noise = rng.normal(0.0, 0.008, size=HOP_LENGTH).astype(np.float32)
            analyzer.push_chunk(i * HOP_LENGTH, (base + noise).astype(np.float32))

        deadline = time.time() + 3.0
        while frame_count["n"] < 40 and time.time() < deadline:
            time.sleep(0.01)

        snap = state.snapshot()
        payload = json.dumps(snap)
        payload_dict = json.loads(payload)

        assert frame_count["n"] > 0, "No chunks were processed under burst load"
        assert len(payload_dict["mel"]) == N_MELS
        assert len(payload_dict["melHist"]) <= 10
        assert len(payload_dict["pitchHist"]) <= 30
        assert len(payload_dict["loudHist"]) <= 30
        assert len(payload) / 1024 < 50.0
        assert np.isfinite(np.array(payload_dict["mel"], dtype=np.float32)).all()
        assert np.isfinite(np.array(payload_dict["loudHist"], dtype=np.float32)).all()


class TestPreprocessingEdgeCases:
    """Edge/invalid input behavior for preprocessing before visualization."""

    def test_onset_spike_then_settle_for_repeated_frames(self):
        buf = RollingBuffer()
        captured: list[FrameInfo] = []
        analyzer = Analyzer(buf, on_frame=lambda info: captured.append(info))

        frame = make_vocal_like(f0=260, amplitude=0.35, duration_s=FRAME_LENGTH / SR)[:FRAME_LENGTH]
        analyzer._process(np.zeros(FRAME_LENGTH, dtype=np.float32))
        analyzer._process(frame)
        analyzer._process(frame)

        assert len(captured) == 3
        assert captured[1].onset > 0.05
        assert captured[2].onset < captured[1].onset

    def test_invalid_samples_nan_and_inf_are_sanitized(self):
        buf = RollingBuffer()
        captured: list[FrameInfo] = []
        analyzer = Analyzer(buf, on_frame=lambda info: captured.append(info))

        frame = make_vocal_like(f0=300, amplitude=0.25, duration_s=FRAME_LENGTH / SR)[:FRAME_LENGTH]
        frame = frame.copy()
        frame[32] = np.nan
        frame[64] = np.inf
        frame[96] = -np.inf

        analyzer._process(frame)
        mel_latest = buf.snapshot()[0][-1]
        assert np.isfinite(mel_latest).all()
        assert np.isfinite(captured[-1].loudness_db)
        assert np.isfinite(captured[-1].centroid_hz)
        assert 0.0 <= captured[-1].energy <= 1.0

    def test_empty_chunk_does_not_kill_analyzer_thread(self):
        buf = RollingBuffer()
        analyzer = Analyzer(buf, on_frame=lambda _info: None)

        analyzer.push_chunk(0, np.array([], dtype=np.float32))
        time.sleep(0.05)
        assert analyzer._thread.is_alive()

    def test_int16_chunk_pipeline_still_produces_finite_payload(self):
        buf = RollingBuffer()
        state = LiveState()

        def on_frame(info: FrameInfo) -> None:
            mel_latest = buf.snapshot()[0][-1]
            state.update_from_frame(info, mel_latest)

        analyzer = Analyzer(buf, on_frame=on_frame)
        signal = (make_vocal_like(f0=220, amplitude=0.3, duration_s=0.5) * 32767.0).astype(np.int16)

        for i in range(0, len(signal), HOP_LENGTH):
            chunk = signal[i:i + HOP_LENGTH]
            if len(chunk) < HOP_LENGTH:
                chunk = np.pad(chunk, (0, HOP_LENGTH - len(chunk)))
            analyzer.push_chunk(i, chunk)

        time.sleep(0.2)
        snap = state.snapshot()
        assert np.isfinite(np.array(snap["mel"], dtype=np.float32)).all()
        assert np.isfinite(float(snap["loudness"]))
        assert np.isfinite(float(snap["centroid"]))


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
