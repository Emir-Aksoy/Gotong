# RFC: Plugin sandbox (long-term)

Status: **DESIGN ONLY**, no implementation in v1.2. This file exists
so the next contributor doesn't redesign from scratch.

---

## The problem

Today every service plugin loaded via `plugins.json` runs in the
**host process** with full Node permissions:

- Unrestricted filesystem access (even to paths outside `space.paths.services`).
- Unrestricted network access.
- Native bindings (`node-gyp`, `better-sqlite3`, …).
- Access to `process.env`, including secrets the host loaded.
- Ability to throw `process.exit()` and bring down the host.

This is fine for first-party plugins shipped by Gotong. It is **not
fine** for the open-ecosystem story sidecar agents enable:

- An organisation lets external developers contribute service
  plugins (e.g. a Notion-backed artifact plugin, a Postgres-backed
  datastore).
- The plugin's `init` accidentally walks `~/.ssh` looking for SSH
  keys, or its `attach` opens a TCP connection to an unrelated host.
- The host operator notices… eventually, in the audit log, after the
  damage.

Sidecar **agents** are isolated by being separate processes that
connect over WS — the SDK doesn't grant them filesystem access at
all. Plugins do not have this property today.

---

## Goals

In strict priority order:

1. **Filesystem confinement.** A plugin can only see
   `<services-root>/<type>/<impl>/`. Outside that subtree is
   invisible.
2. **Network egress blocked by default.** A plugin that opens an
   HTTP connection without an explicit `network: true` in
   `plugins.json` is killed.
3. **Hard crashes do not crash the host.** A plugin's
   `process.exit()` (or a native segfault) becomes an `attach_failed`
   for that specific service slot.
4. **Existing first-party plugins keep working.** The migration
   path must be opt-in for plugin authors, not retroactive.
5. **Performance ceiling.** A 1MB write to `artifact:file` must not
   pay a 10x round-trip penalty over the in-process baseline. This
   rules out pure HTTP-RPC between host and plugin.

Non-goals:

- Hard memory limits per plugin (`--max-old-space-size` is too coarse
  for workers; punt to later).
- Time-of-check vs time-of-use protection (the typical sandbox
  escape via symlinks). Mitigated by Goal 1 but not eliminated.

---

## Two candidate architectures

### Option A — `worker_threads`

Run each plugin instance in its own `Worker`. Communicate via
`MessageChannel`. Filesystem confinement enforced by **patching `fs`
inside the worker** before the plugin's code runs.

```
host                                worker_threads/
                                    │
HubServices ─── postMessage('attach') ─┐
                                       ▼
                                    plugin code
                                    (patched fs, patched http)
                                    │
                                    │ postMessage('result')
                                    ▼
HubServices ◀───
```

**Pros:**
- Same Node process, low IPC overhead (~50µs round-trip).
- Worker crashes do not kill the host; main thread sees `'exit'`.
- Easy migration: a plugin's existing code runs unchanged inside the
  worker, only the loader path changes.

**Cons:**
- `fs` patching is whack-a-mole. A plugin importing
  `fs/promises` directly, or using a native binding's own file
  descriptor, can escape. We need either:
  - A blocklist of paths above the plugin's rootDir (cheap, leaks).
  - `pivot_root`-style remount (Linux only, requires CAP_SYS_ADMIN).
- Native bindings (`better-sqlite3`, `argon2`) can't always be
  loaded in worker threads — the `napi_env` lifecycle is fragile.
  Affects our own `service-datastore-sqlite` plugin.
- No real network isolation. Workers share the host's network
  namespace. Best we can do is patch `http` / `https` / `net`.

### Option B — child process with `cwd` jailing + `--permission`

Spawn each plugin as a separate Node process. Use Node 22+'s
permission model (`--permission --allow-fs-read=... --allow-net=...`)
to enforce filesystem / network confinement at the runtime level.
Communicate via a Unix domain socket + JSON-RPC.

```
host process                          plugin process(es)
                                      ┌──────────────────────┐
HubServices ─── unix-socket ─────────▶│ plugin (--permission)│
                                      │ FS: services/<type>/ │
                                      │ NET: none            │
                                      └──────────────────────┘
```

