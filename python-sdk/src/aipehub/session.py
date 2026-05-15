"""Python equivalent of @aipehub/sdk-node's ``connect()`` and ``Session``.

State machine (mirrors the Node SDK):

    connecting -> ready -> closing -> closed
                    ↘                ↗
                     reconnecting --

Reconnect uses exponential backoff (``reconnect_initial_backoff_ms`` × 2^n,
capped at ``reconnect_max_backoff_ms``). On reconnect, the original HELLO
is re-sent and any in-flight tasks the Hub had dispatched are abandoned —
the Hub's RemoteAgentParticipant will have failed them as
``remote_disconnect``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from typing import Any, Awaitable, Callable, Literal

import websockets

from . import protocol
from .agent import AgentParticipant
from .services import ServiceClient, ServiceUseRequest, to_wire_decls

log = logging.getLogger("aipehub.session")

# Duck-typed connection handle — websockets >= 14 deprecated the named
# WebSocketClientProtocol / WebSocketServerProtocol classes. We treat the
# object returned by ``websockets.connect`` opaquely; only the methods we
# call (send / recv / close / async-iterate, the .closed property) matter.
_WSConnection = Any  # noqa: PYI042


SessionState = Literal[
    "connecting", "ready", "reconnecting", "closing", "closed"
]


class ConnectionRejected(RuntimeError):
    """Raised when the server replies REJECT to our HELLO."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"REJECT {code}: {message}")
        self.code = code
        self.message = message


