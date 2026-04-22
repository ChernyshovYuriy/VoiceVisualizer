"""
buffer.py
Thread-safe rolling buffer – O(1) push via circular index (no per-frame copy).
"""

import numpy as np
import threading

N_TIME = 200    # number of time frames displayed (~4.6 s at hop=512, sr=22050)
N_MELS = 64     # mel frequency bins


class RollingBuffer:
    """
    Circular buffer – push is O(1); snapshot returns a time-ordered view copy.
    """

    def __init__(self, n_time: int = N_TIME, n_mels: int = N_MELS) -> None:
        self.n_time = n_time
        self.n_mels = n_mels
        self._mel = np.zeros((n_time, n_mels), dtype=np.float32)
        self._pitch = np.full(n_time, np.nan, dtype=np.float32)
        self._loudness = np.full(n_time, -80.0, dtype=np.float32)
        self._centroid = np.zeros(n_time, dtype=np.float32)
        self._head = 0          # next write position
        self._lock = threading.Lock()

    # ── write ──────────────────────────────────────────────────────────────

    def push(
        self,
        mel_frame: np.ndarray,
        pitch: float,
        loudness_db: float,
        centroid_hz: float,
    ) -> None:
        with self._lock:
            idx = self._head % self.n_time
            self._mel[idx] = mel_frame
            self._pitch[idx] = pitch
            self._loudness[idx] = loudness_db
            self._centroid[idx] = centroid_hz
            self._head += 1

    def reset(self) -> None:
        with self._lock:
            self._mel[:] = 0
            self._pitch[:] = np.nan
            self._loudness[:] = -80.0
            self._centroid[:] = 0.0
            self._head = 0

    # ── read ───────────────────────────────────────────────────────────────

    def snapshot(self) -> tuple:
        """Return copies of (mel, pitch, loudness_db, centroid_hz) in chronological order."""
        with self._lock:
            n = self.n_time
            start = self._head % n
            idx = np.arange(start, start + n) % n
            return (
                self._mel[idx].copy(),
                self._pitch[idx].copy(),
                self._loudness[idx].copy(),
                self._centroid[idx].copy(),
            )

    @property
    def latest_pitch(self) -> float:
        with self._lock:
            for i in range(self.n_time):
                p = self._pitch[(self._head - 1 - i) % self.n_time]
                if not np.isnan(p) and p > 0:
                    return float(p)
            return float("nan")

    @property
    def latest_loudness(self) -> float:
        with self._lock:
            return float(self._loudness[(self._head - 1) % self.n_time])

    @property
    def latest_centroid(self) -> float:
        with self._lock:
            return float(self._centroid[(self._head - 1) % self.n_time])
