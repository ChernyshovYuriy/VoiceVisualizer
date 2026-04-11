"""
main_window.py
PySide6 main window for the current browser-embedded visualizer.
Includes offline vocal preprocessing with the heavy work offloaded to QThread.
"""

from __future__ import annotations

import webbrowser
from pathlib import Path

from PySide6.QtCore import QObject, Qt, QThread, QTimer, Signal, Slot, QUrl
from PySide6.QtGui import QAction
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QProgressDialog,
    QPushButton,
    QSlider,
    QVBoxLayout,
    QWidget,
)

try:
    from PySide6.QtWebEngineWidgets import QWebEngineView
    from PySide6.QtWebEngineCore import QWebEngineSettings
    HAS_WEBENGINE = True
except ImportError:
    HAS_WEBENGINE = False

from core.player import Player, PreparedTracks, AUDIO_EXT, VIDEO_EXT
from core.buffer import RollingBuffer
from core.analyzer import Analyzer, FrameInfo
from core.live_state import LiveState
from core.preprocess import PreparedMedia, Preprocessor
from core.ws_server import WSServer

_ACCEPT = " ".join(f"*{e}" for e in sorted(AUDIO_EXT | VIDEO_EXT))
_FILTER = f"Audio / Video ({_ACCEPT})"
_HTML = Path(__file__).parent.parent / "frontend" / "visualizer.html"


class _Bridge(QObject):
    frame_ready = Signal(object)


class _PrepareWorker(QObject):
    progress = Signal(str)
    finished = Signal(object, object)
    failed = Signal(str)

    def __init__(
        self,
        source_path: Path | None,
        prepared_media: PreparedMedia | None,
        analysis_mode: str,
    ) -> None:
        super().__init__()
        self._source_path = source_path
        self._prepared_media = prepared_media
        self._analysis_mode = analysis_mode
        self._preprocessor = Preprocessor()

    @Slot()
    def run(self) -> None:
        try:
            prepared = self._prepared_media
            if prepared is None:
                if self._source_path is None:
                    raise RuntimeError("No input source provided.")
                prepared = self._preprocessor.prepare(self._source_path, progress=self.progress.emit)
            else:
                self.progress.emit("Loading cached prepared media…")

            analysis_path = (
                prepared.vocals_path
                if self._analysis_mode == "vocals"
                else prepared.original_audio_path
            )
            self.progress.emit(
                f"Decoding {'vocals stem' if self._analysis_mode == 'vocals' else 'full mix'} for playback…"
            )
            tracks = Player.prepare_tracks(prepared.original_audio_path, analysis_path)
            self.finished.emit(prepared, tracks)
        except Exception as exc:
            self.failed.emit(str(exc))


APP_STYLE = """
QMainWindow, QWidget {
    background-color: #0d1117;
    color: #e6edf3;
    font-family: 'Segoe UI', 'SF Pro Text', 'Helvetica Neue', sans-serif;
    font-size: 13px;
}
QPushButton {
    background-color: #21262d;
    color: #e6edf3;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 6px 16px;
    font-size: 13px;
}
QPushButton:hover    { background-color: #30363d; border-color: #58a6ff; }
QPushButton:pressed  { background-color: #161b22; }
QPushButton:disabled { color: #484f58; border-color: #21262d; }
QLabel  { color: #e6edf3; background: transparent; }
QSlider::groove:horizontal {
    background: #21262d; height: 4px; border-radius: 2px;
}
QSlider::sub-page:horizontal {
    background: #58a6ff; border-radius: 2px;
}
QSlider::handle:horizontal {
    background: #58a6ff; width: 14px; height: 14px;
    margin: -5px 0; border-radius: 7px; border: 2px solid #0d1117;
}
QSlider::handle:horizontal:hover { background: #79c0ff; }
QSplitter::handle { background: #21262d; }
QComboBox {
    background-color: #21262d;
    color: #e6edf3;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 5px 10px;
}
QComboBox:hover { border-color: #58a6ff; }
"""

