# Sidecar agents — running a Hub-attached agent in its own process

This is the practical "Day 1" guide for connecting an agent you've
already written (TypeScript or Python) to an existing AipeHub Hub
without touching the Hub's `node_modules` or YAML manifest. The
contract has been stable since wire protocol **v1.1** (the version
that added Hub Services over WebSocket).

If you want the high-level story, read [`AGENT.md`](./AGENT.md).
If you want the wire-protocol reference, read [`PROTOCOL.md`](./PROTOCOL.md).
This file is the **how-to** in between.

---

## Why sidecars

The three integration shapes for an agent, sorted by friction:

| Shape | Lives where | Reaches for `pnpm install` on host? |
|---|---|---|
| In-process | inside the Hub binary | yes — agent code is a host dep |
| **Sidecar (this guide)** | **its own process, anywhere on the network** | **no** |
| Federated | inside a smaller Hub that's been registered as one agent | no, plus its own scheduler |

Sidecar is the right choice when:

- You don't control the Hub binary (you're an "external developer"
  joining someone else's Hub).
- You want to update your agent independently of the Hub's release
  cadence.
- Your agent needs a runtime the Hub doesn't have (Python, a specific
  Node major, native deps that aren't pre-baked).
- You want a clean restart story — `Ctrl-C` your agent without
  bouncing the Hub.

---

## The 5-line happy path

The TypeScript SDK exposes a single `connect()` call. Everything else
is your own code. Drop the snippet below into a fresh file, point at a
running Hub, and you have a working agent.

```ts
import { AgentParticipant, connect, type Task } from '@aipehub/sdk-node'

class Greeter extends AgentParticipant {
  constructor() { super({ id: 'greeter', capabilities: ['greet'] }) }
  protected handleTask(task: Task) {
    return { text: `Hello, ${(task.payload as { name?: string })?.name ?? 'friend'}!` }
  }
}

await connect({ url: 'ws://127.0.0.1:4000', agents: [new Greeter()] })
console.log('online')
```

