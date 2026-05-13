# @aipehub/web

Embeddable reference web UI for [AipeHub](https://github.com/AipeHub/AipeHub). A zero-dependency vanilla-JS single-page app served by a small Node HTTP + SSE server, talking to your `Hub` via its event stream.

Use it as-is, or read it as ~250 lines of reference for building your own UI on top of `hub.onEvent()`.

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
const web = await serveWeb(hub, { port: 3000 })
// browse to http://localhost:3000

// later
await web.close()
```

## Surface

- `GET /api/state` — snapshot of participants + full transcript + pending human tasks
- `GET /api/stream` — Server-Sent Events stream of every appended `TranscriptEntry`
- `POST /api/tasks/:id/(complete|reject)` — resolve a task on the human participant holding it

## License

MIT
