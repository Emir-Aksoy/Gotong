import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Logger } from '@gotong/core'
import { afterEach, expect, it, vi } from 'vitest'
import { ButlerUserActivity } from '../src/butler-user-activity.js'
import { FileButlerUserIsolation } from '../src/butler-user-isolation.js'
import { HostButlerMemoryService } from '../src/butler-memory-service.js'
import { runButlerMaintenanceOnce } from '../src/personal-butler-maintenance.js'
import { buildRetentionLadder, writeRetentionPolicy } from '../src/space-retention.js'
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
afterEach(() => { vi.restoreAllMocks() })

it('one shared registry drains service, standalone maintenance and retention before retiring the user', async () => {
  const space = await mkdtemp(join(tmpdir(), 'gotong-cross-entry-'))
  const rootDir = join(space, 'butler', 'memory')
  const userActivity = new ButlerUserActivity(new FileButlerUserIsolation(rootDir))
  const service = new HostButlerMemoryService({ rootDir, logger, userActivity })
  const handle = memory.openButlerMemory({ rootDir, userId: 'alice', logger })
  await handle.remember({ kind: 'semantic', text: 'synthetic private-marker' })
  const archive = join(rootDir, 'user', 'alice', 'knowledge', 'archive', 'fact.md')
  await mkdir(dirname(archive), { recursive: true })
  await writeFile(archive, 'synthetic private-marker')
  const old = new Date(Date.now() - 100 * 86_400_000)
  await utimes(archive, old, old)
  await writeRetentionPolicy(space, () => ({ memory_archive_days: 30 }))

  const serviceEntered = deferred()
  const serviceGate = deferred()
  const open = memory.openButlerMemory
  vi.spyOn(memory, 'openButlerMemory').mockImplementationOnce(opts => {
    const result = open(opts)
    const list = result.list.bind(result)
    vi.spyOn(result, 'list').mockImplementation(async opts => {
      serviceEntered.resolve()
      await serviceGate.promise
      return list(opts)
    })
    return result
  })
  const serviceResult = service.export('alice').catch(e => e)
  await serviceEntered.promise

  const maintenanceEntered = deferred()
  const maintenanceGate = deferred()
  vi.spyOn(obsidian, 'projectButlerVault').mockImplementation(async () => {
    maintenanceEntered.resolve()
    await maintenanceGate.promise
  })
  const maintenanceResult = runButlerMaintenanceOnce({
    rootDir, userId: 'alice', userActivity, summarize: async () => 'synthetic', logger,
  }).catch(e => e)
  await maintenanceEntered.promise

  const retentionEntered = deferred()
  const retentionGate = deferred()
  const git = vi.fn(async () => {
    retentionEntered.resolve()
    await retentionGate.promise
    return { code: 0, stdout: String(Math.floor(Date.now() / 1000)), stderr: '' }
  })
  const ladder = buildRetentionLadder({ spaceDir: space, userActivity, git, logger })
  const retentionResult = ladder()
  await retentionEntered.promise

  const retire = vi.fn()
  userActivity.register('alice', retire)
  const closing = userActivity.quiesce('alice')
  await expect(service.read('alice')).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
  await expect(service.export('bob')).resolves.toEqual([])
  expect(retire).not.toHaveBeenCalled()

  serviceGate.resolve()
  expect(await serviceResult).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
  expect(retire).not.toHaveBeenCalled()
  maintenanceGate.resolve()
  expect(await maintenanceResult).toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
  expect(retire).not.toHaveBeenCalled()
  retentionGate.resolve()
  expect(await retentionResult).toMatchObject({ deleted: 1, failed: 1 })
  await closing
  expect(retire).toHaveBeenCalledTimes(1)
  await ladder()
  expect(git).toHaveBeenCalledTimes(1)
  const restarted = new HostButlerMemoryService({ rootDir, logger })
  await expect(restarted.export('alice')).rejects.toMatchObject({ code: 'BUTLER_USER_QUIESCED' })
})
