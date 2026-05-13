"""
renderer.py — Smoke & Filament voice visualizer (PySide6 + OpenGL 3.3 core).

Designed for sustained legato vocal styles (chanson / contralto / mezzo —
tuned around Patricia Kaas). Two main visual elements:

  FILAMENT: a scrolling pitch contour over the last ~6 seconds. Vibrato
            is visible as natural undulation in the line. Colour along
            the trail encodes register (chest warm ↔ head cool) at the
            moment each sample was captured. Thickness ← loudness.

  PLUME:    a volumetric smoke billow anchored at the current note.
            Warmth ← inverse of spectral centroid, size ← loudness,
            drift ← inverse of stability, inner pulse ← onset transients.

Public API (kept compatible with main_window.py):
    from ui.renderer import RingWidget
    self._ring_widget = RingWidget(self._live, parent=root)

Mouse: left-drag orbit, wheel zoom.
"""
from __future__ import annotations
import math, ctypes, time as _t
from collections import deque
from typing import TYPE_CHECKING
import numpy as np
from PySide6.QtCore import Qt, QTimer, QPoint
from PySide6.QtGui import QSurfaceFormat, QMouseEvent, QWheelEvent
from PySide6.QtOpenGLWidgets import QOpenGLWidget
import OpenGL.GL as GL

if TYPE_CHECKING:
    from core.live_state import LiveState


# ── tuning ──────────────────────────────────────────────────────────────────

TRAIL_SECONDS    = 6.0
TRAIL_MAX_POINTS = 360            # ring buffer cap

X_LEFT, X_RIGHT  = -8.4,  7.2     # filament spans this X range — wider
Y_MIN,  Y_MAX    = -3.6,  3.6     # pitch field

FILAMENT_BASE_W  = 0.045
FILAMENT_MAX_W   = 0.220
# Vibrato amplification — per-sample perpendicular wiggle proportional to
# pitch derivative. Honest amplification of existing modulation; zero when
# pitch is steady.
FILAMENT_WIGGLE_GAIN = 0.32

PLUME_BASE_R     = 0.70
PLUME_MAX_R      = 2.10

# Chanson palette — chest (warm/dark) to head (cool/bright)
PALETTE = [
    (0.00, (0.46, 0.11, 0.13)),   # deep wine
    (0.22, (0.62, 0.22, 0.14)),   # burnt orange
    (0.45, (0.78, 0.46, 0.20)),   # amber
    (0.65, (0.85, 0.66, 0.34)),   # warm gold
    (0.82, (0.50, 0.56, 0.50)),   # muted jade
    (1.00, (0.42, 0.54, 0.66)),   # desaturated pewter
]

CHEST_TINT = (0.78, 0.38, 0.16)   # pull-target when centroid is low


# ── shaders ─────────────────────────────────────────────────────────────────

_BG_VERT = """\
#version 330 core
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
    vUv = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.9999, 1.0);
}
"""

_BG_FRAG = """\
#version 330 core
in  vec2 vUv;
out vec4 fragColor;
uniform float uAspect;       // width / height
uniform float uTime;

// Cheap hash for film grain
float hash21(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p.yx + 19.19);
    return fract((p.x + p.y) * p.x);
}

void main() {
    // Vertical sky gradient — midnight, slightly lifted in the middle
    vec3 dark = vec3(0.008, 0.014, 0.024);
    vec3 mid  = vec3(0.020, 0.030, 0.052);
    vec3 sky  = mix(dark, mid, smoothstep(0.0, 0.7, vUv.y));

    // Stage glow from below-LEFT (warm ember) — kept clear of plume on right
    vec2 p = vec2((vUv.x - 0.20) * uAspect, vUv.y - (-0.20));
    float d = length(p) * 1.6;
    float glow = exp(-d * 2.2) * 0.55;
    glow *= smoothstep(0.50, 0.0, vUv.y);   // bottom-half only
    glow *= smoothstep(1.05, 0.55, vUv.x);  // fade out toward right edge

    vec3 stage = vec3(0.42, 0.18, 0.10) * glow;

    vec3 col = sky + stage;

    // Film grain — temporally animated, subtle, slightly amplified in shadows
    float g = hash21(vUv * vec2(1920.0, 1080.0) + fract(uTime * 17.0));
    float grain = (g - 0.5) * 0.028;
    // Bias toward shadows (more grain where colour is darker — feels filmic)
    float shadowLift = 1.0 - smoothstep(0.0, 0.15, length(col));
    col += grain * (0.6 + 0.7 * shadowLift);

    fragColor = vec4(col, 1.0);
}
"""

# Filament: triangle strip in (x,y,z) world space + per-vertex colour + alpha
# + cross-ribbon coordinate (-1..1) for gaussian falloff across the ribbon width.
_FIL_VERT = """\
#version 330 core
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aCol;
layout(location=2) in float aAlpha;
layout(location=3) in float aCross;   // -1 (bottom edge) .. +1 (top edge)
uniform mat4 uMVP;
out vec3 vCol;
out float vAlpha;
out float vCross;
void main() {
    vCol   = aCol;
    vAlpha = aAlpha;
    vCross = aCross;
    gl_Position = uMVP * vec4(aPos, 1.0);
}
"""

