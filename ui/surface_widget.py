"""
surface_widget.py
PyQtGraph OpenGL 3D surface that visualises the rolling mel spectrogram.

Axes:
  X = time  (scrolls left as new frames arrive)
  Y = frequency  (mel scale, 80–4000 Hz, 64 bins)
  Z = energy (mel magnitude, normalised 0–1)
  Color = loudness per time slice  (blue → cyan → green → yellow → red)
"""

from __future__ import annotations

import numpy as np
import pyqtgraph.opengl as gl
from PySide6.QtCore import QTimer

from core.buffer import RollingBuffer, N_TIME, N_MELS


def _loudness_colormap(loud_norm: np.ndarray) -> np.ndarray:
    """
    Vectorised rainbow ramp:
      0.00–0.25  blue → cyan
      0.25–0.50  cyan → green
      0.50–0.75  green → yellow
      0.75–1.00  yellow → red
    Returns (N,) arrays for r, g, b.
    """
    v = np.clip(loud_norm, 0.0, 1.0)
    r = np.zeros_like(v)
    g = np.zeros_like(v)
    b = np.zeros_like(v)

    m1 = v < 0.25
    m2 = (v >= 0.25) & (v < 0.5)
    m3 = (v >= 0.5) & (v < 0.75)
    m4 = v >= 0.75

    t1 = v[m1] / 0.25
    t2 = (v[m2] - 0.25) / 0.25
    t3 = (v[m3] - 0.50) / 0.25
    t4 = (v[m4] - 0.75) / 0.25

    r[m1] = 0;  g[m1] = t1;      b[m1] = 1.0
    r[m2] = 0;  g[m2] = 1.0;     b[m2] = 1.0 - t2
    r[m3] = t3; g[m3] = 1.0;     b[m3] = 0.0
    r[m4] = 1.0; g[m4] = 1.0 - t4; b[m4] = 0.0

    return r, g, b


class SurfaceWidget(gl.GLViewWidget):
    def __init__(self, buffer: RollingBuffer, parent=None) -> None:
        super().__init__(parent)
        self._buffer = buffer
        self._setup_scene()
        self._start_refresh()

    # ── scene setup ───────────────────────────────────────────────────────────

    def _setup_scene(self) -> None:
        self.setBackgroundColor("#0d1117")
        self.setCameraPosition(distance=3.0, elevation=28, azimuth=225)

        # Subtle grid on the floor
        grid = gl.GLGridItem()
        grid.setSize(2, 2, 1)
        grid.setSpacing(0.2, 0.2, 0.2)
        grid.setColor((255, 255, 255, 20))
        self.addItem(grid)

        # Initial flat surface
        x = np.linspace(-1.0, 1.0, N_TIME, dtype=np.float32)
        y = np.linspace(-1.0, 1.0, N_MELS, dtype=np.float32)
        z = np.zeros((N_TIME, N_MELS), dtype=np.float32)

        colors = np.zeros((N_TIME, N_MELS, 4), dtype=np.float32)
        colors[..., 2] = 0.6   # default: cool blue
        colors[..., 3] = 0.88

        self._surface = gl.GLSurfacePlotItem(
            x=x,
            y=y,
            z=z,
            colors=colors,
            smooth=True,
            drawEdges=False,
            drawFaces=True,
        )
        self.addItem(self._surface)

    # ── refresh loop ──────────────────────────────────────────────────────────

    def _start_refresh(self) -> None:
        self._timer = QTimer(self)
        self._timer.setInterval(33)          # ~30 fps
        self._timer.timeout.connect(self._refresh)
        self._timer.start()

    def _refresh(self) -> None:
        mel, _pitch, loudness, _centroid = self._buffer.snapshot()

        # Z: mel magnitude scaled to a visible height
        z = (mel * 0.35).astype(np.float32)

        # Colors: one color per time slice, broadcast across mel bins
        loud_norm = np.clip((loudness + 80.0) / 80.0, 0.0, 1.0)
        r, g, b = _loudness_colormap(loud_norm)

        colors = np.empty((N_TIME, N_MELS, 4), dtype=np.float32)
        colors[..., 0] = r[:, np.newaxis]
        colors[..., 1] = g[:, np.newaxis]
        colors[..., 2] = b[:, np.newaxis]
        colors[..., 3] = 0.88

        self._surface.setData(z=z, colors=colors)
