/**
 * persist-and-resume — proves FileStorage durability across processes.
 *
 *   `start fresh`  -> wipe the file, write a few entries, exit
 *   `start resume` -> load the file, print prior entries, append one more,
 *                     show seq picked up where the previous run left off
 *
 * The transcript path is anchored to *this example's directory*, not the cwd,
 * so the demo behaves the same wherever pnpm dispatches it from.
 */

import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AgentParticipant,
  FileStorage,
  Hub,
  type Task,
  type TranscriptEntry,
} from '@aipehub/core'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(HERE, '..', 'aipe-data')
const TRANSCRIPT_PATH = join(DATA_DIR, 'transcript.jsonl')

type EchoPayload = { text: string }

class EchoAgent extends AgentParticipant {
  constructor() {
    super({ id: 'echo', capabilities: ['echo'] })
  }

  protected handleTask(task: Task): { echoed: unknown } {
    return { echoed: task.payload }
  }
}

async function runFresh(): Promise<void> {
  if (existsSync(TRANSCRIPT_PATH)) {
    await unlink(TRANSCRIPT_PATH)
    console.log(`  wiped ${TRANSCRIPT_PATH}`)
  }

  const hub = new Hub({ storage: new FileStorage(TRANSCRIPT_PATH) })
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
  console.log(`done; transcript persisted at ${TRANSCRIPT_PATH}`)
}

async function runResume(): Promise<void> {
  if (!existsSync(TRANSCRIPT_PATH)) {
    console.error(`no transcript at ${TRANSCRIPT_PATH} — run 'start fresh' first.`)
    process.exit(1)
  }

  const hub = new Hub({ storage: new FileStorage(TRANSCRIPT_PATH) })
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
  const mode = process.argv[2]
  if (mode === 'fresh') {
    await runFresh()
  } else if (mode === 'resume') {
    await runResume()
  } else {
    console.error(`usage: start <fresh|resume>`)
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
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
