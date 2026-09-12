import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hub, Space, type AgentRecord, type Logger, type Participant, type Task, type TaskResult } from '@gotong/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalAgentPool } from '../src/local-agent-pool.js'
import { createButlerRouter, type ButlerRouter } from '../src/butler-router.js'
import { ButlerUserActivity } from '../src/butler-user-activity.js'

const poolLog = vi.hoisted(() => {
  const logger: Logger = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: () => logger,
  }
  return logger
})
vi.mock('@gotong/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@gotong/core')>()
  return { ...actual, createLogger: (...args: Parameters<typeof actual.createLogger>) =>
    args[0] === 'local-agents' ? poolLog : actual.createLogger(...args) }
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
const row: AgentRecord = {
  id: 'assistant', allowedCapabilities: ['chat'], createdAt: '2026-09-12T00:00:00Z',
  managed: { kind: 'llm', provider: 'mock', system: 'synthetic' },
}
const task = (id = 'fast'): Task => ({
  id, from: 'user:alice', strategy: { kind: 'explicit', to: 'assistant' },
  payload: 'synthetic', origin: { orgId: 'local', userId: 'alice' },
})
const result: TaskResult = { kind: 'ok', taskId: 't', by: 'assistant', output: 'synthetic', ts: 1 }
const participant = (extra: Partial<Participant> = {}): Participant => ({
  id: 'assistant', kind: 'agent', capabilities: ['chat'], onTask: async () => result, ...extra,
})

