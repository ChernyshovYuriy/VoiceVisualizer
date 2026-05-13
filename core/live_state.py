"""
live_state.py
Thread-safe container. Calls self.on_update() after each frame so WSServer
can push immediately instead of polling.
"""

from __future__ import annotations

import math
import threading
from typing import TYPE_CHECKING, Callable

import numpy as np

if TYPE_CHECKING:
    from core.analyzer import FrameInfo

_MEL_HISTORY = 10
_SCALAR_HISTORY = 30


class LiveState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.on_update: Callable[[], None] | None = None  # set by WSServer

        self.mel: list[float] = [0.0] * 64
        self.pitch: float = 0.0
        self.loudness: float = -80.0
        self.note: str = "—"
        self.timbre: str = "—"
        self.vocal_range: str = "—"
        self.centroid: float = 0.0
        self.onset: float = 0.0
        self.energy: float = 0.0
        self.pitch_confidence: float = 0.0
        self.peaks: list[dict] = []
        self.frame_id: int = 0  # monotonic; bumped on each update_from_frame

        self._mel_history: list[list[float]] = []
        self._pitch_history: list[float] = []
        self._loudness_history: list[float] = []
        self._centroid_history: list[float] = []
        self._onset_history: list[float] = []

    def reset(self) -> None:
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
            self.frame_id = 0
            self._mel_history.clear()
            self._pitch_history.clear()
            self._loudness_history.clear()
            self._centroid_history.clear()
            self._onset_history.clear()

    @staticmethod
    def _ring_append(lst: list, value, maxlen: int) -> None:
        lst.append(value)
        if len(lst) > maxlen:
            del lst[0]

    def update_from_frame(self, info: "FrameInfo", mel: np.ndarray) -> None:
        mel_list = mel.tolist()
        with self._lock:
            self.mel = mel_list
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

            self._ring_append(self._mel_history, mel_list, _MEL_HISTORY)
            self._ring_append(self._pitch_history, self.pitch, _SCALAR_HISTORY)
            self._ring_append(self._loudness_history, self.loudness, _SCALAR_HISTORY)
            self._ring_append(self._centroid_history, self.centroid, _SCALAR_HISTORY)
            self._ring_append(self._onset_history, self.onset, _SCALAR_HISTORY)
            self.frame_id += 1

        # Notify outside the lock so WSServer can snapshot without deadlock
        cb = self.on_update
        if cb is not None:
            cb()

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

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "mel": list(self.mel),
                "pitch": self.pitch,
                "loudness": self.loudness,
                "note": self.note,
                "timbre": self.timbre,
                "range": self.vocal_range,
                "centroid": self.centroid,
                "onset": self.onset,
                "energy": self.energy,
                "pitchConf": self.pitch_confidence,
                "peaks": list(self.peaks),
                "melHist": list(self._mel_history),
                "pitchHist": list(self._pitch_history),
                "loudHist": list(self._loudness_history),
                "centroidHist": list(self._centroid_history),
                "onsetHist": list(self._onset_history),
                "frameId": self.frame_id,
            }
