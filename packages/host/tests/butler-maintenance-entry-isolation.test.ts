import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@gotong/core'
import type { LlmProvider, LlmStreamChunk } from '@gotong/llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ButlerUserActivity } from '../src/butler-user-activity.js'
import { FileButlerUserIsolation } from '../src/butler-user-isolation.js'
import { runButlerMaintenanceOnce } from '../src/personal-butler-maintenance.js'
import { buildButlerConsolidateToolset } from '../src/personal-butler-consolidate.js'
import * as memory from '../src/personal-butler-memory.js'
import * as obsidian from '../src/butler-obsidian.js'

const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger },
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
const provider: LlmProvider = {
  name: 'synthetic',
  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'text', text: 'synthetic summary' }
    yield { type: 'end', stopReason: 'end_turn' }
  },
}

describe('standalone memory maintenance admission', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'gotong-maint-entry-')) })
  afterEach(() => { vi.restoreAllMocks() })

  it('checks persisted isolation before opening memory, summarizing or projecting', async () => {
    await new FileButlerUserIsolation(root).close('alice')
    const open = vi.spyOn(memory, 'openButlerMemory')
    const project = vi.spyOn(obsidian, 'projectButlerVault')
    const summarize = vi.fn(async () => 'synthetic')
    await expect(runButlerMaintenanceOnce({ rootDir: root, userId: 'alice', summarize, logger }))
      .rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(open).not.toHaveBeenCalled()
    expect(summarize).not.toHaveBeenCalled()
    expect(project).not.toHaveBeenCalled()
    await expect(runButlerMaintenanceOnce({ rootDir: root, userId: 'bob', summarize, logger }))
      .resolves.toHaveProperty('summary')
  })

  it.each([false, true])('drains the complete standalone pass including late projection; fails = %s', async fails => {
    const activity = new ButlerUserActivity()
    const entered = deferred()
    const gate = deferred()
    const project = obsidian.projectButlerVault
    vi.spyOn(obsidian, 'projectButlerVault').mockImplementation(async opts => {
      entered.resolve()
      await gate.promise
      if (fails) throw new Error('private-marker', { cause: 'private-marker' })
      await project(opts)
    })
    const summarize = vi.fn(async () => 'synthetic')
    const retire = vi.fn()
    activity.register('alice', retire)
    const result = runButlerMaintenanceOnce({ rootDir: root, userId: 'alice', summarize, logger, userActivity: activity })
      .catch(e => e)
    await entered.promise
    const closing = activity.quiesce('alice')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(retire).not.toHaveBeenCalled()
    await expect(runButlerMaintenanceOnce({ rootDir: root, userId: 'alice', summarize, logger, userActivity: activity }))
      .rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    gate.resolve()
    const error = await result
    expect(error).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain('private-marker')
    await closing
    expect(retire).toHaveBeenCalledTimes(1)
  })

  it('the standalone consolidation tool forwards shared activity through projection completion', async () => {
    const activity = new ButlerUserActivity()
    const entered = deferred()
    const gate = deferred()
    vi.spyOn(obsidian, 'projectButlerVault').mockImplementation(async () => { entered.resolve(); await gate.promise })
    const retire = vi.fn()
    activity.register('alice', retire)
    const tool = buildButlerConsolidateToolset({
      rootDir: root, userId: 'alice', buildProvider: async () => provider, logger, userActivity: activity,
    })
    const result = tool.callTool('consolidate_my_memory', {})
    await entered.promise
    const closing = activity.quiesce('alice')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(retire).not.toHaveBeenCalled()
    gate.resolve()
    expect(await result).toMatchObject({ isError: true })
    await closing
    expect(retire).toHaveBeenCalledTimes(1)
  })
})
