/**
 * AFR-M1 — the butler tool-face BASELINE report (`pnpm report:atong-toolface`).
 *
 * Two jobs:
 *   1. Measure the REAL per-turn tool face — every toolset the factory composes
 *      into a member's butler (benign + governed + the agent-internal memory
 *      set), built from the REAL builders so schema bytes are the truth, not a
 *      hand-copied list. Surfaces are call-time-only (listTools() is static on
 *      every builder), so empty duck stubs are safe here — nothing ever calls
 *      a tool in this file.
 *   2. Tripwire against drift: the set of builder callsites in
 *      personal-butler-factory.ts must equal the set this report measures
 *      (± the explicitly-excluded deployment-dependent MCP split). Add a new
 *      toolset to the factory without adding it here → this file turns red.
 *
 * Zero behaviour change: this is a report + gate, nothing on the runtime path.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MemoryToolset } from '@gotong/personal-memory'
import { createTaskNotebookToolset, openTaskNotebook } from '@gotong/personal-butler'

import {
  estimateTokens,
  measureToolFace,
  renderToolFaceReport,
  type ToolFaceEntry,
} from '../src/butler-toolface-report.js'
import { buildButlerAskAgentToolset } from '../src/personal-butler-ask-agent.js'
import { buildButlerAskPeerToolset } from '../src/personal-butler-ask-peer.js'
import {
  buildButlerBackupPackToolset,
  buildButlerBackupStatusToolset,
} from '../src/personal-butler-backup.js'
import { buildButlerHubHealthToolset } from '../src/personal-butler-hub-sense.js'
import { buildButlerMembersToolset } from '../src/personal-butler-members.js'
import { buildButlerSchedulesToolset } from '../src/personal-butler-schedules.js'
import { buildButlerSelfStatusToolset } from '../src/personal-butler-self-status.js'
import { buildButlerCapabilitiesToolset } from '../src/personal-butler-capabilities.js'
import { buildButlerConsolidateToolset } from '../src/personal-butler-consolidate.js'
import { buildButlerDailyBriefToolset } from '../src/personal-butler-daily-brief.js'
import { buildButlerDiagnoseToolset } from '../src/personal-butler-diagnose.js'
import { buildButlerGovernedToolset } from '../src/personal-butler-governed.js'
import { buildButlerLanguageToolset } from '../src/personal-butler-language.js'
import { buildButlerLlmCatalogToolset } from '../src/personal-butler-llm-catalog.js'
import { buildButlerGuideToolset } from '../src/personal-butler-guide.js'
import { buildButlerLlmsToolset } from '../src/personal-butler-llms.js'
import { buildButlerObserveToolset } from '../src/personal-butler-observe.js'
import { buildButlerOnboardingToolset } from '../src/personal-butler-onboarding.js'
import { buildButlerPeersToolset } from '../src/personal-butler-peers.js'
import { buildButlerProfileToolset } from '../src/personal-butler-profile.js'
import { buildButlerRemindersToolset } from '../src/personal-butler-reminders.js'
import { buildButlerRunBroadcastToolset } from '../src/personal-butler-run-broadcast.js'
import { buildButlerWorkflowCreateToolset } from '../src/personal-butler-workflow-create.js'
import { buildButlerWorkflowWizardToolset } from '../src/personal-butler-workflow-wizard.js'
import { buildButlerWorkflowsToolset } from '../src/personal-butler-workflows.js'

/**
 * Contextual cast for call-time-only surfaces. listTools() never touches a
 * surface (static definitions), and this file never calls a tool — so an empty
 * object is honest here. If a builder ever starts reading its surface at
 * BUILD time, construction throws and this test turns red (which is correct).
 */
function stub<T>(v: unknown = {}): T {
  return v as T
}

const U = 'member-afr-m1'

/**
 * module label → factory builder callsite it mirrors. The tripwire below
 * checks this registry against the factory SOURCE, so a hand-copied list
 * can't silently drift from the real assembly.
 */
