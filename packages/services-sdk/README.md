# @aipehub/services-sdk

Plugin SDK for AipeHub Hub Services — the abstraction agents and
workflows use for memory, artifacts, datastores, and (later) anything
else the platform wants to manage as a pluggable resource.

> Same surface for first-party (`@aipehub/service-memory-file`,
> `service-artifact-file`, `service-datastore-sqlite`) and
> third-party plugins. No "internal interface" — the loader treats
> both identically.

See [docs/services-rfc.md](../../docs/services-rfc.md) for the design
behind this package.

## What's in here

| File | Purpose |
|---|---|
| `src/plugin.ts` | `ServicePlugin<TConfig, THandle>` — the main contract |
| `src/types/{memory,artifact,datastore}.ts` | Per-type handle interfaces agents call |
| `src/owner.ts` | `Owner` / `Scope` / `resolveOwner()` |
| `src/trash.ts` | `TrashRef` + deterministic id hashing |
| `src/registry.ts` | In-memory plugin index |
| `src/loader.ts` | Reads `plugins.json`, dynamic-imports each entry |
| `src/testing.ts` | `runPluginContract()` shared suite for plugin authors |

## Writing a plugin (sketch)

```ts
import type { ServicePlugin, MemoryHandle, Owner } from '@aipehub/services-sdk'

export default class MyMemoryPlugin implements ServicePlugin<MyConfig, MemoryHandle> {
  readonly type = 'memory'
  readonly impl = 'my-impl'
  readonly version = '0.1.0'
  readonly description = 'In-memory demo'

  async validateConfig(raw) { /* parse + throw on bad */ return raw as MyConfig }
  async init(ctx) { /* one-time setup */ }
  async attach(owner, cfg): Promise<MemoryHandle> { /* return handle */ }
  async detach(owner) { /* close, keep data */ }
  async softDelete(owner) { /* move to trash, return TrashRef */ }
  async restore(ref) { /* move back */ }
  async hardDelete(ref) { /* nuke */ }
  async describe(owner) { /* { sizeBytes, preview? } */ }
  async shutdown() { /* flush + close */ }
}
```

Run the standard contract tests against it:

```ts
import { describe } from 'vitest'
import { runPluginContract } from '@aipehub/services-sdk/testing'

describe('contract: my-memory-plugin', () => {
  runPluginContract({
    plugin: new MyMemoryPlugin(),
    sampleConfig: { /* ... */ },
    sampleOwner: { kind: 'agent', id: 'test-agent' },
    writeSample: async (h) => { await h.remember({ kind: 'episodic', text: 'hi' }) },
    expectSamplePersisted: async (h) => {
      const items = await h.list({ limit: 10 })
      expect(items).toHaveLength(1)
    },
  })
})
```

## Status

**PR-2 of 13** in the Hub Services rollout. Interfaces are stable
within v0.x major but minor releases may add fields.