DIALOG_STYLE = """
QFileDialog, QFileDialog * { background-color: #161b22; color: #e6edf3; font-size: 13px; }
QFileDialog QListView, QFileDialog QTreeView {
    background-color: #21262d; color: #e6edf3;
    border: 1px solid #30363d; border-radius: 4px;
}
QFileDialog QListView::item:selected,
QFileDialog QTreeView::item:selected { background: #1f6feb; color: #fff; }
QFileDialog QLineEdit {
    background: #21262d; color: #e6edf3; border: 1px solid #30363d;
    border-radius: 4px; padding: 4px 8px;
}
QPushButton { background: #21262d; color: #e6edf3; border: 1px solid #30363d;
              border-radius: 6px; padding: 5px 14px; }
QPushButton:hover { background: #30363d; }
QComboBox { background: #21262d; color: #e6edf3; border: 1px solid #30363d;
            border-radius: 4px; padding: 3px 8px; }
QLabel { color: #e6edf3; background: transparent; }
QHeaderView::section { background: #161b22; color: #768390; border: none; padding: 4px; }
QScrollBar:vertical   { background: #161b22; width: 8px; border: none; }
QScrollBar::handle:vertical { background: #30363d; border-radius: 4px; min-height: 20px; }
"""


def _fmt(s: float) -> str:
    m, sec = divmod(int(s), 60)
    return f"{m}:{sec:02d}"


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Voice / Music Visualizer — 3D Live")
        self.resize(1280, 760)
        self.setStyleSheet(APP_STYLE)

        self._live = LiveState()
        self._buffer = RollingBuffer()
        self._bridge = _Bridge()
        self._analyzer = Analyzer(self._buffer, self._bridge.frame_ready.emit)
        self._player = Player(on_chunk=self._analyzer.push_chunk)
        self._slider_dragging = False
        self._prepared: PreparedMedia | None = None
        self._source_path: Path | None = None
        self._progress: QProgressDialog | None = None
        self._worker_thread: QThread | None = None
        self._worker: _PrepareWorker | None = None
        self._pending_seek_seconds = 0.0
        self._pending_resume = False
        self._preprocessor = Preprocessor()

        try:
            self._ws = WSServer(self._live)
            self._ws.start()
        except RuntimeError as e:
            QMessageBox.warning(self, "WS server", str(e))

        self._bridge.frame_ready.connect(self._on_frame)
        self._build_menu()
        self._build_ui()

        self._tick = QTimer(self)
        self._tick.setInterval(100)
        self._tick.timeout.connect(self._tick_cb)
        self._tick.start()

    def _build_menu(self) -> None:
        file_menu = self.menuBar().addMenu("&File")

        open_action = QAction("Open media…", self)
        open_action.triggered.connect(self._open_file)
        file_menu.addAction(open_action)

        open_pair_action = QAction("Open media with external vocals stem…", self)
        open_pair_action.triggered.connect(self._open_manual_pair)
        file_menu.addAction(open_pair_action)

        preprocess_action = QAction("Preprocess media…", self)
        preprocess_action.triggered.connect(self._preprocess_only)
        file_menu.addAction(preprocess_action)

    def _build_ui(self) -> None:
        root = QWidget()
        self.setCentralWidget(root)
        vbox = QVBoxLayout(root)
        vbox.setContentsMargins(10, 10, 10, 8)
        vbox.setSpacing(8)

        tb = QHBoxLayout()
        tb.setSpacing(8)

        self._btn_open = QPushButton("📂  Open file…")
        self._btn_open.setFixedHeight(34)
        self._btn_open.clicked.connect(self._open_file)

        self._btn_play = QPushButton("▶  Play")
        self._btn_play.setFixedWidth(100)
        self._btn_play.setFixedHeight(34)
        self._btn_play.setEnabled(False)
        self._btn_play.clicked.connect(self._toggle_play)

        self._btn_open_pair = QPushButton("🧩  Open media + vocals…")
        self._btn_open_pair.setFixedHeight(34)
        self._btn_open_pair.clicked.connect(self._open_manual_pair)

        self._mode = QComboBox()
        self._mode.addItem("Vocals only", userData="vocals")
        self._mode.addItem("Full mix", userData="full_mix")
        self._mode.currentIndexChanged.connect(self._reload_analysis_track_if_ready)

        self._lbl_file = QLabel("No file loaded")
        self._lbl_file.setStyleSheet("color: #545d68; font-size: 12px;")

        tb.addWidget(self._btn_open)
        tb.addWidget(self._btn_open_pair)
        tb.addWidget(self._btn_play)
        tb.addWidget(self._mode)
        tb.addSpacing(6)
        tb.addWidget(self._lbl_file)
        tb.addStretch()

        if not HAS_WEBENGINE:
            note = QLabel("⚠ PySide6-WebEngine not found — opens in browser")
            note.setStyleSheet("color: #d29922; font-size: 11px;")
            tb.addWidget(note)

        vbox.addLayout(tb)

        sep = QWidget(); sep.setFixedHeight(1)
        sep.setStyleSheet("background:#21262d;")
        vbox.addWidget(sep)

        if HAS_WEBENGINE:
            self._view = QWebEngineView()
            self._view.setStyleSheet("background:#000;")
            page = self._view.page()
            settings = page.settings()
            settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, True)
            settings.setAttribute(QWebEngineSettings.WebAttribute.JavascriptEnabled, True)
            self._view.load(QUrl.fromLocalFile(str(_HTML.resolve())))
            vbox.addWidget(self._view, stretch=1)
        else:
            placeholder = QLabel(
                "3D visualizer opens in your browser.\n"
                "Install PySide6-WebEngine to embed it here:\n"
                "  pip install PySide6-WebEngine"
            )
            placeholder.setAlignment(Qt.AlignCenter)
            placeholder.setStyleSheet(
                "color:#545d68; font-size:14px; "
                "background:#0d1117; border:1px solid #21262d; border-radius:8px;"
            )
            vbox.addWidget(placeholder, stretch=1)
            QTimer.singleShot(800, self._open_browser)

        sep2 = QWidget(); sep2.setFixedHeight(1)
        sep2.setStyleSheet("background:#21262d;")
        vbox.addWidget(sep2)

        sb = QHBoxLayout()
        sb.setSpacing(8)

        self._lbl_cur = QLabel("0:00")
        self._lbl_cur.setStyleSheet("color:#545d68; font-size:12px; min-width:34px;")

        self._slider = QSlider(Qt.Horizontal)
        self._slider.setRange(0, 1000)
        self._slider.sliderPressed.connect(lambda: setattr(self, "_slider_dragging", True))
        self._slider.sliderReleased.connect(self._on_seek)
        self._slider.sliderMoved.connect(self._on_slider_moved)

        self._lbl_dur = QLabel("0:00")
        self._lbl_dur.setStyleSheet("color:#545d68; font-size:12px; min-width:34px;")

        sb.addWidget(self._lbl_cur)
        sb.addWidget(self._slider)
        sb.addWidget(self._lbl_dur)
        vbox.addLayout(sb)

    def _open_file(self) -> None:
        if self._worker_thread is not None:
            return
        dlg = QFileDialog(self, "Open audio or video file")
        dlg.setFileMode(QFileDialog.ExistingFile)
        dlg.setNameFilter(_FILTER)
        dlg.setOption(QFileDialog.DontUseNativeDialog, True)
        dlg.setStyleSheet(DIALOG_STYLE)
        if dlg.exec() != QFileDialog.Accepted:
            return
        sel = dlg.selectedFiles()
        if not sel:
            return

        self._source_path = Path(sel[0])
        self._prepared = None
        self._player.stop()
        self._buffer.reset()
        self._live.reset()
        self._btn_play.setText("▶  Play")
        self._btn_play.setEnabled(False)
        self._lbl_cur.setText("0:00")
        self._lbl_dur.setText("0:00")
        self._slider.setValue(0)
        cache_state = self._preprocessor.check_cache(self._source_path)
        self._lbl_file.setText(cache_state.message)
        self._lbl_file.setStyleSheet("color:#58a6ff; font-size:12px;")
        if cache_state.prepared is not None:
            self._start_prepare_worker(source_path=None, prepared_media=cache_state.prepared)
            return

        prompt = QMessageBox.question(
            self,
            "Preprocessing required",
            f"{cache_state.message}\nPreprocessing required.\n\nRun preprocessing now?",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.Yes,
        )
        if prompt == QMessageBox.Yes:
            self._start_prepare_worker(source_path=self._source_path, prepared_media=None)
        else:
            self._lbl_file.setText("Preprocessing required")
            self._lbl_file.setStyleSheet("color:#d29922; font-size:12px;")

    def _open_manual_pair(self) -> None:
        if self._worker_thread is not None:
            return
        media, _ = QFileDialog.getOpenFileName(self, "Open original media", "", _FILTER)
        if not media:
            return
        vocals, _ = QFileDialog.getOpenFileName(self, "Open vocals stem", "", "Audio (*.wav *.mp3 *.flac *.ogg *.m4a *.aac)")
        if not vocals:
            return
        source_path = Path(media)
        vocals_path = Path(vocals)
        self._source_path = source_path
        self._prepared = self._preprocessor.build_external_prepared(source_path, vocals_path)
        self._player.stop()
        self._buffer.reset()
        self._live.reset()
        self._btn_play.setText("▶  Play")
        self._btn_play.setEnabled(False)
        self._lbl_cur.setText("0:00")
        self._lbl_dur.setText("0:00")
        self._slider.setValue(0)
        self._lbl_file.setText("Loading external vocals stem…")
        self._lbl_file.setStyleSheet("color:#58a6ff; font-size:12px;")
        self._start_prepare_worker(source_path=None, prepared_media=self._prepared)

    def _preprocess_only(self) -> None:
        if self._worker_thread is not None:
            return
        sel, _ = QFileDialog.getOpenFileName(self, "Preprocess media file", "", _FILTER)
        if not sel:
            return
        source_path = Path(sel)
        cache_state = self._preprocessor.check_cache(source_path)
        if cache_state.prepared is not None:
            QMessageBox.information(self, "Preprocess media", "Using cached vocals.")
            self._lbl_file.setText("Using cached vocals")
            self._lbl_file.setStyleSheet("color:#58a6ff; font-size:12px;")
            return
        self._source_path = source_path
        self._prepared = None
        self._start_prepare_worker(source_path=source_path, prepared_media=None)

    def _reload_analysis_track_if_ready(self) -> None:
        if self._prepared is None or self._worker_thread is not None:
            return
        self._pending_resume = self._player.is_playing
        self._pending_seek_seconds = self._player.current_time
        self._player.pause()
        self._btn_play.setText("▶  Play")
        self._start_prepare_worker(source_path=None, prepared_media=self._prepared)

    def _analysis_mode(self) -> str:
        return str(self._mode.currentData())

    def _start_prepare_worker(
        self,
        *,
        source_path: Path | None,
        prepared_media: PreparedMedia | None,
    ) -> None:
        mode_label = "vocals" if self._analysis_mode() == "vocals" else "full mix"
        source_name = source_path.name if source_path else (prepared_media.source_path.name if prepared_media else "media")
        self._lbl_file.setText(f"Preparing {mode_label} for {source_name} …")
        self._lbl_file.setStyleSheet("color:#58a6ff; font-size:12px;")
        self._btn_open.setEnabled(False)
        self._btn_open_pair.setEnabled(False)
        self._btn_play.setEnabled(False)
        self._mode.setEnabled(False)

        self._progress = QProgressDialog("Preparing media…", "", 0, 0, self)
        self._progress.setWindowTitle("Offline preprocessing")
        self._progress.setWindowModality(Qt.WindowModal)
        self._progress.setCancelButton(None)
        self._progress.setMinimumDuration(0)
        self._progress.setValue(0)
        self._progress.show()

        self._worker_thread = QThread(self)
        self._worker = _PrepareWorker(source_path, prepared_media, self._analysis_mode())
        self._worker.moveToThread(self._worker_thread)
        self._worker_thread.started.connect(self._worker.run)
        self._worker.progress.connect(self._on_worker_progress)
        self._worker.finished.connect(self._on_worker_finished)
        self._worker.failed.connect(self._on_worker_failed)
        self._worker.finished.connect(self._cleanup_worker)
        self._worker.failed.connect(self._cleanup_worker)
        self._worker_thread.start()

    @Slot(str)
    def _on_worker_progress(self, text: str) -> None:
        if self._progress is not None:
            self._progress.setLabelText(text)
        self._lbl_file.setText(text)
        self._lbl_file.setStyleSheet("color:#58a6ff; font-size:12px;")

    @Slot(object, object)
    def _on_worker_finished(self, prepared: object, tracks: object) -> None:
        assert isinstance(prepared, PreparedMedia)
        assert isinstance(tracks, PreparedTracks)
        self._prepared = prepared
        dur = self._player.load_prepared(tracks)
        if self._pending_seek_seconds > 0:
            self._player.seek(self._pending_seek_seconds)
        if self._pending_resume:
            self._player.play(on_end=lambda: self._btn_play.setText("▶  Play"))
            self._btn_play.setText("⏸  Pause")
        else:
            self._btn_play.setText("▶  Play")

        cache_note = "cached" if prepared.from_cache else f"new {prepared.separator_backend} stems"
        mode_label = "Vocals only" if self._analysis_mode() == "vocals" else "Full mix"
        self._lbl_file.setText(f"{prepared.source_path.name}  ·  {_fmt(dur)}  ·  {mode_label}  ·  {cache_note}")
        self._lbl_file.setStyleSheet("color:#adbac7; font-size:12px;")
        self._lbl_dur.setText(_fmt(dur))
        self._btn_play.setEnabled(True)
        self._pending_seek_seconds = 0.0
        self._pending_resume = False

    @Slot(str)
    def _on_worker_failed(self, message: str) -> None:
        self._lbl_file.setText("Load failed")
        self._lbl_file.setStyleSheet("color:#f85149; font-size:12px;")
        self._pending_seek_seconds = 0.0
        self._pending_resume = False
        QMessageBox.critical(self, "Preprocess error", message)

    @Slot()
    def _cleanup_worker(self) -> None:
        if self._progress is not None:
            self._progress.close()
            self._progress.deleteLater()
            self._progress = None
        self._btn_open.setEnabled(True)
        self._btn_open_pair.setEnabled(True)
        self._mode.setEnabled(True)
        if self._worker_thread is not None:
            self._worker_thread.quit()
            self._worker_thread.wait()
            self._worker_thread.deleteLater()
            self._worker_thread = None
        if self._worker is not None:
            self._worker.deleteLater()
            self._worker = None

    def _toggle_play(self) -> None:
        if self._player.is_playing:
            self._player.pause()
            self._btn_play.setText("▶  Play")
        else:
            self._player.play(on_end=lambda: self._btn_play.setText("▶  Play"))
            self._btn_play.setText("⏸  Pause")

    def _on_frame(self, info: FrameInfo) -> None:
        mel_latest = self._buffer.snapshot()[0][-1]
        self._live.update_from_frame(info, mel_latest)

    def _on_slider_moved(self, v: int) -> None:
        dur = self._player.duration
        if dur > 0:
            self._lbl_cur.setText(_fmt(v / 1000 * dur))

    def _on_seek(self) -> None:
        self._slider_dragging = False
        dur = self._player.duration
        if dur > 0:
            self._player.seek(self._slider.value() / 1000 * dur)

    def _tick_cb(self) -> None:
        dur = self._player.duration
        cur = self._player.current_time
        if dur > 0 and not self._slider_dragging:
            self._slider.blockSignals(True)
            self._slider.setValue(int(cur / dur * 1000))
            self._slider.blockSignals(False)
            self._lbl_cur.setText(_fmt(cur))

    def _open_browser(self) -> None:
        webbrowser.open(_HTML.resolve().as_uri())

    def closeEvent(self, event) -> None:
        self._player.stop()
        if self._worker_thread is not None:
            self._worker_thread.quit()
            self._worker_thread.wait(2000)
        super().closeEvent(event)
