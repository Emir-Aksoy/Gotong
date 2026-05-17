# web-demo

The smallest possible **worker-driven** room: one writer agent generates drafts in a loop, and you (or your colleagues) approve them in the browser. No LLM key required.

## Run

```bash
pnpm demo:web
```

Open `http://localhost:3000`. The launcher prints the admin URL **once** on first run — save it; subsequent boots only show `/admin`.

The space lives in `.aipehub-web-demo/`. Override with `AIPE_SPACE=/tmp/foo` if you want.

## Scenario

1. A `WriterAgent` (in-process, mock content) drafts a one-liner every few seconds.
2. The Hub dispatches it via `capability: ['approve']`.
3. Anyone who joins at `/` and selects capability `approve` gets the task in their inbox.
4. They click **Approve** / **Reject** in the browser.
5. Repeat forever. Ctrl-C to exit.

## What this proves

- **`@aipehub/web` is embeddable** — `serveWeb(hub, opts)` is the only line that wires the UI to your Hub. No separate front-end build, no SPA bundling.
- **HumanParticipant via the web UI** — same `Participant` contract as the CLI-human or SDK paths, just driven from a browser.
- **File-first state**: refresh the page, restart the process, your worker identity sticks because the HttpOnly cookie maps to `<space>/workers.json`.

Source: [`src/index.ts`](src/index.ts).
