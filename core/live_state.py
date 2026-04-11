"""
live_state.py
Thread-safe container holding the latest analysis frame for the WS server.

Carries the full FrameInfo plus short temporal history so the frontend
can render temporally-aware, expressive visualizations.
"""

from __future__ import annotations

import math
import threading
from collections import deque
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from core.analyzer import FrameInfo

# How many past frames of history to include in the WS payload.
_MEL_HISTORY = 10  # last N mel frames  (10×64 = 640 floats ≈ 4 KB)
_SCALAR_HISTORY = 30  # last N pitch / loudness / centroid values


class LiveState:
    def __init__(self) -> None:
        self._lock = threading.Lock()

        # Current frame (scalars)
        self.mel: list[float] = [0.0] * 64
        self.pitch: float = 0.0
        self.loudness: float = -80.0
        self.note: str = "—"
        self.timbre: str = "—"
        self.vocal_range: str = "—"
        self.centroid: float = 0.0

        # New: rich per-frame features the old code was dropping
        self.onset: float = 0.0
        self.energy: float = 0.0
        self.pitch_confidence: float = 0.0
        self.peaks: list[dict] = []

        # New: short temporal history
        self._mel_history: deque[list[float]] = deque(maxlen=_MEL_HISTORY)
        self._pitch_history: deque[float] = deque(maxlen=_SCALAR_HISTORY)
        self._loudness_history: deque[float] = deque(maxlen=_SCALAR_HISTORY)
        self._centroid_history: deque[float] = deque(maxlen=_SCALAR_HISTORY)
        self._onset_history: deque[float] = deque(maxlen=_SCALAR_HISTORY)

    def reset(self) -> None:
        """Clear all histories and reset to initial state (used on new file load)."""
        with self._lock:
            self.mel = [0.0] * 64
            self.pitch = 0.0
            self.loudness = -80.0
            self.note = "—"
            self.timbre = "—"
            self.vocal_range = "—"
            self.centroid = 0.0
            self.onset = 0.0
            self.energy = 0.0
            self.pitch_confidence = 0.0
            self.peaks = []

            self._mel_history.clear()
            self._pitch_history.clear()
            self._loudness_history.clear()
            self._centroid_history.clear()
            self._onset_history.clear()

    # ── write ─────────────────────────────────────────────────

    def update_from_frame(self, info: FrameInfo, mel: np.ndarray) -> None:
        """Accept a full FrameInfo + latest mel vector."""
        with self._lock:
            self.mel = mel.tolist()
            self.pitch = 0.0 if math.isnan(info.pitch_hz) else float(info.pitch_hz)
            self.loudness = float(info.loudness_db)
            self.note = info.note_name
            self.timbre = info.timbre
            self.vocal_range = info.vocal_range
            self.centroid = float(info.centroid_hz)
            self.onset = float(info.onset)
            self.energy = float(info.energy)
            self.pitch_confidence = float(info.pitch_confidence)
            self.peaks = list(info.peaks)

            # Append to history rings
            self._mel_history.append(list(self.mel))
            self._pitch_history.append(self.pitch)
            self._loudness_history.append(self.loudness)
            self._centroid_history.append(self.centroid)
            self._onset_history.append(self.onset)

    # Backwards-compat shim (unused after main_window is updated)
    def update(self, mel: np.ndarray, pitch: float, loudness: float,
               note: str, timbre: str, vocal_range: str, centroid: float = 0.0) -> None:
        with self._lock:
            self.mel = mel.tolist()
            self.pitch = 0.0 if math.isnan(pitch) else float(pitch)
            self.loudness = float(loudness)
            self.note = note
            self.timbre = timbre
            self.vocal_range = vocal_range
            self.centroid = float(centroid)

    # ── read ──────────────────────────────────────────────────

    def snapshot(self) -> dict:
        with self._lock:
            return {
                # Current frame
                "mel": list(self.mel),
                "pitch": self.pitch,
                "loudness": self.loudness,
                "note": self.note,
                "timbre": self.timbre,
                "range": self.vocal_range,
                "centroid": self.centroid,

                # Rich per-frame features (were being dropped)
                "onset": self.onset,
                "energy": self.energy,
                "pitchConf": self.pitch_confidence,
                "peaks": list(self.peaks),

                # Temporal history
                "melHist": list(self._mel_history),
                "pitchHist": list(self._pitch_history),
                "loudHist": list(self._loudness_history),
                "centroidHist": list(self._centroid_history),
                "onsetHist": list(self._onset_history),
            }
