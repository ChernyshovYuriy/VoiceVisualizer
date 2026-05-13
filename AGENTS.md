# AGENTS.md

## Project: Voice / Music Visualizer

A real-time vocal visualizer tuned for sustained legato styles
(chanson, jazz vocal, contralto/mezzo — designed around Patricia Kaas).

The **primary visual** is rendered natively in-app via
`ui/renderer.py` (PySide6 `QOpenGLWidget` + raw OpenGL 3.3 core). A
secondary browser-based view exists at `frontend/visualizer.html` and
shares the same `LiveState` snapshot over WebSocket.

---

# 🔴 Core Principle

The visual must communicate two things at a glance:

1. **The melodic line** — pitch over the last ~6 seconds, scrolling
   right-to-left. Vibrato must appear as natural undulation in the line.
2. **The current voice character** — a plume anchored at the right
   edge of the trail whose warmth, size, and drift reflect timbre,
   loudness, and vocal stability *right now*.

If a viewer cannot read both at a glance, the implementation is wrong.

---

# 🧱 Visual Architecture: "Smoke & Filament"

Three explicit drawing passes, in order:

1. **Background** — fullscreen quad. Midnight gradient + warm
   stage-light glow from below-centre (chanson stage feel).
2. **Filament** — scrolling pitch contour. A 2D triangle-strip ribbon
   in world XY, built each paint from a client-side ring buffer of
   pitch samples. Per-vertex colour + alpha. Additive blending.
3. **Plume** — two billboards (halo behind, core in front) at the
   right edge of the filament, anchored at the current note Y.
   Multi-octave fbm noise + radial falloff in the fragment shader.

## Forbidden

* Rings, tori, concentric pulses
* Particle systems
* Mel-spectrogram surface meshes
* Bars / equalizer columns / VU meters
* Decorative geometry not tied to data

---

# 🎯 Data Mapping (Authoritative)

| Feature           | Source                          | Visual target                          |
|-------------------|---------------------------------|----------------------------------------|
| pitch (Hz, log)   | `state.pitch`, `pitchConf`      | Filament Y, plume Y                    |
| loudness          | `state.loudness` (dB)           | Filament thickness, plume size         |
| centroid          | `state.centroid` (Hz)           | Filament colour (per-sample), plume warmth |
| stability         | smoothed `pitchConf`            | Plume drift (1−stability)              |
| onset             | `state.onset` + `onsetHist`     | Plume inner-core flash                 |
| voiced gate       | `pitch > 40 ∧ pitchConf > 0.10` | Filament alpha/thickness collapse      |
| vibrato           | *emergent*                      | Natural undulation in the filament     |

**Vibrato is not a separate visual feature.** It emerges from the raw
pitch sample stream. Do not add synthetic sinusoidal warps to fake it.

---

# 🎨 Colour System

Chanson palette, six stops, chest → head:

```
0.00  deep wine        (0.46, 0.11, 0.13)
0.22  burnt orange     (0.62, 0.22, 0.14)
0.45  amber            (0.78, 0.46, 0.20)
0.65  warm gold        (0.85, 0.66, 0.34)
0.82  muted jade       (0.50, 0.56, 0.50)
1.00  desaturated pewter (0.42, 0.54, 0.66)
```

### Register pull

Colour is *not strictly* a function of pitch. The spectral centroid
pulls the sampled colour toward the chest tint `(0.78, 0.38, 0.16)`
when timbre is dark. This makes Kaas-style smoky chest delivery read
as warm even at mid-pitch, and bright head-voice notes read as cool
even when sung lower.

Avoid: neon, pure RGB, rainbow cycling, high saturation everywhere.

---

# ⚙️ Implementation Rules

## 1. Public API

`ui/renderer.py` must export:

```python
class RingWidget(QOpenGLWidget):
    def __init__(self, live_state: LiveState, parent=None): ...
```

The class name is retained for `main_window.py` compatibility even
though the design is no longer rings.

Mouse: left-drag orbit, wheel zoom.

## 2. Sample feed

`LiveState` carries a monotonic `frame_id` (bumped on each
`update_from_frame`, reset by `reset()`). The renderer reads it from
`snapshot()["frameId"]` and appends a new sample to the filament ring
buffer only when the id has advanced. This guarantees:

* one filament vertex per analysis frame (≈43 fps)
* no duplicates if the renderer paints faster than the analyzer
* clean reset on track change

## 3. Per-frame work

* Background: one shader, two triangles, ~zero cost.
* Filament rebuild: O(N) typed-array writes (N ≤ 360 samples). Single
  glBufferSubData per attribute. Triangle list with pre-built index
  buffer.
* Plume: two quads with fragment shaders. No textures.
* No allocations in `paintGL`. Reusable numpy buffers.

## 4. Motion

* Pitch attack 0.45, release 0.08 — dramatic swells linger.
* Plume size / drift / warmth smoothed at 0.10–0.18.
* Filament itself is **not** smoothed — raw per-frame samples are the
  point. Per-feature smoothing happens upstream.

## 5. Voiced gating

The filament collapses width and alpha on unvoiced samples so silence
between phrases reads as visibly *empty*, not a continuous solid line.

## 6. Browser path

`frontend/visualizer-engine.js` + `visualizer.html` consume the same
`LiveState` snapshot via WebSocket. They are a **secondary view** kept
for browser/remote use. Visual parity with the native renderer is
desirable but not required; the native renderer is the canonical
implementation.

---

# 🧪 Validation Checklist

Before completing any task, verify:

* [ ] The pitch contour is readable as a scrolling line
* [ ] Vibrato shows up as natural undulation when sustained vocal
      audio with vibrato is played (e.g. a Kaas track)
* [ ] The plume sits at the right edge and tracks the current note
* [ ] Chest-voice notes are warm/amber; head-voice notes shift cooler
* [ ] Unvoiced gaps produce visible empty regions in the trail
* [ ] No white blowout on overlap (additive blend stays under control)
* [ ] Negative space dominates — the scene is not "full"
* [ ] `python app.py` still launches without import or shader errors

---

# 🚫 Failure Modes to Avoid

* Reintroducing rings, particles, or spine systems
* Drawing the filament as a continuous solid line through silence
* Synthetic vibrato warps in the shader (vibrato must emerge from
  the sample stream itself)
* Plume drifting in a direction unrelated to instability
* Over-bright onset flashes that wash out the scene
* Heavy CPU work or allocations in `paintGL`

---

# 🧭 Guiding Principle

This is a **visual instrument for listening to a singer**, not a
generic music visualizer. Every pixel must justify itself through
musical meaning.
