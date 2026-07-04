"""HELLO / WELCOME / REJECT round-trips."""

from __future__ import annotations

import asyncio

import pytest

from gotong import AgentParticipant, ConnectionRejected, connect
from gotong.protocol import PROTOCOL_VERSION

from .conftest import FakeHub, serve_hub


class NoopAgent(AgentParticipant):
    def handle_task(self, task: dict) -> dict:
        return {"ok": True}


async def test_hello_welcome_returns_ready_session() -> None:
    async def hub(h: FakeHub) -> None:
        hello = await h.expect_hello()
        assert hello["protocolVersion"] == PROTOCOL_VERSION
        assert hello["agents"][0]["id"] == "a1"
        await h.send_welcome()
        # Park the connection until the client closes.
        try:
            async for _ in h.ws:
                pass
        except Exception:
            pass

    async with serve_hub(hub) as url:
        session = await connect(
            url=url,
            agents=[NoopAgent(id="a1", capabilities=["work"])],
            auto_reconnect=False,
        )
        assert session.state == "ready"
        assert session.session_id == "s_test"
        await session.close()
        assert session.state == "closed"


async def test_hello_with_apikey_forwards_to_server() -> None:
    received: dict[str, str] = {}

    async def hub(h: FakeHub) -> None:
        hello = await h.expect_hello()
        received["apiKey"] = hello.get("apiKey", "<none>")
        await h.send_welcome()
        try:
            async for _ in h.ws:
                pass
        except Exception:
            pass

    async with serve_hub(hub) as url:
        session = await connect(
            url=url,
            agents=[NoopAgent(id="a1")],
            api_key="sekrit",
            auto_reconnect=False,
        )
        await session.close()

    assert received["apiKey"] == "sekrit"


async def test_reject_raises_connection_rejected() -> None:
    async def hub(h: FakeHub) -> None:
        await h.expect_hello()
        await h.send_reject("auth_failed", "bad key")

    async with serve_hub(hub) as url:
        with pytest.raises(ConnectionRejected) as exc:
            await connect(
                url=url,
                agents=[NoopAgent(id="a1")],
                auto_reconnect=False,
            )
        assert exc.value.code == "auth_failed"
        assert "bad key" in exc.value.message


async def test_empty_agents_list_raises_value_error() -> None:
    with pytest.raises(ValueError):
        # never reaches the network
        await connect(url="ws://127.0.0.1:1", agents=[], auto_reconnect=False)


async def test_duplicate_local_agent_ids_raises_value_error() -> None:
    with pytest.raises(ValueError):
        await connect(
            url="ws://127.0.0.1:1",
            agents=[NoopAgent(id="dup"), NoopAgent(id="dup")],
            auto_reconnect=False,
        )
