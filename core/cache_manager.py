"""
cache_manager.py
Content-addressed cache for extracted audio and separated stems.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
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
        key = self._hash_file(source_path)
        root = self.base_dir / key
        root.mkdir(parents=True, exist_ok=True)
        return CacheEntry(key=key, root=root)

    def has_vocal_stems(self, entry: CacheEntry) -> bool:
        return entry.original_audio.exists() and entry.vocals.exists() and entry.accompaniment.exists()

    def has_original_audio(self, entry: CacheEntry) -> bool:
        return entry.original_audio.exists()

    def write_meta(self, entry: CacheEntry, payload: dict[str, Any]) -> None:
        entry.meta.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def read_meta(self, entry: CacheEntry) -> dict[str, Any]:
        if not entry.meta.exists():
            return {}
        return json.loads(entry.meta.read_text(encoding="utf-8"))

    def _hash_file(self, path: Path) -> str:
        h = hashlib.sha256()
        with path.open('rb') as f:
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                h.update(chunk)
        h.update(str(path.suffix.lower()).encode('utf-8'))
        return h.hexdigest()[:24]