# Core fragment: thin bright stroke with hard centerline.
_FIL_FRAG_CORE = """\
#version 330 core
in vec3 vCol;
in float vAlpha;
in float vCross;
out vec4 fragColor;
void main() {
    if (vAlpha < 0.002) discard;
    // Tight gaussian across the ribbon → bright thin line
    float a = exp(-vCross * vCross * 3.5) * vAlpha;
    fragColor = vec4(vCol, a);
}
"""

# Halo fragment: wide soft bloom around the line — this is what makes it
# read as glowing light instead of a flat stroke.
_FIL_FRAG_HALO = """\
#version 330 core
in vec3 vCol;
in float vAlpha;
in float vCross;
out vec4 fragColor;
void main() {
    if (vAlpha < 0.002) discard;
    // Loose gaussian → wide soft bloom
    float a = exp(-vCross * vCross * 0.9) * vAlpha * 0.55;
    // Halo colour is warm-shifted and slightly desaturated toward orange
    vec3 c = mix(vCol, vec3(0.85, 0.45, 0.20), 0.20) * 0.85;
    fragColor = vec4(c, a);
}
"""

# Plume: full-quad shader with multi-octave value noise + radial falloff.
_PLUME_VERT = """\
#version 330 core
layout(location=0) in vec2 aPos;
out vec2 vUv;
uniform mat4 uMVP;
uniform vec3 uCenter;
uniform float uScale;
void main() {
    vUv = aPos;                          // -1..1
    vec3 wp = uCenter + vec3(aPos.x * uScale, aPos.y * uScale, 0.0);
    gl_Position = uMVP * vec4(wp, 1.0);
}
"""

_PLUME_FRAG = """\
#version 330 core
in  vec2 vUv;
out vec4 fragColor;

uniform vec3  uColor;
uniform vec3  uInner;
uniform float uTime;
uniform float uDrift;     // 0 still ↔ 1 turbulent
uniform float uFlash;     // onset core flash 0..1
uniform float uWarm;      // 0 cool head ↔ 1 warm chest
uniform float uOpacity;
uniform float uShapeR;    // outer falloff radius (in uv units, ~1.0)

float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) {
        v += a * noise(p);
        p *= 2.07;
        a *= 0.5;
    }
    return v;
}

void main() {
    // Vertical elongation: smoke is taller than wide. We sample noise in a
    // squished coordinate so wisps stretch vertically and the silhouette is
    // not a symmetric blob.
    vec2 uv = vUv;
    vec2 stretchUv = vec2(uv.x * 1.45, uv.y * 0.85);

    // Slow upward breath drift + horizontal sway
    vec2 nuv = stretchUv * 1.3;
    nuv.y += uTime * 0.16;
    nuv.x += sin(uTime * 0.35) * 0.18;
    nuv += vec2(uTime * 0.05, uTime * 0.07) * uDrift;

    // Domain-warped fbm — fbm coordinates are perturbed by another fbm.
    // This is the single biggest "smoke vs glow-ball" difference: warping
    // creates curling wisps and tendrils instead of symmetric blobs.
    vec2 q = vec2(fbm(nuv + vec2(0.0, 0.0)),
                  fbm(nuv + vec2(5.2, 1.3)));
    vec2 r2 = vec2(fbm(nuv + 3.5 * q + vec2(1.7, 9.2) + uTime * 0.04),
                   fbm(nuv + 3.5 * q + vec2(8.3, 2.8) - uTime * 0.05));
    float n = fbm(nuv + 4.0 * r2);

    // Stronger contrast on the noise so wisps are visible, not mush.
    n = smoothstep(0.30, 0.85, n);
    n = mix(0.45, n, 0.50 + uDrift * 0.50);

    // Radial falloff — vertically elongated (smoke rises) and biased upward.
    // We push the centre of the radial falloff slightly downward so density
    // is asymmetric: more substance below, wispy tail above.
    vec2 fuv = vec2(uv.x * 1.10, (uv.y + 0.08) * 0.78);
    float r = length(fuv) / max(0.5, uShapeR);
    float radial = exp(-r * r * 1.7);

    // Upward wispiness: extra density along an upward streak from centre
    float upStreak = exp(-pow(uv.x, 2.0) * 4.0) *
                     exp(-pow(max(0.0, -uv.y - 0.1), 2.0) * 1.8) *
                     n * 0.55;

    // Hard-clip at quad boundary regardless of noise
    float edgeKill = smoothstep(1.0, 0.55, length(uv));
    float dens = (radial * n + upStreak) * edgeKill;

    // Inner bright core — tighter, brighter
    float core = exp(-r * r * 10.0);
    float innerPulse = core * (0.45 + uFlash * 0.55);

    // Cool tint when head voice (uWarm low)
    vec3 cool  = vec3(0.32, 0.42, 0.55);
    vec3 outer = mix(cool * 0.7, uColor, uWarm);

    vec3 col = mix(outer, uInner, innerPulse);
    float a  = clamp(dens, 0.0, 1.0) * uOpacity * 0.62 + innerPulse * uOpacity * 0.42;

    if (a < 0.002) discard;
    fragColor = vec4(col, a);
}
"""


