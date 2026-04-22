"""
renderer.py — 3D torus ring visualizer using QOpenGLWidget.
Orbit with left-drag, zoom with scroll.

Place in ui/renderer.py. Integration in main_window.py:
    from ui.renderer import RingWidget
    self._ring_widget = RingWidget(self._live, parent=root)
    vbox.addWidget(self._ring_widget, stretch=1)
"""
from __future__ import annotations
import math, ctypes, time as _t
from typing import TYPE_CHECKING
import numpy as np
from PySide6.QtCore import Qt, QTimer, QPoint
from PySide6.QtGui import QSurfaceFormat, QMouseEvent, QWheelEvent
from PySide6.QtOpenGLWidgets import QOpenGLWidget
import OpenGL.GL as GL

if TYPE_CHECKING:
    from core.live_state import LiveState

# ── shaders ───────────────────────────────────────────────────────────────────

_VERT = """\
#version 330 core
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNorm;
uniform mat4 uMVP;
uniform mat3 uNormalMat;
out vec3 vWorldNorm;
out vec3 vWorldPos;
void main() {
    vWorldNorm = uNormalMat * aNorm;
    vWorldPos  = aPos;
    gl_Position = uMVP * vec4(aPos, 1.0);
}
"""

_FRAG = """\
#version 330 core
in vec3 vWorldNorm;
in vec3 vWorldPos;
out vec4 fragColor;
uniform vec3  uColor;
uniform float uOpacity;
uniform float uFlash;
uniform vec3  uEye;
void main() {
    vec3 n = normalize(vWorldNorm);
    vec3 v = normalize(uEye - vWorldPos);
    float ndotv = abs(dot(n, v));
    // Bright at silhouette (ndotv~0), dim face-on
    float rim   = 1.0 - ndotv;
    float inner = smoothstep(0.65, 0.35, ndotv);
    float body  = exp(-pow(rim * 3.0, 2.0));
    float halo  = exp(-pow(rim * 1.2, 2.0));
    float alpha = (inner * 0.55 + body * 0.35 + halo * 0.15) * uOpacity;
    if (alpha < 0.003) discard;
    vec3 col = mix(uColor, vec3(1.0, 0.95, 0.85), uFlash * 0.30);
    col += inner * vec3(0.08, 0.04, 0.01);
    fragColor = vec4(col, alpha);
}
"""

_BG_VERT = """\
#version 330 core
layout(location=0) in vec2 aPos;
out float vY;
void main() { vY = aPos.y * 0.5 + 0.5; gl_Position = vec4(aPos, 0.9999, 1.0); }
"""

_BG_FRAG = """\
#version 330 core
in float vY; out vec4 fragColor;
void main() {
    fragColor = vec4(mix(vec3(0.004,0.012,0.024), vec3(0.018,0.036,0.070),
                         smoothstep(0.0, 1.0, vY)), 1.0);
}
"""

# ── verified matrix math ──────────────────────────────────────────────────────
# Convention: standard row-major numpy matrices P@V@M, uploaded with transpose=True
# so OpenGL receives them in column-major order as expected.

def _perspective(fov_deg, aspect, near, far):
    t = math.tan(math.radians(fov_deg) / 2)
    return np.array([
        [1/(aspect*t), 0,    0,                    0],
        [0,            1/t,  0,                    0],
        [0,            0,   -(far+near)/(far-near), -2*far*near/(far-near)],
        [0,            0,   -1,                    0],
    ], dtype=np.float32)

def _look_at(eye, ctr, up):
    eye=np.array(eye,np.float32); ctr=np.array(ctr,np.float32); up=np.array(up,np.float32)
    f=ctr-eye; f/=np.linalg.norm(f)
    r=np.cross(f,up); r/=np.linalg.norm(r)
    u=np.cross(r,f)
    R = np.array([[r[0],r[1],r[2],0],[u[0],u[1],u[2],0],[-f[0],-f[1],-f[2],0],[0,0,0,1]],np.float32)
    T = np.array([[1,0,0,-eye[0]],[0,1,0,-eye[1]],[0,0,1,-eye[2]],[0,0,0,1]],np.float32)
    return R @ T

