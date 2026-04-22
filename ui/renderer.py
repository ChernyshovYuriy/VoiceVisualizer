"""
renderer.py
3D ring visualizer — QOpenGLWidget with orbit camera.
Uses GLM-style column-major matrices passed to OpenGL without transposition.
Mouse drag = orbit, scroll = zoom.

Integration (main_window.py):
    from renderer import RingWidget
    self._ring_widget = RingWidget(self._live, parent=root)
    vbox.addWidget(self._ring_widget, stretch=1)
"""
from __future__ import annotations

import math
import ctypes
import numpy as np
from typing import TYPE_CHECKING

from PySide6.QtCore import Qt, QTimer, QPoint
from PySide6.QtGui import QSurfaceFormat, QMouseEvent, QWheelEvent
from PySide6.QtOpenGLWidgets import QOpenGLWidget
from OpenGL import GL

if TYPE_CHECKING:
    from core.live_state import LiveState

# ── shaders ───────────────────────────────────────────────────────────────────

_RING_VERT = """
#version 330 core
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNorm;
uniform mat4 uMVP;
uniform mat4 uNorm;
out vec3 vNorm;
void main() {
    vNorm = mat3(uNorm) * aNorm;
    gl_Position = uMVP * vec4(aPos, 1.0);
}
"""

_RING_FRAG = """
#version 330 core
in vec3 vNorm;
out vec4 fragColor;
uniform vec3  uColor;
uniform float uOpacity;
uniform float uFlash;
uniform float uGlow;
void main() {
    vec3 n   = normalize(vNorm);
    // Rim glow: bright at silhouette (where normal faces camera, n.z~0)
    float rim  = 1.0 - abs(n.z);
    float body = exp(-rim * 2.0);
    float halo = exp(-rim * 0.7);
    float alpha = (body * 0.55 + halo * 0.38 + uGlow * 0.07) * uOpacity;
    if (alpha < 0.003) discard;
    vec3 col = mix(uColor, vec3(1.0, 0.95, 0.85), uFlash * 0.28);
    col += uGlow * vec3(0.07, 0.03, 0.0);
    fragColor = vec4(col, alpha);
}
"""

_BG_VERT = """
#version 330 core
layout(location=0) in vec2 aPos;
out float vY;
void main() { vY = aPos.y*0.5+0.5; gl_Position = vec4(aPos, 0.9999, 1.0); }
"""

_BG_FRAG = """
#version 330 core
in float vY;
out vec4 fragColor;
void main() {
    vec3 top    = vec3(0.020, 0.039, 0.078);
    vec3 bottom = vec3(0.004, 0.012, 0.024);
    fragColor = vec4(mix(bottom, top, smoothstep(0.0, 1.0, vY)), 1.0);
}
"""

# ── column-major matrix helpers (GLM convention) ──────────────────────────────
# numpy arrays are row-major; we build column-major by filling column by column.
# Pass to OpenGL with transpose=False (GL_FALSE).

def _cm_perspective(fov_deg, aspect, near, far):
    f = 1.0 / math.tan(math.radians(fov_deg) / 2)
    m = np.zeros((4, 4), dtype=np.float32)
    m[0, 0] = f / aspect
    m[1, 1] = f
    m[2, 2] = (far + near) / (near - far)
    m[2, 3] = (2 * far * near) / (near - far)
    m[3, 2] = -1.0
    return m

def _cm_look_at(eye, center, up):
    eye = np.array(eye, dtype=np.float32)
    ctr = np.array(center, dtype=np.float32)
    up  = np.array(up, dtype=np.float32)
    f = ctr - eye; f /= np.linalg.norm(f)
    r = np.cross(f, up); r /= np.linalg.norm(r)
    u = np.cross(r, f)
    m = np.zeros((4, 4), dtype=np.float32)
    # Column 0: right
    m[0, 0]=r[0]; m[1, 0]=r[1]; m[2, 0]=r[2]; m[3, 0]=-np.dot(r, eye)
    # Column 1: up
    m[0, 1]=u[0]; m[1, 1]=u[1]; m[2, 1]=u[2]; m[3, 1]=-np.dot(u, eye)
    # Column 2: -forward
    m[0, 2]=-f[0]; m[1, 2]=-f[1]; m[2, 2]=-f[2]; m[3, 2]=np.dot(f, eye)
    m[3, 3] = 1.0
    return m