const MEASURED_BUILDERS: Record<string, string> = {
  workflows: 'buildButlerWorkflowsToolset',
  observe: 'buildButlerObserveToolset',
  diagnose: 'buildButlerDiagnoseToolset',
  'ask-agent': 'buildButlerAskAgentToolset',
  peers: 'buildButlerPeersToolset',
  llms: 'buildButlerLlmsToolset',
  wizard: 'buildButlerWorkflowWizardToolset',
  consolidate: 'buildButlerConsolidateToolset',
  reminders: 'buildButlerRemindersToolset',
  'task-notebook': 'createTaskNotebookToolset',
  language: 'buildButlerLanguageToolset',
  capabilities: 'buildButlerCapabilitiesToolset',
  'llm-catalog': 'buildButlerLlmCatalogToolset',
  guide: 'buildButlerGuideToolset',
  'daily-brief': 'buildButlerDailyBriefToolset',
  'run-broadcast': 'buildButlerRunBroadcastToolset',
  profile: 'buildButlerProfileToolset',
  onboarding: 'buildButlerOnboardingToolset',
  steward: 'buildButlerGovernedToolset',
  'workflow-create': 'buildButlerWorkflowCreateToolset',
  'ask-peer': 'buildButlerAskPeerToolset',
  'backup-status': 'buildButlerBackupStatusToolset',
  'backup-pack': 'buildButlerBackupPackToolset',
  'hub-sense': 'buildButlerHubHealthToolset',
  'self-status': 'buildButlerSelfStatusToolset',
  schedules: 'buildButlerSchedulesToolset',
  members: 'buildButlerMembersToolset',
}

/**
 * Deployment-dependent, deliberately NOT in the baseline: the row's MCP servers
 * (S1-M2 read/write split — tool count varies per installed connector) ride
 * `buildButlerMcpToolsets`; the pool's base dispatch tools arrive via `base`.
 * The report renders the honest note instead of a fake number.
 */
const EXCLUDED_BUILDERS = new Set(['buildButlerMcpToolsets'])

