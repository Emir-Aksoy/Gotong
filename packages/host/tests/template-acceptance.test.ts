/**
 * FDE-M2 — tests for the golden-run acceptance service
 * (`template-acceptance.json` store + member-gated runner + zero-LLM judging).
 *
 * What these pin:
 *   1. Store posture = the M1b connector-slot mirror: record→list round-trip,
 *      last-install-wins, record([]) clears, corrupt file → warn + empty.
 *   2. The runner goes through the SAME member gate as /me · butler · sweeper
 *      (`evaluateRunnable`): unpublished / non-member-facing → red
 *      `unrunnable`, and the scope key is FORCED to the caller — a case's
 *      trigger can't smuggle another member's id.
 *   3. Verdicts map the whole TaskResult surface honestly: ok+asserts-green →
 *      green; ok+asserts-red → `assert_failed` with violations; failed →
 *      `dispatch_failed`; suspended → `suspended`; never-resolving dispatch →
 *      `timeout` after the injected cap.
 *   4. `extractText` is deterministic: string / LlmTaskOutput.text / the
 *      single-key `{brief: …}` idiom / JSON fallback.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  TEMPLATE_ACCEPTANCE_FILE,
  createTemplateAcceptanceService,
  extractText,
  type RecordedAcceptanceCase,
} from '../src/template-acceptance.js'
import type { ButlerWorkflowSummary } from '../src/personal-butler-workflows.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gotong-acceptance-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const publishedBrief = (): ButlerWorkflowSummary => ({
  id: 'morning-brief',
  name: '我的晨报',
  triggerCapability: 'brief.request',
  state: 'published',
  surfaceMe: {
    enabled: true,
    inputSchema: [{ id: 'focus' }, { id: 'reader_id' }],
    userScopeField: 'reader_id',
  },
})

const smokeCase = (over?: Partial<RecordedAcceptanceCase>): RecordedAcceptanceCase => ({
  id: 'smoke-brief',
  workflowId: 'morning-brief',
  trigger: { focus: '高效开始这一天' },
  assert: { contains: ['今日重点', '提醒', '今日一学'], forbid: ['作为一个AI'] },
  ...over,
})

function makeSvc(opts?: {
  summaries?: ButlerWorkflowSummary[]
  listThrows?: boolean
  dispatch?: (input: Record<string, unknown>) => Promise<unknown>
  timeoutMs?: number
}) {
  const dispatched: Record<string, unknown>[] = []
  const svc = createTemplateAcceptanceService({
    spaceDir: dir,
    workflows: {
      list: async () => {
        if (opts?.listThrows) throw new Error('catalog offline')
        return opts?.summaries ?? [publishedBrief()]
      },
    },
    hub: {
      dispatch: async (input) => {
        dispatched.push(input as unknown as Record<string, unknown>)
        if (opts?.dispatch) return opts.dispatch(input as unknown as Record<string, unknown>)
        return {
          kind: 'ok',
          taskId: 't1',
          by: 'workflow:morning-brief',
          output: { brief: { text: '1. 今日重点…\n2. 提醒…\n3. 今日一学…' } },
          ts: 1,
        }
      },
    },
    timeoutMs: opts?.timeoutMs ?? 5_000,
    now: () => Date.UTC(2026, 6, 4),
  })
  return { svc, dispatched }
}

describe('acceptance store', () => {
  it('lists [] when nothing recorded; round-trips a recorded pack', async () => {
    const { svc } = makeSvc()
    expect(await svc.list()).toEqual([])
    await svc.record('morning-brief-hub', [smokeCase({ note: '诚实模式即合格线' })])
    const rows = await svc.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      pack: 'morning-brief-hub',
      installedAt: '2026-07-04T00:00:00.000Z',
    })
    expect(rows[0]!.cases[0]).toEqual({
      id: 'smoke-brief',
      workflowId: 'morning-brief',
      trigger: { focus: '高效开始这一天' },
      assert: { contains: ['今日重点', '提醒', '今日一学'], forbid: ['作为一个AI'] },
      note: '诚实模式即合格线',
    })
  })

  it('replaces on re-record (last install wins) and record([]) clears', async () => {
    const { svc } = makeSvc()
    await svc.record('pack-a', [smokeCase()])
    await svc.record('pack-a', [smokeCase({ id: 'v2-case' })])
    let rows = await svc.list()
    expect(rows[0]!.cases.map((c) => c.id)).toEqual(['v2-case'])
    await svc.record('pack-a', [])
    rows = await svc.list()
    expect(rows).toEqual([])
  })

  it('corrupt file → [] (advisory registry), next record repairs it', async () => {
    await writeFile(join(dir, TEMPLATE_ACCEPTANCE_FILE), '{nope', 'utf8')
    const { svc } = makeSvc()
    expect(await svc.list()).toEqual([])
    await svc.record('pack-a', [smokeCase()])
    expect(await svc.list()).toHaveLength(1)
  })

  it('skips a malformed pack entry, the rest survive', async () => {
    await writeFile(
      join(dir, TEMPLATE_ACCEPTANCE_FILE),
      JSON.stringify({
        packs: [
          { pack: 'good', cases: [smokeCase()] },
          { pack: 'bad-case', cases: [{ id: 'x' }] }, // no workflowId/assert
          { pack: '', cases: [] },
        ],
      }),
      'utf8',
    )
    const { svc } = makeSvc()
    expect((await svc.list()).map((r) => r.pack)).toEqual(['good'])
  })
})

describe('acceptance run', () => {
  it('throws acceptance_not_found for an unknown pack or case', async () => {
    const { svc } = makeSvc()
    await expect(svc.run('nope', { userId: 'u1' })).rejects.toMatchObject({
      code: 'acceptance_not_found',
    })
    await svc.record('pack-a', [smokeCase()])
    await expect(svc.run('pack-a', { userId: 'u1', caseId: 'missing' })).rejects.toMatchObject({
      code: 'acceptance_not_found',
    })
  })

  it('green: fires through the member gate and passes the structure checks', async () => {
    const { svc, dispatched } = makeSvc()
    await svc.record('pack-a', [smokeCase()])
    const report = await svc.run('pack-a', { userId: 'admin-1' })
    expect(report.allGreen).toBe(true)
    expect(report.ranBy).toBe('admin-1')
    expect(report.results[0]).toMatchObject({
      caseId: 'smoke-brief',
      workflowId: 'morning-brief',
      verdict: 'green',
    })
    // Dispatch went to the workflow's trigger capability with declared fields.
    expect(dispatched[0]).toMatchObject({
      origin: { orgId: 'local', userId: 'admin-1' },
      strategy: { kind: 'capability', capabilities: ['brief.request'] },
    })
    expect((dispatched[0]!.payload as Record<string, unknown>).focus).toBe('高效开始这一天')
  })

  it('forces the scope key to the caller — a case cannot run as someone else', async () => {
    const { svc, dispatched } = makeSvc()
    await svc.record('pack-a', [
      smokeCase({ trigger: { focus: 'x', reader_id: 'victim', extra: 'dropped' } }),
    ])
    await svc.run('pack-a', { userId: 'admin-1' })
    const payload = dispatched[0]!.payload as Record<string, unknown>
    expect(payload.reader_id).toBe('admin-1') // forced, not 'victim'
    expect('extra' in payload).toBe(false) // undeclared fields dropped
  })

  it('red unrunnable: unpublished workflow (same gate as /me · butler · sweeper)', async () => {
    const { svc, dispatched } = makeSvc({
      summaries: [{ ...publishedBrief(), state: 'draft' }],
    })
    await svc.record('pack-a', [smokeCase()])
    const report = await svc.run('pack-a', { userId: 'u1' })
    expect(report.results[0]).toMatchObject({ verdict: 'red', reason: 'unrunnable' })
    expect(dispatched).toHaveLength(0) // gate refused before any dispatch
  })

  it('red unrunnable when the catalog read fails (fail closed)', async () => {
    const { svc } = makeSvc({ listThrows: true })
    await svc.record('pack-a', [smokeCase()])
    const report = await svc.run('pack-a', { userId: 'u1' })
    expect(report.results[0]).toMatchObject({ verdict: 'red', reason: 'unrunnable' })
  })

  it('red assert_failed carries the checker violations', async () => {
    const { svc } = makeSvc({
      dispatch: async () => ({
        kind: 'ok',
        output: { brief: { text: '作为一个AI，我无法……（也没有小节）' } },
      }),
    })
    await svc.record('pack-a', [smokeCase()])
    const report = await svc.run('pack-a', { userId: 'u1' })
    const r = report.results[0]!
    expect(r).toMatchObject({ verdict: 'red', reason: 'assert_failed' })
    const kinds = (r.violations ?? []).map((v) => v.kind)
    expect(kinds).toContain('missing_phrase')
    expect(kinds).toContain('forbidden_phrase')
    expect(report.allGreen).toBe(false)
  })

  it('red dispatch_failed on a failed TaskResult (error surfaced)', async () => {
    const { svc } = makeSvc({
      dispatch: async () => ({ kind: 'failed', error: 'agent exploded' }),
    })
    await svc.record('pack-a', [smokeCase()])
    const report = await svc.run('pack-a', { userId: 'u1' })
    expect(report.results[0]).toMatchObject({
      verdict: 'red',
      reason: 'dispatch_failed',
      message: 'agent exploded',
    })
  })

  it('red suspended on a HITL suspension (golden cases must run unattended)', async () => {
    const { svc } = makeSvc({
      dispatch: async () => ({ kind: 'suspended', resumeAt: 99 }),
    })
    await svc.record('pack-a', [smokeCase()])
    const report = await svc.run('pack-a', { userId: 'u1' })
    expect(report.results[0]).toMatchObject({ verdict: 'red', reason: 'suspended' })
  })

  it('red timeout when the run outlives the cap (dispatch keeps running)', async () => {
    const { svc } = makeSvc({
      dispatch: () => new Promise(() => {}), // never resolves
      timeoutMs: 20,
    })
    await svc.record('pack-a', [smokeCase()])
    const report = await svc.run('pack-a', { userId: 'u1' })
    expect(report.results[0]).toMatchObject({ verdict: 'red', reason: 'timeout' })
  })

  it('caseId narrows the run to one case', async () => {
    const { svc, dispatched } = makeSvc()
    await svc.record('pack-a', [smokeCase(), smokeCase({ id: 'second' })])
    const report = await svc.run('pack-a', { userId: 'u1', caseId: 'second' })
    expect(report.results.map((r) => r.caseId)).toEqual(['second'])
    expect(dispatched).toHaveLength(1)
  })
})

describe('extractText', () => {
  it('follows the three documented rules, then JSON', () => {
    expect(extractText('plain')).toBe('plain')
    expect(extractText({ text: 'llm output', stopReason: 'end' })).toBe('llm output')
    expect(extractText({ brief: { text: 'nested' } })).toBe('nested')
    expect(extractText({ a: 1, b: 2 })).toBe('{"a":1,"b":2}')
    expect(extractText(undefined)).toBe('')
  })
})
