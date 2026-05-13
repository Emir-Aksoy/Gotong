"""Python worker for the remote-python demo.

Connects to the Node-side Hub on ws://127.0.0.1:4001, registers two agents,
runs until the Hub closes the session.
"""

from __future__ import annotations

import asyncio
import sys

from aipehub import AgentParticipant, connect


class WriterAgent(AgentParticipant):
    def __init__(self) -> None:
        super().__init__(id="writer-py", capabilities=["draft"])

    async def handle_task(self, task: dict) -> dict:
        topic = task["payload"].get("topic", "?")
        print(f"[worker] writer-py received '{task.get('title')}' topic={topic}",
              flush=True)
        await asyncio.sleep(0.3)
        return {
            "text": (
                f"On {topic}: this draft came back over a WebSocket from a Python "
                f"process, and the Hub didn't blink."
            ),
        }


class ReviewerAgent(AgentParticipant):
    def __init__(self) -> None:
        super().__init__(id="reviewer-py", capabilities=["review"])

    async def handle_task(self, task: dict) -> dict:
        print(f"[worker] reviewer-py received '{task.get('title')}'", flush=True)
        await asyncio.sleep(0.3)
        return {"note": "Add a concrete snippet showing the Python SDK in use."}


def _on_state(state: str, info: dict | None) -> None:
    extra = f" ({info})" if info else ""
    print(f"[worker] state -> {state}{extra}", flush=True)


async def main() -> None:
    print("[worker] connecting to ws://127.0.0.1:4001 ...", flush=True)
    session = await connect(
        url="ws://127.0.0.1:4001",
        agents=[WriterAgent(), ReviewerAgent()],
        auto_reconnect=False,
        on_state_change=_on_state,
    )
    print(f"[worker] connected, session_id={session.session_id}", flush=True)
    await session.wait_closed()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
