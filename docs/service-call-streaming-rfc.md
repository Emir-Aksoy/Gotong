# RFC: SERVICE_CALL streaming (protocol v1.3 draft)

Status: **DRAFT** — design only as of 2026-05. Implementation gated on
real demand. Frame types are reserved in `@gotong/protocol` so
v1.2 clients/servers don't accidentally collide with future names.

---

## Motivation

Today every SERVICE_CALL is request/response: one frame out, one
frame back. The whole response value rides on a single
`SERVICE_RESULT.value`. Three workloads chafe against this shape:

1. **LLM streaming**. A datastore plugin that wraps a managed LLM
   wants to stream tokens as they arrive — today the sidecar agent
   has to wait for the whole completion to land in `SERVICE_RESULT`,
   undercutting the "perceived latency" win streaming exists for.
2. **Bulk queries**. `sql.query` against a 50k-row table forces the
   whole result set onto the wire in one frame. For large enough
   results this overflows browser-tab buffers (the admin SSE consumer)
   and stalls the WebSocket for seconds.
3. **Long-running operations with progress**. A `code.run` plugin
   might want to publish `{kind:'progress', pct:0.4}` as it works,
   then a final `{kind:'output', text:'...'}`. Today it has to either
   block until done or use the side-channel `MESSAGE` frame, which is
   not call-scoped.

A clean streaming primitive on top of SERVICE_CALL solves all three
with one new pair of frames.

---

## Wire shape

Two new frame types, both **additive** on v1.2:

### SERVICE_RESULT_CHUNK

Sent server→client zero or more times in response to a SERVICE_CALL,
**before** the terminal SERVICE_RESULT. Each chunk is tagged with the
same `callId` the original SERVICE_CALL carried.

```json
{
  "type": "SERVICE_RESULT_CHUNK",
  "callId": "c12_abc34",
  "seq": 0,
  "value": <plugin-defined>
}
```

- `seq` is a strictly-increasing integer starting at `0`. Clients MAY
  use it to detect drops (none expected on a TCP-backed WS, but the
  field is cheap insurance for future binary transports).
- `value` is plugin-defined. The SDK does NOT try to interpret it; it
  hands the raw value to the consumer via an async iterator (see
  below).

### SERVICE_RESULT (terminal — already exists)

The existing `SERVICE_RESULT` frame keeps its v1.1 shape but takes on
an extra role: it MUST be the **last** message for a given `callId`.
For streaming calls, the conventional final shape is:

- `ok: true` with `value: { __stream_end__: true }` — signals "no more
  chunks; all good." Clients close the iterator cleanly.
- `ok: false` with `error: {...}` — signals "stream terminated due to
  error." Clients reject the iterator with `ServiceCallError`.

The `__stream_end__` sentinel is opt-in; non-streaming calls keep
working unchanged (no chunks, terminal value is the result).

---

## SDK surface

### TypeScript

```ts
// New helper on every handle (typed agnostic to streaming-ness)
interface StreamableCall {
  callStream(method: string, ...args: unknown[]): AsyncIterable<unknown>
}
```

Usage:

```ts
const ds = session.services!.datastoreFor('sqlite', owner)
for await (const row of ds.callStream('sql.queryStream', 'SELECT * FROM big')) {
  console.log(row)
}
```

For built-in types, dedicated streaming methods (e.g.
`memory.recallStream({ k: 1000 })`) get added alongside the
non-streaming variants. Their existence in the protocol's
`BUILTIN_SERVICE_METHODS` table is what marks them streamable —
clients that don't know about a stream variant can still call the
non-streaming form.

### Python

```python
async for row in session.services.datastore['cases'].sql.query_stream(
    "SELECT * FROM big",
):
    print(row)
```

The Python SDK exposes streaming methods as `__call__`-returning
async iterators, mirroring TS shape.

---

## Server (host) responsibilities

`ServiceCallRouter` grows a streaming path:

1. After ACL passes, the router checks whether the resolved handle's
   method returns an `AsyncIterable<T>` (or is registered as
   streamable via plugin metadata; see §plugin contract).
2. If yes, the router consumes the iterator, ships each yielded value
   as a `SERVICE_RESULT_CHUNK { seq }`, and finally sends
   `SERVICE_RESULT { ok:true, value: {__stream_end__: true} }`.
