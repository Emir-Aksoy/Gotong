# @gotong/service-memory-file

First-party Gotong plugin: file-backed `memory` service.
Implements [`MemoryHandle`](../services-sdk/src/types/memory.ts) on
top of append-only JSONL files.

## Layout (under `ServiceInitCtx.rootDir`)

```
<rootDir>/
├─ agent/<agentId>/
│  ├─ episodic.jsonl     ← one MemoryEntry per line
│  ├─ semantic.jsonl
│  └─ working.jsonl
├─ workflow-run/<runId>/   ← when scope=workflow
├─ shared/<groupId>/       ← when scope=shared:<group>
└─ .trash/
   └─ <trashRefId>/
      ├─ meta.json         ← serialized TrashRef
      └─ payload/          ← original owner directory, moved (not copied)
```

**Deviation from RFC §9**: that example showed `semantic.md` +
`working/<taskId>.json`. This plugin keeps all three kinds as
identical JSONL files for symmetry — `recall` / `list` / `forget(id)`
behave the same across kinds. Agents that want a markdown view of
semantic memory can read all `semantic.jsonl` entries and concatenate
their `text` fields.

Also: trash lives **under this plugin's rootDir**, not under a
shared `services/.trash/`. Keeps the SDK contract small. Hub
aggregates trash by calling each plugin's `listTrash()` (PR-5).

## Config schema

```yaml
uses:
  - type: memory
    impl: file
    config:
      kinds: [episodic, semantic]   # default: all three
      maxEpisodicBytes: 4194304     # default: no cap
      maxSemanticBytes: 1048576     # default: no cap
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `kinds` | `MemoryKind[]` | `['episodic','semantic','working']` | Allowed kinds. `remember()` on a disallowed kind throws. |
| `maxEpisodicBytes` | `number` | none | When `episodic.jsonl` exceeds this, the oldest ~50% of lines are dropped. |
| `maxSemanticBytes` | `number` | none | Same for `semantic.jsonl`. Working is never auto-truncated — agents are expected to `clear({kind:'working'})`. |

## Recall semantics

- Text match: case-insensitive substring on `entry.text`.
- `kinds` filter intersects with the configured `kinds`.
- `since`: only entries with `ts >= since`.
- `k`: capped at `200` (default `20`).
- Order: newest first by `ts`.

For vector-based recall, ship a separate plugin (`memory:vector`)
with the same `MemoryHandle` surface — agents can swap impls.

## Concurrency

All writes from one handle are serialized through an in-process
promise chain. Two concurrent `remember()` calls from the same agent
land one-after-the-other in the JSONL file (no interleaving).

The Hub guarantees one open handle per `(plugin, owner)` at a time;
this plugin makes no cross-handle locking attempt. Multi-host setups
that share an owner directory are out of scope for the file backend
— use a database-backed plugin there.

## Status

**PR-3 of 13.** Internal v0.1; interface stable within v0.x.