describe('LocalAgentPool real butler shutdown wiring', () => {
  let space: Space
  let hub: Hub
  const release: Array<() => void> = []
  beforeEach(async () => {
    vi.clearAllMocks()
    const root = await mkdtemp(join(tmpdir(), 'gotong-pool-butler-shutdown-'))
    space = (await Space.init(root, { name: 'synthetic' })).space
    hub = new Hub({ space })
    await hub.start()
  })
  afterEach(async () => {
    for (const resolve of release.splice(0)) resolve()
    await hub.stop()
    vi.restoreAllMocks()
  })
  function gate() {
    const value = deferred()
    release.push(value.resolve)
    return value
  }

  it.each(['stop/start', 'direct replacement'] as const)('%s closes the old router without awaiting its tail and releases its registration', async mode => {
    const activity = new ButlerUserActivity()
    const active = new Set<() => void | Promise<void>>()
    const register = activity.register.bind(activity)
    vi.spyOn(activity, 'register').mockImplementation((userId, retire) => {
      const dispose = register(userId, retire)
      active.add(retire)
      return () => {
        const removed = dispose()
        if (removed) active.delete(retire)
        return removed
      }
    })
    const tail = gate()
    const writes: string[] = []
    const instanceShutdown = vi.fn()
    const routers: ButlerRouter[] = []
    const pool = new LocalAgentPool({ hub, space, butlerDefaultOn: true,
      butlerFactory: base => {
        const router = createButlerRouter({ id: base.id, capabilities: ['chat'], userActivity: activity,
          createForUser: () => participant({
            onTask: async t => { if (t.id === 'slow') await tail.promise; writes.push(t.id); return result },
            onShutdown: instanceShutdown,
          }) })
        routers.push(router)
        return router
      },
    })
    await pool.start(row)
    const old = routers[0]!
    const shutdown = vi.spyOn(old, 'onShutdown')
    const pending = old.onTask!(task('slow'))
    const stopping = mode === 'stop/start' ? pool.stop(row.id) : pool.start(row)
    if (mode === 'stop/start') {
      // The local gate closes before stop yields to service/MCP detachment.
      await expect(old.onTask!(task())).rejects.toMatchObject({ code: 'BUTLER_ROUTER_CLOSED' })
    }
    await stopping
    expect(shutdown).toHaveBeenCalledTimes(1)
    await expect(old.onResume!(task(), {})).rejects.toMatchObject({ code: 'BUTLER_ROUTER_CLOSED' })
    await expect(old.onTaskCancelled!('slow', 'stop')).rejects.toMatchObject({ code: 'BUTLER_ROUTER_CLOSED' })
    expect(instanceShutdown).not.toHaveBeenCalled()
    expect(active.size).toBe(1)
    if (mode === 'stop/start') await pool.start(row)
    const current = routers[1]!
    expect(hub.participant(row.id)).toBe(current)
    await expect(current.onTask!(task('new'))).resolves.toBe(result)
    expect(active.size).toBe(2)
    tail.resolve()
    await pending
    await shutdown.mock.results[0]!.value
    expect(writes).toEqual(['new', 'slow'])
    expect(old.size).toBe(0)
    expect(active.size).toBe(1)
    expect(instanceShutdown).toHaveBeenCalledTimes(1)
    await activity.quiesce('alice')
    expect(instanceShutdown).toHaveBeenCalledTimes(2)
    expect(current.size).toBe(0)
  })

  it('an admitted task can await stopping itself without deadlocking on its own drain', async () => {
    const stopped = gate()
    const tail = gate()
    const instanceShutdown = vi.fn()
    let router!: ButlerRouter
    const pool = new LocalAgentPool({ hub, space, butlerDefaultOn: true,
      butlerFactory: base => {
        router = createButlerRouter({ id: base.id, capabilities: ['chat'], createForUser: () => participant({
          onTask: async () => { await pool.stop(row.id); stopped.resolve(); await tail.promise; return result },
          onShutdown: instanceShutdown,
        }) })
        return router
      },
    })
    await pool.start(row)
    const shutdown = vi.spyOn(router, 'onShutdown')
    const pending = router.onTask!(task())
    await stopped.promise
    expect(hub.participant(row.id)).toBeUndefined()
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(instanceShutdown).not.toHaveBeenCalled()
    await expect(router.onTask!(task())).rejects.toMatchObject({ code: 'BUTLER_ROUTER_CLOSED' })
    tail.resolve()
    expect(await pending).toBe(result)
    await shutdown.mock.results[0]!.value
    expect(router.size).toBe(0)
    expect(instanceShutdown).toHaveBeenCalledTimes(1)
  })

  it('user quiescence still drains a stopped old router and the pool observes its late shutdown rejection', async () => {
    const activity = new ButlerUserActivity()
    const tail = gate()
    const instanceShutdown = vi.fn()
    const retire = vi.fn()
    let router!: ButlerRouter
    const pool = new LocalAgentPool({ hub, space, butlerDefaultOn: true,
      butlerFactory: base => {
        router = createButlerRouter({ id: base.id, capabilities: ['chat'], userActivity: activity,
          retireForUser: retire, createForUser: () => participant({
            onTask: async () => { await tail.promise; return result }, onShutdown: instanceShutdown,
          }) })
        return router
      },
    })
    await pool.start(row)
    const pending = router.onTask!(task()).catch(e => e)
    await pool.stop(row.id)
    await expect(router.onTask!(task())).rejects.toMatchObject({ code: 'BUTLER_ROUTER_CLOSED' })
    let done = false
    const closed = activity.quiesce('alice').then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)
    expect(retire).not.toHaveBeenCalled()
    tail.resolve()
    expect(await pending).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
    await closed
    expect(router.size).toBe(0)
    expect(retire).toHaveBeenCalledTimes(1)
    expect(instanceShutdown).toHaveBeenCalledTimes(1)
  })

  it('does not call shutdown on a non-router, even one with copied router fields', async () => {
    const shutdown = vi.fn()
    const copy = { ...createButlerRouter({ id: row.id, capabilities: ['chat'], createForUser: () => participant() }), onShutdown: shutdown }
    const pool = new LocalAgentPool({ hub, space, butlerDefaultOn: true, butlerFactory: () => copy })
    await pool.start(row)
    await pool.stop(row.id)
    expect(shutdown).not.toHaveBeenCalled()
    await pool.stop('unknown')
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('observes asynchronous router shutdown failures with a fixed, content-free log', async () => {
    let router!: ButlerRouter
    const pool = new LocalAgentPool({ hub, space, butlerDefaultOn: true, butlerFactory: base => {
      router = createButlerRouter({ id: base.id, capabilities: ['chat'], createForUser: () => participant() })
      return router
    } })
    await pool.start(row)
    vi.spyOn(router, 'onShutdown').mockRejectedValueOnce(new Error('private-marker'))
    await pool.stop(row.id)
    await Promise.resolve()
    await Promise.resolve()
    expect(poolLog.warn).toHaveBeenCalledWith('butler router shutdown failed during stop')
    expect(JSON.stringify(vi.mocked(poolLog.warn).mock.calls)).not.toContain('private-marker')
  })
})
