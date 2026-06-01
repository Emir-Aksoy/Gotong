"""CrewAI adapter — a crew becomes an AipeHub participant.

We never import crewai: the adapter is duck-typed on ``.kickoff(inputs)`` /
``.kickoff_async``, so fakes exercise every path. Tests drive ``on_task``
directly (the public TaskResult envelope) to prove the input mapping, the
default ``.raw`` extraction, and error semantics.
"""

from __future__ import annotations

from aipehub import AgentParticipant
from aipehub.adapters import CrewParticipant, crewai_participant


class FakeOutput:
    """Mirrors CrewAI's ``CrewOutput`` — ``.raw`` holds the final string."""

    def __init__(self, raw: str) -> None:
        self.raw = raw


class FakeSyncCrew:
    def __init__(self) -> None:
        self.seen: list = []

    def kickoff(self, inputs=None):
        self.seen.append(inputs)
        return FakeOutput(f"sync:{(inputs or {}).get('topic')}")


class FakeAsyncCrew:
    def __init__(self) -> None:
        self.seen: list = []

    async def kickoff_async(self, inputs=None):
        self.seen.append(inputs)
        return FakeOutput(f"async:{inputs['topic']}")

    def kickoff(self, inputs=None):  # must NOT be called when async exists
        raise AssertionError("kickoff_async must be preferred over kickoff")


def _task(payload, task_id="t1"):
    return {"id": task_id, "payload": payload, "title": "q"}


async def test_default_extracts_raw_and_passes_payload_as_inputs() -> None:
    crew = FakeSyncCrew()
    agent = crewai_participant(crew, id="cw", capabilities=["plan"])
    result = await agent.on_task(_task({"topic": "launch"}))
    assert result["kind"] == "ok"
    assert result["by"] == "cw"
    assert result["output"] == {"text": "sync:launch"}
    assert crew.seen == [{"topic": "launch"}]


async def test_bare_string_output_is_wrapped() -> None:
    class StringCrew:
        def kickoff(self, inputs=None):
            return "plain result"

    agent = crewai_participant(StringCrew(), id="cw", capabilities=["plan"])
    result = await agent.on_task(_task({}))
    assert result["output"] == {"text": "plain result"}


async def test_custom_input_and_output_mappers() -> None:
    class JsonCrew:
        def kickoff(self, inputs=None):
            out = FakeOutput("ignored")
            out.json_dict = {"score": inputs["n"]}
            return out

    agent = crewai_participant(
        JsonCrew(),
        id="cw",
        capabilities=["score"],
        to_inputs=lambda task: {"n": task["payload"]["value"]},
        from_output=lambda out: out.json_dict,
    )
    result = await agent.on_task(_task({"value": 9}))
    assert result["output"] == {"score": 9}


async def test_kickoff_async_preferred_when_present() -> None:
    crew = FakeAsyncCrew()
    agent = crewai_participant(crew, id="cw", capabilities=["plan"])
    result = await agent.on_task(_task({"topic": "x"}))
    assert result["output"] == {"text": "async:x"}
    assert crew.seen == [{"topic": "x"}]


async def test_crew_error_becomes_failed_result() -> None:
    class Boom:
        def kickoff(self, inputs=None):
            raise RuntimeError("crew exploded")

    agent = crewai_participant(Boom(), id="cw", capabilities=["plan"])
    result = await agent.on_task(_task({"topic": "x"}))
    assert result["kind"] == "failed"
    assert result["by"] == "cw"
    assert "crew exploded" in result["error"]


async def test_is_agent_participant_subclass() -> None:
    agent = crewai_participant(FakeSyncCrew(), id="cw", capabilities=["plan"])
    assert isinstance(agent, AgentParticipant)
    assert isinstance(agent, CrewParticipant)
    assert agent.id == "cw"
    assert agent.capabilities == ["plan"]
