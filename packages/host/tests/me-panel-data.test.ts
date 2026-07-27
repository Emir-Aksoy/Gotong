/**
 * SDUI-C1a — me-panel-data projections (the /api/me/panel/data/* backing).
 *
 * Load-bearing claims:
 *  - tasksForUser reads the REAL notebook file layout (ownerDir + tasks.json,
 *    the same path the butler factory writes) and projects open tasks only —
 *    the free-form `note` never enters the projection;
 *  - observer contract holds end-to-end: missing / corrupt / hostile-userId
 *    all → [] with zero side effects (no quarantine — the butler's turn stays
 *    the file's only writer);
 *  - schedulesForUser is a pure passthrough of the SEN-M4 surface (null when
 *    unwired — the route's {available:false});
 *  - hubStatus projects derivePatrolCards over the SAME snapshot authority the
 *    patrol uses, and a failing probe degrades to [] (never throws into the
 *    route);
 *  - usageForUser (C1-b) windows the ledger aggregate to 7/30 days and
 *    re-sorts chronologically (the SQL orders by cost DESC — chart order).
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openTaskNotebook } from '@gotong/personal-butler'
import { ownerDir } from '@gotong/service-memory-file'

import type { HealthSnapshot } from '../src/admin-health.js'
import { buildMePanelData } from '../src/me-panel-data.js'

let memoryRoot: string

beforeEach(async () => {
  memoryRoot = await mkdtemp(join(tmpdir(), 'gotong-panel-data-'))
})

afterEach(async () => {
  await rm(memoryRoot, { recursive: true, force: true })
})

function build(overrides?: Partial<Parameters<typeof buildMePanelData>[0]>) {
  return buildMePanelData({
    memoryRoot,
    schedules: () => undefined,
    health: () => undefined,
    ...overrides,
  })
}

function healthSnapshot(partial?: Partial<HealthSnapshot>): HealthSnapshot {
  return {
    agents: [],
    agentsMissingKey: 0,
    managedCount: 0,
    onlineCount: 0,
    mcpServers: [],
    mcpUnwired: 0,
    spaceWritable: true,
    spacePath: '/space',
    ...partial,
  }
}

describe('me-panel-data: tasksForUser', () => {
  it('projects open tasks (title + progress) from the real notebook file, note stays out', async () => {
    const userDir = ownerDir(memoryRoot, { kind: 'user', id: 'alice' })
    await mkdir(userDir, { recursive: true })
    const notebook = openTaskNotebook({ file: join(userDir, 'tasks.json') })
    const opened = await notebook.openNote({
      title: '筹备生日',
      steps: ['订蛋糕', '发邀请'],
      note: '私密草稿不该出现在投影里',
    })
    await notebook.updateNote(opened.id, { doneSteps: [1] })
    const closed = await notebook.openNote({ title: '已完结的', steps: ['x'] })
    await notebook.closeNote(closed.id, 'done')

    const rows = await build().tasksForUser('alice')
    expect(rows).toHaveLength(1)
    expect(rows![0]).toMatchObject({
      id: opened.id,
      title: '筹备生日',
      stepsDone: 1,
      stepsTotal: 2,
    })
    expect(typeof rows![0]!.updatedAt).toBe('number')
    // Narrow projection — the working note is structurally absent.
    expect(Object.keys(rows![0]!)).not.toContain('note')
    expect(JSON.stringify(rows)).not.toContain('私密草稿')
  })

  it('missing file → [] (wired-but-empty, not unavailable)', async () => {
    expect(await build().tasksForUser('nobody')).toEqual([])
  })

  it('corrupt file → [] and the evidence stays untouched (observer never quarantines)', async () => {
    const userDir = ownerDir(memoryRoot, { kind: 'user', id: 'bob' })
    await mkdir(userDir, { recursive: true })
    await writeFile(join(userDir, 'tasks.json'), '{not json', 'utf8')
    expect(await build().tasksForUser('bob')).toEqual([])
    expect(await readdir(userDir)).toEqual(['tasks.json']) // no .corrupt-* rename
  })

  it('hostile userId cannot traverse — ownerDir assert → []', async () => {
    expect(await build().tasksForUser('../../etc')).toEqual([])
  })
})

describe('me-panel-data: schedulesForUser', () => {
  it('surface unwired → null (route answers {available:false})', async () => {
    expect(await build().schedulesForUser('alice')).toBeNull()
  })

  it('passes the SEN-M4 projection through untouched', async () => {
    const rows = [
      {
        workflowId: 'daily-brief',
        cadence: { kind: 'daily' as const, hour: 8, tzOffsetMinutes: 480 },
        enabled: true,
        valid: true,
        lastFiredMark: '2026-07-25',
      },
    ]
    const data = build({
      schedules: () => ({
        listForUser: async (userId: string) => (userId === 'alice' ? rows : []),
      }),
    })
    expect(await data.schedulesForUser('alice')).toEqual(rows)
    expect(await data.schedulesForUser('other')).toEqual([])
  })
})

describe('me-panel-data: hubStatus', () => {
  it('surface unwired → null', async () => {
    expect(await build().hubStatus()).toBeNull()
  })

  it('projects derivePatrolCards over the health snapshot ({id,severity,label,fact} only)', async () => {
    const snap = healthSnapshot({
      agents: [
        { id: 'atong', provider: 'openai-compatible', online: true, missingKey: true },
      ] as HealthSnapshot['agents'],
      mcpServers: [{ name: 'notes', wired: false }] as HealthSnapshot['mcpServers'],
    })
    const data = build({ health: () => ({ snapshot: async () => snap }) })
    const cards = await data.hubStatus()
    expect(cards!.map((c) => c.id)).toEqual(['agent-key:atong', 'mcp-unwired:notes'])
    for (const c of cards!) {
      expect(c.severity).toBe('yellow')
      expect(Object.keys(c).sort()).toEqual(['fact', 'id', 'label', 'severity'])
    }
  })

  it('healthy hub → [] (renderer shows 一切正常, not unavailable)', async () => {
    const data = build({ health: () => ({ snapshot: async () => healthSnapshot() }) })
    expect(await data.hubStatus()).toEqual([])
  })

  it('failing probe → warn + [] (never throws into the route)', async () => {
    const warns: string[] = []
    const data = build({
      health: () => ({ snapshot: async () => { throw new Error('probe down') } }),
      logger: { warn: (msg) => warns.push(msg) },
    })
    expect(await data.hubStatus()).toEqual([])
    expect(warns.length).toBe(1)
  })
})

describe('me-panel-data: usageForUser (C1-b)', () => {
  it('surface unwired → null (route answers {available:false})', async () => {
    expect(await build().usageForUser('alice', 'week')).toBeNull()
  })

  it('week → 7-day window, month → 30-day window, userId passed through', async () => {
    const asked: Array<{ userId: string; since: number }> = []
    const data = build({
      usage: () => ({
        dailyForUser: (userId, since) => {
          asked.push({ userId, since })
          return []
        },
      }),
    })
    const before = Date.now()
    await data.usageForUser('alice', 'week')
    await data.usageForUser('alice', 'month')
    expect(asked.map((a) => a.userId)).toEqual(['alice', 'alice'])
    // since ≈ now − N days (allow the test's own elapsed ms as slack).
    expect(before - asked[0]!.since).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000)
    expect(Date.now() - asked[0]!.since).toBeLessThanOrEqual(7 * 86_400_000 + 1000)
    expect(before - asked[1]!.since).toBeGreaterThanOrEqual(30 * 86_400_000 - 1000)
    expect(Date.now() - asked[1]!.since).toBeLessThanOrEqual(30 * 86_400_000 + 1000)
  })

  it('maps key→day and re-sorts chronologically (ledger aggregate comes cost-DESC)', async () => {
    const data = build({
      usage: () => ({
        dailyForUser: () => [
          { key: '2026-07-25', calls: 9, inputTokens: 900, outputTokens: 90, costMicros: 5000 },
          { key: '2026-07-23', calls: 1, inputTokens: 100, outputTokens: 10, costMicros: 200 },
          { key: '2026-07-24', calls: 4, inputTokens: 400, outputTokens: 40, costMicros: 900 },
        ],
      }),
    })
    const rows = await data.usageForUser('alice', 'week')
    expect(rows!.map((r) => r.day)).toEqual(['2026-07-23', '2026-07-24', '2026-07-25'])
    expect(rows![2]).toEqual({
      day: '2026-07-25',
      calls: 9,
      inputTokens: 900,
      outputTokens: 90,
      costMicros: 5000,
    })
  })

  it('aggregate throw → warn + [] (never throws into the route)', async () => {
    const warns: string[] = []
    const data = build({
      usage: () => ({
        dailyForUser: () => { throw new Error('db locked') },
      }),
      logger: { warn: (msg) => warns.push(msg) },
    })
    expect(await data.usageForUser('alice', 'week')).toEqual([])
    expect(warns.length).toBe(1)
  })
})
