# federated-team

Two independent Hubs, talking to each other through a `TeamBridgeAgent`. The downstream team Hub appears upstream as **one** agent — its members, API keys, and sub-tasks stay private.

## Run

```bash
pnpm demo:federated-team
```

(Or double-click [`启动-联邦协作.command`](../../启动-联邦协作.command) on macOS.)

To split across windows / machines:

```bash
pnpm --filter @aipehub/example-federated-team upstream  # :3200 web / :4200 ws
pnpm --filter @aipehub/example-federated-team team      # :3300 web
pnpm --filter @aipehub/example-federated-team driver    # dispatches the three tasks
```

## Scenario

- **Upstream Hub** (`.aipehub-upstream/`) — what a parent organisation runs. Bound to `:4200` for agent connections.
- **Team Hub** (`.aipehub-team/`) — a sub-team's own private Hub.
- **TeamBridgeAgent** — connects to the upstream Hub as a single agent. Internally it forwards inbound tasks to the team Hub's scheduler, which picks one of the team's real agents.
- **Driver** — dispatches three tasks at the upstream level; results bubble up through the bridge.

## What this proves

- **Sovereignty**: upstream sees `alice-team completed N tasks`, never the individual contributors. Internal prompts, keys, and sub-task topology stay local.
- **Composition**: a Hub can hold normal agents *and* bridges side by side. Recursive composition is fine.
- **No special protocol**: the bridge speaks the same v1.x wire protocol as any other remote agent. The "team" abstraction is library code in `@aipehub/sdk-node`, not new wire frames.

> **Token caveat**: the launcher greps the upstream admin token from stdout. On second run (the token already lives in `admins.json` and isn't reprinted) you'll get an error message telling you to delete `.aipehub-upstream/` to remint.

Source: [`src/launcher.ts`](src/launcher.ts), [`src/upstream-host.ts`](src/upstream-host.ts), [`src/team-host.ts`](src/team-host.ts), [`src/driver.ts`](src/driver.ts). Design context: [`docs/FEDERATION.md`](../../docs/FEDERATION.md).