def _cm_translate(x, y, z):
    m = np.eye(4, dtype=np.float32)
    m[3, 0]=x; m[3, 1]=y; m[3, 2]=z
    return m

def _cm_scale(s):
    m = np.eye(4, dtype=np.float32)
    m[0,0]=m[1,1]=m[2,2]=s
    return m

# ── torus mesh ────────────────────────────────────────────────────────────────

def _make_torus(R=1.0, r=0.048, seg=96, tseg=16):
    """Float32 array (N,6): position xyz + normal xyz. Ring lies in XZ plane."""
    verts = []
    for i in range(seg):
        a0 = 2*math.pi*i/seg
        a1 = 2*math.pi*(i+1)/seg
        for j in range(tseg):
            b0 = 2*math.pi*j/tseg
            b1 = 2*math.pi*(j+1)/tseg
            def v(a, b):
                cb, sb = math.cos(b), math.sin(b)
                ca, sa = math.cos(a), math.sin(a)
                x = (R + r*cb)*ca
                y = r*sb
                z = (R + r*cb)*sa
                return x, y, z, cb*ca, sb, cb*sa
            p00=v(a0,b0); p10=v(a1,b0); p01=v(a0,b1); p11=v(a1,b1)
            verts += [p00,p10,p11, p00,p11,p01]
    return np.array(verts, dtype=np.float32)

# ── palette + smoother ────────────────────────────────────────────────────────

_PAL = [
    (0.00, (0.43,0.15,0.12)), (0.25, (0.61,0.28,0.14)),
    (0.48, (0.72,0.46,0.18)), (0.65, (0.62,0.58,0.28)),
    (0.80, (0.30,0.55,0.47)), (1.00, (0.21,0.56,0.64)),
]

def _palette(t):
    t=max(0.,min(1.,t))
    for i in range(len(_PAL)-1):
        t0,c0=_PAL[i]; t1,c1=_PAL[i+1]
        if t0<=t<=t1:
            f=(t-t0)/(t1-t0)
            return tuple(c0[k]+f*(c1[k]-c0[k]) for k in range(3))
    return _PAL[-1][1]

_LLO = math.log(65.4); _LR = math.log(2093.)-_LLO

def _hz(hz): return max(0.,min(1.,(math.log(max(65.4,hz))-_LLO)/_LR))
def _lp(a,b,t): return a+(b-a)*t
def _lp3(a,b,t): return tuple(a[k]+(b[k]-a[k])*t for k in range(3))

class _Smoother:
    GATE=0.35
    def __init__(self):
        self.pn=0.5; self.ln=0.; self.en=0.; self.conf=0.
        self.ho=0.; self.tr=0.; self._note=""
    def update(self,snap,dt):
        pitch=float(snap.get("pitch",0)); loud=float(snap.get("loudness",-80))
        energy=float(snap.get("energy",0)); rc=float(snap.get("pitchConf",0))
        onset=float(snap.get("onset",0)); oh=snap.get("onsetHist",[]); note=snap.get("note","—")
        ok=pitch>40 and rc>=self.GATE; c=rc if ok else 0.
        if ok: self.pn=_lp(self.pn,_hz(pitch),0.12)
        self.conf=_lp(self.conf,c,0.18)
        self.ln=_lp(self.ln,max(0.,min(1.,(loud+58)/38)),0.22)
        self.en=_lp(self.en,max(0.,min(1.,energy)),0.28)
        ho=(sum(oh)/len(oh)) if oh else onset
        self.ho=_lp(self.ho,max(0.,min(1.,ho)),0.3)
        if onset>0.28: self.tr=max(self.tr,onset*0.7)
        if note!="—" and note!=self._note: self.tr=max(self.tr,0.8); self._note=note
        self.tr=max(0.,self.tr-dt*18.)
    def build(self):
        c=self.conf; lm=max(0.,min(1.,0.65*self.ln+0.35*self.en))
        tr=max(0.,min(1.,self.tr*0.8+self.ho*0.2))
        return dict(active=c>0.08, pn=self.pn, radius=0.76+lm*1.82+tr*0.15,
                    fy=_lp(0.05,0.10,c*c), fr=0.14 if lm>0 else 0.06,
                    tr=tr, conf=c, org=max(0.,min(1.,self.en*0.6+tr*0.4)),
                    thick=_lp(0.068,0.038,min(c,1.)))

