"""Expose a compiled LangGraph graph as an AipeHub Participant.

LangGraph and AipeHub model the same thing from two ends: LangGraph builds a
stateful graph of steps *inside* one process; AipeHub routes a Task to
*whichever* participant serves a capability and writes a transcript. This
adapter is the seam — it lets a LangGraph graph join a Hub as a first-class
agent without the Hub knowing it's a graph, and without this SDK taking a
runtime dependency on ``langgraph``.

The graph is duck-typed: anything with ``.invoke(state) -> dict`` works (the
shape every compiled ``StateGraph`` exposes), and ``.ainvoke`` is preferred
when present so an async graph stays on the event loop. That keeps the adapter
testable with a one-line fake and keeps ``langgraph`` an *optional* peer
dependency the user installs only for real graphs.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Protocol

from ..agent import AgentParticipant, Task


class _CompiledGraph(Protocol):
    """The slice of a LangGraph compiled graph this adapter calls.

    A Protocol (not an import of ``langgraph``) so the adapter type-checks
    against both the real ``CompiledStateGraph`` and the fakes in tests.
    """

    def invoke(self, state: Any, /, *args: Any, **kwargs: Any) -> Any: ...


# Map an AipeHub Task to the graph's input state, and the graph's final state
# back to the Task output. Defaults pass the payload straight through (a
# LangGraph state IS just a dict) and return the whole final state — callers
# override when the graph speaks a different shape (e.g. ``{"messages": [...]}``).
StateMapper = Callable[[Task], Any]
OutputMapper = Callable[[Any], Any]


def _default_to_state(task: Task) -> Any:
    return task.get("payload") or {}


def _default_from_state(state: Any) -> Any:
    return state


class LangGraphParticipant(AgentParticipant):
    """An AipeHub agent backed by a compiled LangGraph graph.

    Prefer the ``langgraph_participant`` factory; this class is exported for
    ``isinstance`` checks and subclassing.
    """

    def __init__(
        self,
        graph: _CompiledGraph,
        *,
        id: str,
        capabilities: list[str] | None = None,
        to_state: StateMapper | None = None,
        from_state: OutputMapper | None = None,
        config: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(id=id, capabilities=capabilities)
        self._graph = graph
        self._to_state = to_state or _default_to_state
        self._from_state = from_state or _default_from_state
        # LangGraph's per-invocation config (e.g. a checkpointer thread_id).
        # Forwarded only when set so a fake graph can stay ``invoke(state)``.
        self._config = config

    async def handle_task(self, task: Task) -> Any:
        state = self._to_state(task)
        kwargs = {"config": self._config} if self._config is not None else {}
        ainvoke = getattr(self._graph, "ainvoke", None)
        if callable(ainvoke):
            final = await ainvoke(state, **kwargs)
        else:
            # A sync graph does blocking LLM I/O; run it off the event loop so
            # one graph doesn't stall the other agents sharing this connection.
            final = await asyncio.to_thread(self._graph.invoke, state, **kwargs)
        return self._from_state(final)


def langgraph_participant(
    graph: _CompiledGraph,
    *,
    id: str,
    capabilities: list[str] | None = None,
    to_state: StateMapper | None = None,
    from_state: OutputMapper | None = None,
    config: dict[str, Any] | None = None,
) -> LangGraphParticipant:
    """Wrap a compiled LangGraph graph as an AipeHub ``AgentParticipant``.

    Example::

        from langgraph.graph import StateGraph
        from aipehub import connect
        from aipehub.adapters import langgraph_participant

        graph = build_graph().compile()
        agent = langgraph_participant(
            graph,
            id="researcher-lg",
            capabilities=["research"],
            to_state=lambda task: {"question": task["payload"]["question"]},
            from_state=lambda state: {"answer": state["answer"]},
        )
        await connect(url="ws://127.0.0.1:4000", agents=[agent])
    """
    return LangGraphParticipant(
        graph,
        id=id,
        capabilities=capabilities,
        to_state=to_state,
        from_state=from_state,
        config=config,
    )
