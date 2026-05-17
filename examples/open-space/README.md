# open-space

The v2.0 "File-first" full-stack demo: Hub + WebSocket transport + Web UI + a remote writer agent, all glued together so you can drive a real room from your browser.

## Run

```bash
pnpm demo:open-space
```

(Or double-click [`启动-OpenSpace.command`](../../启动-OpenSpace.command) on macOS.)

The launcher prints two URLs on first boot:

- **Admin**: `http://localhost:3100/admin?token=<HEX>` — save this **once**; subsequent boots only print `/admin`.
- **Worker**: `http://localhost:3100/`

Open the admin URL in your browser, the worker URL in a private tab, and you have a full room: approve the pending writer agent in admin, join as a worker, dispatch tasks.

## Scenario

`src/launcher.ts` spawns:

1. `src/host.ts` — Hub + WebSocket (`:4100`) + Web UI (`:3100`) bound to the `.aipehub-open-space/` directory.
2. `src/agent.ts` — a remote writer agent that connects over WebSocket and lands in **pending** state under `admission gating`.

## What this proves

- **File-first persistence**: admins, workers, sessions, transcript, and pending applications all live in `.aipehub-open-space/`. Stop the demo, restart it, you're still admin; the writer reconnects automatically.
- **Admission gating**: with `gating: 'admin-approval'` a new agent appears in the pending tray; you click Approve to let it in.
- **Web UI** as the production driver — not a separate demo surface.

To start completely fresh: [`重置-OpenSpace.command`](../../重置-OpenSpace.command) (or `rm -rf examples/open-space/.aipehub-open-space`).

Source: [`src/launcher.ts`](src/launcher.ts), [`src/host.ts`](src/host.ts), [`src/agent.ts`](src/agent.ts).
