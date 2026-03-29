"""
player.py
Loads playback media and a synchronized analysis track.
The original media audio is played to the speakers while analyzer receives
aligned chunks from either the full mix or a precomputed vocals stem.

Heavy decoding can be done off the UI thread with Player.prepare_tracks(),
then applied on the main thread with Player.load_prepared().
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

import librosa
import numpy as np
import sounddevice as sd

SR = 22_050
HOP = 512

AUDIO_EXT = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".avi", ".webm"}


@dataclass(slots=True)
class PreparedTracks:
    playback_y: np.ndarray
    analysis_y: np.ndarray
    duration: float


class Player:
    def __init__(self, on_chunk: Callable[[int, np.ndarray], None]) -> None:
        self._on_chunk = on_chunk
        self._play_y: Optional[np.ndarray] = None
        self._analysis_y: Optional[np.ndarray] = None
        self._pos = 0
        self._duration = 0.0
        self._lock = threading.Lock()
        self._stream: Optional[sd.OutputStream] = None
        self._playing = False
        self._on_end: Optional[Callable] = None

    def load_tracks(self, playback_audio_path: Path, analysis_audio_path: Path | None = None) -> float:
        prepared = self.prepare_tracks(playback_audio_path, analysis_audio_path)
        return self.load_prepared(prepared)

    @classmethod
    def prepare_tracks(
        cls,
        playback_audio_path: Path,
        analysis_audio_path: Path | None = None,
    ) -> PreparedTracks:
        play_y, _ = librosa.load(str(playback_audio_path), sr=SR, mono=True)
        analysis_src = analysis_audio_path or playback_audio_path
        analysis_y, _ = librosa.load(str(analysis_src), sr=SR, mono=True)

        play_y = np.asarray(play_y, dtype=np.float32)
        analysis_y = np.asarray(analysis_y, dtype=np.float32)

        max_len = max(len(play_y), len(analysis_y))
        if len(play_y) < max_len:
            play_y = np.pad(play_y, (0, max_len - len(play_y)))
        if len(analysis_y) < max_len:
            analysis_y = np.pad(analysis_y, (0, max_len - len(analysis_y)))

        return PreparedTracks(
            playback_y=play_y,
            analysis_y=analysis_y,
            duration=max_len / SR,
        )

    def load_prepared(self, prepared: PreparedTracks) -> float:
        self.stop()
        with self._lock:
            self._play_y = prepared.playback_y
            self._analysis_y = prepared.analysis_y
            self._pos = 0
            self._duration = prepared.duration
        return prepared.duration

    def play(self, on_end: Optional[Callable] = None) -> None:
        if self._play_y is None:
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
        if self._play_y is not None and not self._playing:
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
            if self._play_y is not None:
                self._pos = int(np.clip(seconds * SR, 0, len(self._play_y) - 1))

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

    def _callback(self, outdata: np.ndarray, frames: int, time, status) -> None:
        with self._lock:
            if self._play_y is None or self._analysis_y is None:
                outdata[:] = 0
                return
            end = min(self._pos + frames, len(self._play_y))
            play_chunk = self._play_y[self._pos:end]
            analysis_chunk = self._analysis_y[self._pos:end]
            n = len(play_chunk)
            outdata[:n, 0] = play_chunk
            if n < frames:
                outdata[n:, 0] = 0
            pos_snap = self._pos
            self._pos = end

        self._on_chunk(pos_snap, analysis_chunk)

        if end >= len(self._play_y):
            raise sd.CallbackStop()

    def _finished(self) -> None:
        self._playing = False
        if self._on_end:
            self._on_end()
