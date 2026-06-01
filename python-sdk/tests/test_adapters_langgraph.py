"""LangGraph adapter — a compiled graph becomes an AipeHub participant.

We never import langgraph: the adapter is duck-typed, so a fake object with
``invoke`` / ``ainvoke`` exercises every path. Tests drive ``on_task`` directly
(the public TaskResult envelope) — no Hub round-trip needed to prove the
state mapping + error semantics.
"""

from __future__ import annotations

from aipehub import AgentParticipant
from aipehub.adapters import LangGraphParticipant, langgraph_participant


class FakeSyncGraph:
    """Mirrors a compiled StateGraph's sync ``.invoke(state) -> dict``."""

    def __init__(self) -> None:
        self.seen: list = []

    def invoke(self, state):
        self.seen.append(state)
        return {**state, "answer": f"sync:{state.get('question')}"}


class FakeAsyncGraph:
    """A graph exposing ``ainvoke`` — the adapter must prefer it."""

    def __init__(self) -> None:
        self.seen: list = []

    async def ainvoke(self, state, **kwargs):
        self.seen.append((state, kwargs))
        return {"answer": f"async:{state['question']}"}

    def invoke(self, state):  # must NOT be called when ainvoke exists
        raise AssertionError("ainvoke must be preferred over invoke")


def _task(payload, task_id="t1"):
    return {"id": task_id, "payload": payload, "title": "q"}


async def test_default_mapping_passes_payload_as_state() -> None:
    graph = FakeSyncGraph()
    agent = langgraph_participant(graph, id="lg", capabilities=["research"])
    result = await agent.on_task(_task({"question": "why"}))
    assert result["kind"] == "ok"
    assert result["by"] == "lg"
    assert result["output"]["answer"] == "sync:why"
    assert graph.seen == [{"question": "why"}]


async def test_missing_payload_defaults_to_empty_state() -> None:
    graph = FakeSyncGraph()
    agent = langgraph_participant(graph, id="lg", capabilities=["research"])
    result = await agent.on_task({"id": "t9", "title": "q"})
    assert result["kind"] == "ok"
    assert graph.seen == [{}]


async def test_custom_to_and_from_state() -> None:
    graph = FakeSyncGraph()
    agent = langgraph_participant(
        graph,
        id="lg",
        capabilities=["research"],
        to_state=lambda task: {"question": task["payload"]["q"]},
        from_state=lambda state: {"reply": state["answer"]},
    )
    result = await agent.on_task(_task({"q": "deep"}))
    assert result["output"] == {"reply": "sync:deep"}


async def test_ainvoke_preferred_when_present() -> None:
    graph = FakeAsyncGraph()
    agent = langgraph_participant(graph, id="lg", capabilities=["research"])
    result = await agent.on_task(_task({"question": "x"}))
    assert result["kind"] == "ok"
    assert result["output"]["answer"] == "async:x"


async def test_config_forwarded_when_set() -> None:
    graph = FakeAsyncGraph()
    agent = langgraph_participant(
        graph,
        id="lg",
        capabilities=["research"],
        config={"configurable": {"thread_id": "abc"}},
    )
    await agent.on_task(_task({"question": "x"}))
    assert graph.seen[0][1] == {"config": {"configurable": {"thread_id": "abc"}}}


async def test_graph_error_becomes_failed_result() -> None:
    class Boom:
        def invoke(self, state):
            raise RuntimeError("graph exploded")

    agent = langgraph_participant(Boom(), id="lg", capabilities=["research"])
    result = await agent.on_task(_task({"question": "x"}))
    assert result["kind"] == "failed"
    assert result["by"] == "lg"
    assert "graph exploded" in result["error"]


async def test_is_agent_participant_subclass() -> None:
    agent = langgraph_participant(FakeSyncGraph(), id="lg", capabilities=["research"])
    assert isinstance(agent, AgentParticipant)
    assert isinstance(agent, LangGraphParticipant)
    assert agent.id == "lg"
    assert agent.capabilities == ["research"]