`pnpm add @aipehub/sdk-node` if you haven't already. Python is the
mirror image; see [`AGENT.md` § Option B](./AGENT.md#option-b--python).

The Hub does **not** need a yaml entry for your agent. The HELLO
frame is the manifest.

---

## Adding Hub Services to a sidecar

This is the v1.1 part. Declare what services you want, hand the
returned `ServiceClient` back to the agent, and call its handles
exactly like an in-process LlmAgent would.

```ts
import { AgentParticipant, connect, type ServiceClient, type Task } from '@aipehub/sdk-node'

class CoachAgent extends AgentParticipant {
  services?: ServiceClient   // populated after connect()

  constructor() { super({ id: 'coach', capabilities: ['draft'] }) }

  protected async handleTask(task: Task) {
    const caseId = (task.payload as { caseId: string }).caseId
    // Per-case memory — owner.id is dynamic, resolved at call time.
    const caseMem = this.services!.memoryFor('file', {
      kind: 'workflow-run',
      id: caseId,
    })

    const history = await caseMem.recall({ k: 20 })
    const draft  = await this.draft(task, history)
    await caseMem.remember({
      kind: 'episodic',
      text: `coach draft: ${draft.summary}`,
      meta: { taskId: task.id },
    })
    return draft
  }

  private async draft(_t: Task, _h: unknown[]) { return { summary: '...' } }
}

const coach = new CoachAgent()
const session = await connect({
  url: 'wss://hub.example.com/ws',
  agents: [coach],
  services: [
    // 1) per-agent scratchpad (resolves 'self' → 'coach' server-side)
    { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
    // 2) per-case memory shared with other agents in the workflow
    { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*' } },
  ],
})
coach.services = session.services
```

Three things to remember:

1. **The `services` array IS the ACL.** Anything not listed will come
   back as `forbidden_service` or `forbidden_owner` at call time. The
   admin reviewing your application (when gating is `admin-approval`)
   sees this list verbatim.
2. **`owner.id: 'self'` is server-substituted.** Don't try to send the
   agent's literal id; the server fills it in on every SERVICE_CALL.
   This lets the same declaration scale across multi-agent processes.
3. **`owner.id: '*'` is a wildcard.** Use it when the id (e.g.
   `caseId`) is only known at call time. Concrete id values come from
   `memoryFor(impl, { kind, id })`.

---

## Migrating an in-process agent into a sidecar

Take `examples/industry-consultation-deepseek/src/index.ts` as the
worked example. The pipeline runs a coach + researcher + case-manager
+ reviewer team inside one host process today; here's the **shape** of
splitting the coach out into a sidecar.

### Step 1 — extract the agent class

The in-process file declares the coach inline:

```ts
class CoachAgent extends LlmAgent {
  protected async handleTask(task: Task) { /* ... */ }
}
```

Move it verbatim into a new file `sidecar-coach/src/index.ts`. The
class doesn't change — `LlmAgent` works in both shapes. The only
constraint is its dependencies: it must import nothing from
`@aipehub/host`, since the sidecar process won't have a host.

### Step 2 — adopt the SDK's `AgentParticipant`

If your agent extended `LlmAgent`, keep doing so — `LlmAgent` is in
`@aipehub/llm` which is sidecar-safe. If it extended an internal host
class (e.g. `LocalAgentPool`'s spawn shape), drop down to
`AgentParticipant` from `@aipehub/sdk-node` and reconstruct the
behaviour with explicit `provider` and `services` fields.

### Step 3 — declare services in HELLO

The in-process version got its `memory` / `artifact` handles via
`LocalAgentPool` resolving the agent's yaml `uses:` block. In sidecar
mode, you declare them on `connect()`:

```ts
const session = await connect({
  url: process.env.AIPEHUB_URL ?? 'ws://127.0.0.1:4000',
  agents: [coach],
  services: [
    { type: 'memory', impl: 'file', owner: { kind: 'agent',       id: 'self' } },
    { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*'  } },
  ],
})
coach.services = session.services
```

The `case-memory` writes / reads continue to land in the same
on-disk JSONL files the host's `service-memory-file` plugin manages.
Cross-process visibility is automatic — both the in-process agents
that stayed behind AND your sidecar coach point at the same plugin
on the host.

### Step 4 — point the Hub at the sidecar's ws URL

Nothing on the Hub changes. The Hub already accepts WebSocket
connections at the port the host operator configured. Your sidecar
opens that URL and is just another participant from the scheduler's
point of view. Capabilities (`draft`, `review`, …) dispatch by
capability match — same string in both shapes.

### Step 5 — keep the workflow yaml as-is

The workflow yaml dispatches by capability, not by participant id.
Once the sidecar registers as `capabilities: ['draft']`, the
`industry-consultation-flow` workflow's `draft` step starts hitting
the sidecar instead of (or alongside) the in-process coach.

---

## Auth & gating

By default the Hub runs `gating: 'open'` and lets HELLO through
without admin involvement. **Production hubs MUST set
`gating: 'admin-approval'`**, in which case:

1. `connect()` hangs on `AWAIT_APPROVAL`.
2. The admin UI shows your application, including the `services` list
   you declared, the `client.name` / `client.version`, and the
   `remoteAddress`.
3. An admin clicks Approve and your sidecar gets `WELCOME`.

The SDK retries on any transient WebSocket failure (exponential
backoff 1s → 30s) but does **not** retry on `REJECT` — that's
terminal. The reason is in `decision.reason` if you supplied an
`on_state_change` callback.

For zero-friction local development, run with `gating: 'open'`. For
shared dev clusters, use `gating: 'admin-approval'` with admins
pre-seeded via the host's `--admin <token>` flag.

---

## Cancellation, disconnect, and reattach

The Hub may cancel a task in flight — most commonly because a
broadcast task was claimed by someone else. The SDK calls your
agent's `onTaskCancelled(taskId, reason)`; default impl is a no-op,
override if you hold external resources (HTTP requests, sub-processes,
LLM streams).

On disconnect, the host detaches every service handle it had cached
for your session. When your sidecar reconnects, the Hub treats it as
a fresh HELLO and re-attaches everything you declare again. So:

- **Do not assume handles survive a reconnect.** They don't — the
  underlying `(type, impl, owner)` slot is re-resolved on the first
  SERVICE_CALL after reconnect.
- **Do not cache `services.memory` across `onStateChange('reconnecting')`.**
  Re-read `session.services` after each WELCOME.
- **Pending SERVICE_CALLs reject with `session_not_ready`** the moment
  the connection drops. They are not retried — the Hub doesn't know
  what your agent's recovery policy is.

---

## Observability

The host appends a `service_call` transcript entry for every resolved
SERVICE_CALL — see Admin UI → Services tab → "SERVICE_CALL audit." It
records the calling agent's id, the service identity, the method, the
outcome (`ok` or a wire `ServiceErrorCode`), and the round-trip
duration. **Args are not persisted.** They're potentially large and
may contain user data.

If you need richer in-agent telemetry (token counts, slow paths, model
choice), do it in the sidecar process — it's just normal Node /
Python. The SDK does not have a metrics surface of its own.

---

## Mistake gallery

The errors people actually hit, with what each one means.

| Symptom | What happened |
|---|---|
| `forbidden_service` | The `(type, impl)` pair isn't in your HELLO `services` array. Add it. |
| `forbidden_owner` | The owner you passed to `memoryFor(...)` doesn't match any declared pattern. Wildcards in declarations cover `id: '*'`; literals must match exactly. |
| `unknown_method` | The method name isn't on the wire allowlist for that service type. For built-ins, see `BUILTIN_SERVICE_METHODS`; for third-party types, the host plugin must call `registerServiceMethods` at bootstrap. |
| `attach_failed` | The host plugin's `attach()` threw — invalid config, broken disk path, etc. The host logs are the source of truth. |
| `session_not_ready` | The SDK's pending-call table got fail-all'd. Either the connection dropped, or `session.close()` was called while a call was in flight. |
| `bad_args` | The wire `args` field wasn't a JSON array. Don't pass non-serialisable objects (functions, class instances with private fields, etc). |
| `unknown_agent` | The `from` on your SERVICE_CALL doesn't match any agent declared in your HELLO. This is usually a bug — the SDK fills `from` automatically from the first agent. |

---

## Reference

- **Code samples**: `examples/services-sidecar-demo/` (TypeScript) and
  `python-sdk/tests/test_services.py` (Python wire-level driver).
- **Wire frames**: `docs/PROTOCOL.md` § SERVICE_CALL / SERVICE_RESULT.
- **ACL model**: `docs/services-over-ws-rfc.md` § 3.
- **`docs/AGENT.md`**: the narrative version of this guide.
