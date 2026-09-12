import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@gotong/core'
import type { LlmProvider, LlmStreamChunk } from '@gotong/llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ButlerUserActivity } from '../src/butler-user-activity.js'
import { ButlerMaintenanceSweeper } from '../src/personal-butler-maintenance.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
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
    yield { type: 'text', text: 'synthetic digest' }
    yield { type: 'end', stopReason: 'end_turn' }
  },
}

describe('maintenance user quiescence wiring', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gotong-maint-quiescence-')) })
  afterEach(() => { vi.restoreAllMocks() })
  async function seed(userId: string, count = 1) {
    const memory = openButlerMemory({ rootDir: root, userId, logger, now: () => 1000 })
    for (let i = 0; i < count; i++) await memory.remember({
      kind: count > 1 ? 'episodic' : 'semantic', text: `synthetic evidence number ${i}`,
      meta: { importance: 2, tier: 'persona' },
    })
  }

  it('drains the real maintenance pass and its later Git work before retirement', async () => {
    await seed('alice', 40)
    await seed('bob')
    const activity = new ButlerUserActivity()
    const modelGate = deferred()
    const modelEntered = deferred()
    const gitGate = deferred()
    const gitEntered = deferred()
    const retire = vi.fn()
    activity.register('alice', retire)
    const gitUsers: string[] = []
    const sweeper = new ButlerMaintenanceSweeper({
      rootDir: root, logger, userActivity: activity, now: () => 9_000_000,
      buildProvider: async () => ({
        name: 'delayed', async *stream(): AsyncIterable<LlmStreamChunk> {
          modelEntered.resolve()
          await modelGate.promise
          yield { type: 'text', text: 'synthetic digest' }
          yield { type: 'end', stopReason: 'end_turn' }
        },
      }),
      gitSnapshot: true, git: async (_args, cwd) => {
        gitUsers.push(cwd)
        if (cwd.endsWith('/alice')) { gitEntered.resolve(); await gitGate.promise }
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    const sweep = sweeper.runOnce()
    await modelEntered.promise
    const closed = activity.quiesce('alice')
    await Promise.resolve()
    await Promise.resolve()
    expect(retire).not.toHaveBeenCalled()
    modelGate.resolve()
    await gitEntered.promise
    expect(retire).not.toHaveBeenCalled()
    gitGate.resolve()
    await closed
    await sweep
    expect(retire).toHaveBeenCalledTimes(1)
    expect(gitUsers).toContain(join(root, 'user', 'bob'))
    gitUsers.length = 0
    await sweeper.runOnce()
    expect(gitUsers).not.toContain(join(root, 'user', 'alice'))
    expect(gitUsers).toContain(join(root, 'user', 'bob'))
  })

  it('drains the entire no-model projection before retirement', async () => {
    await seed('alice')
    await seed('bob')
    const activity = new ButlerUserActivity()
    const gate = deferred()
    const entered = deferred()
    const project = obsidian.projectButlerVault
    const projection = vi.spyOn(obsidian, 'projectButlerVault').mockImplementation(async opts => {
      if (opts.userId === 'alice') { entered.resolve(); await gate.promise }
      await project(opts)
    })
    const retire = vi.fn()
    activity.register('alice', retire)
    const sweeper = new ButlerMaintenanceSweeper({ rootDir: root, logger, userActivity: activity, buildProvider: async () => null })
    const sweep = sweeper.runOnce()
    await entered.promise
    const closed = activity.quiesce('alice')
    await Promise.resolve()
    await Promise.resolve()
    expect(retire).not.toHaveBeenCalled()
    gate.resolve()
    await closed
    await sweep
    expect(existsSync(join(root, 'user', 'alice', 'memory', 'persona.md'))).toBe(true)
    expect(existsSync(join(root, 'user', 'bob', 'memory', 'persona.md'))).toBe(true)
    projection.mockClear()
    await sweeper.runOnce()
    expect(projection.mock.calls.map(([opts]) => opts.userId)).toEqual(['bob'])
  })

  it.each([false, true])('skips closed users before any member work; model available = %s', async withModel => {
    await seed('alice')
    await seed('bob')
    const activity = new ButlerUserActivity()
    await activity.quiesce('alice')
    const projection = vi.spyOn(obsidian, 'projectButlerVault')
    const sweeper = new ButlerMaintenanceSweeper({
      rootDir: root, logger, userActivity: activity,
      buildProvider: async () => withModel ? provider : null,
    })
    await sweeper.runOnce()
    expect(projection.mock.calls.map(([opts]) => opts.userId)).toEqual(['bob'])
    expect(existsSync(join(root, 'user', 'alice', 'memory', 'persona.md'))).toBe(false)
    expect(existsSync(join(root, 'user', 'bob', 'memory', 'persona.md'))).toBe(true)
  })
})
