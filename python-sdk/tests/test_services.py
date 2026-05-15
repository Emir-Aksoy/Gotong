"""Tests for the Python SDK's protocol v1.1 services support.

We drive a fake Hub that:
  1. Asserts HELLO carries the expected ``services`` declarations.
  2. Replies WELCOME.
  3. Reads SERVICE_CALL frames the SDK ships out, fabricates SERVICE_RESULT
     frames in response.

This exercises ``ServiceClient`` end-to-end at the wire level without
needing a real host process / disk plugin.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from aipehub import (
    AgentParticipant,
    ServiceCallError,
    ServiceOwner,
    ServiceUseRequest,
    connect,
)
from aipehub.protocol import PROTOCOL_VERSION

from .conftest import serve_hub


class _NoopAgent(AgentParticipant):
    def __init__(self) -> None:
        super().__init__(id="py-sidecar", capabilities=["noop"])

    async def handle_task(self, task: dict) -> dict:
        return {"echo": task.get("payload")}


# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hello_carries_services_declarations() -> None:
    """HELLO.services must be on the wire when ``services=[...]`` is passed.

    Validates the per-decl shape: ``type``, ``impl``, ``owner.kind/id``,
    optional ``config``. Owner ``'self'`` is sent VERBATIM (server-side
    substitution is the contract).
    """
    captured = asyncio.Future()

    async def hub_handler(fake) -> None:
        hello = await fake.expect_hello()
        captured.set_result(hello)
        await fake.send_welcome()
        # keep the connection alive briefly so the SDK doesn't loop
        await asyncio.sleep(0.05)

    async with serve_hub(hub_handler) as url:
        session = await connect(
            url=url,
            agents=[_NoopAgent()],
            auto_reconnect=False,
            services=[
                ServiceUseRequest(
                    type="memory",
                    impl="file",
                    owner=ServiceOwner("agent", "self"),
                ),
                ServiceUseRequest(
                    type="datastore",
                    impl="sqlite",
                    owner=ServiceOwner("agent", "self"),
                    config={"name": "cases"},
                ),
            ],
        )
        try:
            hello = await asyncio.wait_for(captured, timeout=2)
            assert hello["protocolVersion"] == PROTOCOL_VERSION
            assert hello["services"] == [
                {
                    "type": "memory",
                    "impl": "file",
                    "owner": {"kind": "agent", "id": "self"},
                },
                {
                    "type": "datastore",
                    "impl": "sqlite",
                    "owner": {"kind": "agent", "id": "self"},
                    "config": {"name": "cases"},
                },
            ]
            assert session.services is not None
        finally:
            await session.close()


@pytest.mark.asyncio
async def test_memory_recall_roundtrip_resolves_call() -> None:
    """A ``memory.recall`` call ships a SERVICE_CALL frame; SERVICE_RESULT
    with ``ok:true`` resolves the awaiter with the wire value.
    """
    async def hub_handler(fake) -> None:
        await fake.expect_hello()
        await fake.send_welcome()
        raw = await fake.recv()
        assert raw["type"] == "SERVICE_CALL"
        assert raw["service"]["type"] == "memory"
        assert raw["method"] == "recall"
        assert raw["service"]["owner"] == {"kind": "agent", "id": "py-sidecar"}
        # Echo a fake result back.
        await fake.ws.send(
            json.dumps(
                {
                    "type": "SERVICE_RESULT",
                    "callId": raw["callId"],
                    "ok": True,
                    "value": [{"id": "e1", "text": "prior thought"}],
                }
            )
        )
        await asyncio.sleep(0.05)

    async with serve_hub(hub_handler) as url:
        session = await connect(
            url=url,
            agents=[_NoopAgent()],
            auto_reconnect=False,
            services=[
                ServiceUseRequest(
                    type="memory", impl="file", owner=ServiceOwner("agent", "self"),
                ),
            ],
        )
        try:
            assert session.services is not None
            # `self` is resolved to the agent id eagerly for the static-owner
            # convenience handle, so this should Just Work.
            result = await session.services.memory.recall({"k": 5})
            assert result == [{"id": "e1", "text": "prior thought"}]
        finally:
            await session.close()


@pytest.mark.asyncio
async def test_service_call_error_propagates_code() -> None:
    """SERVICE_RESULT.ok:false → ServiceCallError with .code set."""
    async def hub_handler(fake) -> None:
        await fake.expect_hello()
        await fake.send_welcome()
        raw = await fake.recv()
        await fake.ws.send(
            json.dumps(
                {
                    "type": "SERVICE_RESULT",
                    "callId": raw["callId"],
                    "ok": False,
                    "error": {"code": "forbidden_owner", "message": "nope"},
                }
            )
        )
        await asyncio.sleep(0.05)

    async with serve_hub(hub_handler) as url:
        session = await connect(
            url=url,
            agents=[_NoopAgent()],
            auto_reconnect=False,
            services=[
                ServiceUseRequest(
                    type="memory", impl="file", owner=ServiceOwner("workflow-run", "*"),
                ),
            ],
        )
        try:
            mem = session.services.memory_for(
                "file", ServiceOwner("workflow-run", "case-42")
            )
            with pytest.raises(ServiceCallError) as exc:
                await mem.recall({"k": 1})
            assert exc.value.code == "forbidden_owner"
        finally:
            await session.close()


@pytest.mark.asyncio
async def test_custom_for_dispatches_third_party_method() -> None:
    """Third-party types use ``custom_for(...).call(method, *args)``. The
    SDK doesn't know the method names; the host's plugin allowlist gates.
    """
    async def hub_handler(fake) -> None:
        await fake.expect_hello()
        await fake.send_welcome()
        raw = await fake.recv()
        assert raw["service"]["type"] == "notion"
        assert raw["method"] == "pages.create"
        assert raw["args"] == [{"title": "hi"}]
        await fake.ws.send(
            json.dumps(
                {
                    "type": "SERVICE_RESULT",
                    "callId": raw["callId"],
                    "ok": True,
                    "value": {"id": "p1"},
                }
            )
        )
        await asyncio.sleep(0.05)

    async with serve_hub(hub_handler) as url:
        session = await connect(
            url=url,
            agents=[_NoopAgent()],
            auto_reconnect=False,
            services=[
                ServiceUseRequest(
                    type="notion", impl="official", owner=ServiceOwner("agent", "self"),
                ),
            ],
        )
        try:
            assert session.services is not None
            handle = session.services.custom_for(
                "notion", "official", ServiceOwner("agent", "py-sidecar")
            )
            value = await handle.call("pages.create", {"title": "hi"})
            assert value == {"id": "p1"}
        finally:
            await session.close()


@pytest.mark.asyncio
async def test_pending_call_rejects_on_close() -> None:
    """Pending SERVICE_CALL awaiters reject with session_not_ready when
    ``session.close()`` is invoked before SERVICE_RESULT arrives.
    """
    async def hub_handler(fake) -> None:
        await fake.expect_hello()
        await fake.send_welcome()
        # Read but never reply.
        await fake.recv()
        await asyncio.sleep(0.3)

    async with serve_hub(hub_handler) as url:
        session = await connect(
            url=url,
            agents=[_NoopAgent()],
            auto_reconnect=False,
            services=[
                ServiceUseRequest(
                    type="memory", impl="file", owner=ServiceOwner("agent", "self"),
                ),
            ],
        )
        try:
            assert session.services is not None
            task = asyncio.create_task(session.services.memory.recall({"k": 1}))
            await asyncio.sleep(0.05)
            # Close — pending call should reject.
            await session.close()
            with pytest.raises(ServiceCallError) as exc:
                await task
            assert exc.value.code == "session_not_ready"
        finally:
            if session.state != "closed":
                await session.close()
