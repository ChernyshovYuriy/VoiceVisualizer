# Voice / Music Visualizer — Live (3D)

A native desktop app that plays any audio or video file and renders a
**live 3D surface visualization** synchronized to the audio in real time.

```
┌─────────────────────────────────────────────────────────────────┐
│  📂 Open file…   ▶ Play   song.mp3  (3:24)                      │
│                                                                 │
│  ┌────────────────────────────────────┐  ┌──────────────────┐   │
│  │                                    │  │ › Analysis       │   │
│  │   3D mel-spectrogram surface       │  │ Note   A4        │   │
│  │   X = time  (scrolling)            │  │ Freq   440 Hz    │   │
│  │   Y = frequency (mel, 80–4k Hz)    │  │ Volume −8.2 dB   │   │
│  │   Z = energy                       │  │ Timbre Bright    │   │
│  │   Color = loudness                 │  │ Range  Head      │   │
│  └────────────────────────────────────┘  └──────────────────┘   │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  1:12 / 3:24                │
└─────────────────────────────────────────────────────────────────┘
```

---

## How it works

| Component | Role |
|---|---|
| `sounddevice.OutputStream` | Streams audio to system output in 512-sample blocks |
| `core/analyzer.py` | Daemon thread: computes mel spectrum, YIN pitch, RMS, spectral centroid per block |
| `core/buffer.py` | Thread-safe rolling buffer (200 frames ≈ 4.6 s) |
| `ui/surface_widget.py` | PyQtGraph `GLSurfacePlotItem` — redraws at 30 fps from the buffer |
| `ui/info_panel.py` | Live Note / Freq / Volume / Timbre / Range overlay |

Audio callback → analysis queue → analyzer thread → rolling buffer → Qt timer → GPU surface.

---

## Supported formats

**Audio:** `.wav` `.mp3` `.flac` `.ogg` `.m4a` `.aac`  
**Video:** `.mp4` `.mov` `.mkv` `.avi` `.webm` *(requires ffmpeg)*

---

## Dependencies

- Python 3.10+
- PySide6
- pyqtgraph + PyOpenGL   ← 3D rendering
- sounddevice            ← audio playback
- librosa                ← mel spectrogram + YIN pitch
- numpy / scipy / soundfile

---

## Installation

```bash
cd live_visualizer

python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate

pip install -r requirements.txt

# For video support (optional)
# macOS:   brew install ffmpeg
# Ubuntu:  sudo apt install ffmpeg
# Windows: https://ffmpeg.org/download.html  (add to PATH)

# Optional: install Demucs runtime dependencies explicitly (CPU build)
# pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio torchvision
```

> **macOS note** — if PyOpenGL shows a black widget, install the system
> OpenGL headers: `xcode-select --install`

> **Windows note** — use a Python from python.org (not the Microsoft Store
> version) to avoid sounddevice DLL issues.

---

## Running

```bash
python app.py
```

---

## Project layout

```
live_visualizer/
├── app.py                   ← entry point
├── requirements.txt
├── README.md
├── core/
│   ├── player.py            ← sounddevice file playback + position tracking
│   ├── analyzer.py          ← per-frame DSP (mel, YIN, RMS, centroid)
│   └── buffer.py            ← thread-safe rolling frame buffer
├── ui/
│   ├── main_window.py       ← PySide6 window, toolbar, seek bar
│   ├── surface_widget.py    ← PyQtGraph GLSurfacePlotItem (3D surface)
│   └── info_panel.py        ← Note · Freq · Volume · Timbre · Range overlay
└── utils/
    └── note_utils.py        ← Hz → note name, vocal range, timbre label
```

---

## Performance notes

- Analysis runs in a background thread; the audio callback never blocks.
- The mel filterbank and Hanning window are pre-built once at startup.
- Frames are dropped (not queued) if the analyzer falls behind — this
  prevents memory buildup at the cost of occasional skipped frames.
- The surface renders at ~30 fps; analysis produces frames at ~43 fps.

---

## Known limitations

- No playback cursor cursor-sync on the surface (the surface scrolls
  continuously; time=0 is always the left edge).
- Very long files (> ~30 min) load fully into RAM at 22 050 Hz mono
  (≈ 150 MB/30 min). Consider using the Streamlit version for batch analysis.
- `.m4a` / `.aac` may require ffmpeg even for pure audio on some systems.
- PyOpenGL on Apple Silicon may need `DYLD_LIBRARY_PATH` pointing to OpenGL
  frameworks if the `.venv` isolates system libraries.


## Offline vocal preprocessing

The app preprocesses media offline and visualizes a cached vocals stem while playing the original media track.

### Backend strategy

1. **Demucs (preferred)**: runs **in-process** (Python API), keeps separated tensors in memory, and writes WAV stems with `soundfile.write`.
2. **Spleeter (fallback)**: if Demucs is unavailable or fails (Torch/TorchCodec/CUDA/shared-library/runtime issues), the app automatically falls back to Spleeter CLI.

This avoids fragile Demucs CLI output-saving paths and keeps stem writing on a standard WAV writer.

### Requirements

- `ffmpeg` on PATH
- At least one separator backend:
  - **Demucs (preferred):**
    ```bash
    pip install demucs
    # If needed, install matching torch wheels first (CPU example):
    pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio torchvision
    ```
  - **Spleeter fallback:**
    ```bash
    pip install spleeter
    ```

### Preprocess/cache flow

1. Open a media file.
2. The app extracts mono WAV audio into cache.
3. Separator backend generates `vocals.wav` + `accompaniment.wav`.
4. Playback uses original extracted audio.
5. Analyzer uses vocals stem or full mix based on toolbar mode.
6. Results are cached by source-file hash and reused on next load.

Cache location: `~/.voice_music_visualizer/cache/`

### Troubleshooting notes

- If Demucs fails at inference/runtime, the app auto-falls back to Spleeter.
- Error dialogs now distinguish extraction/separation issues and include backend + stage details.
- If both backends fail, install/verify at least one backend and retry.
