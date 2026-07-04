"""TASK -> handle_task -> RESULT round-trips."""

from __future__ import annotations

import asyncio

import pytest

from gotong import AgentParticipant, connect

from .conftest import FakeHub, serve_hub


class WriterAgent(AgentParticipant):
    def __init__(self) -> None:
        super().__init__(id="writer", capabilities=["draft"])
        self.calls: list[dict] = []

    async def handle_task(self, task: dict) -> dict:
        self.calls.append(task)
        topic = task["payload"]["topic"]
        return {"text": f"on {topic}: hi from python"}


class SyncAgent(AgentParticipant):
    """Synchronous handle_task — SDK must still await the result."""

    def __init__(self) -> None:
        super().__init__(id="sync", capabilities=["sync"])

    def handle_task(self, task: dict) -> dict:
        return {"echo": task["payload"]}


class ThrowingAgent(AgentParticipant):
    def __init__(self) -> None:
        super().__init__(id="thrower", capabilities=["throw"])

    async def handle_task(self, task: dict) -> dict:
        raise RuntimeError("kaboom")


async def test_async_handle_task_returns_ok_result() -> None:
    agent = WriterAgent()

    async def hub(h: FakeHub) -> None:
        await h.expect_hello()
        await h.send_welcome()
        await h.send_task(recipient="writer", task_id="t1", payload={"topic": "X"})
        reply = await h.recv()
        assert reply["type"] == "RESULT"
        result = reply["result"]
        assert result["kind"] == "ok"
        assert result["taskId"] == "t1"
        assert result["by"] == "writer"
        assert result["output"] == {"text": "on X: hi from python"}
        # close the connection so client returns
        await h.ws.close()

    async with serve_hub(hub) as url:
        session = await connect(
            url=url,
            agents=[agent],
            auto_reconnect=False,
        )
        await session.wait_closed()

    assert len(agent.calls) == 1
    assert agent.calls[0]["payload"] == {"topic": "X"}


async def test_sync_handle_task_is_awaited_correctly() -> None:
    async def hub(h: FakeHub) -> None:
        await h.expect_hello()
        await h.send_welcome()
        await h.send_task(recipient="sync", task_id="t2", payload={"x": 1})
        reply = await h.recv()
        assert reply["result"]["kind"] == "ok"
        assert reply["result"]["output"] == {"echo": {"x": 1}}
        await h.ws.close()

    async with serve_hub(hub) as url:
        session = await connect(
            url=url, agents=[SyncAgent()], auto_reconnect=False,
        )
        await session.wait_closed()


async def test_thrown_exception_becomes_failed_result() -> None:
    async def hub(h: FakeHub) -> None:
        await h.expect_hello()
        await h.send_welcome()
        await h.send_task(recipient="thrower", task_id="t3", payload={})
        reply = await h.recv()
        assert reply["type"] == "RESULT"
        assert reply["result"]["kind"] == "failed"
        assert "kaboom" in reply["result"]["error"]
        await h.ws.close()

    async with serve_hub(hub) as url:
        session = await connect(
            url=url, agents=[ThrowingAgent()], auto_reconnect=False,
        )
        await session.wait_closed()


async def test_ping_is_answered_with_pong() -> None:
    async def hub(h: FakeHub) -> None:
        await h.expect_hello()
        await h.send_welcome()
        await h.send_ping(ts=42)
        reply = await h.recv()
        assert reply["type"] == "PONG"
        assert reply["ts"] == 42
        await h.ws.close()

    async with serve_hub(hub) as url:
        session = await connect(
            url=url,
            agents=[WriterAgent()],
            auto_reconnect=False,
        )
        await session.wait_closed()


async def test_cancel_triggers_on_task_cancelled() -> None:
    cancelled: list[tuple[str, str]] = []

    class CancellableAgent(AgentParticipant):
        def __init__(self) -> None:
            super().__init__(id="cx", capabilities=["work"])

        async def on_task_cancelled(self, task_id: str, reason: str) -> None:
            cancelled.append((task_id, reason))

        def handle_task(self, task: dict) -> dict:
            return {}

    async def hub(h: FakeHub) -> None:
        await h.expect_hello()
        await h.send_welcome()
        await h.send_cancel(recipient="cx", task_id="t-cancel", reason="lost_broadcast")
        await asyncio.sleep(0.05)
        await h.ws.close()

    async with serve_hub(hub) as url:
        session = await connect(
            url=url, agents=[CancellableAgent()], auto_reconnect=False,
        )
        await session.wait_closed()

    assert cancelled == [("t-cancel", "lost_broadcast")]