# ── helpers ─────────────────────────────────────────────────────────────────

_LLO = math.log(65.4)
_LR  = math.log(2093.0) - _LLO

def _hz_norm(hz: float) -> float:
    if hz <= 40.0:
        return 0.5
    return max(0.0, min(1.0, (math.log(max(65.4, hz)) - _LLO) / _LR))

def _pitch_to_y(hz: float) -> float:
    return Y_MIN + (Y_MAX - Y_MIN) * _hz_norm(hz)

def _lp(a, b, t):     return a + (b - a) * t
def _lp3(a, b, t):    return (a[0] + (b[0] - a[0]) * t,
                              a[1] + (b[1] - a[1]) * t,
                              a[2] + (b[2] - a[2]) * t)
def _clamp(v, lo, hi): return max(lo, min(hi, v))

def _palette(t: float):
    t = _clamp(t, 0.0, 1.0)
    for i in range(len(PALETTE) - 1):
        t0, c0 = PALETTE[i]; t1, c1 = PALETTE[i + 1]
        if t0 <= t <= t1:
            f = (t - t0) / (t1 - t0)
            return (c0[0] + f * (c1[0] - c0[0]),
                    c0[1] + f * (c1[1] - c0[1]),
                    c0[2] + f * (c1[2] - c0[2]))
    return PALETTE[-1][1]


# ── matrix math ─────────────────────────────────────────────────────────────
# Convention: row-major numpy, P @ V @ M, uploaded with transpose=True.

def _perspective(fov_deg, aspect, near, far):
    t = math.tan(math.radians(fov_deg) / 2)
    return np.array([
        [1/(aspect*t), 0,    0,                      0],
        [0,            1/t,  0,                      0],
        [0,            0,   -(far+near)/(far-near),  -2*far*near/(far-near)],
        [0,            0,   -1,                      0],
    ], dtype=np.float32)

def _look_at(eye, ctr, up):
    eye = np.array(eye, np.float32)
    ctr = np.array(ctr, np.float32)
    up  = np.array(up,  np.float32)
    f = ctr - eye;  f /= np.linalg.norm(f)
    r = np.cross(f, up); r /= np.linalg.norm(r)
    u = np.cross(r, f)
    R = np.array([[r[0], r[1], r[2], 0],
                  [u[0], u[1], u[2], 0],
                  [-f[0], -f[1], -f[2], 0],
                  [0, 0, 0, 1]], np.float32)
    T = np.array([[1, 0, 0, -eye[0]],
                  [0, 1, 0, -eye[1]],
                  [0, 0, 1, -eye[2]],
                  [0, 0, 0, 1]], np.float32)
    return R @ T


# ── GL helpers ──────────────────────────────────────────────────────────────

def _shader(src, kind):
    s = GL.glCreateShader(kind)
    GL.glShaderSource(s, src)
    GL.glCompileShader(s)
    if not GL.glGetShaderiv(s, GL.GL_COMPILE_STATUS):
        raise RuntimeError(GL.glGetShaderInfoLog(s).decode())
    return s

def _program(vs, fs):
    p = GL.glCreateProgram()
    v = _shader(vs, GL.GL_VERTEX_SHADER)
    f = _shader(fs, GL.GL_FRAGMENT_SHADER)
    GL.glAttachShader(p, v); GL.glAttachShader(p, f)
    GL.glLinkProgram(p)
    if not GL.glGetProgramiv(p, GL.GL_LINK_STATUS):
        raise RuntimeError(GL.glGetProgramInfoLog(p).decode())
    GL.glDeleteShader(v); GL.glDeleteShader(f)
    return p

def _ul(p, name): return GL.glGetUniformLocation(p, name)

def _make_quad_vao():
    """Fullscreen NDC quad with vec2 positions."""
    q = np.array([-1, -1,  1, -1,  1,  1,
                  -1, -1,  1,  1, -1,  1], dtype=np.float32)
    vao = GL.glGenVertexArrays(1); vbo = GL.glGenBuffers(1)
    GL.glBindVertexArray(vao)
    GL.glBindBuffer(GL.GL_ARRAY_BUFFER, vbo)
    GL.glBufferData(GL.GL_ARRAY_BUFFER, q.nbytes, q, GL.GL_STATIC_DRAW)
    GL.glEnableVertexAttribArray(0)
    GL.glVertexAttribPointer(0, 2, GL.GL_FLOAT, False, 0, None)
    GL.glBindVertexArray(0)
    return vao


# ── filament ────────────────────────────────────────────────────────────────

