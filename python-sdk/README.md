# aipehub (Python SDK)

Connect Python agents to an [AipeHub](https://github.com/emir-aksoy/AipeHub) Hub over WebSocket.

The Hub is the TypeScript reference implementation; this SDK speaks the same wire protocol (`docs/PROTOCOL.md`) so Python agents register into the same registry, get scheduled by the same scheduler, and appear in the same transcript as TypeScript or in-process agents.

## Install

```bash
# from-source (recommended at this stage — PyPI publish is descoped)
pip install -e python-sdk/

# from PyPI — NOT yet published, decision tracked in
# https://github.com/Emir-Aksoy/AipeHub/blob/main/.github/RELEASE-CHECKLIST.md
# pip install aipehub
```

Requires Python ≥ 3.10.

## Usage

```python
import asyncio
from aipehub import AgentParticipant, connect


class WriterAgent(AgentParticipant):
    def __init__(self) -> None:
        super().__init__(id="writer-py", capabilities=["draft"])

    async def handle_task(self, task: dict) -> dict:
        topic = task["payload"].get("topic", "?")
        return {"text": f"on {topic}: a sentence courtesy of Python."}


async def main() -> None:
    session = await connect(
        url="ws://127.0.0.1:4000",
        agents=[WriterAgent()],
        api_key="my-key",            # optional
        on_state_change=lambda s, info: print(f"[state] -> {s} {info or ''}"),
    )
    await session.wait_closed()


asyncio.run(main())
```

Subclass `AgentParticipant`, give it an `id` + `capabilities`, override `handle_task`. Both `async def handle_task` and plain `def handle_task` work — the SDK awaits whichever you wrote.

## Adapters — bring your own agent framework

`aipehub.adapters` wraps an external framework's object as an `AgentParticipant`, so the Hub routes Tasks to it like any other agent. The framework is a **peer dependency** — importing the adapter never pulls in `langgraph` / `crewai`; you install those yourself only for real graphs.

```python
from langgraph.graph import StateGraph
from aipehub import connect
from aipehub.adapters import langgraph_participant

graph = build_graph().compile()          # any compiled StateGraph

agent = langgraph_participant(
    graph,
    id="researcher-lg",
    capabilities=["research"],
    # map the AipeHub task <-> the graph's state dict (defaults pass the
    # payload straight through and return the whole final state)
    to_state=lambda task: {"question": task["payload"]["question"]},
    from_state=lambda state: {"answer": state["answer"]},
)

await connect(url="ws://127.0.0.1:4000", agents=[agent])
```

The graph is duck-typed (anything with `.invoke(state)`), `.ainvoke` is preferred when present, and a sync graph runs off the event loop so it can't stall the other agents on the connection.

## What the SDK does

- Opens a WebSocket to the Hub
- Sends `HELLO` with your declared agents and optional `apiKey`
- Awaits `WELCOME`, raises `ConnectionRejected` on `REJECT`
- Dispatches `TASK` frames to the right agent's `handle_task`, sends back `RESULT`
- Replies to `PING` with `PONG`, forwards `CANCEL` to `on_task_cancelled`
- Auto-reconnects on transport failure with exponential backoff
- Cleans up on `close()` (sends `GOODBYE`, closes the socket)

## What it doesn't do (yet)

- Publish/subscribe on channels (the Python agent is task-side only in v0.5)
- Streaming results
- Resume of in-flight tasks across reconnect (the Hub fails them as `remote_disconnect`, same as the Node SDK)

## License

MIT
