"""
preprocess.py
Offline preprocessing pipeline: extract audio, separate vocals, cache results.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from core.cache_manager import CacheManager
from core.separation import SeparationError, extract_audio_to_wav, separate_vocals

ProgressFn = Callable[[str], None]


class PreprocessError(RuntimeError):
    """User-facing preprocessing error with technical details attached."""


@dataclass(frozen=True)
class PreparedMedia:
    source_path: Path
    cache_key: str
    original_audio_path: Path
    vocals_path: Path
    accompaniment_path: Path
    separator_backend: str
    from_cache: bool


class Preprocessor:
    def __init__(self, cache: CacheManager | None = None) -> None:
        self._cache = cache or CacheManager()

    def prepare(self, source_path: Path, progress: ProgressFn | None = None) -> PreparedMedia:
        entry = self._cache.entry_for(source_path)
        if self._cache.has_vocal_stems(entry):
            self._emit(progress, f"Using cached stems for {source_path.name}…")
            meta = self._cache.read_meta(entry)
            return PreparedMedia(
                source_path=source_path,
                cache_key=entry.key,
                original_audio_path=entry.original_audio,
                vocals_path=entry.vocals,
                accompaniment_path=entry.accompaniment,
                separator_backend=str(meta.get("separator_backend", "cached")),
                from_cache=True,
            )

        self._emit(progress, f"Extracting audio from {source_path.name}…")
        try:
            extract_audio_to_wav(source_path, entry.original_audio)
        except Exception as exc:
            raise PreprocessError(
                "Could not decode audio from this file. Please verify ffmpeg is installed and the media format is supported."
                f"\n\nDetails:\n{exc}"
            ) from exc

        try:
            vocals, accompaniment, backend = separate_vocals(
                entry.original_audio,
                entry.root,
                progress=progress,
            )
        except SeparationError as exc:
            raise PreprocessError(
                "Could not generate vocal stems for offline analysis. "
                "Try installing Demucs and/or Spleeter as documented in the README."
                f"\n\nDetails:\n{exc}"
            ) from exc

        self._cache.write_meta(entry, {
            "source_path": str(source_path),
            "separator_backend": backend,
        })
        self._emit(progress, "Vocal stem ready.")
        return PreparedMedia(
            source_path=source_path,
            cache_key=entry.key,
            original_audio_path=entry.original_audio,
            vocals_path=vocals,
            accompaniment_path=accompaniment,
            separator_backend=backend,
            from_cache=False,
        )

    def _emit(self, progress: ProgressFn | None, message: str) -> None:
        if progress:
            progress(message)
