/**
 * Run the shared plugin contract suite from @gotong/services-sdk
 * against DatastoreSqlitePlugin. Verifies it satisfies the same
 * lifecycle invariants as the other first-party plugins.
 */

import { describe, expect } from 'vitest'
import { runPluginContract } from '@gotong/services-sdk/testing'
import type { DatastoreHandle } from '@gotong/services-sdk'
import { DatastoreSqlitePlugin } from '../src/plugin.js'

describe('contract: datastore-sqlite', () => {
  runPluginContract({
    plugin: new DatastoreSqlitePlugin(),
    sampleConfig: { name: 'contract-default' },
    sampleOwner: { kind: 'agent', id: 'contract-agent' },
    writeSample: async (h: DatastoreHandle) => {
      await h.kv.set('sample-key', 'sample-value')
    },
    expectSamplePersisted: async (h: DatastoreHandle) => {
      expect(await h.kv.get('sample-key')).toBe('sample-value')
    },
  })
})
