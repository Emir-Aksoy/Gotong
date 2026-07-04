# remote-python

Two-process demo: an **Gotong Hub running in Node** (TypeScript) talks to **a Python agent** over the wire protocol. Same scenario as `examples/remote-agent`, except the worker is in Python instead of TypeScript.

## Run

From the repo root:

```bash
pnpm demo:remote:python
```

Behind the scenes:

1. `src/launcher.ts` spawns the TypeScript host (`src/host.ts`) on `ws://127.0.0.1:4001`.
2. After a short delay it spawns the Python worker (`src/worker.py`) which runs in the project venv (`python-sdk/.venv`) and registers two agents.
3. The host dispatches a `draft` task and a `review` task by capability — they reach the Python agents over the WebSocket. Both responses come back, the host prints them, then shuts down.

## Prerequisites

The Python SDK must be installed in editable mode in `python-sdk/.venv`. Set this up once with:

```bash
cd python-sdk
python3.12 -m venv .venv
.venv/bin/pip install -e ".[test]"
```

## What this proves

The Python agent registers into the same `Hub.registry` as a local TypeScript agent would, gets selected by the same `DefaultScheduler` capability match, and writes to the same transcript. The Hub does not need to know which language the agent is written in — only that it speaks the wire protocol.
