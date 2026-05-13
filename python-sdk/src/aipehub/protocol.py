"""Wire-protocol shapes for AipeHub.

Mirrors `@aipehub/protocol` (TypeScript) exactly — frame names, field names,
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

PROTOCOL_VERSION = "1.0"
DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
HELLO_TIMEOUT_MS = 5_000
MAX_MISSED_PINGS = 2


def major_version_of(v: str) -> str:
    return v.split(".", 1)[0]


# --- outbound frame builders (client -> server) -----------------------------

def hello(
    *,
    agents: list[dict[str, Any]],
    client_name: str = "aipehub-python",
    client_version: str = "0.5.0",
    api_key: str | None = None,
) -> dict[str, Any]:
    frame: dict[str, Any] = {
        "type": "HELLO",
        "protocolVersion": PROTOCOL_VERSION,
        "client": {"name": client_name, "version": client_version},
        "agents": agents,
    }
    if api_key is not None:
        frame["apiKey"] = api_key
    return frame


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