class _Filament:
    """
    Ring buffer of pitch samples + GPU triangle strip rebuilt each paint.
    Each sample contributes 2 vertices (top + bottom of a 2D ribbon in XY).
    Per-vertex attributes: position(3), color(3), alpha(1).
    """
    STRIDE = (3 + 3 + 1) * 4   # bytes per vertex

    def __init__(self, capacity: int):
        self._cap = capacity
        # Each sample: (t, y, thickness, r, g, b, voiced)
        self._buf: deque = deque(maxlen=capacity)
        self._last_frame_id = -1

        # Pre-allocate CPU buffers for max vertex count
        nverts = capacity * 2
        self._pos   = np.zeros(nverts * 3, dtype=np.float32)
        self._col   = np.zeros(nverts * 3, dtype=np.float32)
        self._alpha = np.zeros(nverts,     dtype=np.float32)
        # Per-vertex cross-ribbon coordinate: -1 for bottom, +1 for top.
        # Static across frames, so set once.
        self._cross = np.empty(nverts, dtype=np.float32)
        self._cross[0::2] = 1.0    # top vertex of each pair
        self._cross[1::2] = -1.0   # bottom vertex of each pair

        # Index buffer — strip-like triangulation
        nsegs = capacity - 1
        idx = np.empty(nsegs * 6, dtype=np.uint32)
        for i in range(nsegs):
            a = i * 2
            o = i * 6
            idx[o:o+6] = (a, a+1, a+2, a+1, a+3, a+2)
        self._idx_cpu = idx

        # GL handles — created in init_gl()
        self.vao = self.vbo_pos = self.vbo_col = self.vbo_a = self.vbo_x = self.ebo = 0

    # ---- GL lifecycle ------------------------------------------------------

    def init_gl(self):
        self.vao = GL.glGenVertexArrays(1)
        GL.glBindVertexArray(self.vao)

        self.vbo_pos = GL.glGenBuffers(1)
        GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self.vbo_pos)
        GL.glBufferData(GL.GL_ARRAY_BUFFER, self._pos.nbytes, None, GL.GL_DYNAMIC_DRAW)
        GL.glEnableVertexAttribArray(0)
        GL.glVertexAttribPointer(0, 3, GL.GL_FLOAT, False, 0, None)

        self.vbo_col = GL.glGenBuffers(1)
        GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self.vbo_col)
        GL.glBufferData(GL.GL_ARRAY_BUFFER, self._col.nbytes, None, GL.GL_DYNAMIC_DRAW)
        GL.glEnableVertexAttribArray(1)
        GL.glVertexAttribPointer(1, 3, GL.GL_FLOAT, False, 0, None)

        self.vbo_a = GL.glGenBuffers(1)
        GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self.vbo_a)
        GL.glBufferData(GL.GL_ARRAY_BUFFER, self._alpha.nbytes, None, GL.GL_DYNAMIC_DRAW)
        GL.glEnableVertexAttribArray(2)
        GL.glVertexAttribPointer(2, 1, GL.GL_FLOAT, False, 0, None)

        # Cross-ribbon coordinate — static, uploaded once
        self.vbo_x = GL.glGenBuffers(1)
        GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self.vbo_x)
        GL.glBufferData(GL.GL_ARRAY_BUFFER, self._cross.nbytes,
                        self._cross, GL.GL_STATIC_DRAW)
        GL.glEnableVertexAttribArray(3)
        GL.glVertexAttribPointer(3, 1, GL.GL_FLOAT, False, 0, None)

        self.ebo = GL.glGenBuffers(1)
        GL.glBindBuffer(GL.GL_ELEMENT_ARRAY_BUFFER, self.ebo)
        GL.glBufferData(GL.GL_ELEMENT_ARRAY_BUFFER, self._idx_cpu.nbytes,
                        self._idx_cpu, GL.GL_STATIC_DRAW)

        GL.glBindVertexArray(0)

    # ---- sample ingestion --------------------------------------------------

    def ingest(self, snap: dict, t_now: float) -> None:
        """Append a sample only if a new analysis frame has arrived."""
        fid = int(snap.get("frameId", 0))
        if fid == self._last_frame_id:
            return
        self._last_frame_id = fid

        pitch = float(snap.get("pitch", 0.0))
        conf  = float(snap.get("pitchConf", 0.0))
        voiced = (pitch > 40.0) and (conf > 0.10)

        loud  = float(snap.get("loudness", -80.0))
        cent  = float(snap.get("centroid", 900.0))
        # Sensitive in -45..-15 dB range typical of preprocessed vocal stems
        loud_n = _clamp((loud + 45.0) / 30.0, 0.0, 1.0)
        # Mild perceptual curve so louds don't saturate too fast
        loud_n = pow(loud_n, 0.85)
        cent_n = _clamp((cent - 250.0) / 3600.0, 0.0, 1.0)

        # Sample colour: pitch palette pulled toward chest tint when dark.
        # Reduced pull strength (was 0.55*0.55=~0.30; now ~0.18) so the
        # full chest→head palette is visibly traversed.
        pn   = _hz_norm(pitch if voiced else 220.0)
        pcol = _palette(pn)
        chest_pull = (1.0 - cent_n) * 0.30
        col = _lp3(pcol, CHEST_TINT, chest_pull)
        # Slight saturation lift so amber doesn't read as brown on-screen
        col = (min(col[0] * 1.08, 1.0),
               min(col[1] * 1.02, 1.0),
               min(col[2] * 0.98, 1.0))

        # Thickness from loudness
        thick = FILAMENT_BASE_W + (FILAMENT_MAX_W - FILAMENT_BASE_W) * loud_n

        y = _pitch_to_y(pitch if voiced else 220.0)
        self._buf.append((t_now, y, thick, col[0], col[1], col[2], 1.0 if voiced else 0.0))

    # ---- per-frame geometry rebuild ---------------------------------------

    def build_and_upload(self, t_now: float, spill: float = 0.0,
                         spill_col: tuple = (1.0, 0.7, 0.4)) -> int:
        """Returns number of indices to draw (0 if nothing).

        spill: 0..1 brightness of light spill from the plume onto the
               rightmost trail samples. Affects roughly the last 20% of
               the trail.
        spill_col: warm tint of the spill.
        """
        buf = self._buf
        n = len(buf)
        if n < 2:
            return 0

        # Window to samples within trailSeconds
        t_oldest_allowed = t_now - TRAIL_SECONDS
        # Find first sample within window (deque indexing is O(n) but n<=cap)
        items = list(buf)
        start = 0
        for i, s in enumerate(items):
            if s[0] >= t_oldest_allowed:
                start = i; break
        else:
            start = len(items) - 1
        used = n - start
        if used < 2:
            return 0

        t_new = items[-1][0]
        t_old = items[start][0]
        t_span = max(0.05, t_new - t_old)

        pos = self._pos; col = self._col; a = self._alpha

        # Pre-compute a smoothed Y track so we can extract the per-sample
        # deviation (= vibrato component) and amplify it visually. This is
        # honest amplification of existing modulation: amp ∝ (y - smoothed_y).
        # When the singer holds a perfectly steady note the deviation is zero
        # and no wiggle is added.
        ys = [items[start + i][1] for i in range(used)]
        voiceds = [items[start + i][6] > 0.5 for i in range(used)]
        win = 5
        smoothed = [0.0] * used
        for i in range(used):
            lo = max(0, i - win); hi = min(used, i + win + 1)
            smoothed[i] = sum(ys[lo:hi]) / (hi - lo)

        # Jump-gap weights: when consecutive samples have a large Y gap or
        # cross a voiced↔unvoiced boundary, fade the alpha at that sample
        # toward zero so the ribbon visibly *breaks* instead of drawing a
        # vertical zig-zag. Eye reads breaks as phrasing, zig-zags as bugs.
        JUMP_THRESHOLD = 0.55   # world units of Y change to consider a jump
        gap_w = [1.0] * used
        for i in range(used):
            d_prev = abs(ys[i] - ys[i - 1]) if i > 0 else 0.0
            d_next = abs(ys[i + 1] - ys[i]) if i < used - 1 else 0.0
            d = max(d_prev, d_next)
            if d > JUMP_THRESHOLD:
                # smooth fade: zero at d=1.2, full at d=0.55
                gap_w[i] = max(0.0, 1.0 - (d - JUMP_THRESHOLD) / 0.65)
            # Also fade samples that border an unvoiced neighbour
            if i > 0 and voiceds[i] != voiceds[i - 1]:
                gap_w[i] *= 0.35
            if i < used - 1 and voiceds[i] != voiceds[i + 1]:
                gap_w[i] *= 0.35

        sr, sg, sb = spill_col

        for i in range(used):
            t, y, thick, r, g, b, voiced = items[start + i]
            tfrac = (t - t_old) / t_span         # 0 oldest .. 1 newest
            x = X_LEFT + (X_RIGHT - X_LEFT) * tfrac

            # Vibrato amplification: deviation from local mean, gained up.
            # Bounded so wide pitch leaps don't get exploded.
            dev = y - smoothed[i]
            dev = max(-0.35, min(0.35, dev))
            y_vis = y + dev * FILAMENT_WIGGLE_GAIN * (1.0 if voiced > 0.5 else 0.0)

            # Age weighting: thicker/brighter near "now"
            age_fade  = pow(tfrac, 0.55)
            head_fade = 1.0 - pow(1.0 - tfrac, 6.0)
            # Voiced gating — unvoiced regions collapse to near-zero width
            vw = 1.0 if voiced > 0.5 else 0.12
            half = 0.5 * thick * vw * age_fade * (0.4 + 0.6 * head_fade)

            top_y = y_vis + half
            bot_y = y_vis - half

            o = i * 2
            # vertices: top, bottom
            pos[o*3+0] = x;  pos[o*3+1] = top_y; pos[o*3+2] = 0.0
            pos[(o+1)*3+0] = x;  pos[(o+1)*3+1] = bot_y; pos[(o+1)*3+2] = 0.0

            # Brighten the leading 8% of the trail
            head_boost = 1.0 + pow(_clamp((tfrac - 0.92) / 0.08, 0.0, 1.0), 1.2) * 0.55
            cr = r * head_boost
            cg = g * head_boost
            cb = b * head_boost

            # Light spill from the plume — brightens roughly the last 20% of
            # the trail, tinted toward the plume's warm core. Strongest at
            # the head and falls off quickly going left.
            if spill > 0.001:
                spill_w = pow(_clamp((tfrac - 0.78) / 0.22, 0.0, 1.0), 1.4) * spill
                cr += sr * spill_w * 0.45
                cg += sg * spill_w * 0.45
                cb += sb * spill_w * 0.45

            cr = min(cr, 1.5)
            cg = min(cg, 1.5)
            cb = min(cb, 1.5)
            col[o*3+0]   = cr; col[o*3+1]   = cg; col[o*3+2]   = cb
            col[(o+1)*3+0] = cr; col[(o+1)*3+1] = cg; col[(o+1)*3+2] = cb

            av = (0.95 if voiced > 0.5 else 0.10) * age_fade * gap_w[i]
            a[o]   = av
            a[o+1] = av

        # Upload sub-ranges
        nverts = used * 2
        GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self.vbo_pos)
        GL.glBufferSubData(GL.GL_ARRAY_BUFFER, 0, nverts * 3 * 4, pos[:nverts * 3])
        GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self.vbo_col)
        GL.glBufferSubData(GL.GL_ARRAY_BUFFER, 0, nverts * 3 * 4, col[:nverts * 3])
        GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self.vbo_a)
        GL.glBufferSubData(GL.GL_ARRAY_BUFFER, 0, nverts * 4, a[:nverts])

        return (used - 1) * 6


