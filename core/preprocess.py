"""
preprocess.py
Offline preprocessing pipeline: extract audio, separate vocals, cache results.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable
import wave

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


@dataclass(frozen=True)
class CacheCheckResult:
    prepared: PreparedMedia | None
    message: str


class Preprocessor:
    def __init__(self, cache: CacheManager | None = None) -> None:
        self._cache = cache or CacheManager()

    def prepare(self, source_path: Path, progress: ProgressFn | None = None) -> PreparedMedia:
        cache_check = self.check_cache(source_path)
        if cache_check.prepared is not None:
            self._emit(progress, cache_check.message)
            return cache_check.prepared

        entry = self._cache.entry_for(source_path)
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

        duration = self._duration_seconds(entry.original_audio)
        self._cache.write_meta(entry, {
            **self._cache.build_meta(
                source_path=source_path,
                entry=entry,
                separator_backend=backend,
                duration_seconds=duration,
                vocals_path=vocals,
                accompaniment_path=accompaniment,
            ),
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

    def check_cache(self, source_path: Path) -> CacheCheckResult:
        entry = self._cache.entry_for(source_path)
        meta = self._cache.read_meta(entry)
        if not meta:
            return CacheCheckResult(prepared=None, message="Cached vocals not found.")

        if not self._cache.has_vocal_stems(entry):
            self._cache.invalidate_entry(entry)
            return CacheCheckResult(prepared=None, message="Cache invalid; preprocessing required.")

        if str(meta.get("file_hash", "")) != entry.key:
            self._cache.invalidate_entry(entry)
            return CacheCheckResult(prepared=None, message="Cache hash mismatch; preprocessing required.")

        separator_backend = str(meta.get("separator_backend", "cached"))
        prepared = PreparedMedia(
            source_path=source_path,
            cache_key=entry.key,
            original_audio_path=entry.original_audio,
            vocals_path=entry.vocals,
            accompaniment_path=entry.accompaniment,
            separator_backend=separator_backend,
            from_cache=True,
        )
        return CacheCheckResult(prepared=prepared, message="Using cached vocals.")

    def build_external_prepared(self, source_path: Path, vocals_path: Path) -> PreparedMedia:
        return PreparedMedia(
            source_path=source_path,
            cache_key="external",
            original_audio_path=source_path,
            vocals_path=vocals_path,
            accompaniment_path=vocals_path,
            separator_backend="external",
            from_cache=True,
        )

    def cache_base_dir(self) -> Path:
        return self._cache.base_dir

    def _emit(self, progress: ProgressFn | None, message: str) -> None:
        if progress:
            progress(message)

    def _duration_seconds(self, wav_path: Path) -> float | None:
        try:
            with wave.open(str(wav_path), "rb") as wav:
                frames = wav.getnframes()
                rate = wav.getframerate()
                if rate <= 0:
                    return None
                return frames / float(rate)
        except Exception:
            return None
