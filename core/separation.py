"""
separation.py
Audio extraction and vocals/accompaniment source separation helpers.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import librosa
import numpy as np
import soundfile as sf

SR = 22_050
ProgressFn = Callable[[str], None]


class SeparationError(RuntimeError):
    """Raised when all separation backends fail."""


@dataclass(frozen=True)
class BackendFailure:
    backend: str
    stage: str
    technical_message: str


class BackendStageError(RuntimeError):
    def __init__(self, backend: str, stage: str, technical_message: str):
        super().__init__(technical_message)
        self.backend = backend
        self.stage = stage
        self.technical_message = technical_message


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


def separate_vocals(
    input_wav: Path,
    output_dir: Path,
    progress: ProgressFn | None = None,
) -> tuple[Path, Path, str]:
    output_dir.mkdir(parents=True, exist_ok=True)

    failures: list[BackendFailure] = []

    if _demucs_importable():
        _progress(progress, "Separating vocals with Demucs (in-process)…")
        try:
            return _run_demucs_in_process(input_wav, output_dir)
        except BackendStageError as exc:
            failures.append(BackendFailure(exc.backend, exc.stage, exc.technical_message))
            _progress(progress, "Demucs failed; falling back to Spleeter…")
        except Exception as exc:
            failures.append(BackendFailure("demucs", "inference", str(exc)))
            _progress(progress, "Demucs failed; falling back to Spleeter…")
    else:
        failures.append(BackendFailure("demucs", "setup", "Demucs Python module is not importable."))

    if _spleeter_available():
        _progress(progress, "Separating vocals with Spleeter…")
        try:
            return _run_spleeter(input_wav, output_dir)
        except BackendStageError as exc:
            failures.append(BackendFailure(exc.backend, exc.stage, exc.technical_message))
        except Exception as exc:
            failures.append(BackendFailure("spleeter", "inference", str(exc)))
    else:
        failures.append(BackendFailure("spleeter", "setup", "Spleeter CLI is not installed or unavailable."))

    raise SeparationError(_format_failure_message(failures))


def _run_demucs_in_process(input_wav: Path, output_dir: Path) -> tuple[Path, Path, str]:
    try:
        import torch
        from demucs.apply import apply_model
        from demucs.pretrained import get_model
    except Exception as exc:
        raise BackendStageError("demucs", "setup", f"Could not import Demucs runtime: {exc}") from exc

    try:
        model = get_model("htdemucs")
        if model is None:
            raise RuntimeError("Demucs model loading returned None.")

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model.to(device)
        model.eval()

        waveform, src_sr = sf.read(str(input_wav), always_2d=True, dtype="float32")
        waveform = waveform.T  # [channels, time]

        target_sr = int(getattr(model, "samplerate", SR))
        target_channels = int(getattr(model, "audio_channels", waveform.shape[0]))

        if src_sr != target_sr:
            resampled = [librosa.resample(ch, orig_sr=src_sr, target_sr=target_sr) for ch in waveform]
            waveform = np.stack(resampled, axis=0)

        if waveform.shape[0] < target_channels:
            waveform = np.vstack([waveform] * target_channels)
        elif waveform.shape[0] > target_channels:
            waveform = waveform[:target_channels, :]

        mix = torch.from_numpy(waveform).unsqueeze(0).to(device)
        with torch.no_grad():
            separated = apply_model(model, mix, device=device, progress=False, split=True)

        source_names = list(getattr(model, "sources", []))
        if "vocals" not in source_names:
            raise RuntimeError(f"Demucs sources missing vocals stem: {source_names}")

        vocals_idx = source_names.index("vocals")
        vocals = separated[0, vocals_idx].detach().cpu().numpy()

        accomp = np.zeros_like(vocals)
        for idx, name in enumerate(source_names):
            if name != "vocals":
                accomp += separated[0, idx].detach().cpu().numpy()

        vocals_mono = _to_output_mono(vocals, target_sr)
        accomp_mono = _to_output_mono(accomp, target_sr)
    except BackendStageError:
        raise
    except Exception as exc:
        raise BackendStageError("demucs", "inference", str(exc)) from exc

    vocals_dst = output_dir / "vocals.wav"
    acc_dst = output_dir / "accompaniment.wav"
    _write_wav(vocals_dst, vocals_mono, "demucs")
    _write_wav(acc_dst, accomp_mono, "demucs")
    return vocals_dst, acc_dst, "demucs"


def _run_spleeter(input_wav: Path, output_dir: Path) -> tuple[Path, Path, str]:
    work_dir = output_dir / "_spleeter_work"
    work_dir.mkdir(parents=True, exist_ok=True)

    result = subprocess.run(
        [
            "spleeter",
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
        stderr = result.stderr.decode(errors="replace")[-2500:]
        raise BackendStageError("spleeter", "inference", stderr)

    stem_root = work_dir / input_wav.stem
    vocals_src = stem_root / "vocals.wav"
    acc_src = stem_root / "accompaniment.wav"
    if not vocals_src.exists() or not acc_src.exists():
        raise BackendStageError(
            "spleeter",
            "save",
            "Spleeter completed but vocals.wav or accompaniment.wav was not produced.",
        )

    vocals_dst = output_dir / "vocals.wav"
    acc_dst = output_dir / "accompaniment.wav"
    shutil.copy2(vocals_src, vocals_dst)
    shutil.copy2(acc_src, acc_dst)
    return vocals_dst, acc_dst, "spleeter"


def _to_output_mono(audio_ch_t: np.ndarray, src_sr: int) -> np.ndarray:
    mono = audio_ch_t.mean(axis=0).astype(np.float32, copy=False)
    if src_sr != SR:
        mono = librosa.resample(mono, orig_sr=src_sr, target_sr=SR)
    return mono.astype(np.float32, copy=False)


def _write_wav(path: Path, samples: np.ndarray, backend: str) -> None:
    try:
        sf.write(str(path), samples, SR, subtype="PCM_16")
    except Exception as exc:
        raise BackendStageError(backend, "save", str(exc)) from exc


def _demucs_importable() -> bool:
    try:
        import demucs  # noqa: F401

        return True
    except Exception:
        return False


def _spleeter_available() -> bool:
    return shutil.which("spleeter") is not None


def _format_failure_message(failures: list[BackendFailure]) -> str:
    title = "Could not generate offline vocal stems."
    lines = [
        "The app tried Demucs first, then Spleeter fallback, but both failed.",
        "",
    ]
    for failure in failures:
        lines.append(f"- {failure.backend} failed during {failure.stage}: {failure.technical_message}")

    lines += [
        "",
        "Troubleshooting:",
        "• For Demucs: verify torch/torchaudio compatibility and CUDA/CPU libraries.",
        "• For Spleeter: ensure `spleeter` is installed and callable from PATH.",
        "• See README backend setup instructions.",
    ]
    return title + "\n\n" + "\n".join(lines)


def _progress(progress: ProgressFn | None, message: str) -> None:
    if progress:
        progress(message)