def _translate(x,y,z):
    m=np.eye(4,dtype=np.float32); m[0,3]=x; m[1,3]=y; m[2,3]=z; return m

def _scale(s):
    m=np.eye(4,dtype=np.float32); m[0,0]=m[1,1]=m[2,2]=s; return m

# ── torus geometry ────────────────────────────────────────────────────────────

def _torus(R=1.0, r=0.22, seg=120, tseg=40):
    """Torus in XZ plane. Returns float32 (N,6): xyz + normal xyz."""
    rows = []
    for i in range(seg):
        for j in range(tseg):
            for di, dj in ((0,0),(1,0),(1,1),(0,0),(1,1),(0,1)):
                a = 2*math.pi*(i+di)/seg
                b = 2*math.pi*(j+dj)/tseg
                ca,sa = math.cos(a),math.sin(a)
                cb,sb = math.cos(b),math.sin(b)
                x = (R + r*cb)*ca
                y = r*sb
                z = (R + r*cb)*sa
                nx,ny,nz = cb*ca, sb, cb*sa
                rows.append((x,y,z,nx,ny,nz))
    return np.array(rows, dtype=np.float32)

# ── palette ───────────────────────────────────────────────────────────────────

_PAL=[(0.00,(0.43,0.15,0.12)),(0.25,(0.61,0.28,0.14)),(0.48,(0.72,0.46,0.18)),
      (0.65,(0.62,0.58,0.28)),(0.80,(0.30,0.55,0.47)),(1.00,(0.21,0.56,0.64))]

def _pal(t):
    t=max(0.,min(1.,t))
    for i in range(len(_PAL)-1):
        t0,c0=_PAL[i]; t1,c1=_PAL[i+1]
        if t0<=t<=t1:
            f=(t-t0)/(t1-t0); return tuple(c0[k]+f*(c1[k]-c0[k]) for k in range(3))
    return _PAL[-1][1]

# ── smoother ──────────────────────────────────────────────────────────────────

_LLO=math.log(65.4); _LR=math.log(2093.)-_LLO
def _hn(hz): return max(0.,min(1.,(math.log(max(65.4,hz))-_LLO)/_LR))
def _lp(a,b,t): return a+(b-a)*t
def _lp3(a,b,t): return tuple(a[k]+(b[k]-a[k])*t for k in range(3))

class _Sm:
    G=0.35
    def __init__(self): self.pn=0.5;self.ln=0.;self.en=0.;self.c=0.;self.ho=0.;self.tr=0.;self._n=""
    def tick(self,s,dt):
        p=float(s.get("pitch",0));lo=float(s.get("loudness",-80))
        e=float(s.get("energy",0));rc=float(s.get("pitchConf",0))
        on=float(s.get("onset",0));oh=s.get("onsetHist",[]);n=s.get("note","—")
        ok=p>40 and rc>=self.G; c=rc if ok else 0.
        if ok: self.pn=_lp(self.pn,_hn(p),0.12)
        self.c=_lp(self.c,c,.18); self.ln=_lp(self.ln,max(0.,min(1.,(lo+58)/38)),.22)
        self.en=_lp(self.en,max(0.,min(1.,e)),.28)
        ho=(sum(oh)/len(oh)) if oh else on; self.ho=_lp(self.ho,max(0.,min(1.,ho)),.3)
        if on>0.28: self.tr=max(self.tr,on*.7)
        if n!="—" and n!=self._n: self.tr=max(self.tr,.8); self._n=n
        self.tr=max(0.,self.tr-dt*18.)
    def out(self):
        c=self.c; lm=max(0.,min(1.,.65*self.ln+.35*self.en)); tr=max(0.,min(1.,self.tr*.8+self.ho*.2))
        return dict(active=c>.08, pn=self.pn, r=.52+lm*.48+tr*.08,
                    fy=_lp(.05,.10,c*c), fr=.14 if lm>0 else .06,
                    tr=tr, org=max(0.,min(1.,self.en*.6+tr*.4)))