# ── GL helpers ────────────────────────────────────────────────────────────────

def _compile(src, kind):
    s=GL.glCreateShader(kind)
    GL.glShaderSource(s, src)
    GL.glCompileShader(s)
    if not GL.glGetShaderiv(s, GL.GL_COMPILE_STATUS):
        raise RuntimeError(GL.glGetShaderInfoLog(s).decode())
    return s

def _prog(vs, fs):
    p=GL.glCreateProgram()
    v=_compile(vs,GL.GL_VERTEX_SHADER); f=_compile(fs,GL.GL_FRAGMENT_SHADER)
    GL.glAttachShader(p,v); GL.glAttachShader(p,f); GL.glLinkProgram(p)
    if not GL.glGetProgramiv(p,GL.GL_LINK_STATUS):
        raise RuntimeError(GL.glGetProgramInfoLog(p).decode())
    GL.glDeleteShader(v); GL.glDeleteShader(f)
    return p

def _u(p,n): return GL.glGetUniformLocation(p,n)

def _upload_torus(verts):
    vao=GL.glGenVertexArrays(1); vbo=GL.glGenBuffers(1)
    GL.glBindVertexArray(vao)
    GL.glBindBuffer(GL.GL_ARRAY_BUFFER,vbo)
    GL.glBufferData(GL.GL_ARRAY_BUFFER,verts.nbytes,verts,GL.GL_STATIC_DRAW)
    stride=6*4
    GL.glEnableVertexAttribArray(0)
    GL.glVertexAttribPointer(0,3,GL.GL_FLOAT,False,stride,ctypes.c_void_p(0))
    GL.glEnableVertexAttribArray(1)
    GL.glVertexAttribPointer(1,3,GL.GL_FLOAT,False,stride,ctypes.c_void_p(12))
    GL.glBindVertexArray(0)
    return vao, verts.shape[0]

def _upload_quad():
    q=np.array([-1.,-1., 1.,-1., 1.,1., -1.,-1., 1.,1., -1.,1.],dtype=np.float32)
    vao=GL.glGenVertexArrays(1); vbo=GL.glGenBuffers(1)
    GL.glBindVertexArray(vao)
    GL.glBindBuffer(GL.GL_ARRAY_BUFFER,vbo)
    GL.glBufferData(GL.GL_ARRAY_BUFFER,q.nbytes,q,GL.GL_STATIC_DRAW)
    GL.glEnableVertexAttribArray(0)
    GL.glVertexAttribPointer(0,2,GL.GL_FLOAT,False,0,None)
    GL.glBindVertexArray(0)
    return vao

# ── ring layout ───────────────────────────────────────────────────────────────

_RINGS = [
    dict(y_off= 0.00, scale=1.00, op=0.90, echo=False),
    dict(y_off= 0.44, scale=0.93, op=0.44, echo=True),
    dict(y_off= 0.88, scale=0.87, op=0.24, echo=True),
    dict(y_off=-0.44, scale=0.93, op=0.44, echo=True),
    dict(y_off=-0.88, scale=0.87, op=0.24, echo=True),
]

# ── widget ────────────────────────────────────────────────────────────────────