# ── feature smoother for the plume ──────────────────────────────────────────

class _Smoother:
    """Smoothed display state for the plume (current note)."""
    G = 0.20   # min confidence to be 'voiced'

    def __init__(self):
        self.pn = 0.5
        self.ln = 0.0
        self.en = 0.0
        self.c  = 0.0      # smoothed pitch confidence (stability)
        self.cn = 0.25     # centroid norm
        self.tr = 0.0      # transient flash
        self.dy = 0.0      # display Y
        self._n = ""

    def tick(self, s: dict, dt: float) -> None:
        p   = float(s.get("pitch", 0.0))
        lo  = float(s.get("loudness", -80.0))
        e   = float(s.get("energy", 0.0))
        rc  = float(s.get("pitchConf", 0.0))
        cent = float(s.get("centroid", 900.0))
        on  = float(s.get("onset", 0.0))
        oh  = s.get("onsetHist", [])
        n   = s.get("note", "—")

        ok = p > 40 and rc >= self.G
        c  = rc if ok else 0.0

        if ok:
            self.pn = _lp(self.pn, _hz_norm(p), 0.20)
        self.c  = _lp(self.c,  c,  0.18)
        self.ln = _lp(self.ln, _clamp((lo + 58.0) / 38.0, 0.0, 1.0), 0.22)
        self.en = _lp(self.en, _clamp(e, 0.0, 1.0), 0.28)
        self.cn = _lp(self.cn, _clamp((cent - 250.0) / 3600.0, 0.0, 1.0), 0.18)

        ho = (sum(oh) / len(oh)) if oh else on
        if on > 0.28:
            self.tr = max(self.tr, on * 0.7)
        if n != "—" and n != self._n:
            self.tr = max(self.tr, 0.8); self._n = n
        self.tr = max(0.0, self.tr - dt * 14.0)

        # Y eases up fast on attack, releases slowly (chanson sustain)
        ty = _lp(Y_MIN, Y_MAX, self.pn) if ok else 0.0
        y_alpha = 0.45 if ty > self.dy else 0.08
        self.dy = _lp(self.dy, ty, y_alpha)

    def state(self) -> dict:
        return {
            "active": self.c > 0.08,
            "y":      self.dy,
            "pn":     self.pn,
            "loud":   self.ln,
            "stab":   self.c,
            "warm":   1.0 - self.cn,     # 0 cool ↔ 1 warm
            "flash":  _clamp(self.tr, 0.0, 1.0),
        }