# ── GL ────────────────────────────────────────────────────────────────────────

def _shader(src, kind):
    s=GL.glCreateShader(kind); GL.glShaderSource(s,src); GL.glCompileShader(s)
    if not GL.glGetShaderiv(s,GL.GL_COMPILE_STATUS):
        raise RuntimeError(GL.glGetShaderInfoLog(s).decode())
    return s

def _program(vs,fs):
    p=GL.glCreateProgram()
    v=_shader(vs,GL.GL_VERTEX_SHADER); f=_shader(fs,GL.GL_FRAGMENT_SHADER)
    GL.glAttachShader(p,v); GL.glAttachShader(p,f); GL.glLinkProgram(p)
    if not GL.glGetProgramiv(p,GL.GL_LINK_STATUS):
        raise RuntimeError(GL.glGetProgramInfoLog(p).decode())
    GL.glDeleteShader(v); GL.glDeleteShader(f); return p

def _vao_mesh(arr):
    vao=GL.glGenVertexArrays(1); vbo=GL.glGenBuffers(1)
    GL.glBindVertexArray(vao)
    GL.glBindBuffer(GL.GL_ARRAY_BUFFER,vbo)
    GL.glBufferData(GL.GL_ARRAY_BUFFER,arr.nbytes,arr,GL.GL_STATIC_DRAW)
    GL.glEnableVertexAttribArray(0)
    GL.glVertexAttribPointer(0,3,GL.GL_FLOAT,False,24,ctypes.c_void_p(0))
    GL.glEnableVertexAttribArray(1)
    GL.glVertexAttribPointer(1,3,GL.GL_FLOAT,False,24,ctypes.c_void_p(12))
    GL.glBindVertexArray(0); return vao, len(arr)

def _vao_quad():
    q=np.array([-1,-1,1,-1,1,1,-1,-1,1,1,-1,1],dtype=np.float32)
    vao=GL.glGenVertexArrays(1); vbo=GL.glGenBuffers(1)
    GL.glBindVertexArray(vao)
    GL.glBindBuffer(GL.GL_ARRAY_BUFFER,vbo)
    GL.glBufferData(GL.GL_ARRAY_BUFFER,q.nbytes,q,GL.GL_STATIC_DRAW)
    GL.glEnableVertexAttribArray(0)
    GL.glVertexAttribPointer(0,2,GL.GL_FLOAT,False,0,None)
    GL.glBindVertexArray(0); return vao

def _ul(p,n): return GL.glGetUniformLocation(p,n)

# ── ring layout ───────────────────────────────────────────────────────────────

