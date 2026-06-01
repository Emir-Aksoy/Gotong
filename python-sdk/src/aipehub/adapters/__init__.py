"""Optional adapters that bridge external agent frameworks into an AipeHub Hub.

Each adapter is duck-typed and dependency-light: it wraps a framework object
(a LangGraph graph, a CrewAI crew, ...) as an AipeHub ``AgentParticipant`` so
the Hub routes Tasks to it like any other agent. The framework itself is a
peer dependency you install separately — importing this subpackage never pulls
in langgraph / crewai, which keeps the core SDK install light and lets the
adapters be unit-tested against trivial fakes.
"""

from .langgraph import LangGraphParticipant, langgraph_participant

__all__ = [
    "LangGraphParticipant",
    "langgraph_participant",
]