# ── widget ──────────────────────────────────────────────────────────────────

class RingWidget(QOpenGLWidget):
    """
    Public name retained for main_window.py compatibility. The visual is
    now Smoke & Filament, not rings.
    """

    def __init__(self, live_state: "LiveState", parent=None):
        fmt = QSurfaceFormat()
        fmt.setVersion(3, 3)
        fmt.setProfile(QSurfaceFormat.OpenGLContextProfile.CoreProfile)
        fmt.setSamples(4)
        fmt.setDepthBufferSize(24)
        QSurfaceFormat.setDefaultFormat(fmt)
        super().__init__(parent)

        self._live = live_state
        self._sm   = _Smoother()
        self._fil  = _Filament(TRAIL_MAX_POINTS)

        # Smoothed plume display state
        self._plume_y     = 0.0
        self._plume_size  = 0.6
        self._plume_drift = 0.5
        self._plume_warm  = 0.7
        self._plume_flash = 0.0
        self._plume_color = (0.78, 0.46, 0.20)
        self._plume_inner = (0.95, 0.78, 0.55)

        # Camera orbit — gentle stage perspective, closer in
        self._yaw   = -4.0     # tiny side angle for depth
        self._pitch = 3.0
        self._dist  = 9.0
        self._mp: QPoint | None = None

        # Wall-clock timeline for the filament
        self._t0   = _t.perf_counter()
        self._lt   = None

        QTimer(self, interval=16, timeout=self.update).start()

    # ---- input -------------------------------------------------------------

    def mousePressEvent(self, e: QMouseEvent):
        if e.button() == Qt.LeftButton:
            self._mp = e.position().toPoint()

    def mouseReleaseEvent(self, e: QMouseEvent):
        self._mp = None

    def mouseMoveEvent(self, e: QMouseEvent):
        if self._mp is None: return
        self._yaw   += (e.position().x() - self._mp.x()) * 0.35
        self._pitch  = _clamp(self._pitch + (e.position().y() - self._mp.y()) * 0.35, -60.0, 60.0)
        self._mp = e.position().toPoint()

    def wheelEvent(self, e: QWheelEvent):
        self._dist = _clamp(self._dist - e.angleDelta().y() / 120.0 * 0.6, 5.0, 22.0)

    # ---- GL ---------------------------------------------------------------

    def initializeGL(self):
        try:
            self._bg_prog    = _program(_BG_VERT,    _BG_FRAG)
            self._fil_core   = _program(_FIL_VERT,   _FIL_FRAG_CORE)
            self._fil_halo   = _program(_FIL_VERT,   _FIL_FRAG_HALO)
            self._plume_prog = _program(_PLUME_VERT, _PLUME_FRAG)

            self._quad_vao = _make_quad_vao()
            self._fil.init_gl()

            GL.glEnable(GL.GL_BLEND)
            try:
                GL.glEnable(GL.GL_MULTISAMPLE)
            except Exception:
                pass
            print("[renderer] Smoke & Filament OK —",
                  GL.glGetString(GL.GL_RENDERER).decode())
        except Exception as exc:
            print(f"[renderer] FAILED: {exc}")
            self._bg_prog = 0

    def resizeGL(self, w, h):
        GL.glViewport(0, 0, w, h)

    def paintGL(self):
        if not getattr(self, "_bg_prog", 0):
            return

        # Time bookkeeping
        now = _t.perf_counter()
        dt = min((now - self._lt) if self._lt else 0.016, 0.05)
        self._lt = now
        t_world = now - self._t0

        snap = self._live.snapshot()
        self._sm.tick(snap, dt)
        self._fil.ingest(snap, t_world)
        lv = self._sm.state()

        # Camera matrices
        w = self.width(); h = max(self.height(), 1)
        aspect = w / h
        yaw = math.radians(self._yaw)
        pit = math.radians(self._pitch)
        d   = self._dist
        eye = np.array([
            d * math.cos(pit) * math.sin(yaw),
            d * math.sin(pit) * 0.4,            # mostly horizontal — chanson stage feel
            d * math.cos(pit) * math.cos(yaw),
        ], np.float32)
        P  = _perspective(40.0, aspect, 0.1, 100.0)
        V  = _look_at(eye, [0.0, 0.0, 0.0], [0, 1, 0])
        VP = (P @ V).astype(np.float32)

        # ── Background — disable depth, draw fullscreen quad
        GL.glDisable(GL.GL_DEPTH_TEST)
        GL.glDepthMask(False)
        GL.glBlendFunc(GL.GL_SRC_ALPHA, GL.GL_ONE_MINUS_SRC_ALPHA)
        GL.glClearColor(0.008, 0.014, 0.024, 1.0)
        GL.glClear(GL.GL_COLOR_BUFFER_BIT | GL.GL_DEPTH_BUFFER_BIT)
        GL.glUseProgram(self._bg_prog)
        GL.glUniform1f(_ul(self._bg_prog, "uAspect"), aspect)
        GL.glUniform1f(_ul(self._bg_prog, "uTime"),   t_world)
        GL.glBindVertexArray(self._quad_vao)
        GL.glDrawArrays(GL.GL_TRIANGLES, 0, 6)

        # ── Smooth plume state FIRST (filament needs current spill colour)
        active = lv["active"]
        target_size = (PLUME_BASE_R + lv["loud"] * (PLUME_MAX_R - PLUME_BASE_R)) if active else 0.45
        target_drift = (1.0 - lv["stab"]) if active else 0.8
        target_warm  = lv["warm"] if active else 0.5
        target_flash = lv["flash"] if active else 0.0

        self._plume_size  = _lp(self._plume_size,  target_size,  0.18 if active else 0.06)
        self._plume_drift = _lp(self._plume_drift, target_drift, 0.10)
        self._plume_warm  = _lp(self._plume_warm,  target_warm,  0.12)
        self._plume_flash = _lp(self._plume_flash, target_flash, 0.40)

        pcol = _palette(lv["pn"])
        chest_pull = self._plume_warm * 0.5
        target_col = _lp3(pcol, CHEST_TINT, chest_pull * 0.5)
        self._plume_color = _lp3(self._plume_color, target_col, 0.18)

        # Inner core colour: warmer-bright in chest, cooler in head
        inner_target = (
            _lp(0.78, 1.00, self._plume_warm),
            _lp(0.72, 0.85, self._plume_warm),
            _lp(0.70, 0.55, self._plume_warm),
        )
        self._plume_inner = _lp3(self._plume_inner, inner_target, 0.20)

        plume_y = self._sm.dy
        opacity = 0.95 if active else 0.25

        # ── Filament — build with light spill from plume, then two-pass draw
        GL.glBlendFunc(GL.GL_SRC_ALPHA, GL.GL_ONE)

        # Spill intensity: scaled by loudness × warmth × active, smoothed via
        # the same plume state we just updated.
        spill = 0.0
        if active:
            spill = _clamp(lv["loud"] * (0.55 + 0.45 * self._plume_warm), 0.0, 1.0)
        idx_count = self._fil.build_and_upload(
            t_world, spill=spill, spill_col=self._plume_inner)

        if idx_count > 0:
            GL.glBindVertexArray(self._fil.vao)
            # Halo pass first (wider soft bloom)
            GL.glUseProgram(self._fil_halo)
            GL.glUniformMatrix4fv(_ul(self._fil_halo, "uMVP"), 1, True, VP.flatten())
            GL.glDrawElements(GL.GL_TRIANGLES, idx_count, GL.GL_UNSIGNED_INT, None)
            # Core pass — bright tight line on top
            GL.glUseProgram(self._fil_core)
            GL.glUniformMatrix4fv(_ul(self._fil_core, "uMVP"), 1, True, VP.flatten())
            GL.glDrawElements(GL.GL_TRIANGLES, idx_count, GL.GL_UNSIGNED_INT, None)

        GL.glUseProgram(self._plume_prog)
        GL.glUniformMatrix4fv(_ul(self._plume_prog, "uMVP"), 1, True, VP.flatten())
        GL.glBindVertexArray(self._quad_vao)

        # Halo (larger, dimmer, behind) — quad oversized 3x so edge is invisible
        halo_size = self._plume_size * 1.65
        halo_col  = (self._plume_color[0] * 0.50,
                     self._plume_color[1] * 0.38,
                     self._plume_color[2] * 0.28)
        GL.glUniform3f(_ul(self._plume_prog, "uCenter"), X_RIGHT, plume_y, -0.05)
        GL.glUniform1f(_ul(self._plume_prog, "uScale"),  halo_size * 3.0)
        GL.glUniform3f(_ul(self._plume_prog, "uColor"),  *halo_col)
        GL.glUniform3f(_ul(self._plume_prog, "uInner"),  *self._plume_inner)
        GL.glUniform1f(_ul(self._plume_prog, "uTime"),   t_world)
        GL.glUniform1f(_ul(self._plume_prog, "uDrift"),  self._plume_drift)
        GL.glUniform1f(_ul(self._plume_prog, "uFlash"),  0.0)
        GL.glUniform1f(_ul(self._plume_prog, "uWarm"),   self._plume_warm)
        GL.glUniform1f(_ul(self._plume_prog, "uOpacity"), opacity * 0.32)
        GL.glUniform1f(_ul(self._plume_prog, "uShapeR"), 1.0 / 3.0)
        GL.glDrawArrays(GL.GL_TRIANGLES, 0, 6)

        # Core — same trick: quad 3x visible radius, falloff compressed to inner third
        GL.glUniform3f(_ul(self._plume_prog, "uCenter"), X_RIGHT, plume_y, 0.01)
        GL.glUniform1f(_ul(self._plume_prog, "uScale"),  self._plume_size * 3.0)
        GL.glUniform3f(_ul(self._plume_prog, "uColor"),  *self._plume_color)
        GL.glUniform3f(_ul(self._plume_prog, "uInner"),  *self._plume_inner)
        GL.glUniform1f(_ul(self._plume_prog, "uTime"),   t_world)
        GL.glUniform1f(_ul(self._plume_prog, "uDrift"),  self._plume_drift)
        GL.glUniform1f(_ul(self._plume_prog, "uFlash"),  self._plume_flash)
        GL.glUniform1f(_ul(self._plume_prog, "uWarm"),   self._plume_warm)
        GL.glUniform1f(_ul(self._plume_prog, "uOpacity"), opacity)
        GL.glUniform1f(_ul(self._plume_prog, "uShapeR"), 1.0 / 3.0)
        GL.glDrawArrays(GL.GL_TRIANGLES, 0, 6)

        GL.glBindVertexArray(0)
        GL.glUseProgram(0)
