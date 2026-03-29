"""CLI for offline media preprocessing and cache warming.

Usage:
    python -m tools.preprocess_media /path/to/media
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from core.preprocess import Preprocessor, PreprocessError


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Preprocess media into cached vocals stems.")
    parser.add_argument("source", type=Path, help="Path to source audio/video file")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    source_path = args.source.expanduser().resolve()
    if not source_path.exists() or not source_path.is_file():
        print(f"Error: source file not found: {source_path}", file=sys.stderr)
        return 2

    preprocessor = Preprocessor()
    print(f"Source: {source_path}")

    try:
        cache_state = preprocessor.check_cache(source_path)
        if cache_state.prepared is not None:
            prepared = cache_state.prepared
            print(cache_state.message)
            print(f"Cache key: {prepared.cache_key}")
            print("Outputs:")
            print(f"  original_audio.wav: {prepared.original_audio_path}")
            print(f"  vocals.wav: {prepared.vocals_path}")
            print(f"  accompaniment.wav: {prepared.accompaniment_path}")
            print(f"  meta.json: {prepared.original_audio_path.parent / 'meta.json'}")
            return 0

        print(cache_state.message)
        print("Preprocessing required.")
        prepared = preprocessor.prepare(source_path, progress=lambda msg: print(f"[progress] {msg}"))

        print("Done.")
        print(f"Cache directory: {prepared.original_audio_path.parent}")
        print(f"Cache key: {prepared.cache_key}")
        print("Outputs:")
        print(f"  original_audio.wav: {prepared.original_audio_path}")
        print(f"  vocals.wav: {prepared.vocals_path}")
        print(f"  accompaniment.wav: {prepared.accompaniment_path}")
        print(f"  meta.json: {prepared.original_audio_path.parent / 'meta.json'}")
        return 0
    except PreprocessError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
