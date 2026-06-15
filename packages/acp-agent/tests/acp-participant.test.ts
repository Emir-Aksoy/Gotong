import { describe, it, expect } from 'vitest'

import { SuspendTaskError, type Task, type TaskId, type TaskResult } from '@aipehub/core'

import { AcpParticipant } from '../src/acp-participant.js'
import { ACP_NEVER_RESUME_AT, type AcpCheckpointState } from '../src/acp-checkpoint.js'
import { createMockAcpAgent } from './mock-acp-agent.js'

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

function makeTask(id: string, prompt: string): Task {
  return { id: id as TaskId, capability: 'code', payload: { prompt } } as unknown as Task
}

/** Output shape `finish()` returns. */
interface Out {
  text: string
  stopReason: string
  sessionId?: string
  permissionApproved?: boolean
}
const out = (r: TaskResult): Out => (r as { output: Out }).output

async function escalateOnce(p: AcpParticipant, id = 't1', prompt = 'NEED_PERM'): Promise<SuspendTaskError> {
  try {
    await p.onTask(makeTask(id, prompt))
  } catch (e) {
    if (e instanceof SuspendTaskError) return e
    throw e
  }
  throw new Error('expected a SuspendTaskError')
}

describe('AcpParticipant — hold one session, dispatch many (OBSERVE)', () => {
  it('reuses one session across two tasks (handshake once, context preserved)', async () => {
    const { transport, stats } = createMockAcpAgent()
    const chunks: Array<{ taskId: string; text: string | undefined }> = []
    const p = new AcpParticipant({
      id: 'acp',
      capabilities: ['code'],
      command: 'x',
      transport,
      onChunk: (taskId, c) => chunks.push({ taskId, text: c.text }),
    })

    const r1 = await p.onTask(makeTask('t1', 'first'))
    const r2 = await p.onTask(makeTask('t2', 'second'))

    expect(r1.kind).toBe('ok')
    expect(r2.kind).toBe('ok')
    expect(stats.initCount).toBe(1) // spawned + handshook ONCE
    expect(stats.promptCount).toBe(2)
    expect(out(r1).text).toContain('echo:first')
    expect(out(r2).text).toContain('turn=2') // counter only advances on the SAME session
    expect(chunks.some((c) => c.taskId === 't1' && c.text?.includes('echo:first'))).toBe(true)
    expect(p.sessionId).toBe('mock-1')
  })
})

describe('AcpParticipant — INTERCEPT', () => {
  it('inline-allows when the gate allows (no park)', async () => {
    const { transport } = createMockAcpAgent()
    const p = new AcpParticipant({
      id: 'acp',
      capabilities: ['code'],
      command: 'x',
      transport,
      gate: () => ({ allow: true }),
    })
    const r = await p.onTask(makeTask('t1', 'do NEED_PERM thing'))
    expect(r.kind).toBe('ok')
    expect(out(r).stopReason).toBe('end_turn')
  })

  it('escalates a destructive tool → SuspendTaskError(NEVER_RESUME_AT) carrying the tool context', async () => {
    const { transport } = createMockAcpAgent()
    const p = new AcpParticipant({ id: 'acp', capabilities: ['code'], command: 'x', transport })
    const suspend = await escalateOnce(p)
    expect(suspend.resumeAt).toBe(ACP_NEVER_RESUME_AT)
    const st = suspend.state as AcpCheckpointState
    expect(st.kind).toBe('permission')
    expect(st.permissionToken).toMatch(/^acp-perm-/)
    expect(st.tool.title).toBe('rm -rf build')
    expect(st.reason).toContain('destructive')
  })
})

describe('AcpParticipant — RESUME (no drift)', () => {
  it('approve → answers the held permission and finishes the SAME turn', async () => {
    const { transport } = createMockAcpAgent()
    const p = new AcpParticipant({ id: 'acp', capabilities: ['code'], command: 'x', transport })
    const suspend = await escalateOnce(p)

    // Host merges { ...parkState, decision } and resumes the same task.
    const r = await p.onResume(makeTask('t1', 'NEED_PERM'), { ...(suspend.state as object), decision: { approved: true } })
    expect(r.kind).toBe('ok')
    expect(out(r).stopReason).toBe('end_turn')
    expect(out(r).permissionApproved).toBe(true)
    // No drift: the pre-permission chunk AND the post-permission work both landed.
    expect(out(r).text).toContain('echo:NEED_PERM')
    expect(out(r).text).toContain('perm:allowed')
  })

  it('reject → denies the tool; the agent finishes the turn (refusal), task still ok', async () => {
    const { transport } = createMockAcpAgent()
    const p = new AcpParticipant({ id: 'acp', capabilities: ['code'], command: 'x', transport })
    const suspend = await escalateOnce(p)
    const r = await p.onResume(makeTask('t1', 'NEED_PERM'), {
      ...(suspend.state as object),
      decision: { approved: false },
    })
    expect(r.kind).toBe('ok')
    expect(out(r).stopReason).toBe('refusal')
    expect(out(r).permissionApproved).toBe(false)
  })

  it('stale handle (lost session) fails loudly, never hangs', async () => {
    const { transport } = createMockAcpAgent()
    const p = new AcpParticipant({ id: 'acp', capabilities: ['code'], command: 'x', transport })
    const r = await p.onResume(makeTask('t1', 'x'), {
      v: 1,
      kind: 'permission',
      reason: 'r',
      permissionToken: 'acp-perm-404',
      tool: { kind: 'execute', title: 'rm -rf build' },
      decision: { approved: true },
    })
    expect(r.kind).toBe('failed')
    expect((r as { error: string }).error).toContain('no longer live')
  })

  it('resume without ACP checkpoint state fails loudly (does not re-run a fresh turn)', async () => {
    const { transport } = createMockAcpAgent()
    const p = new AcpParticipant({ id: 'acp', capabilities: ['code'], command: 'x', transport })
    const r = await p.onResume(makeTask('t1', 'x'), { decision: { approved: true } })
    expect(r.kind).toBe('failed')
    expect((r as { error: string }).error).toContain('without ACP checkpoint state')
  })
})

