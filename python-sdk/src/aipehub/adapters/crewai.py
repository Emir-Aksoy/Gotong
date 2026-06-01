"""Expose a CrewAI crew as an AipeHub Participant.

Same seam as the LangGraph adapter: a CrewAI ``Crew`` orchestrates a team of
role-playing agents *inside* one process; AipeHub routes a Task to whichever
participant serves a capability and writes a transcript. This adapter lets a
crew join a Hub as one agent, with ``crewai`` kept as an optional peer
dependency — it is never imported here. The crew is duck-typed on
``.kickoff(inputs)`` (with ``.kickoff_async`` preferred when present), so the
adapter unit-tests against a trivial fake and a sync crew runs off the event
loop instead of stalling the connection's other agents.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Protocol

from ..agent import AgentParticipant, Task


class _Crew(Protocol):
    """The slice of a CrewAI ``Crew`` this adapter calls.

    A Protocol rather than an import of ``crewai`` so the adapter type-checks
    against both a real ``Crew`` and the fakes in tests.
    """

    def kickoff(self, inputs: Any = ..., /, *args: Any, **kwargs: Any) -> Any: ...


# Map an AipeHub Task to the crew's kickoff inputs, and the crew's output back
# to the Task output. Default inputs = the payload (CrewAI interpolates it into
# task descriptions); default output extracts ``.raw`` — see _default_from_output.
InputMapper = Callable[[Task], Any]
OutputMapper = Callable[[Any], Any]


def _default_to_inputs(task: Task) -> Any:
    return task.get("payload") or {}


def _default_from_output(output: Any) -> Any:
    # CrewAI returns a ``CrewOutput`` whose ``.raw`` is the final string; a fake
    # (or a future shape) may return a bare string. Either way produce a
    # JSON-serializable dict — the result crosses the wire into the transcript,
    # and a raw CrewOutput object would not serialize. Callers override
    # ``from_output`` to pull ``.json_dict`` / ``.tasks_output`` instead.
    raw = getattr(output, "raw", None)
    return {"text": raw if raw is not None else str(output)}


class CrewParticipant(AgentParticipant):
    """An AipeHub agent backed by a CrewAI crew.

    Prefer the ``crewai_participant`` factory; this class is exported for
    ``isinstance`` checks and subclassing.
    """

    def __init__(
        self,
        crew: _Crew,
        *,
        id: str,
        capabilities: list[str] | None = None,
        to_inputs: InputMapper | None = None,
        from_output: OutputMapper | None = None,
    ) -> None:
        super().__init__(id=id, capabilities=capabilities)
        self._crew = crew
        self._to_inputs = to_inputs or _default_to_inputs
        self._from_output = from_output or _default_from_output

    async def handle_task(self, task: Task) -> Any:
        inputs = self._to_inputs(task)
        kickoff_async = getattr(self._crew, "kickoff_async", None)
        if callable(kickoff_async):
            output = await kickoff_async(inputs=inputs)
        else:
            # Sync kickoff does blocking LLM I/O; keep the event loop free.
            output = await asyncio.to_thread(self._crew.kickoff, inputs=inputs)
        return self._from_output(output)


def crewai_participant(
    crew: _Crew,
    *,
    id: str,
    capabilities: list[str] | None = None,
    to_inputs: InputMapper | None = None,
    from_output: OutputMapper | None = None,
) -> CrewParticipant:
    """Wrap a CrewAI ``Crew`` as an AipeHub ``AgentParticipant``.

    Example::

        from crewai import Crew
        from aipehub import connect
        from aipehub.adapters import crewai_participant

        crew = Crew(agents=[...], tasks=[...])
        agent = crewai_participant(
            crew,
            id="market-research-crew",
            capabilities=["market-research"],
            to_inputs=lambda task: {"topic": task["payload"]["topic"]},
            from_output=lambda out: {"report": out.raw},
        )
        await connect(url="ws://127.0.0.1:4000", agents=[agent])
    """
    return CrewParticipant(
        crew,
        id=id,
        capabilities=capabilities,
        to_inputs=to_inputs,
        from_output=from_output,
    )
