"""
cache_manager.py
Content-addressed cache for extracted audio and separated stems.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class CacheEntry:
    key: str
    root: Path

    @property
    def original_audio(self) -> Path:
        return self.root / "original_audio.wav"

    @property
    def vocals(self) -> Path:
        return self.root / "vocals.wav"

    @property
    def accompaniment(self) -> Path:
        return self.root / "accompaniment.wav"

    @property
    def meta(self) -> Path:
        return self.root / "meta.json"


class CacheManager:
    def __init__(self, base_dir: Path | None = None) -> None:
        self.base_dir = (base_dir or (Path.home() / ".voice_music_visualizer" / "cache")).expanduser()
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def entry_for(self, source_path: Path) -> CacheEntry:
        key = self.hash_for(source_path)
        root = self.base_dir / key
        root.mkdir(parents=True, exist_ok=True)
        return CacheEntry(key=key, root=root)

    def hash_for(self, source_path: Path) -> str:
        return self._hash_file(source_path)

    def has_vocal_stems(self, entry: CacheEntry) -> bool:
        return (
            self._is_non_empty_wav(entry.original_audio)
            and self._is_non_empty_wav(entry.vocals)
            and self._is_non_empty_wav(entry.accompaniment)
        )

    def write_meta(self, entry: CacheEntry, payload: dict[str, Any]) -> None:
        entry.meta.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def read_meta(self, entry: CacheEntry) -> dict[str, Any]:
        if not entry.meta.exists():
            return {}
        return json.loads(entry.meta.read_text(encoding="utf-8"))

    def build_meta(
        self,
        *,
        source_path: Path,
        entry: CacheEntry,
        separator_backend: str,
        duration_seconds: float | None,
        vocals_path: Path,
        accompaniment_path: Path | None,
    ) -> dict[str, Any]:
        return {
            "source_path": str(source_path),
            "file_hash": entry.key,
            "duration_seconds": duration_seconds,
            "separator_backend": separator_backend,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "outputs": {
                "original_audio": str(entry.original_audio),
                "vocals": str(vocals_path),
                "accompaniment": str(accompaniment_path) if accompaniment_path else None,
                "meta": str(entry.meta),
            },
        }

    def invalidate_entry(self, entry: CacheEntry) -> None:
        for path in (entry.original_audio, entry.vocals, entry.accompaniment, entry.meta):
            if path.exists():
                path.unlink(missing_ok=True)

    def _is_non_empty_wav(self, path: Path) -> bool:
        return path.exists() and path.is_file() and path.stat().st_size > 44

    def _hash_file(self, path: Path) -> str:
        h = hashlib.sha256()
        with path.open("rb") as f:
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                h.update(chunk)
        h.update(str(path.suffix.lower()).encode("utf-8"))
        return h.hexdigest()[:24]
