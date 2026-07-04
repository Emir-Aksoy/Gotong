"""Wire-protocol shapes for Gotong.

Mirrors `@gotong/protocol` (TypeScript) exactly — frame names, field names,
and discriminator values are all on the wire and MUST match. See
docs/PROTOCOL.md at the repo root.

For the Python SDK we use plain ``dict``s on the wire and helper builder
functions for outbound frames. Inbound frames are decoded via ``json.loads``
into ``dict[str, Any]`` and dispatched by the ``type`` field. We don't need
runtime validation beyond a ``type`` discriminator; the Hub is the source
of truth for shape, and any extra fields are tolerated for forward compat.
"""

from __future__ import annotations

from typing import Any

PROTOCOL_VERSION = "1.2"
DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
HELLO_TIMEOUT_MS = 5_000
MAX_MISSED_PINGS = 2
DEFAULT_SERVICE_CALL_TIMEOUT_MS = 30_000


def major_version_of(v: str) -> str:
    return v.split(".", 1)[0]


def _default_client_version() -> str:
    # Read the wheel's `__version__` rather than hard-coding here so
    # the HELLO.client.version always matches the installed package.
    # Pre-3.1 this was a hand-baked literal that drifted from the
    # pyproject + dunder (P5 in the v3.1 audit).
    from . import __version__
    return __version__


# --- outbound frame builders (client -> server) -----------------------------

def hello(
    *,
    agents: list[dict[str, Any]],
    client_name: str = "gotong-python",
    client_version: str | None = None,
    api_key: str | None = None,
    services: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build a HELLO frame.

    ``services`` (v1.1) declares which Hub Services this connection wants
    to call. Shape mirrors `@gotong/protocol`'s ``ServiceUseDecl``: each
    entry is ``{type, impl, owner: {kind, id}, config?}``. Omit (or pass
    None / empty list) for v1.0-compatible behaviour — no service ACL,
    SERVICE_CALL frames will get ``forbidden_service``.
    """
    resolved_version = client_version if client_version is not None else _default_client_version()
    frame: dict[str, Any] = {
        "type": "HELLO",
        "protocolVersion": PROTOCOL_VERSION,
        "client": {"name": client_name, "version": resolved_version},
        "agents": agents,
    }
    if api_key is not None:
        frame["apiKey"] = api_key
    if services:
        frame["services"] = services
    return frame


def service_call(
    *,
    call_id: str,
    from_agent: str,
    service_type: str,
    impl: str,
    owner: dict[str, str],
    method: str,
    args: list[Any],
) -> dict[str, Any]:
    """Build a SERVICE_CALL frame (v1.1)."""
    return {
        "type": "SERVICE_CALL",
        "callId": call_id,
        "from": from_agent,
        "service": {"type": service_type, "impl": impl, "owner": owner},
        "method": method,
        "args": args,
    }


def result(*, kind: str, task_id: str, by: str | None = None, **extras: Any) -> dict[str, Any]:
    """Build a RESULT frame's `result` payload.

    Caller is responsible for the wire-protocol shape of the result object;
    we just stitch the envelope. Use ``send_result`` on Session, not this
    helper, in normal code.
    """
    body: dict[str, Any] = {"kind": kind, "taskId": task_id, "ts": _now_ms()}
    if by is not None:
        body["by"] = by
    body.update(extras)
    return body


def pong(ts: int) -> dict[str, Any]:
    return {"type": "PONG", "ts": ts}


def ping(ts: int) -> dict[str, Any]:
    return {"type": "PING", "ts": ts}


def goodbye(reason: str | None = None) -> dict[str, Any]:
    frame: dict[str, Any] = {"type": "GOODBYE"}
    if reason is not None:
        frame["reason"] = reason
    return frame


def result_frame(result_body: dict[str, Any]) -> dict[str, Any]:
    return {"type": "RESULT", "result": result_body}


# --- helpers ----------------------------------------------------------------

def _now_ms() -> int:
    import time
    return int(time.time() * 1000)