class Session:
    """Owns one WebSocket connection and its agent set."""

    def __init__(
        self,
        *,
        url: str,
        agents: list[AgentParticipant],
        api_key: str | None = None,
        auto_reconnect: bool = True,
        reconnect_initial_backoff_ms: int = 500,
        reconnect_max_backoff_ms: int = 30_000,
        on_state_change: Callable[[SessionState, dict[str, Any] | None], None] | None = None,
        services: list[ServiceUseRequest] | None = None,
    ) -> None:
        if not agents:
            raise ValueError("connect() requires at least one agent")
        ids = [a.id for a in agents]
        if len(set(ids)) != len(ids):
            raise ValueError(f"duplicate agent ids: {ids}")
        self._url = url
        self._agents: dict[str, AgentParticipant] = {a.id: a for a in agents}
        self._api_key = api_key
        self._auto_reconnect = auto_reconnect
        self._initial_backoff = reconnect_initial_backoff_ms
        self._max_backoff = reconnect_max_backoff_ms
        self._on_state_change = on_state_change
        self._services_decls: list[ServiceUseRequest] = list(services) if services else []

        self._ws: _WSConnection | None = None
        self._state: SessionState = "connecting"
        self._session_id: str | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._closed_event = asyncio.Event()
        self._welcome_event = asyncio.Event()
        self._welcome_error: ConnectionRejected | None = None

        # Build the ServiceClient eagerly (before the socket opens) so agents
        # can read `session.services` immediately after connect() returns —
        # SERVICE_CALL frames just queue against the session and ship as the
        # session sends them. None when no services were declared.
        if self._services_decls:
            default_agent = next(iter(self._agents))
            self.services: ServiceClient | None = ServiceClient(
                declarations=self._services_decls,
                send_call=self._send_service_call,
                default_agent_id=lambda: default_agent,
            )
        else:
            self.services = None

    def _send_service_call(self, frame: dict[str, Any]) -> None:
        """Synchronous send entry point used by ServiceClient. The frame
        is JSON-encoded and pushed onto the websocket; if the socket is
        not open we raise — the ServiceClient surfaces this as
        ``session_not_ready`` to the awaiting handle method.
        """
        ws = self._ws
        if ws is None or not _is_open(ws):
            raise RuntimeError("websocket not connected")
        # ws.send is a coroutine; fire-and-forget the task and let
        # exceptions bubble through the SERVICE_RESULT timeout if delivery
        # never completes.
        asyncio.create_task(ws.send(json.dumps(frame)))

    # ----- public API -------------------------------------------------------

    @property
    def state(self) -> SessionState:
        return self._state

    @property
    def session_id(self) -> str | None:
        return self._session_id

    async def wait_closed(self) -> None:
        """Block until the session reaches the terminal ``closed`` state."""
        await self._closed_event.wait()

    async def close(self, reason: str = "client_close") -> None:
        """Gracefully shut down. Sends GOODBYE if currently connected."""
        if self._state in ("closing", "closed"):
            return
        self._auto_reconnect = False
        self._set_state("closing", {"reason": reason})
        ws = self._ws
        if ws is not None and _is_open(ws):
            with contextlib.suppress(Exception):
                await ws.send(json.dumps(protocol.goodbye(reason)))
            with contextlib.suppress(Exception):
                await ws.close()
        if self._reader_task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                self._reader_task.cancel()
                await self._reader_task
        # Reject every still-pending SERVICE_CALL — awaiters would otherwise
        # hang on their futures forever.
        if self.services is not None:
            self.services.fail_all_pending(reason)
        self._set_state("closed", {"reason": reason})
        self._closed_event.set()

    # ----- lifecycle (internal) --------------------------------------------

    async def _start(self) -> None:
        """Run the connect / reconnect loop until ``close()`` or terminal failure.

        Returns once the first WELCOME has been observed (or on hard failure).
        The loop continues in the background via ``_reader_task``.
        """
        self._reader_task = asyncio.create_task(self._run(), name="aipehub-session")
        # block until WELCOME or REJECT (or transport failure)
        await self._welcome_event.wait()
        if self._welcome_error is not None:
            await self.close(reason="rejected")
            raise self._welcome_error

    async def _run(self) -> None:
        backoff_ms = self._initial_backoff
        first = True
        try:
            while True:
                if not first:
                    self._set_state("reconnecting", {"backoffMs": backoff_ms})
                    await asyncio.sleep(backoff_ms / 1000)
                first = False
                try:
                    await self._one_connection()
                    # _one_connection returns normally only on graceful goodbye
                    return
                except ConnectionRejected:
                    # REJECT is terminal — don't reconnect on an auth/bad-hello error
                    raise
                except Exception as err:  # noqa: BLE001
                    log.warning("connection error: %s", err)
                    if not self._auto_reconnect:
                        return
                    backoff_ms = min(backoff_ms * 2, self._max_backoff)
        finally:
            if self._state not in ("closing", "closed"):
                self._set_state("closed", {"reason": "loop_exit"})
            self._closed_event.set()
            # If we exited without ever WELCOMEing, unblock _start()
            self._welcome_event.set()

    async def _one_connection(self) -> None:
        self._set_state("connecting", None)
        async with websockets.connect(self._url) as ws:
            self._ws = ws
            await ws.send(json.dumps(protocol.hello(
                agents=[{"id": a.id, "capabilities": a.capabilities} for a in self._agents.values()],
                api_key=self._api_key,
                services=to_wire_decls(self._services_decls) if self._services_decls else None,
            )))
            # await first server frame: WELCOME or REJECT
            try:
                first = await asyncio.wait_for(ws.recv(), timeout=protocol.HELLO_TIMEOUT_MS / 1000)
            except asyncio.TimeoutError:
                raise RuntimeError(
                    f"no WELCOME within {protocol.HELLO_TIMEOUT_MS}ms",
                ) from None
            frame = _safe_decode(first)
            if frame is None:
                raise RuntimeError("invalid first frame from server")
            ftype = frame.get("type")
            if ftype == "REJECT":
                err = ConnectionRejected(frame.get("code", "?"), frame.get("message", ""))
                if not self._welcome_event.is_set():
                    self._welcome_error = err
                    self._welcome_event.set()
                raise err
            if ftype != "WELCOME":
                raise RuntimeError(f"expected WELCOME, got {ftype}")
            self._session_id = frame.get("sessionId")
            self._set_state("ready", {"sessionId": self._session_id})
            self._welcome_event.set()

            # main loop: dispatch frames + heartbeat is server-driven (we just PONG)
            async for raw in ws:
                msg = _safe_decode(raw)
                if msg is None:
                    continue
                await self._on_frame(msg)
            # ws closed cleanly — fall through; _run() decides about reconnect

    async def _on_frame(self, frame: dict[str, Any]) -> None:
        t = frame.get("type")
        if t == "TASK":
            asyncio.create_task(self._handle_task_frame(frame))
        elif t == "SERVICE_RESULT":
            # Hand back to the ServiceClient pending-call table. Tolerated
            # if the client never instantiated services — late results
            # from a previous session are dropped silently.
            if self.services is not None:
                self.services.attach_result(frame)
        elif t == "CANCEL":
            recipient = frame.get("recipient")
            agent = self._agents.get(recipient) if isinstance(recipient, str) else None
            if agent is not None:
                with contextlib.suppress(Exception):
                    await agent.on_task_cancelled(
                        frame.get("taskId", ""),
                        frame.get("reason", "cancelled"),
                    )
        elif t == "MESSAGE":
            recipient = frame.get("recipient")
            agent = self._agents.get(recipient) if isinstance(recipient, str) else None
            if agent is not None:
                with contextlib.suppress(Exception):
                    await agent.on_message(frame.get("msg", {}))
        elif t == "PING":
            ws = self._ws
            if ws is not None and _is_open(ws):
                with contextlib.suppress(Exception):
                    await ws.send(json.dumps(protocol.pong(frame.get("ts", int(time.time() * 1000)))))
        elif t == "GOODBYE":
            # server-initiated graceful close
            ws = self._ws
            if ws is not None and _is_open(ws):
                with contextlib.suppress(Exception):
                    await ws.close()

    async def _handle_task_frame(self, frame: dict[str, Any]) -> None:
        recipient = frame.get("recipient")
        task = frame.get("task")
        if not isinstance(recipient, str) or not isinstance(task, dict):
            return
        agent = self._agents.get(recipient)
        if agent is None:
            return
        try:
            result_body = await agent.on_task(task)
        except Exception as err:  # noqa: BLE001 — should be caught by on_task; defense-in-depth
            result_body = {
                "kind": "failed",
                "taskId": task.get("id", ""),
                "by": agent.id,
                "error": str(err),
                "ts": int(time.time() * 1000),
            }
        ws = self._ws
        if ws is not None and _is_open(ws):
            with contextlib.suppress(Exception):
                await ws.send(json.dumps(protocol.result_frame(result_body)))

    def _set_state(self, new: SessionState, info: dict[str, Any] | None) -> None:
        if new == self._state:
            return
        self._state = new
        if self._on_state_change is not None:
            try:
                self._on_state_change(new, info)
            except Exception:  # noqa: BLE001
                log.exception("on_state_change raised; ignoring")


