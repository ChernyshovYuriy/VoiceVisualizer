"""
info_panel.py
Right-hand metrics panel — solid colors, no rgba, full contrast.
"""

from __future__ import annotations
import math

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QFrame,
    QLabel,
    QVBoxLayout,
    QWidget,
)

from core.analyzer import FrameInfo


class _Card(QWidget):
    """One metric row: small grey label above a large bright value."""

    def __init__(self, label: str, parent=None) -> None:
        super().__init__(parent)

        frame = QFrame()
        frame.setStyleSheet(
            "QFrame { background-color: #2d333b; border-radius: 6px; "
            "border: 1px solid #444c56; }"
        )

        inner = QVBoxLayout(frame)
        inner.setContentsMargins(12, 8, 12, 8)
        inner.setSpacing(2)

        self._lbl = QLabel(label)
        self._lbl.setStyleSheet(
            "QLabel { color: #768390; font-size: 10px; font-weight: 500; "
            "background: transparent; border: none; }"
        )

        self._val = QLabel("—")
        self._val.setStyleSheet(
            "QLabel { color: #e6edf3; font-size: 19px; font-weight: 700; "
            "background: transparent; border: none; }"
        )

        inner.addWidget(self._lbl)
        inner.addWidget(self._val)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(frame)

    def set_value(self, text: str, color: str = "#e6edf3") -> None:
        self._val.setText(text)
        self._val.setStyleSheet(
            f"QLabel {{ color: {color}; font-size: 19px; font-weight: 700; "
            "background: transparent; border: none; }"
        )


class InfoPanel(QWidget):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setFixedWidth(220)
        self.setStyleSheet(
            "InfoPanel { background-color: #22272e; border-radius: 10px; "
            "border: 1px solid #373e47; }"
        )
        self._build()

    def _build(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 14, 12, 14)
        layout.setSpacing(8)

        header = QLabel("› Analysis Metrics")
        header.setStyleSheet(
            "QLabel { color: #4493f8; font-size: 12px; font-weight: 600; "
            "background: transparent; border: none; }"
        )
        layout.addWidget(header)

        self._note   = _Card("NOTE")
        self._freq   = _Card("FREQUENCY")
        self._volume = _Card("VOLUME")
        self._timbre = _Card("TIMBRE")
        self._range  = _Card("VOCAL RANGE")

        for card in (self._note, self._freq, self._volume, self._timbre, self._range):
            layout.addWidget(card)

        layout.addStretch()

        hint = QLabel("X = time  ·  Y = pitch  ·  Z = energy\nColor = loudness")
        hint.setAlignment(Qt.AlignCenter)
        hint.setStyleSheet(
            "QLabel { color: #545d68; font-size: 10px; background: transparent; "
            "border: none; line-height: 1.4; }"
        )
        layout.addWidget(hint)

    # ── public ────────────────────────────────────────────────────────────────

    def update_info(self, info: FrameInfo) -> None:
        voiced = bool(info.pitch_hz) and not math.isnan(info.pitch_hz)

        # Note
        self._note.set_value(
            info.note_name if voiced else "—",
            color="#f0f6fc" if voiced else "#545d68",
        )

        # Frequency
        self._freq.set_value(
            f"{info.pitch_hz:.1f} Hz" if voiced else "— Hz",
            color="#79c0ff" if voiced else "#545d68",
        )

        # Volume — color-coded green / amber / red
        db = info.loudness_db
        if db > -20:
            vol_color = "#f85149"
        elif db > -45:
            vol_color = "#d29922"
        else:
            vol_color = "#3fb950"
        self._volume.set_value(f"{db:.1f} dB", color=vol_color)

        # Timbre
        timbre_colors = {
            "Dark": "#79c0ff",
            "Warm": "#e3b341",
            "Bright": "#ffa657",
            "Brilliant": "#ff7b72",
        }
        self._timbre.set_value(
            info.timbre,
            color=timbre_colors.get(info.timbre, "#e6edf3"),
        )

        # Vocal range
        range_colors = {
            "Bass":    "#79c0ff",
            "Chest":   "#56d364",
            "Mixed":   "#e3b341",
            "Head":    "#ffa657",
            "Whistle": "#ff7b72",
        }
        self._range.set_value(
            info.vocal_range if voiced else "—",
            color=range_colors.get(info.vocal_range, "#e6edf3") if voiced else "#545d68",
        )
