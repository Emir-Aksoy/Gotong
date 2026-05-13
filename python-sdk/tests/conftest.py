"""Pytest fixtures for AipeHub Python SDK tests.

We stand up a real ``websockets`` server inside each test that plays the
role of the Hub: validates HELLO, sends WELCOME (or REJECT), forwards
TASKs from the test body, and asserts on RESULTs. This keeps the SDK
exercised against a real WebSocket, not a mock.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Awaitable, Callable

import pytest_asyncio
import websockets

from aipehub.protocol import PROTOCOL_VERSION


class FakeHub:
    """Driver for one accepted client connection."""

    def __init__(self, ws: Any) -> None:
        self.ws = ws
        self.hello: dict[str, Any] | None = None

    async def expect_hello(self) -> dict[str, Any]:
        raw = await asyncio.wait_for(self.ws.recv(), timeout=5)
        msg = json.loads(raw)
        assert msg["type"] == "HELLO"
        self.hello = msg
        return msg

    async def send_welcome(self) -> None:
        await self.ws.send(
            json.dumps(
                {
                    "type": "WELCOME",
                    "sessionId": "s_test",
                    "protocolVersion": PROTOCOL_VERSION,
                    "serverTime": 0,
                    "heartbeatIntervalMs": 30_000,
                },
            ),
        )

    async def send_reject(self, code: str, message: str) -> None:
        await self.ws.send(json.dumps({"type": "REJECT", "code": code, "message": message}))
        await self.ws.close()

    async def send_task(
        self,
        *,
        recipient: str,
        task_id: str,
        payload: Any,
        title: str | None = None,
    ) -> None:
        await self.ws.send(
            json.dumps(
                {
                    "type": "TASK",
                    "recipient": recipient,
                    "task": {
                        "id": task_id,
                        "from": "system",
                        "strategy": {"kind": "explicit", "to": recipient},
                        "payload": payload,
                        "title": title,
                        "createdAt": 0,
                    },
                },
            ),
        )

    async def send_cancel(self, *, recipient: str, task_id: str, reason: str = "cancelled") -> None:
        await self.ws.send(
            json.dumps(
                {
                    "type": "CANCEL",
                    "recipient": recipient,
                    "taskId": task_id,
                    "reason": reason,
                },
            ),
        )

    async def send_ping(self, ts: int = 0) -> None:
        await self.ws.send(json.dumps({"type": "PING", "ts": ts}))

    async def recv(self) -> dict[str, Any]:
        raw = await asyncio.wait_for(self.ws.recv(), timeout=5)
        return json.loads(raw)


@asynccontextmanager
async def serve_hub(
    handler: Callable[[FakeHub], Awaitable[None]],
) -> AsyncIterator[str]:
    """Run a fake Hub on an ephemeral port and yield its ws:// URL."""
    started = asyncio.Event()
    url: list[str] = []

    async def on_connect(ws: Any) -> None:
        await handler(FakeHub(ws))

    server = await websockets.serve(on_connect, host="127.0.0.1", port=0)
    try:
        port = server.sockets[0].getsockname()[1]
        url.append(f"ws://127.0.0.1:{port}")
        started.set()
        yield url[0]
    finally:
        server.close()
        await server.wait_closed()


@pytest_asyncio.fixture
async def hub_factory():
    """Yield a callable that starts a fake Hub with a custom handler."""
    return serve_hub
