"""
buffer.py
Thread-safe rolling buffer that stores the last N analysis frames.
"""

import numpy as np
import threading

N_TIME = 200    # number of time frames displayed (~4.6 s at hop=512, sr=22050)
N_MELS = 64     # mel frequency bins


class RollingBuffer:
    """
    Stores the most recent N_TIME analysis frames.
    All reads/writes are protected by a lock so the audio worker and the
    Qt render timer can access it safely from different threads.
    """

    def __init__(self, n_time: int = N_TIME, n_mels: int = N_MELS) -> None:
        self.n_time = n_time
        self.n_mels = n_mels
        self._mel = np.zeros((n_time, n_mels), dtype=np.float32)
        self._pitch = np.full(n_time, np.nan, dtype=np.float32)
        self._loudness = np.full(n_time, -80.0, dtype=np.float32)
        self._centroid = np.zeros(n_time, dtype=np.float32)
        self._lock = threading.Lock()

    # ── write ─────────────────────────────────────────────────────────────────

    def push(
        self,
        mel_frame: np.ndarray,
        pitch: float,
        loudness_db: float,
        centroid_hz: float,
    ) -> None:
        with self._lock:
            # Shift everything left (oldest frame drops off)
            self._mel[:-1] = self._mel[1:]
            self._pitch[:-1] = self._pitch[1:]
            self._loudness[:-1] = self._loudness[1:]
            self._centroid[:-1] = self._centroid[1:]
            # Append newest at the right end
            self._mel[-1] = mel_frame
            self._pitch[-1] = pitch
            self._loudness[-1] = loudness_db
            self._centroid[-1] = centroid_hz

    def reset(self) -> None:
        with self._lock:
            self._mel[:] = 0
            self._pitch[:] = np.nan
            self._loudness[:] = -80.0
            self._centroid[:] = 0.0

    # ── read ──────────────────────────────────────────────────────────────────

    def snapshot(self) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """Return copies of (mel, pitch, loudness_db, centroid_hz)."""
        with self._lock:
            return (
                self._mel.copy(),
                self._pitch.copy(),
                self._loudness.copy(),
                self._centroid.copy(),
            )

    @property
    def latest_pitch(self) -> float:
        with self._lock:
            for p in reversed(self._pitch):
                if not np.isnan(p) and p > 0:
                    return float(p)
            return float("nan")

    @property
    def latest_loudness(self) -> float:
        with self._lock:
            return float(self._loudness[-1])

    @property
    def latest_centroid(self) -> float:
        with self._lock:
            return float(self._centroid[-1])