_RINGS = [
    (0.00, 1.00, 0.90, False),
    (0.00, 0.80, 0.40, True),
    (0.00, 1.20, 0.30, True),
    (0.00, 0.62, 0.20, True),
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

        self._live = live_state
        self._sm   = _Sm()
        self._dy   = 0.0
        self._dr   = 0.65
        self._col  = (0.72, 0.45, 0.22)
        self._lt   = None

        # Camera orbit: yaw around Y, pitch above horizon
        self._yaw   = 25.0
        self._pitch = 30.0
        self._dist  =  7.0
        self._mp: QPoint | None = None

        QTimer(self, interval=16, timeout=self.update).start()

    def mousePressEvent(self, e: QMouseEvent):
        if e.button() == Qt.LeftButton: self._mp = e.position().toPoint()

    def mouseReleaseEvent(self, e: QMouseEvent): self._mp = None

    def mouseMoveEvent(self, e: QMouseEvent):
        if self._mp is None: return
        self._yaw  += (e.position().x() - self._mp.x()) * 0.4
        self._pitch = max(-89., min(89., self._pitch + (e.position().y() - self._mp.y()) * 0.4))
        self._mp = e.position().toPoint()

    def wheelEvent(self, e: QWheelEvent):
        self._dist = max(3., min(20., self._dist - e.angleDelta().y()/120. * 0.5))

    def initializeGL(self):
        try:
            self._rp  = _program(_VERT,    _FRAG)
            self._bgp = _program(_BG_VERT,  _BG_FRAG)
            self._rvao, self._rn = _vao_mesh(_torus())
            self._bgvao = _vao_quad()
            GL.glEnable(GL.GL_DEPTH_TEST)
            GL.glEnable(GL.GL_BLEND)
            try: GL.glEnable(GL.GL_MULTISAMPLE)
            except Exception: pass
            print("[renderer] OK —", GL.glGetString(GL.GL_RENDERER).decode())
        except Exception as exc:
            print(f"[renderer] FAILED: {exc}")
            self._rp = 0

    def resizeGL(self, w, h): GL.glViewport(0, 0, w, h)

    def paintGL(self):
        if not getattr(self,'_rp',0): return

        now=_t.perf_counter(); dt=min((now-self._lt) if self._lt else .016,.05); self._lt=now

        snap=self._live.snapshot(); self._sm.tick(snap,dt); lv=self._sm.out()

        tY=_lp(-3.,3.,lv["pn"]) if lv["active"] else 0.
        self._dy  = _lp(self._dy,  tY,      lv["fy"] if lv["active"] else .05)
        self._dr  = _lp(self._dr,  lv["r"], lv["fr"])
        self._col = _lp3(self._col, _pal(lv["pn"]), .12)

        w=self.width(); h=max(self.height(),1)
        yr=math.radians(self._yaw); pr=math.radians(self._pitch); d=self._dist
        eye=np.array([d*math.cos(pr)*math.sin(yr), d*math.sin(pr), d*math.cos(pr)*math.cos(yr)],np.float32)

        # Verified convention: P@V@M in numpy row-major, uploaded with transpose=True
        P=_perspective(44.,w/h,0.1,100.)
        V=_look_at(eye,[0,0,0],[0,1,0])
        VP=P@V

        # Background
        GL.glDepthMask(False)
        GL.glBlendFunc(GL.GL_SRC_ALPHA,GL.GL_ONE_MINUS_SRC_ALPHA)
        GL.glClearColor(.004,.012,.024,1.); GL.glClear(GL.GL_COLOR_BUFFER_BIT|GL.GL_DEPTH_BUFFER_BIT)
        GL.glUseProgram(self._bgp); GL.glBindVertexArray(self._bgvao); GL.glDrawArrays(GL.GL_TRIANGLES,0,6)

        # Rings — additive blend
        GL.glBlendFunc(GL.GL_SRC_ALPHA,GL.GL_ONE)
        GL.glUseProgram(self._rp); GL.glBindVertexArray(self._rvao)

        for y_off, scale, op, echo in _RINGS:
            r=self._dr*scale; yp=self._dy+y_off
            M=_translate(0,yp,0)@_scale(r)
            mvp=(VP@M).astype(np.float32)
            nm=np.linalg.inv(M[:3,:3]).T.astype(np.float32)

            GL.glUniformMatrix4fv(_ul(self._rp,"uMVP"),      1, True, mvp.flatten())
            GL.glUniformMatrix3fv(_ul(self._rp,"uNormalMat"),1, True, nm.flatten())
            GL.glUniform3f(_ul(self._rp,"uEye"),  *eye)
            dim=1. if not echo else .72
            GL.glUniform3f(_ul(self._rp,"uColor"), *(self._col[k]*dim for k in range(3)))
            GL.glUniform1f(_ul(self._rp,"uOpacity"), op)
            GL.glUniform1f(_ul(self._rp,"uFlash"),   lv["tr"]*(1. if not echo else .3))
            GL.glDrawArrays(GL.GL_TRIANGLES,0,self._rn)

        GL.glDepthMask(True); GL.glBindVertexArray(0); GL.glUseProgram(0)
