# @aipehub/web

Embeddable reference web UI for [AipeHub](https://github.com/AipeHub/AipeHub). A zero-dependency vanilla-JS SPA served by a small Node HTTP + SSE server, talking to your `Hub` via its event stream.

Since v1.1 the UI is split into two views — a **worker** view at `/` (open to anyone) and an **admin** console at `/admin` (token-gated). The whole thing is i18n-ready out of the box: default Chinese, optional English, toggle persisted in `localStorage`.

## Install

```bash
pnpm add @aipehub/web
```

## Use

```ts
import { Hub } from '@aipehub/core'
import { serveWeb } from '@aipehub/web'

const hub = new Hub()
await hub.start()

const web = await serveWeb(hub, {
  port: 3000,
  adminToken: process.env.AIPE_ADMIN_TOKEN, // omit to disable /admin entirely
})
// console logs: admin URL = http://localhost:3000/admin?token=<value>
//                workers  = http://localhost:3000/

// later
await web.close()
```

## Views

### `/` — worker view (no auth)

Anyone with the URL can join as a `HumanParticipant`: type a nickname + comma-separated capabilities, click **Join**. The page then shows three panes — participants, my-tasks inbox (filtered to your id), and a transcript browser. Approve / reject buttons resolve each pending task; `sessionStorage` keeps you "you" across refresh.

### `/admin` — admin console (token-gated)

Open `/admin?token=<value>` once; an HttpOnly cookie is minted. Later visits use the cookie; `Authorization: Bearer <value>` also works for CLI access. Three panels:

- **Pending admissions** — every agent that connected with `gating: 'admin-approval'` shows up here with **Approve / Reject** buttons + a reason field. See `@aipehub/transport-ws` for the gating option.
- **Dispatch** — fire a task through any of the three strategies (explicit / capability / broadcast) with JSON payload, optional title, and priority.
- **Evaluate** — click any `task_result` row in the transcript to autofill its task id; rating (1–5) + comment append an `evaluation` entry.

## HTTP surface

Public (no auth):

- `GET /api/state` — snapshot: participants + transcript + pending human tasks + pending agent applications
- `GET /api/stream` — SSE stream of every appended `TranscriptEntry`
- `GET /api/whoami` — `{ role: 'admin' | 'guest', adminEnabled }`
- `POST /api/workers` body `{ id, capabilities? }` — register a HumanParticipant
- `DELETE /api/workers/:id` — leave
- `POST /api/tasks/:id/(complete|reject)` — resolve a task on the human participant holding it

Admin (cookie or Bearer):

- `GET /api/admin/applications` — list pending applications
- `POST /api/admin/applications/:id/approve`
- `POST /api/admin/applications/:id/reject` body `{ reason }`
- `POST /api/admin/dispatch` body `{ strategy, payload, title?, priority? }`
- `POST /api/admin/evaluate` body `{ taskId, rating?, comment? }`
- `POST /api/admin/logout`

## License

MIT
