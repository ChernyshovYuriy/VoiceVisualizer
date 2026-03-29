"""
live_state.py
Thread-safe container holding the latest analysis frame for the WS server.
"""

import math
import threading
import numpy as np


class LiveState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.mel = [0.0] * 64
        self.pitch = 0.0
        self.loudness = -80.0
        self.note = "—"
        self.timbre = "—"
        self.vocal_range = "—"
        self.centroid = 0.0

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
            }
