# windmill-bridge

**Gotong → durable external workflow.** An Gotong agent delegates a task to
[Windmill](https://www.windmill.dev/) — which *persists* the job, retries failed
steps, and survives its own restarts — then polls until the durable job
completes and surfaces the result back through the Hub's transcript. This is the
**outbound** twin of the [`activepieces-bridge`](../activepieces-bridge) (which
is inbound).

## Run the demo

```bash
pnpm --filter @gotong/example-windmill-bridge start
```

A tiny fake Windmill server runs over loopback and models the real async API: a
durable job needs two polls before it reports `completed`, so the demo exercises
the participant's poll loop. It asserts a happy job's result flows back (`ok`)
and a job that fails its own logic becomes a `failed` task. No Windmill account,
no network.

## The participant in one paragraph

`WindmillParticipant` is a normal `AgentParticipant`, so it sits beside your
local agents and is selected by capability like any of them. On a task it:

1. `POST {base}/api/w/{workspace}/jobs/run/f/{flowPath}` with the inputs →
   Windmill returns a job id immediately (the job is now durable, server-side).
2. polls `GET {base}/api/w/{workspace}/jobs_u/completed/get_result_maybe/{id}`
   until `completed`, then returns the result (or fails the task if the durable
   job reported `success:false`).

```ts
hub.register(new WindmillParticipant({
  id: 'lead-enricher-wm',
  capabilities: ['enrich:lead'],
  baseUrl: 'https://app.windmill.dev',
  workspace: 'demo',
  token: process.env.WINDMILL_TOKEN!,   // read from env/vault, never inlined
  flowPath: 'u/alice/process_lead',
  toInputs: (task) => ({ lead: task.payload }),
  fromResult: (r) => ({ enrichment: r }),
}))
```

`fetchImpl` is injectable for deterministic tests; the token is passed in by the
caller, never read here.

## Why "durable" matters

A normal in-process agent dies with the host. Handing the work to Windmill (or
Temporal, Inngest, a queued worker — same `submit → poll` shape, swap the two
URLs) gives you retries, step-level checkpointing, and execution that outlives
the Gotong process. Gotong stays the *router and system of record*; the heavy,
long-running, must-not-lose-progress execution lives in the engine built for it.

> Store the Windmill token in the host's vault, not in the workflow YAML. Run
> against the engine over TLS.
