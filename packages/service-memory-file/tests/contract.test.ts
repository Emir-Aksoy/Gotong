/**
 * Run the shared plugin contract suite from @gotong/services-sdk
 * against MemoryFilePlugin. This validates lifecycle invariants —
 * persistence across detach/re-attach, soft delete → restore round
 * trip, idempotent same-day soft delete — that every plugin in the
 * registry must honour.
 */

import { describe, expect } from 'vitest'
import { runPluginContract } from '@gotong/services-sdk/testing'
import { MemoryFilePlugin } from '../src/plugin.js'
import type { MemoryHandle } from '@gotong/services-sdk'

describe('contract: memory-file', () => {
  runPluginContract({
    plugin: new MemoryFilePlugin(),
    sampleConfig: { kinds: ['episodic'] },
    sampleOwner: { kind: 'agent', id: 'contract-agent' },
    writeSample: async (h: MemoryHandle) => {
      await h.remember({ kind: 'episodic', text: 'sample-line' })
    },
    expectSamplePersisted: async (h: MemoryHandle) => {
      const items = await h.list({ limit: 10 })
      expect(items.map((x) => x.text)).toContain('sample-line')
    },
  })
})
