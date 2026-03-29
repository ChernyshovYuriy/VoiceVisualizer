"""
separation.py
Audio extraction and vocals/accompaniment source separation helpers.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

SR = 22_050
ProgressFn = Callable[[str], None]


@dataclass(frozen=True)
class SeparationBackend:
    name: str
    command: list[str]


class SeparationError(RuntimeError):
    pass


def ensure_ffmpeg() -> None:
    if not shutil.which("ffmpeg"):
        raise SeparationError("ffmpeg is not installed or not on PATH. Install ffmpeg first.")


def extract_audio_to_wav(source: Path, target_wav: Path) -> None:
    ensure_ffmpeg()
    target_wav.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(source),
            "-vn",
            "-acodec", "pcm_s16le",
            "-ar", str(SR),
            "-ac", "1",
            str(target_wav),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=3600,
    )
    if result.returncode != 0:
        raise SeparationError(
            "ffmpeg audio extraction failed.\n"
            + result.stderr.decode(errors="replace")[-2000:]
        )


def available_backend() -> SeparationBackend:
    demucs_cmd = [sys.executable, "-m", "demucs"]
    if _command_works(demucs_cmd + ["--help"]):
        return SeparationBackend(name="demucs", command=demucs_cmd)

    spleeter_cmd = ["spleeter"]
    if _command_works(spleeter_cmd + ["--help"]):
        return SeparationBackend(name="spleeter", command=spleeter_cmd)

    raise SeparationError(
        "No supported separator found. Install one of:\n"
        "  pip install demucs\n"
        "or\n"
        "  pip install spleeter"
    )


def separate_vocals(
    input_wav: Path,
    output_dir: Path,
    progress: ProgressFn | None = None,
) -> tuple[Path, Path, str]:
    backend = available_backend()
    output_dir.mkdir(parents=True, exist_ok=True)
    _progress(progress, f"Separating vocals with {backend.name}…")

    if backend.name == "demucs":
        return _run_demucs(backend, input_wav, output_dir)
    if backend.name == "spleeter":
        return _run_spleeter(backend, input_wav, output_dir)
    raise SeparationError(f"Unsupported separation backend: {backend.name}")


def _run_demucs(backend: SeparationBackend, input_wav: Path, output_dir: Path) -> tuple[Path, Path, str]:
    work_dir = output_dir / "_demucs_work"
    work_dir.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        backend.command + [
            "--two-stems=vocals",
            "--out", str(work_dir),
            str(input_wav),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=7200,
    )
    if result.returncode != 0:
        raise SeparationError(
            "Demucs separation failed.\n"
            + result.stderr.decode(errors="replace")[-2500:]
        )

    stem_root = next((p for p in work_dir.rglob(input_wav.stem) if p.is_dir()), None)
    if stem_root is None:
        raise SeparationError("Demucs completed but output stems were not found.")

    vocals_src = stem_root / "vocals.wav"
    other_src = stem_root / "no_vocals.wav"
    if not vocals_src.exists() or not other_src.exists():
        raise SeparationError("Demucs output is missing vocals.wav or no_vocals.wav.")

    vocals_dst = output_dir / "vocals.wav"
    acc_dst = output_dir / "accompaniment.wav"
    shutil.copy2(vocals_src, vocals_dst)
    shutil.copy2(other_src, acc_dst)
    return vocals_dst, acc_dst, "demucs"


def _run_spleeter(backend: SeparationBackend, input_wav: Path, output_dir: Path) -> tuple[Path, Path, str]:
    work_dir = output_dir / "_spleeter_work"
    work_dir.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        backend.command + [
            "separate",
            "-p", "spleeter:2stems",
            "-o", str(work_dir),
            str(input_wav),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=7200,
    )
    if result.returncode != 0:
        raise SeparationError(
            "Spleeter separation failed.\n"
            + result.stderr.decode(errors="replace")[-2500:]
        )

    stem_root = work_dir / input_wav.stem
    vocals_src = stem_root / "vocals.wav"
    acc_src = stem_root / "accompaniment.wav"
    if not vocals_src.exists() or not acc_src.exists():
        raise SeparationError("Spleeter output is missing vocals.wav or accompaniment.wav.")

    vocals_dst = output_dir / "vocals.wav"
    acc_dst = output_dir / "accompaniment.wav"
    shutil.copy2(vocals_src, vocals_dst)
    shutil.copy2(acc_src, acc_dst)
    return vocals_dst, acc_dst, "spleeter"


def _command_works(command: Iterable[str]) -> bool:
    try:
        result = subprocess.run(
            list(command),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=20,
        )
        return result.returncode == 0
    except Exception:
        return False


def _progress(progress: ProgressFn | None, message: str) -> None:
    if progress:
        progress(message)
