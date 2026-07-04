"""Base class for Python agents that participate in an Gotong Hub.

Mirrors @gotong/sdk-node's ``AgentParticipant``: subclass it, override
``handle_task`` (and optionally ``handle_message`` / ``on_task_cancelled``),
register it through ``connect(agents=[...])``. The SDK runs ``handle_task``
on the asyncio event loop; you can ``async def`` or ``def`` it — sync
functions are wrapped automatically.

The SDK is the only thing that talks to the wire; agents only see neutral
``Task`` / ``Message`` dicts that mirror the TypeScript types one-for-one.
"""

from __future__ import annotations

import inspect
from typing import Any, Awaitable, Callable

Task = dict[str, Any]
Message = dict[str, Any]


class AgentParticipant:
    """Inherit, set ``id`` + ``capabilities``, implement ``handle_task``.

    Example::

        class WriterAgent(AgentParticipant):
            def __init__(self) -> None:
                super().__init__(id="writer-py", capabilities=["draft"])

            async def handle_task(self, task: Task) -> dict:
                topic = task["payload"]["topic"]
                return {"text": f"on {topic}: ..."}
    """

    id: str
    capabilities: list[str]

    def __init__(self, *, id: str, capabilities: list[str] | None = None) -> None:
        self.id = id
        self.capabilities = list(capabilities) if capabilities else []

    async def on_task(self, task: Task) -> dict[str, Any]:
        """Wraps ``handle_task`` and produces a `TaskResult`-shaped dict.

        Override this directly if you need full control over the envelope
        (e.g. emit partial results, custom error semantics).
        """
        import time
        try:
            output = await _maybe_await(self.handle_task(task))
            return {
                "kind": "ok",
                "taskId": task["id"],
                "by": self.id,
                "output": output,
                "ts": int(time.time() * 1000),
            }
        except Exception as err:  # noqa: BLE001 — any agent error becomes a failed result
            return {
                "kind": "failed",
                "taskId": task["id"],
                "by": self.id,
                "error": str(err),
                "ts": int(time.time() * 1000),
            }

    # -- override points -----------------------------------------------------

    def handle_task(self, task: Task) -> Any:  # noqa: ARG002 -- abstract-ish
        """Do the actual work. Returns the result payload, or raises on failure.

        Override in subclasses. The default raises ``NotImplementedError`` —
        listen-only agents are valid in the Participant model, but a `handle_task`
        that's missing is almost always a bug.
        """
        raise NotImplementedError(
            f"{type(self).__name__}.handle_task is not implemented",
        )

    async def on_message(self, msg: Message) -> None:
        """Override to consume broadcast / channel messages. Default: ignore."""
        return

    async def on_task_cancelled(self, task_id: str, reason: str) -> None:  # noqa: ARG002
        """Hook for broadcast losers. Default: no-op."""
        return


async def _maybe_await(value: Any | Awaitable[Any]) -> Any:
    """Await ``value`` if it's a coroutine / awaitable, else return as-is.

    Lets ``handle_task`` be either ``async def`` or plain ``def``.
    """
    if inspect.isawaitable(value):
        return await value
    return value


# Re-export for type-hinting convenience
TaskHandler = Callable[[Task], Awaitable[dict[str, Any]] | dict[str, Any]]