3. If the iterator throws, the router sends `SERVICE_RESULT
   { ok:false, error: ... }` and ends the stream — no chunk loss
   recovery; the client treats it as a fatal call failure.
4. **Back-pressure**: the router does not pre-buffer. It awaits the
   underlying `ws.send` for each chunk. If the WebSocket buffer fills
   up, the iterator naturally pauses on the next yield — which is the
   right behaviour for SQL cursors and LLM streams alike.

Plugins opt into streaming by returning an `AsyncIterable<T>` from
their handle method. The plugin contract gains an optional metadata
field:

```ts
interface ServicePlugin {
  // … existing
  /**
   * Names of methods on this plugin's handle that return an
   * `AsyncIterable<T>` rather than a `Promise<T>`. The router uses this
   * to decide whether to ship chunks. If absent, the router
   * synchronously awaits the method and ships only `SERVICE_RESULT`.
   */
  readonly streamingMethods?: readonly string[]
}
```

For built-in types we extend the existing allowlist to include the
streaming-suffix variants:

```ts
BUILTIN_SERVICE_METHODS.memory.push('recallStream')
BUILTIN_SERVICE_METHODS.datastore.push('sql.queryStream')
```

These are additive — no client that doesn't ask for the streaming
variant ever sees the new frames.

---

## Cancellation

The sidecar needs a way to say "I'm done reading; please stop." We
reuse the existing CANCEL frame, namespaced to the callId:

```json
{
  "type": "SERVICE_CALL_CANCEL",
  "callId": "c12_abc34",
  "reason": "iterator_aborted"
}
```

On receipt, the router calls the iterator's `.return()` (or `.throw()`
if the plugin chose to react to cancellation). The next frame for
that callId is the terminal SERVICE_RESULT (often `ok:false,
error:{code:'cancelled'}`).

SDK iterators wired through `for await (...) { break }` automatically
emit `SERVICE_CALL_CANCEL` for the underlying call.

---

## Backward compatibility

- v1.2 clients calling v1.3 servers: never request streaming, never
  receive chunks. The streaming variants are advertised separately
  in the type-level allowlist; v1.2 clients only know the
  non-streaming names.
- v1.3 clients calling v1.2 servers: the streaming method's name is
  not on the v1.2 server's allowlist, so the call returns
  `unknown_method`. The SDK can fall back to the non-streaming variant
  if the caller used the high-level `callStream` helper.
- The CANCEL frame is namespaced (`SERVICE_CALL_CANCEL`) so it doesn't
  clash with the existing task-level CANCEL.

---

## What this RFC does **not** propose

- **Streaming requests** (client→server chunked input). Today's args
  shape is bounded — if you need to push 10MB of input, write it to
  `artifact` first and pass the ref. Adding bidirectional streaming
  would require a more involved state machine; defer until a real use
  case arrives.
- **Server-pushed unsolicited streams**. The existing channel
  pub/sub already covers "the server has something to say
  unprompted." SERVICE_CALL stays request/response — chunks are
  the response.

---

## Open questions for v1.3

1. **Heartbeat for long streams**. If a stream is silent for 30s, is
   that a stuck plugin or a slow legitimate result? Probably need a
   per-call idle timeout, configurable.
2. **Ordering across calls**. Today the router can serve multiple
   SERVICE_CALLs concurrently. Streaming complicates this — a slow
   stream's chunks must not block a fast independent call's
   SERVICE_RESULT. Confirm `ws.send` interleaving handles this
   (probably yes — `ws` is a queue) but write a stress test.
3. **Audit shape**. The current `service_call` transcript entry has
   a single `outcome`. For streams, we probably want
   `{ chunks: N, outcome: 'ok' | error_code }` — RFC the schema before
   landing.

---

## Status & next step

This is a sketch. **No code changes land for v1.2.** Before
implementing, we'd want:

1. A consumer (e.g. a managed-LLM plugin for `service-llm-stream`)
   wanting to use it concretely. Building the protocol around a
   hypothetical use case has historically led to abandoned generality
   in this codebase.
2. A draft of the `streamingMethods` plugin field with a real plugin
   pinned to it.
3. A reservation in `@gotong/protocol`'s `ServiceErrorCode` for
   `'stream_aborted'` and `'stream_overrun'` so v1.2 clients can
   surface them.

Until then, sidecars that need streaming can keep using the channel
`MESSAGE` frames as a side-channel — same wire, different semantics.
