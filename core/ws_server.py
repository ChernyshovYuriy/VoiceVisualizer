"""
ws_server.py
Asyncio WebSocket server — pushes analysis frames to connected browser clients at 30 fps.
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

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True, name="ws-server")
        self._thread.start()

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(self._serve())

    async def _serve(self) -> None:
        async with websockets.serve(self._handler, HOST, PORT):
            await asyncio.Future()   # run forever

    async def _handler(self, websocket) -> None:
        try:
            while True:
                payload = json.dumps(self._state.snapshot())
                await websocket.send(payload)
                await asyncio.sleep(1 / 30)
        except Exception:
            pass