function buildFullFace(): ToolFaceEntry[] {
  const tmp = mkdtempSync(join(tmpdir(), 'afr-toolface-'))
  const notebook = openTaskNotebook({ file: join(tmp, 'tasks.json'), logger: stub() })
  return [
    // Agent-internal (PersonalButlerAgent always composes a MemoryToolset).
    { module: 'memory', kind: 'memory', toolset: new MemoryToolset({ memory: stub() }) },
    // The factory's benign set, full face (every surface present, all flags on).
    {
      module: 'workflows',
      kind: 'benign',
      toolset: buildButlerWorkflowsToolset({
        userId: U,
        workflows: stub(),
        hub: stub(),
        logger: stub(),
      }),
    },
    {
      module: 'observe',
      kind: 'benign',
      toolset: buildButlerObserveToolset({
        userId: U,
        runs: stub(),
        agents: stub(),
        usage: stub(),
        logger: stub(),
      }),
    },
    {
      module: 'diagnose',
      kind: 'benign',
      toolset: buildButlerDiagnoseToolset({
        userId: U,
        ownedAgents: stub(),
        adaptation: stub(),
        logger: stub(),
      }),
    },
    {
      module: 'ask-agent',
      kind: 'benign',
      toolset: buildButlerAskAgentToolset({ userId: U, roster: stub(), hub: stub(), logger: stub() }),
    },
    { module: 'peers', kind: 'benign', toolset: buildButlerPeersToolset({ peers: stub(), logger: stub() }) },
    { module: 'llms', kind: 'benign', toolset: buildButlerLlmsToolset({ llms: stub(), logger: stub() }) },
    {
      module: 'wizard',
      kind: 'benign',
      toolset: buildButlerWorkflowWizardToolset({ userId: U, wizard: stub(), logger: stub() }),
    },
    {
      module: 'consolidate',
      kind: 'benign',
      toolset: buildButlerConsolidateToolset({
        userId: U,
        rootDir: tmp,
        buildProvider: async () => null,
        logger: stub(),
      }),
    },
    {
      module: 'reminders',
      kind: 'benign',
      toolset: buildButlerRemindersToolset({ userId: U, hub: stub(), logger: stub() }),
    },
    { module: 'task-notebook', kind: 'benign', toolset: createTaskNotebookToolset(notebook) },
    {
      module: 'language',
      kind: 'benign',
      toolset: buildButlerLanguageToolset({ file: join(tmp, 'reply-language.json'), logger: stub() }),
    },
    {
      module: 'capabilities',
      kind: 'benign',
      toolset: buildButlerCapabilitiesToolset({ toolNames: async () => [] }),
    },
    { module: 'llm-catalog', kind: 'benign', toolset: buildButlerLlmCatalogToolset() },
    { module: 'guide', kind: 'benign', toolset: buildButlerGuideToolset() },
    {
      module: 'daily-brief',
      kind: 'benign',
      toolset: buildButlerDailyBriefToolset({ userId: U, rootDir: tmp, logger: stub() }),
    },
    {
      module: 'run-broadcast',
      kind: 'benign',
      toolset: buildButlerRunBroadcastToolset({ userId: U, rootDir: tmp, logger: stub() }),
    },
    {
      module: 'profile',
      kind: 'benign',
      toolset: buildButlerProfileToolset({ userId: U, view: stub(), logger: stub() }),
    },
    {
      module: 'onboarding',
      kind: 'benign',
      toolset: buildButlerOnboardingToolset({
        stateFile: join(tmp, 'onboarding-state.json'),
        keyCheck: () => undefined,
        lang: 'zh',
        logger: stub(),
      }),
    },
    // The governed gates (full face: workflow editor present, all switches on).
    {
      module: 'steward',
      kind: 'governed',
      toolset: buildButlerGovernedToolset({
        userId: U,
        agents: stub(),
        workflowEditor: stub(),
      }),
    },
    {
      module: 'workflow-create',
      kind: 'governed',
      toolset: buildButlerWorkflowCreateToolset({ userId: U, create: stub(), logger: stub() }),
    },
    {
      module: 'ask-peer',
      kind: 'governed',
      toolset: buildButlerAskPeerToolset({ userId: U, peers: stub(), hub: stub(), logger: stub() }),
    },
    // AFR-M7 恢复层:status 是 benign 只读,pack 是 governed(身份档含签名钥)。
    {
      module: 'backup-status',
      kind: 'benign',
      toolset: buildButlerBackupStatusToolset({ ops: stub() }),
    },
    {
      module: 'backup-pack',
      kind: 'governed',
      toolset: buildButlerBackupPackToolset({ userId: U, ops: stub() }),
    },
    // SEN-M1 hub 体检:benign 只读,与巡检/面板同源投影。
    {
      module: 'hub-sense',
      kind: 'benign',
      toolset: buildButlerHubHealthToolset({ health: () => undefined }),
    },
    // SEN-M3 自我状态一卡:benign 只读,六块既有投影的再组合。
    {
      module: 'self-status',
      kind: 'benign',
      toolset: buildButlerSelfStatusToolset({ userId: 'u', notebook }),
    },
    // SEN-M4 定时工作流成员向投影:benign 只读,admin list 同源。
    {
      module: 'schedules',
      kind: 'benign',
      toolset: buildButlerSchedulesToolset({
        userId: 'u',
        schedules: { listForUser: async () => [] },
      }),
    },
    // SEN-M5 成员名单投影:benign 只读,岔口 A 全员见名+角色+id。
    {
      module: 'members',
      kind: 'benign',
      toolset: buildButlerMembersToolset({
        members: { listForButler: async () => [] },
      }),
    },
  ]
}