async def connect(
    *,
    url: str,
    agents: list[AgentParticipant],
    api_key: str | None = None,
    auto_reconnect: bool = True,
    reconnect_initial_backoff_ms: int = 500,
    reconnect_max_backoff_ms: int = 30_000,
    on_state_change: Callable[[SessionState, dict[str, Any] | None], None] | None = None,
    services: list[ServiceUseRequest] | None = None,
) -> Session:
    """Open a session, send HELLO, await WELCOME, return the live ``Session``.

    Raises ``ConnectionRejected`` on REJECT, or ``RuntimeError`` on transport
    failure before the first WELCOME. After WELCOME, transient WebSocket
    failures are handled by the SDK (auto-reconnect with exponential backoff)
    unless ``auto_reconnect=False``.

    ``services`` (v1.1) is the list of Hub Services this connection wants
    to call. Each entry is a :class:`aipehub.services.ServiceUseRequest`.
    See ``docs/AGENT.md`` for the model.

    Caller is expected to ``await session.wait_closed()`` if it needs to
    keep the process alive, or build its own join logic.
    """
    session = Session(
        url=url,
        agents=agents,
        api_key=api_key,
        auto_reconnect=auto_reconnect,
        reconnect_initial_backoff_ms=reconnect_initial_backoff_ms,
        reconnect_max_backoff_ms=reconnect_max_backoff_ms,
        on_state_change=on_state_change,
        services=services,
    )
    await session._start()
    return session


def _is_open(ws: Any) -> bool:
    """Best-effort 'is the socket still usable for send' check.

    The websockets library renamed/removed ``.closed`` in v14; modern
    connections expose ``.state`` (a State enum) and ``.close_code``. We
    duck-type against both new and old shapes.
    """
    state = getattr(ws, "state", None)
    if state is not None:
        name = getattr(state, "name", str(state))
        return name == "OPEN"
    # very old websockets — fall back to .closed (negated)
    closed = getattr(ws, "closed", None)
    if closed is not None:
        return not closed
    # cannot determine — assume open and let send/close exceptions speak
    return True


def _safe_decode(raw: str | bytes) -> dict[str, Any] | None:
    try:
        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode("utf-8")
        data = json.loads(raw)
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(data, dict):
        return None
    return data
