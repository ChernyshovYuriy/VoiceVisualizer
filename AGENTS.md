# AGENTS.md

## Project: Voice / Music Visualizer (3D)

This project implements a **premium real-time voice/music visualizer** using Three.js.

The system is NOT a generic particle visualizer.

It is a **structured spatial representation of sound** with strict visual rules:

* Pitch → vertical position
* Loudness → horizontal/radial expansion (rings)

---

# 🔴 Core Principle (Non-Negotiable)

The visual must communicate:

* WHERE the sound is → vertical (pitch)
* HOW strong it is → horizontal spread (rings)

If this mapping is not visually obvious, the implementation is incorrect.

---

# 🧱 Rendering Architecture

The scene must be built from explicit systems.

## Allowed Systems

* BackgroundSystem
* PitchBandSystem
* RingSystem
* AxisSystem (subtle reference only)
* CameraSystem
* (Later) AudioMappingSystem

## Forbidden Systems (must NOT exist or render)

* Spine mesh
* Ribbon systems
* Particle clouds
* Nebula planes
* Random noise fields
* “Decorative” geometry not tied to data

If any of the above appear, the result is invalid.

---

# 🎯 Visual Composition Rules

## 1. Scene Philosophy

* Minimal
* Structured
* Cinematic
* Data-driven

NOT:

* noisy
* chaotic
* effect-heavy
* “cool demo”

---

## 2. Background

* Deep navy-black (NOT pure black)
* Subtle gradient allowed
* No visible textures or noise

---

## 3. Pitch Bands (Vertical Structure)

* 6–8 horizontal zones
* Soft transitions (no hard lines)
* Very subtle visibility
* Used as spatial reference only

### Color progression (bottom → top):

* Deep crimson / wine (low)
* Burnt orange / amber (mid)
* Gold / warm yellow (upper-mid)
* Muted jade / cyan-blue (high)

❗ Never use pure RGB colors or rainbow gradients

---

## 4. Rings (Primary Visual Element)

Rings represent loudness.

### Behavior:

* Position (Y) = pitch
* Radius = loudness
* Thickness = energy stability
* Brightness = energy + onset

### Appearance:

* Not flat lines
* Must have thickness and gradient profile

Each ring must include:

* Inner edge → brighter, sharper
* Mid body → main color
* Outer edge → soft fade

### Shape:

* Slight ellipse (perspective)
* Subtle organic deformation allowed
* NEVER perfect mathematically rigid circles

---

## 5. Ring Motion (when enabled later)

* Expand outward with easing (fast → slow)
* Fade gradually (not abrupt)
* Leave faint echo trail

---

## 6. Layering

Each sound event should produce:

* Main ring
* Faint inner ring
* Faint outer echo ring

All slightly offset in time.

---

## 7. Overlap Rules

When multiple rings overlap:

* Do NOT allow white blowout
* Clamp brightness
* Preserve readability

---

## 8. Axis (Center)

* Optional, very subtle
* Must NOT look like a hard white line
* Should feel like soft reference, not geometry

---

## 9. Lighting & Bloom

* Bloom must be minimal and controlled
* Scene must look correct with bloom OFF
* Bloom enhances — never defines the shape

---

## 10. Negative Space

Large empty space is REQUIRED.

If the scene feels “full” → it is wrong.

---

# 🎨 Color System (Critical)

Avoid:

* neon
* pure red/green/blue
* high saturation everywhere

Prefer:

* amber
* gold
* copper
* jade
* cyan-blue (desaturated)

Use layered tones, not flat colors.

---

# ⚙️ Implementation Rules

## 1. Always prefer clarity over complexity

If a feature reduces readability → remove it.

---

## 2. No legacy carryover

Do NOT reuse old systems (spine, ribbons, particles).

Rebuild cleanly.

---

## 3. Config-driven tuning required

Expose these parameters:

* ringThickness
* ringGlow
* ringOpacity
* ringEchoCount
* bandOpacity
* axisOpacity
* bloomStrength
* cameraDistance

---

## 4. Static-first workflow

Every feature must:

1. Look correct in a paused/static frame
2. Only then be animated
3. Only then be connected to audio

---

## 5. No randomness without meaning

All motion must relate to:

* pitch
* loudness
* onset
* vibrato

No decorative randomness.

---

# 🧪 Validation Checklist

Before completing any task, verify:

* No forbidden systems are rendering
* Rings are the dominant visual element
* Pitch is readable vertically
* Loudness is readable via ring size
* No white blobs or overexposure
* Scene looks clean when paused
* Negative space is preserved

If any check fails → implementation is incorrect.

---

# 🚫 Common Failure Modes (Avoid)

* Reintroducing particle systems
* Adding glow to hide poor geometry
* Overusing bloom
* Making everything bright
* Using rainbow gradients
* Perfect geometric shapes with no life
* Trying to make it “more impressive” instead of more readable

---

# 🧭 Development Stages

## Stage 1

Static scene:

* pitch bands + rings only

## Stage 2

Ring quality:

* thickness, gradients, layering

## Stage 3

Audio mapping:

* pitch → Y
* loudness → radius

## Stage 4

Motion polish:

* easing, trails, stability

## Stage 5

Final polish:

* color tuning
* performance
* UI refinement

---

# 🧠 Guiding Principle

This is not a visual effect.

This is a **visual instrument**.

Every pixel must justify itself through meaning or refinement.

---