**Pros:**
- True OS-level isolation. The plugin gets a real `EACCES` on
  out-of-bounds reads, not a fake one from a `fs` patch.
- Native bindings work — they're loaded in the plugin's own process
  with its own `napi_env`.
- Plugin crash isolation is automatic (separate PID).
- Future-compat: as Node's permission model matures, we get tighter
  guarantees for free.

**Cons:**
- 5-10x more memory per plugin (each worker holds its own V8 heap).
  For a host with ~6 plugins this adds ~100MB of overhead.
- IPC is slower (~1-2ms round-trip via UDS+JSON-RPC). Affects
  workloads that issue thousands of small calls per second.
- Bigger code surface: process supervision (auto-restart on crash,
  graceful shutdown, file-descriptor passing for the unix socket).

---

## Recommendation: phased

### Phase 1 (v1.3, ~2 weeks of work)

Ship Option A with `fs` patching. Targets the **honest mistake**
threat model: a third-party plugin that uses the standard `fs`
module accidentally walks above its rootDir. We refuse the I/O,
emit a `service_audit_violation` transcript event.

Explicit non-goal: a plugin that **deliberately** wants to escape
will. We document this and use code review + signing as the social
barrier for now.

Add to `plugins.json`:

```jsonc
{ "plugins": [
  // First-party / trusted: no sandbox.
  "@gotong/service-memory-file",
  // Untrusted: opt into worker sandbox.
  { "package": "third-party/notion-artifact", "sandbox": true },
]}
```

Default for unknown plugins is conservative: `sandbox: true` if the
package name doesn't match an `@gotong/*` first-party prefix.
First-party packages are always allowed full host access — they're
shipped in the same release as the host binary, so the trust
boundary is already drawn there.

### Phase 2 (v1.4+, ~6 weeks of work)

Ship Option B for plugins that ask for it via `sandbox: 'process'`.
Use Node 22+ permission model. Workers (Phase 1) stay for plugins
that need higher throughput.

Trigger for landing Phase 2: someone trying to run an actively
hostile plugin and needing real defence (probably an SaaS deployment
of Gotong).

---

## Open questions

1. **What about plugins that need to "look up the network"?** A
   Notion plugin needs to make HTTPS calls to api.notion.com. We
   need an allowlist syntax — probably
   `"network": ["api.notion.com:443"]` — and the runtime needs to
   reject anything else. Phase 1 best-effort, Phase 2 enforced.
2. **How does the SDK author test against sandboxed plugins?** The
   in-process testing path (`contractSuite`) bypasses sandbox. We
   need either (a) a separate "sandboxed contract" test mode, or
   (b) document that contract tests run un-sandboxed and rely on the
   sandbox layer being verified separately.
3. **`describe()` returns a `preview` blob** — sometimes binary,
   sometimes large. Cross-worker / cross-process this means a real
   copy. We need to make sure the protocol doesn't ship a 10MB
   blob through the IPC channel; cap at the existing
   `PREVIEW_MAX_BYTES` (already 2KB so this is fine).

---

## What v1.2 actually does today

**Nothing.** Plugins still run in-process with full permissions.
The honest signal in our docs is to mark third-party plugin install
in the host README as "trusted code only," and lean on the
plugins.json review step that admins approve.

If you're a deployment running someone else's plugin, your two
options before v1.3 ships are:

1. Review the plugin source like you'd review the host's source.
   Pre-build it from a known commit.
2. Don't load it — wrap it as a sidecar agent instead. SDK-level
   sandboxing already isolates sidecars cleanly.

---

## Cross-references

- `docs/services-over-ws-rfc.md` § Future Work (which mentions
  sandbox at a high level).
- `packages/services-sdk/src/plugin.ts` — current plugin contract,
  unchanged by this RFC.
- Node 22 permission model docs:
  https://nodejs.org/api/permissions.html#permission-model

---

## Status

- v1.2: this design doc only.
- v1.3 (likely): Phase 1 (worker_threads + fs patching).
- v1.4+ (conditional): Phase 2 (child process + Node permissions).