class RingWidget(QOpenGLWidget):

    def __init__(self, live_state: "LiveState", parent=None):
        fmt = QSurfaceFormat()
        fmt.setVersion(3, 3)
        fmt.setProfile(QSurfaceFormat.OpenGLContextProfile.CoreProfile)
        fmt.setSamples(4)
        fmt.setDepthBufferSize(24)
        QSurfaceFormat.setDefaultFormat(fmt)
        super().__init__(parent)

        self._live  = live_state
        self._sm    = _Smoother()
        self._dy    = 0.0
        self._dr    = 1.0
        self._col   = (0.72, 0.45, 0.22)
        self._t     = 0.0
        self._lt    = None

        # Orbit
        self._yaw   =  30.0
        self._pitch = -20.0
        self._dist  =   8.0
        self._mpos: QPoint | None = None

        QTimer(self, interval=16, timeout=self.update).start()

    def mousePressEvent(self, e: QMouseEvent):
        if e.button() == Qt.LeftButton:
            self._mpos = e.position().toPoint()

    def mouseReleaseEvent(self, e: QMouseEvent):
        self._mpos = None

    def mouseMoveEvent(self, e: QMouseEvent):
        if self._mpos is None: return
        dx = e.position().x() - self._mpos.x()
        dy = e.position().y() - self._mpos.y()
        self._yaw   += dx * 0.4
        self._pitch  = max(-89., min(89., self._pitch + dy * 0.4))
        self._mpos   = e.position().toPoint()

    def wheelEvent(self, e: QWheelEvent):
        self._dist = max(3., min(20., self._dist - e.angleDelta().y()/120. * 0.6))

    def initializeGL(self):
        self._rp  = _prog(_RING_VERT, _RING_FRAG)
        self._bgp = _prog(_BG_VERT,   _BG_FRAG)
        mesh = _make_torus(R=1.0, r=0.048, seg=96, tseg=16)
        self._rvao, self._rn = _upload_torus(mesh)
        self._bgvao = _upload_quad()
        GL.glEnable(GL.GL_DEPTH_TEST)
        GL.glEnable(GL.GL_BLEND)
        GL.glEnable(GL.GL_MULTISAMPLE)

    def resizeGL(self, w, h):
        GL.glViewport(0, 0, w, h)

    def paintGL(self):
        import time as _time
        now = _time.perf_counter()
        dt  = min((now - self._lt) if self._lt else 0.016, 0.05)
        self._lt = now
        self._t += dt

        snap = self._live.snapshot()
        self._sm.update(snap, dt)
        live = self._sm.build()

        tY = _lp(-3.2, 3.2, live["pn"]) if live["active"] else 0.
        tR = live["radius"] if live["active"] else 0.78
        self._dy  = _lp(self._dy, tY, live["fy"] if live["active"] else 0.05)
        self._dr  = _lp(self._dr, tR, live["fr"])
        self._col = _lp3(self._col, _palette(live["pn"]), 0.12)

        w, h = self.width(), max(self.height(), 1)
        yr = math.radians(self._yaw)
        pr = math.radians(self._pitch)
        d  = self._dist
        eye = np.array([d*math.cos(pr)*math.sin(yr),
                        d*math.sin(pr),
                        d*math.cos(pr)*math.cos(yr)], dtype=np.float32)

        proj = _cm_perspective(44., w/h, 0.1, 100.)
        view = _cm_look_at(eye, [0,0,0], [0,1,0])
        vp   = view @ proj   # column-major: model*view*proj for column vectors

        # Background
        GL.glDepthMask(False)
        GL.glBlendFunc(GL.GL_SRC_ALPHA, GL.GL_ONE_MINUS_SRC_ALPHA)
        GL.glClearColor(0.004, 0.012, 0.024, 1.)
        GL.glClear(GL.GL_COLOR_BUFFER_BIT | GL.GL_DEPTH_BUFFER_BIT)
        GL.glUseProgram(self._bgp)
        GL.glBindVertexArray(self._bgvao)
        GL.glDrawArrays(GL.GL_TRIANGLES, 0, 6)

        # Rings (additive)
        GL.glBlendFunc(GL.GL_SRC_ALPHA, GL.GL_ONE)
        GL.glUseProgram(self._rp)

        for spec in _RINGS:
            echo  = spec["echo"]
            r     = self._dr * spec["scale"]
            y_pos = self._dy + spec["y_off"]

            model = _cm_translate(0, y_pos, 0) @ _cm_scale(r)
            mvp   = model @ vp          # column-major order
            # Normal matrix = transpose of inverse of upper-left 3x3 of model
            norm_m = model.copy()

            GL.glUniformMatrix4fv(_u(self._rp,"uMVP"),  1, True,  mvp.flatten())
            GL.glUniformMatrix4fv(_u(self._rp,"uNorm"), 1, True, norm_m.flatten())

            dim = 1. if not echo else 0.72
            col = tuple(self._col[k]*dim for k in range(3))
            GL.glUniform3f(_u(self._rp,"uColor"),   *col)
            GL.glUniform1f(_u(self._rp,"uOpacity"), spec["op"])
            GL.glUniform1f(_u(self._rp,"uFlash"),   live["tr"]*(1. if not echo else 0.3))
            GL.glUniform1f(_u(self._rp,"uGlow"),    live["org"]*(1. if not echo else 0.4))

            GL.glBindVertexArray(self._rvao)
            GL.glDrawArrays(GL.GL_TRIANGLES, 0, self._rn)

        GL.glDepthMask(True)
        GL.glBindVertexArray(0)
        GL.glUseProgram(0)
