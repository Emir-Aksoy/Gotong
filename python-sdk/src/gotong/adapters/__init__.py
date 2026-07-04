"""Optional adapters that bridge external agent frameworks into an Gotong Hub.

Each adapter is duck-typed and dependency-light: it wraps a framework object
(a LangGraph graph, a CrewAI crew, ...) as an Gotong ``AgentParticipant`` so
the Hub routes Tasks to it like any other agent. The framework itself is a
peer dependency you install separately — importing this subpackage never pulls
in langgraph / crewai, which keeps the core SDK install light and lets the
adapters be unit-tested against trivial fakes.
"""

from .crewai import CrewParticipant, crewai_participant
from .langgraph import LangGraphParticipant, langgraph_participant

__all__ = [
    "CrewParticipant",
    "LangGraphParticipant",
    "crewai_participant",
    "langgraph_participant",
]
