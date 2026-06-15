"""WebSocket broadcast manager and endpoint with per-TF subscription routing."""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from config import TIMEFRAMES, PRIMARY_TIMEFRAME

logger = logging.getLogger(__name__)
router = APIRouter()

# Each connection tracks the timeframe it has subscribed to. Messages tagged
# with a `timeframe` field are only delivered to matching subscribers; messages
# without a `timeframe` (system-level / global) are delivered to all.
_subscriptions: dict[WebSocket, str] = {}
_lock = asyncio.Lock()


async def broadcast(payload: dict[str, Any]) -> None:
    """Send a JSON message to connected WebSocket clients.

    Routing rule:
      - If `payload["data"]["timeframe"]` is set, only clients subscribed to
        that exact timeframe receive the message.
      - Otherwise (system messages, unscoped events), all clients receive it.

    Sends to all matching clients concurrently via asyncio.gather for lower
    latency when multiple clients are connected.
    """
    message = json.dumps(payload)
    msg_tf: str | None = None
    data = payload.get("data")
    if isinstance(data, dict):
        msg_tf = data.get("timeframe")

    async with _lock:
        targets = [
            ws for ws, sub_tf in _subscriptions.items()
            if msg_tf is None or sub_tf == msg_tf
        ]

    if not targets:
        return

    async def _send(ws: WebSocket) -> WebSocket | None:
        try:
            await ws.send_text(message)
            return None
        except Exception:
            return ws

    results = await asyncio.gather(*[_send(ws) for ws in targets])
    dead = [ws for ws in results if ws is not None]
    if dead:
        async with _lock:
            for ws in dead:
                _subscriptions.pop(ws, None)


def _parse_subscribe(text: str) -> str | None:
    """Parse a subscribe message; return the requested TF or None if invalid."""
    try:
        msg = json.loads(text)
    except (ValueError, TypeError):
        return None
    if not isinstance(msg, dict):
        return None
    tf = msg.get("subscribe_tf")
    if isinstance(tf, str) and tf in TIMEFRAMES:
        return tf
    return None


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    # Allow optional ?tf=5m query-string subscription on connect; defaults to PRIMARY
    initial_tf = websocket.query_params.get("tf", PRIMARY_TIMEFRAME)
    if initial_tf not in TIMEFRAMES:
        initial_tf = PRIMARY_TIMEFRAME

    await websocket.accept()
    async with _lock:
        _subscriptions[websocket] = initial_tf
    logger.info("WS client connected tf=%s (%d total)", initial_tf, len(_subscriptions))

    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
                continue
            new_tf = _parse_subscribe(data)
            if new_tf is not None:
                async with _lock:
                    _subscriptions[websocket] = new_tf
                await websocket.send_text(json.dumps({"type": "subscribed", "timeframe": new_tf}))
                logger.info("WS client re-subscribed tf=%s", new_tf)
    except WebSocketDisconnect:
        pass
    finally:
        async with _lock:
            _subscriptions.pop(websocket, None)
        logger.info("WS client disconnected (%d total)", len(_subscriptions))