describe('estimateTokens (CJK-aware ruler)', () => {
  it('counts ASCII at ~4 chars/token', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('counts CJK at ~1 token/char', () => {
    expect(estimateTokens('你好')).toBe(2)
  })

  it('mixes both', () => {
    // 4 ASCII → 1, 2 CJK → 2.
    expect(estimateTokens('abcd你好')).toBe(3)
  })
})

describe('measureToolFace / renderToolFaceReport', () => {
  it('sums rows into module rollups, kind subtotals and totals', async () => {
    const fake = (names: string[]) => ({
      listTools: () =>
        names.map((n) => ({
          name: n,
          description: 'desc',
          inputSchema: { type: 'object' as const, properties: {} },
        })),
      callTool: async () => ({ content: [] }),
    })
    const report = await measureToolFace([
      { module: 'a', kind: 'benign', toolset: fake(['t1', 't2']) },
      { module: 'b', kind: 'governed', toolset: fake(['t3']) },
    ])
    expect(report.totalTools).toBe(3)
    expect(report.modules.map((m) => [m.module, m.tools])).toEqual([
      ['a', 2],
      ['b', 1],
    ])
    expect(report.byKind.benign.tools).toBe(2)
    expect(report.byKind.governed.tools).toBe(1)
    expect(report.totalSchemaBytes).toBe(
      report.rows.reduce((s, r) => s + r.schemaBytes, 0),
    )
    const text = renderToolFaceReport(report)
    expect(text).toContain('tools=3')
    expect(text).toContain('t1')
  })
})

describe('AFR-M1 baseline — the real butler tool face', () => {
  it('tripwire: the factory’s builder callsites equal the measured registry', () => {
    const src = readFileSync(
      new URL('../src/personal-butler-factory.ts', import.meta.url),
      'utf8',
    )
    // Callsites only (the lookahead skips import lists, which have no paren).
    const found = new Set(
      [...src.matchAll(/\b(buildButler[A-Za-z]+Toolsets?|createTaskNotebookToolset)\b(?=\()/g)].map(
        (m) => m[1],
      ),
    )
    const measured = new Set(Object.values(MEASURED_BUILDERS))
    for (const name of found) {
      expect(
        measured.has(name) || EXCLUDED_BUILDERS.has(name),
        `factory 组装了 ${name} 但 AFR-M1 报告没度量它 — 把它加进 MEASURED_BUILDERS(或显式排除并说明)`,
      ).toBe(true)
    }
    for (const name of measured) {
      expect(
        found.has(name),
        `报告在度量 ${name} 但工厂已不再组装它 — 从 MEASURED_BUILDERS 移除`,
      ).toBe(true)
    }
  })

  it('measures the full face, prints the baseline, and pins the floor', async () => {
    const entries = buildFullFace()
    // Every registry module is present exactly once.
    expect(entries.map((e) => e.module).sort()).toEqual(
      [...Object.keys(MEASURED_BUILDERS), 'memory'].sort(),
    )

    const report = await measureToolFace(entries)

    // The known floor: NA-M0 clocked ~34+; the composed face today is ≥ 34
    // named tools (30 host-named + 5 memory − overlap-free) — a silent shrink
    // below that means a toolset went missing, not an optimization.
    expect(report.totalTools).toBeGreaterThanOrEqual(34)

    // Every tool definition is wire-complete.
    for (const r of report.rows) {
      expect(r.name.length).toBeGreaterThan(0)
      expect(r.schemaBytes).toBeGreaterThan(0)
      expect(r.estTokens).toBeGreaterThan(0)
    }

    // The agent-internal memory set is the 5 known tools.
    expect(report.rows.filter((r) => r.module === 'memory').map((r) => r.name)).toEqual([
      'remember',
      'remember_procedure',
      'refine_procedure',
      'recall',
      'forget',
    ])

    // The governed face carries exactly the park-able verbs (first-class in AFR-M2).
    const governedNames = report.rows.filter((r) => r.kind === 'governed').map((r) => r.name)
    for (const name of [
      'create_agent',
      'edit_agent',
      'delete_agent',
      'edit_workflow',
      'create_workflow',
      'ask_peer',
    ]) {
      expect(governedNames, `governed face should include ${name}`).toContain(name)
    }

    // The baseline the M0 doc pins — visible via `pnpm report:atong-toolface`.
    console.log(renderToolFaceReport(report))
  })
})
