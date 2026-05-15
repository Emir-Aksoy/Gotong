"""AipeHub Python SDK.

Connect Python agents to an AipeHub Hub over WebSocket.

Quick start::

    import asyncio
    from aipehub import AgentParticipant, connect

    class WriterAgent(AgentParticipant):
        def __init__(self) -> None:
            super().__init__(id="writer-py", capabilities=["draft"])

        async def handle_task(self, task: dict) -> dict:
            return {"text": f"on {task['payload']['topic']}: a Python sentence."}

    async def main() -> None:
        session = await connect(
            url="ws://127.0.0.1:4000",
            agents=[WriterAgent()],
        )
        await session.wait_closed()

    asyncio.run(main())
"""

from .agent import AgentParticipant, Message, Task
from .protocol import PROTOCOL_VERSION
from .services import (
    ArtifactHandle,
    CustomServiceHandle,
    DatastoreHandle,
    KvHandle,
    MemoryHandle,
    ServiceCallError,
    ServiceClient,
    ServiceOwner,
    ServiceUseRequest,
    SqlHandle,
)
from .session import ConnectionRejected, Session, SessionState, connect

__all__ = [
    "AgentParticipant",
    "ArtifactHandle",
    "ConnectionRejected",
    "CustomServiceHandle",
    "DatastoreHandle",
    "KvHandle",
    "Message",
    "MemoryHandle",
    "PROTOCOL_VERSION",
    "ServiceCallError",
    "ServiceClient",
    "ServiceOwner",
    "ServiceUseRequest",
    "Session",
    "SessionState",
    "SqlHandle",
    "Task",
    "connect",
]

__version__ = "1.1.0"
