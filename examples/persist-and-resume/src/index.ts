/**
 * persist-and-resume — proves transcript durability across processes.
 *
 *   `start fresh`           -> FileStorage: wipe, write entries, exit
 *   `start resume`          -> FileStorage: load and append one more
 *   `start fresh --sqlite`  -> SqliteStorage: same flow on a SQLite DB
 *   `start resume --sqlite` -> SqliteStorage: load and append one more
 *
 * `--sqlite` swaps FileStorage for SqliteStorage. The Hub doesn't care which
 * one is used — the Storage interface is the same.
 */

import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AgentParticipant,
  FileStorage,
  Hub,
  SqliteStorage,
  type Storage,
  type Task,
  type TranscriptEntry,
} from '@aipehub/core'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(HERE, '..', 'aipe-data')
const FILE_PATH = join(DATA_DIR, 'transcript.jsonl')
const SQLITE_PATH = join(DATA_DIR, 'transcript.db')

function pickStorage(useSqlite: boolean): { storage: Storage; path: string; kind: string } {
  if (useSqlite) {
    return { storage: new SqliteStorage({ path: SQLITE_PATH }), path: SQLITE_PATH, kind: 'sqlite' }
  }
  return { storage: new FileStorage(FILE_PATH), path: FILE_PATH, kind: 'file' }
}

async function clearBacking(useSqlite: boolean): Promise<void> {
  if (useSqlite) {
    for (const p of [SQLITE_PATH, `${SQLITE_PATH}-wal`, `${SQLITE_PATH}-shm`]) {
      if (existsSync(p)) await unlink(p)
    }
  } else if (existsSync(FILE_PATH)) {
    await unlink(FILE_PATH)
  }
}

type EchoPayload = { text: string }

class EchoAgent extends AgentParticipant {
  constructor() {
    super({ id: 'echo', capabilities: ['echo'] })
  }

  protected handleTask(task: Task): { echoed: unknown } {
    return { echoed: task.payload }
  }
}

async function runFresh(useSqlite: boolean): Promise<void> {
  await clearBacking(useSqlite)
  const { storage, path, kind } = pickStorage(useSqlite)
  console.log(`  storage: ${kind} at ${path}`)

  const hub = new Hub({ storage })
  await hub.start()
  hub.register(new EchoAgent())

  console.log('\n=== fresh run: dispatching 3 echo tasks ===\n')
  for (let i = 1; i <= 3; i++) {
    const res = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['echo'] },
      payload: { text: `hello #${i}` } satisfies EchoPayload,
      title: `echo ${i}`,
    })
    console.log(`  task ${i} result:`, res.kind === 'ok' ? res.output : res)
  }

  console.log(`\ntranscript size: ${hub.transcript.size()}`)
  await hub.stop()
  console.log(`done; transcript persisted at ${path}`)
}

async function runResume(useSqlite: boolean): Promise<void> {
  const { storage, path, kind } = pickStorage(useSqlite)
  if (!existsSync(path)) {
    console.error(`no transcript at ${path} — run 'start fresh${useSqlite ? ' --sqlite' : ''}' first.`)
    process.exit(1)
  }
  console.log(`  storage: ${kind} at ${path}`)

  const hub = new Hub({ storage })
  await hub.start() // hub.start() awaits transcript.load()

  console.log('\n=== resume run: prior transcript loaded ===\n')
  const before = hub.transcript.all()
  for (const e of before) {
    console.log(`  [seq=${String(e.seq).padStart(2, '0')}] ${describe(e)}`)
  }
  const lastSeqBefore = before.length > 0 ? before[before.length - 1]!.seq : 0
  console.log(`\nloaded ${before.length} entries; last seq = ${lastSeqBefore}`)

  hub.register(new EchoAgent())

  console.log('\n=== dispatching one more echo task ===\n')
  const res = await hub.dispatch({
    from: 'system',
    strategy: { kind: 'capability', capabilities: ['echo'] },
    payload: { text: `resumed at ${new Date().toISOString()}` } satisfies EchoPayload,
    title: 'echo after resume',
  })
  console.log('  result:', res.kind === 'ok' ? res.output : res)

  console.log('\n=== transcript after new dispatch ===\n')
  const after = hub.transcript.all()
  for (const e of after) {
    console.log(`  [seq=${String(e.seq).padStart(2, '0')}] ${describe(e)}`)
  }
  const lastSeqAfter = after[after.length - 1]!.seq
  console.log(
    `\nbefore: ${before.length} entries (max seq=${lastSeqBefore}) -> ` +
      `after: ${after.length} entries (max seq=${lastSeqAfter})`,
  )

  await hub.stop()
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const mode = args[0]
  const useSqlite = args.includes('--sqlite')
  if (mode === 'fresh') {
    await runFresh(useSqlite)
  } else if (mode === 'resume') {
    await runResume(useSqlite)
  } else {
    console.error(`usage: start <fresh|resume> [--sqlite]`)
    process.exit(1)
  }
}

function describe(e: TranscriptEntry): string {
  switch (e.kind) {
    case 'participant_joined':
      return `JOIN     ${e.data.id} (${e.data.participantKind}) caps=[${e.data.capabilities.join(',')}]`
    case 'participant_left':
      return `LEAVE    ${e.data.id}`
    case 'message':
      return `MSG      ${e.data.from} -> #${e.data.channel}`
    case 'task': {
      const s = e.data.strategy
      const target =
        s.kind === 'explicit'
          ? `to=${s.to}`
          : s.kind === 'capability'
            ? `caps=[${s.capabilities.join(',')}]`
            : `broadcast`
      return `TASK     ${e.data.from} "${e.data.title ?? '(untitled)'}" via ${s.kind} ${target}`
    }
    case 'task_result': {
      const r = e.data
      if (r.kind === 'ok') return `RESULT   ok by ${r.by}`
      if (r.kind === 'failed') return `RESULT   failed by ${r.by}: ${r.error}`
      if (r.kind === 'cancelled') return `RESULT   cancelled: ${r.reason}`
      return `RESULT   no_participant: ${r.reason}`
    }
    case 'agent_pending':
      return `PENDING  ${e.data.agents.map((a) => a.id).join(',')}`
    case 'agent_approved':
      return `APPROVE  ${e.data.agentIds.join(',')}`
    case 'agent_rejected':
      return `REJECT   ${e.data.agentIds.join(',')} — ${e.data.reason}`
    case 'evaluation':
      return `EVAL     ${e.data.taskId.slice(0, 8)}… by ${e.data.by}`
    case 'service_trashed':
      return `TRASH    ${e.data.type}:${e.data.impl} owner=${e.data.ownerKind}/${e.data.ownerId}`
    case 'service_purged':
      return `PURGE    ${e.data.type}:${e.data.impl} trashId=${e.data.trashId}`
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