describe('AcpParticipant — TERMINATE', () => {
  it('onTaskCancelled ends an in-flight turn as cancelled', async () => {
    const { transport } = createMockAcpAgent()
    const p = new AcpParticipant({ id: 'acp', capabilities: ['code'], command: 'x', transport })
    const taskP = p.onTask(makeTask('t1', 'please HANG'))
    await tick() // let the prompt go in-flight on the mock
    p.onTaskCancelled('t1' as TaskId)
    const r = await taskP
    expect(r.kind).toBe('ok')
    expect(out(r).stopReason).toBe('cancelled')
  })
})

describe('AcpParticipant — outbound data-class + quota gate (Item 2 X-M2)', () => {
  /** A dispatched task that declares data classes (what the per-step gate stamps). */
  function classed(id: string, prompt: string, dataClasses: readonly string[]): Task {
    return { ...makeTask(id, prompt), dataClasses } as unknown as Task
  }

  it('refuses a disallowed class — failed AND the subprocess is NEVER started (fail-closed before spawn)', async () => {
    const { transport, stats } = createMockAcpAgent()
    const p = new AcpParticipant({
      id: 'acp',
      capabilities: ['code'],
      command: 'x',
      transport,
      allowedDataClasses: ['public'],
    })

    const r = await p.onTask(classed('t1', 'go', ['pii']))

    expect(r.kind).toBe('failed')
    expect((r as { error: string }).error).toContain('outbound_data_class_denied:pii')
    // The whole point: the gate runs BEFORE ensureStarted → no handshake, no child.
    expect(stats.initCount).toBe(0)
    expect(stats.promptCount).toBe(0)
  })

  it('admits a task whose classes are all allowed (subprocess starts normally)', async () => {
    const { transport, stats } = createMockAcpAgent()
    const p = new AcpParticipant({
      id: 'acp',
      capabilities: ['code'],
      command: 'x',
      transport,
      allowedDataClasses: ['public', 'pii'],
    })

    const r = await p.onTask(classed('t1', 'do thing', ['pii']))

    expect(r.kind).toBe('ok')
    expect(stats.initCount).toBe(1)
  })

  it('allowedDataClasses === [] locks down — any declared class is refused, never started', async () => {
    const { transport, stats } = createMockAcpAgent()
    const p = new AcpParticipant({
      id: 'acp', capabilities: ['code'], command: 'x', transport, allowedDataClasses: [],
    })
    const r = await p.onTask(classed('t1', 'go', ['anything']))
    expect(r.kind).toBe('failed')
    expect(stats.initCount).toBe(0)
  })

  it('no contract (null) feeds anything — a declared class still runs', async () => {
    const { transport, stats } = createMockAcpAgent()
    const p = new AcpParticipant({
      id: 'acp', capabilities: ['code'], command: 'x', transport, allowedDataClasses: null,
    })
    const r = await p.onTask(classed('t1', 'go', ['pii']))
    expect(r.kind).toBe('ok')
    expect(stats.initCount).toBe(1)
  })

  it('refuses when the quota gate returns false — failed, subprocess NEVER started', async () => {
    const { transport, stats } = createMockAcpAgent()
    const p = new AcpParticipant({
      id: 'acp',
      capabilities: ['code'],
      command: 'x',
      transport,
      outboundQuotaGate: () => false,
    })

    const r = await p.onTask(makeTask('t1', 'go'))

    expect(r.kind).toBe('failed')
    expect((r as { error: string }).error).toContain('outbound_quota_exceeded')
    expect(stats.initCount).toBe(0)
  })

  it('data-class gate runs before quota (disallowed + over-budget → names the class)', async () => {
    const { transport, stats } = createMockAcpAgent()
    const p = new AcpParticipant({
      id: 'acp', capabilities: ['code'], command: 'x', transport,
      allowedDataClasses: ['public'], outboundQuotaGate: () => false,
    })
    const r = await p.onTask(classed('t1', 'go', ['pii']))
    expect(r.kind).toBe('failed')
    expect((r as { error: string }).error).toContain('outbound_data_class_denied')
    expect(stats.initCount).toBe(0)
  })
})
