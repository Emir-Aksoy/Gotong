/**
 * Run the shared plugin contract suite from @gotong/services-sdk
 * against ArtifactFilePlugin. Verifies it satisfies the same
 * lifecycle invariants as memory-file.
 */

import { describe, expect } from 'vitest'
import { runPluginContract } from '@gotong/services-sdk/testing'
import type { ArtifactHandle } from '@gotong/services-sdk'
import { ArtifactFilePlugin } from '../src/plugin.js'

describe('contract: artifact-file', () => {
  runPluginContract({
    plugin: new ArtifactFilePlugin(),
    sampleConfig: { name: 'contract-default' },
    sampleOwner: { kind: 'agent', id: 'contract-agent' },
    writeSample: async (h: ArtifactHandle) => {
      await h.write('sample.md', '# sample')
    },
    expectSamplePersisted: async (h: ArtifactHandle) => {
      expect(await h.exists('sample.md')).toBe(true)
      const { content } = await h.read('sample.md')
      expect(content).toBe('# sample')
    },
  })
})
