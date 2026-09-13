import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hub, Logger, Participant, Task } from '@gotong/core'
import type { LlmProvider, LlmStreamChunk } from '@gotong/llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildButlerFactory, type ButlerFactoryRefs } from '../src/personal-butler-factory.js'
import { ButlerUserActivity } from '../src/butler-user-activity.js'
import * as recall from '../src/butler-recall-index.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { ButlerMaintenanceSweeper } from '../src/personal-butler-maintenance.js'
import * as obsidian from '../src/butler-obsidian.js'

const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger },
}
const refs: ButlerFactoryRefs = {
  governedAgents: undefined, workflowEditor: undefined, workflowCreate: undefined,
  workflows: undefined, observeRuns: undefined, observeAgents: undefined,
  observeUsage: undefined, diagnoseOwned: undefined, diagnoseAdapt: undefined,
  askRoster: undefined, memberPush: undefined, peerRoster: undefined, llmRoster: undefined,
  schedules: undefined, pendingInbox: undefined, wizard: undefined,
  providerBuilder: undefined, memoryView: undefined,
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
const task = (userId = 'alice'): Task => ({
  id: 't', from: 'user:x', strategy: { kind: 'explicit', to: 'chat' },
  payload: 'synthetic query', origin: { orgId: 'local', userId },
})
const provider: LlmProvider = {
  name: 'synthetic',
  async *stream(): AsyncIterable<LlmStreamChunk> {
    yield { type: 'text', text: 'synthetic answer' }
    yield { type: 'end', stopReason: 'end_turn' }
  },
}

describe('factory user quiescence wiring', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gotong-factory-quiescence-')) })
  afterEach(() => { vi.restoreAllMocks() })
  const factory = (memoryRoot: string, userActivity?: ButlerUserActivity) => buildButlerFactory({
    hub: { dispatch: async () => ({ kind: 'ok' }) } as unknown as Hub,
    logger, memoryRoot, userActivity, refs: () => refs,
    governedOn: false, maintenanceOn: false, proactiveOn: false, runBroadcastOn: false,
  })

  it('a new default factory rejects a persisted isolation before opening memory or calling the model', async () => {
    await mkdir(join(root, '.user-isolation', createHash('sha256').update('alice').digest('hex')), { recursive: true })
    const opened = vi.spyOn(recall, 'openButlerRecallIndex')
    const stream = vi.spyOn(provider, 'stream')
    const router = factory(root)({ id: 'restarted', capabilities: ['chat'], provider })
    await expect(router.onTask!(task())).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await expect(router.onResume!(task(), {})).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(opened).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'user', 'alice'))).toBe(false)
    await expect(router.onTask!(task('bob'))).resolves.toMatchObject({ kind: 'ok' })
    await router.onShutdown!()
  })

  it('shares one injected activity across agents, drains their tasks, and retires their real indexes', async () => {
    const userActivity = new ButlerUserActivity()
    const opened = vi.spyOn(recall, 'openButlerRecallIndex')
    const build = factory(root, userActivity)
    const gate = deferred()
    const entered = [deferred(), deferred()]
    const routers = entered.map((entry, i) => build({
      id: `chat-${i}`, capabilities: ['chat'], provider: {
        name: 'delayed', async *stream(): AsyncIterable<LlmStreamChunk> {
          entry.resolve()
          await gate.promise
          yield { type: 'text', text: 'private-marker' }
          yield { type: 'end', stopReason: 'end_turn' }
        },
      },
    }))
    const memory = openButlerMemory({ rootDir: root, userId: 'alice', logger })
    await memory.remember({ kind: 'semantic', text: 'synthetic query evidence' })
    const tasks = routers.map(router => router.onTask!(task()).catch(e => e))
    await Promise.all(entered.map(e => e.promise))
    const indexes = opened.mock.results.map(r => r.value as recall.FileBackedInvertedIndex)
    expect(indexes).toHaveLength(2)
    await Promise.all(indexes.map(index => index.ensureFresh()))
    const cache = join(root, 'user', 'alice', 'recall-index.json')
    expect(existsSync(cache)).toBe(true)
    const retired = indexes.map(index => vi.spyOn(index, 'retire'))
    const closed = userActivity.quiesce('alice')
    for (const router of routers) {
      await expect(router.onResume!(task(), {})).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    }
    expect(retired.every(r => r.mock.calls.length === 0)).toBe(true)
    gate.resolve()
    for (const error of await Promise.all(tasks)) expect(error).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await closed
    expect(existsSync(cache)).toBe(false)
    for (const index of indexes) await expect(index.ensureFresh()).rejects.toMatchObject({ code: 'RECALL_INDEX_RETIRED' })
    for (const router of routers) await expect(router.onTask!(task())).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(opened).toHaveBeenCalledTimes(3) // Two live indexes plus lightweight disk cleanup.
    await expect(routers[0]!.onTask!(task('bob'))).resolves.toMatchObject({ kind: 'ok' })
    expect(opened).toHaveBeenCalledTimes(4)
  })

  it('allocates the default registry once per factory, not once per router', async () => {
    const registration = vi.spyOn(ButlerUserActivity.prototype, 'register')
    const finalization = vi.spyOn(ButlerUserActivity.prototype, 'registerFinalizer')
    const build = factory(root)
    const one = build({ id: 'one', capabilities: ['chat'], provider })
    const two = build({ id: 'two', capabilities: ['chat'], provider })
    await one.onTask!(task())
    await two.onTask!(task())
    expect(registration).toHaveBeenCalledTimes(2)
    expect(finalization).toHaveBeenCalledTimes(1)
    const shared = registration.mock.contexts[0] as ButlerUserActivity
    expect(registration.mock.contexts.every(context => context === shared)).toBe(true)
    expect(finalization.mock.contexts[0]).toBe(shared)
    await shared.quiesce('alice')
    await expect(one.onTask!(task())).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await expect(two.onTask!(task())).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    const restarted = factory(root)({ id: 'new-process', capabilities: ['chat'], provider })
    await expect(restarted.onTask!(task())).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await expect(restarted.onTask!(task('bob'))).resolves.toMatchObject({ kind: 'ok' })
    await restarted.onShutdown!()
  })

  it('normal shutdown preserves caches and later quiescence cleans them without retaining the old index', async () => {
    const activity = new ButlerUserActivity()
    const opened = vi.spyOn(recall, 'openButlerRecallIndex')
    const router = factory(root, activity)({ id: 'chat', capabilities: ['chat'], provider })
    await router.onTask!(task())
    const index = opened.mock.results[0]!.value as recall.FileBackedInvertedIndex
    await index.ensureFresh()
    const cache = join(root, 'user', 'alice', 'recall-index.json')
    const retire = vi.spyOn(index, 'retire')
    await router.onShutdown!()
    expect(retire).not.toHaveBeenCalled()
    expect(existsSync(cache)).toBe(true)
    await activity.quiesce('alice')
    await expect(router.onTask!(task())).rejects.toMatchObject({ code: 'BUTLER_ROUTER_CLOSED' })
    expect(retire).not.toHaveBeenCalled()
    expect(opened).toHaveBeenCalledTimes(2)
    expect(existsSync(cache)).toBe(false)
  })

  it('stop/restart unregisters old instance callbacks, leaving one lightweight disk responsibility per user', async () => {
    const activity = new ButlerUserActivity()
    const finalization = vi.spyOn(activity, 'registerFinalizer')
    const register = activity.register.bind(activity)
    const active = new Set<() => void | Promise<void>>()
    const disposers: Array<ReturnType<typeof vi.fn>> = []
    vi.spyOn(activity, 'register').mockImplementation((userId, retire) => {
      const unregister = register(userId, retire)
      active.add(retire)
      const dispose = vi.fn(() => {
        const removed = unregister()
        if (removed) active.delete(retire)
        return removed
      })
      disposers.push(dispose)
      return dispose
    })
    const opened = vi.spyOn(recall, 'openButlerRecallIndex')
    const build = factory(root, activity)
    const oldRetirements: Array<ReturnType<typeof vi.spyOn>> = []
    for (let i = 0; i < 4; i++) {
      const router = build({ id: `chat-${i}`, capabilities: ['chat'], provider })
      await router.onTask!(task())
      const index = opened.mock.results[i]!.value as recall.FileBackedInvertedIndex
      oldRetirements.push(vi.spyOn(index, 'retire'))
      expect(active.size).toBe(1)
      await router.onShutdown!()
      expect(active.size).toBe(0)
      expect(finalization).toHaveBeenCalledTimes(1)
    }
    expect(disposers).toHaveLength(4)
    expect(disposers.filter(dispose => dispose.mock.calls.length === 1)).toHaveLength(4)
    expect(disposers.filter(dispose => dispose.mock.calls.length === 0)).toHaveLength(0)
    await activity.quiesce('alice')
    expect(oldRetirements.every(retire => retire.mock.calls.length === 0)).toBe(true)
    expect(opened).toHaveBeenCalledTimes(5)
    expect(existsSync(join(root, 'user', 'alice', 'recall-index.json'))).toBe(false)
  })

  it('retries failed lightweight disk cleanup after the last live router has stopped', async () => {
    const activity = new ButlerUserActivity()
    const router = factory(root, activity)({ id: 'chat', capabilities: ['chat'], provider })
    await router.onTask!(task())
    await router.onShutdown!()
    const opened = vi.spyOn(recall, 'openButlerRecallIndex')
    const retire = vi.spyOn(recall.FileBackedInvertedIndex.prototype, 'retire')
      .mockRejectedValueOnce(new Error('private-marker'))
    const error = await activity.quiesce('alice').catch(e => e)
    expect(error).toMatchObject({ code: 'BUTLER_USER_RETIRE_FAILED' })
    expect(error).not.toHaveProperty('cause')
    await expect(activity.run('alice', vi.fn())).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await activity.quiesce('alice')
    expect(opened).toHaveBeenCalledTimes(2)
    expect(retire).toHaveBeenCalledTimes(2)
    expect(existsSync(join(root, 'user', 'alice', 'recall-index.json'))).toBe(false)
  })

  it('strictly awaits instance shutdown and propagates its failure without skipping index retirement', async () => {
    const activity = new ButlerUserActivity()
    const opened = vi.spyOn(recall, 'openButlerRecallIndex')
    // Capture the real participant at its existing router construction boundary.
    const routerModule = await import('../src/butler-router.js')
    const create = routerModule.createButlerRouter
    let instance!: Participant
    vi.spyOn(routerModule, 'createButlerRouter').mockImplementation(opts => create({
      ...opts, createForUser: user => { instance = opts.createForUser(user); return instance },
    }))
    const router = factory(root, activity)({ id: 'chat', capabilities: ['chat'], provider })
    await router.onTask!(task())
    const index = opened.mock.results[0]!.value as recall.FileBackedInvertedIndex
    const retire = vi.spyOn(index, 'retire')
    const gate = deferred()
    const started = deferred()
    instance.onShutdown = vi.fn(async () => { started.resolve(); await gate.promise; throw new Error('private-marker') })
    const closed = activity.quiesce('alice').catch(e => e)
    await started.promise
    expect(retire).not.toHaveBeenCalled()
    gate.resolve()
    expect(await closed).toMatchObject({ code: 'BUTLER_USER_RETIRE_FAILED' })
    expect(retire).toHaveBeenCalledTimes(1)
    instance.onShutdown = vi.fn()
    await activity.quiesce('alice')
    expect(instance.onShutdown).toHaveBeenCalledTimes(1)
  })

  it('purges a shared cache recreated by shutdown retry after the real instance index already retired', async () => {
    const activity = new ButlerUserActivity()
    const opened = vi.spyOn(recall, 'openButlerRecallIndex')
    const routerModule = await import('../src/butler-router.js')
    const create = routerModule.createButlerRouter
    let instance!: Participant
    vi.spyOn(routerModule, 'createButlerRouter').mockImplementation(opts => create({
      ...opts, createForUser: user => { instance = opts.createForUser(user); return instance },
    }))
    const router = factory(root, activity)({ id: 'chat', capabilities: ['chat'], provider })
    await router.onTask!(task())
    const index = opened.mock.results[0]!.value as recall.FileBackedInvertedIndex
    await index.ensureFresh()
    const cache = join(root, 'user', 'alice', 'recall-index.json')
    expect(existsSync(cache)).toBe(true)
    instance.onShutdown = vi.fn()
      .mockRejectedValueOnce(new Error('private-marker'))
      .mockImplementationOnce(async () => { await writeFile(cache, '{"synthetic":"recreated on retry"}') })
    await expect(activity.quiesce('alice')).rejects.toMatchObject({ code: 'BUTLER_USER_RETIRE_FAILED' })
    expect(opened).toHaveBeenCalledTimes(1) // Finalizer has not opened a cleanup index yet.
    const originalRetirement = index.retire()
    await originalRetirement
    await expect(index.ensureFresh()).rejects.toMatchObject({ code: 'RECALL_INDEX_RETIRED' })
    await activity.quiesce('alice')
    expect(instance.onShutdown).toHaveBeenCalledTimes(2)
    expect(opened).toHaveBeenCalledTimes(2)
    // Reusing this already-successful promise does NOT purge a newly written file.
    expect(index.retire()).toBe(originalRetirement)
    await expect(readFile(cache, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a newly requested maintenance pass after its outer task has been closed', async () => {
    const activity = new ButlerUserActivity()
    const run = vi.spyOn(activity, 'run')
    const projection = vi.spyOn(obsidian, 'projectButlerVault')
    const maintenanceStream = vi.spyOn(provider, 'stream')
    const gate = deferred()
    const entered = deferred()
    const buildProvider = vi.fn(async () => provider)
    let rounds = 0
    const router = buildButlerFactory({
      hub: { dispatch: async () => ({ kind: 'ok' }) } as unknown as Hub,
      logger, memoryRoot: root, userActivity: activity,
      refs: () => ({ ...refs, providerBuilder: buildProvider }),
      governedOn: false, maintenanceOn: true, proactiveOn: false, runBroadcastOn: false,
    })({
      id: 'chat', capabilities: ['chat'], provider: {
        name: 'on-demand', async *stream(): AsyncIterable<LlmStreamChunk> {
          if (rounds++ === 0) {
            entered.resolve()
            await gate.promise
            yield { type: 'tool_use', toolUse: {
              type: 'tool_use', id: 'consolidate', name: 'use_tool',
              input: { name: 'consolidate_my_memory', args: {} },
            } }
            yield { type: 'end', stopReason: 'tool_use' }
          } else {
            yield { type: 'text', text: 'synthetic completion' }
            yield { type: 'end', stopReason: 'end_turn' }
          }
        },
      },
    })
    const pending = router.onTask!(task()).catch(e => e)
    await entered.promise
    const closed = activity.quiesce('alice')
    gate.resolve()
    expect(await pending).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await closed
    expect(buildProvider).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(2)
    expect(projection).not.toHaveBeenCalled()
    expect(maintenanceStream).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'user', 'alice', 'STATUS.md'))).toBe(false)
  })

  it('one shared activity drains a real factory task and a sweeper projection together', async () => {
    const activity = new ButlerUserActivity()
    const opened = vi.spyOn(recall, 'openButlerRecallIndex')
    const modelGate = deferred()
    const modelEntered = deferred()
    const projectGate = deferred()
    const projectEntered = deferred()
    const router = factory(root, activity)({
      id: 'chat', capabilities: ['chat'], provider: {
        name: 'shared', async *stream(): AsyncIterable<LlmStreamChunk> {
          modelEntered.resolve()
          await modelGate.promise
          yield { type: 'end', stopReason: 'end_turn' }
        },
      },
    })
    await openButlerMemory({ rootDir: root, userId: 'alice', logger }).remember({ kind: 'semantic', text: 'synthetic' })
    const pending = router.onTask!(task()).catch(e => e)
    await modelEntered.promise
    const project = obsidian.projectButlerVault
    vi.spyOn(obsidian, 'projectButlerVault').mockImplementation(async opts => {
      projectEntered.resolve()
      await projectGate.promise
      await project(opts)
    })
    const sweeper = new ButlerMaintenanceSweeper({ rootDir: root, logger, userActivity: activity, buildProvider: async () => null })
    const sweep = sweeper.runOnce()
    await projectEntered.promise
    const index = opened.mock.results[0]!.value as recall.FileBackedInvertedIndex
    const retire = vi.spyOn(index, 'retire')
    const closed = activity.quiesce('alice')
    modelGate.resolve()
    expect(await pending).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    expect(retire).not.toHaveBeenCalled()
    projectGate.resolve()
    await closed
    await sweep
    expect(retire).toHaveBeenCalledTimes(1)
  })
})
