"""
ws_server.py
Push-on-update WebSocket server — sends a frame immediately when LiveState
is updated (triggered by the analyzer), rather than polling at a fixed rate.
This removes the 1/30 s polling delay and matches the actual analysis cadence.
"""

from __future__ import annotations
import asyncio
import json
import threading

try:
    import websockets
    HAS_WEBSOCKETS = True
except ImportError:
    HAS_WEBSOCKETS = False

from core.live_state import LiveState

HOST = "localhost"
PORT = 8765


class WSServer:
    def __init__(self, state: LiveState) -> None:
        if not HAS_WEBSOCKETS:
            raise RuntimeError(
                "websockets package is not installed.\n"
                "Run:  pip install websockets"
            )
        self._state = state
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._clients: set = set()
        self._lock = threading.Lock()
        # LiveState calls this after each update_from_frame
        self._state.on_update = self._notify

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True, name="ws-server")
        self._thread.start()

    def _run(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._serve())

    async def _serve(self) -> None:
        async with websockets.serve(self._handler, HOST, PORT):
            await asyncio.Future()   # run forever

    async def _handler(self, websocket) -> None:
        with self._lock:
            self._clients.add(websocket)
        try:
            # Send current state immediately on connect
            await websocket.send(json.dumps(self._state.snapshot()))
            await websocket.wait_closed()
        except Exception:
            pass
        finally:
            with self._lock:
                self._clients.discard(websocket)

    def _notify(self) -> None:
        """Called from analyzer thread after each frame. Schedules a broadcast."""
        loop = self._loop
        if loop is None or not loop.is_running():
            return
        payload = json.dumps(self._state.snapshot())
        loop.call_soon_threadsafe(self._broadcast, payload)

    def _broadcast(self, payload: str) -> None:
        with self._lock:
            clients = list(self._clients)
        for ws in clients:
            asyncio.ensure_future(self._send_safe(ws, payload))

    @staticmethod
    async def _send_safe(ws, payload: str) -> None:
        try:
            await ws.send(payload)
        except Exception:
            pass
