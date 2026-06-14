/**
 * codex-deepseek-hub — a case AipeHub can carry: one router LLM actively manages
 * Codex + a DeepSeek-backed TUI coding agent, routing the RIGHT coder for each
 * goal, and the two share project-level files.
 *
 * ★ The pairing (能力分派要合适) ★
 * The two coders have complementary strengths, and the router routes by them —
 * NOT a fixed pipeline:
 *   · a trivial fix (typo / rename)        → Codex only, implement directly;
 *   · a review/explain ask (don't change)  → the DeepSeek TUI only (its reasoner
 *                                            leads analysis), no implementation;
 *   · a feature that needs design          → the DeepSeek TUI drafts, Codex builds.
 * The routing is a PURE function (`planRoute`) the router calls; a real router LLM
 * makes the same call from the same goal.
 *
 * Deterministic, no API key (situation-aware router + mock CLIs), but the FILE
 * SHARING is real: a real temp repo with a real AGENTS.md + PROGRESS.md. Each
 * scenario asserts the SET of agents that appended to the shared PROGRESS.md
 * equals what the goal should route — proof the dispatch fitted the goal.
 *
 * To drive the REAL agents: see `index.real.ts` / `real-agents.ts` — codex via the
 * real `codex` CLI, the DeepSeek TUI via your DeepSeek-backed terminal coder, and
 * the router brain on DeepSeek. The hub wiring is identical.
 *
 * Run:  pnpm demo:codex-deepseek-hub
 */

import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, InMemoryStorage, type Task, type TaskId } from '@aipehub/core'
import { DispatchToolset, LlmAgent } from '@aipehub/llm'
import { dangerousCommandGate } from '@aipehub/cli-agent'

import { setupSharedWorkspace, readProgress, type SharedWorkspace } from './workspace.js'
import { SharedWorkspaceCli } from './shared-workspace-cli.js'
import { createRouterProvider } from './router-provider.js'
import { DEFAULT_CODING_POLICY, type CodingAgent, type RoutingPolicy } from './routing.js'
import { applyPolicyEdit, loadPolicy, savePolicy } from './policy.js'

const MOCK_CODER = fileURLToPath(new URL('./mock-coder.mjs', import.meta.url))

const ROUTER_SYSTEM =
  'You route a coding goal to the RIGHT coders — NOT a fixed pipeline — combining ' +
  "the task with the user's arrangement (the roster, who is on-call, the budget). " +
  'You manage two coders: `deepseek-tui` (a DeepSeek-backed terminal coder whose ' +
  'reasoner leads analysis / design / review) and `codex` (the fast implementer). ' +
  'A trivial fix (typo / rename) → one implementer, directly. ' +
  'A review/explain ask (do not change code) → one reviewer, no implementation. ' +
  'Anything that needs design first → a lead drafts, then an implementer builds. ' +
  'Never dispatch a coder the user marked unavailable; if the ideal coder is off, ' +
  'the on-call coder covers the role. If the budget caps to one coder, the lead does both. ' +
  'Dispatch by agentId; let PROGRESS.md carry the handoff.'

interface RoutingScenario {
  label: string
  goal: string
  /** The user's standing arrangement for this run (defaults to the std roster). */
  policy?: RoutingPolicy
  /**
   * A plain-language edit to the standing arrangement, applied (and round-tripped
   * through a policy file) BEFORE routing — proof that changing 总分工层 in words
   * changes how the SAME goal routes.
   */
  policyEdit?: string
  /** A short human label of the arrangement, for the console. */
  arrangement?: string
  /** The agents we assert appended to the shared PROGRESS.md (the dispatched set). */
  expect: CodingAgent[]
}

// The SAME two goals are routed under DIFFERENT arrangements below — the proof
// that dispatch combines 分析任务 with 用户的安排, not a fixed pipeline.
const FEATURE_GOAL = 'Add OAuth login with refresh tokens to the auth service.'
const TRIVIAL_GOAL = 'Fix the typo in the README heading.'

const SCENARIOS: RoutingScenario[] = [
  // —— feature goal, three arrangements ——
  {
    label: '[A] 功能 · 默认 roster',
    goal: FEATURE_GOAL,
    arrangement: 'DeepSeek TUI 主理设计 + Codex 实现,都在岗',
    expect: ['deepseek-tui', 'codex'],
  },
  {
    label: '[A2] 功能 · Codex 不在岗',
    goal: FEATURE_GOAL,
    policy: { ...DEFAULT_CODING_POLICY, unavailable: ['codex'] },
    arrangement: 'Codex 已登出 / 限流 → 标记不可用',
    expect: ['deepseek-tui'], // 同一目标, 安排变了 → 在岗的 DeepSeek TUI 一人包办
  },
  {
    label: '[A3] 功能 · 预算限单 coder',
    goal: FEATURE_GOAL,
    policy: { ...DEFAULT_CODING_POLICY, singleCoder: true },
    arrangement: '预算只允许派一个 coder',
    expect: ['deepseek-tui'], // 同一目标, 预算安排 → 主理独立完成
  },
  // —— trivial goal, two arrangements ——
  {
    label: '[B] 琐碎 · 默认 roster',
    goal: TRIVIAL_GOAL,
    arrangement: '都在岗 → 交给快手 Codex',
    expect: ['codex'],
  },
  {
    label: '[B2] 琐碎 · Codex 不在岗',
    goal: TRIVIAL_GOAL,
    policy: { ...DEFAULT_CODING_POLICY, unavailable: ['codex'] },
    arrangement: 'Codex 不在岗 → 小修也得有人接',
    expect: ['deepseek-tui'], // 同一目标, 安排变了 → 在岗的 DeepSeek TUI 接小修
  },
  // —— review goal ——
  {
    label: '[C] 只审查不改 · 默认 roster',
    goal: 'Review auth.ts for security issues; do not change code.',
    arrangement: '默认 roster',
    expect: ['deepseek-tui'],
  },
  // —— 显式分派: the user names coders in the goal itself (覆盖角色填充) ——
  {
    label: '[F] 显式分派 · 这次点名交给 codex',
    goal: '交给 codex 直接实现这个登录按钮',
    arrangement: '用户在目标里点名 → 覆盖默认 roster',
    expect: ['codex'],
  },
  {
    label: '[F2] 显式分派 · deepseek-tui 设计、codex 实现',
    goal: '让 deepseek-tui 设计、codex 实现 OAuth 刷新令牌',
    arrangement: '用户点名两人各司其职',
    expect: ['deepseek-tui', 'codex'],
  },
  // —— 用大白话改总分工层: same FEATURE_GOAL routes differently after the edit ——
  {
    label: '[G] 大白话改分工 · codex 今天不在岗',
    goal: FEATURE_GOAL,
    policyEdit: 'codex 今天限流, 先不在岗',
    arrangement: '改 standing 分工 → 写回 routing-policy.json',
    expect: ['deepseek-tui'], // 同一 feature, 总分工层改了 → 只派在岗的 deepseek-tui
  },
  {
    label: '[G2] 大白话改分工 · 让 deepseek-tui 主理 + 预算限单',
    goal: FEATURE_GOAL,
    policyEdit: '让 deepseek-tui 主理, 这周预算限单 coder',
    arrangement: '主理=deepseek-tui + 限单 → 主理一人包办',
    expect: ['deepseek-tui'],
  },
]

async function main(): Promise<void> {
  console.log('\n=== AipeHub case: codex-deepseek-hub ===')
  console.log('  路由结合「任务分析 × 用户的安排」合理分派编码 agent —— Codex 快手实现, DeepSeek TUI 推理领设计/审查。\n')

  for (const s of SCENARIOS) await runRouting(s)
  await runActionGate()

  section('done')
  console.log('  同一个目标, 安排变了就派得不同:Codex 不在岗 → DeepSeek TUI 一人包办;')
  console.log('  预算限单 coder → 主理独立完成;小修默认给 Codex、Codex 不在岗就给在岗的。')
  console.log('  点名(显式分派)直接覆盖;用大白话改总分工层(写回 routing-policy.json)→ 同一目标重新路由。安全闸照旧。\n')
  process.exit(0)
}

/** Run one routing scenario in its own repo + hub, assert the dispatched set. */
async function runRouting(s: RoutingScenario): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'aipe-codex-deepseek-'))
  const ws = setupSharedWorkspace(dir)

  // 用大白话改总分工层: apply the natural-language edit, persist it to a policy
  // file next to the repo, reload — proving the file is the source of truth both
  // run modes derive from (copy the dir = take the arrangement).
  let policy = s.policy ?? DEFAULT_CODING_POLICY
  let editNote = ''
  if (s.policyEdit) {
    const edit = applyPolicyEdit(policy, s.policyEdit)
    if (!edit.understood) throw new Error(`[${s.label}] policy edit not understood: "${s.policyEdit}"`)
    const policyFile = join(dir, 'routing-policy.json')
    savePolicy(policyFile, edit.policy)
    policy = loadPolicy(policyFile)
    if (JSON.stringify(policy) !== JSON.stringify(edit.policy)) {
      throw new Error(`[${s.label}] policy file round-trip mismatch`)
    }
    editNote = edit.changes.join('; ')
  }

  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()
  hub.register(makeCoder('deepseek-tui', ws))
  hub.register(makeCoder('codex', ws))
  const routerId = 'router'
  hub.register(
    new LlmAgent({
      id: routerId,
      capabilities: ['route'],
      provider: createRouterProvider(policy),
      system: ROUTER_SYSTEM,
      tools: DispatchToolset.create({ hub, selfId: routerId, allowedAgents: ['deepseek-tui', 'codex'] }),
    }),
  )

  try {
    section(s.label)
    console.log(`  goal: ${s.goal}`)
    if (s.arrangement) console.log(`  安排: ${s.arrangement}`)
    if (editNote) console.log(`  ✎ 大白话改分工: "${s.policyEdit}" → ${editNote}`)
    const result = await hub.dispatch({
      from: 'human',
      strategy: { kind: 'capability', capabilities: ['route'] },
      payload: { prompt: s.goal },
      title: s.label,
    })
    if (result.kind !== 'ok') throw new Error(`[${s.label}] router failed: ${JSON.stringify(result)}`)
    console.log(`\n  🧭 ${(result.output as { text?: string }).text ?? '(no text)'}`)

    // The SET of agents that appended to the shared PROGRESS.md == the dispatch.
    const appended = appendedAgents(readProgress(ws))
    console.log(`  分派: ${appended.join(' → ') || '无'}`)
    const got = [...appended].sort().join(',')
    const want = [...s.expect].sort().join(',')
    if (got !== want) throw new Error(`[${s.label}] expected dispatch {${want}}, got {${got}}`)
  } finally {
    await hub.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The safety gate: a destructive task parks before spawning and fails closed. */
async function runActionGate(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'aipe-codex-deepseek-'))
  const ws = setupSharedWorkspace(dir)
  const parked = new Map<TaskId, { task: Task; state: unknown }>()
  const hub = new Hub({
    storage: new InMemoryStorage(),
    suspendNotifier: (task, _by, s) => {
      parked.set(task.id, { task, state: s.state })
    },
  })
  await hub.start()
  hub.register(makeCoder('codex', ws))

  try {
    section('[D] 安全闸 — 危险任务 fail-closed')
    const danger = await hub.dispatch({
      from: 'human',
      strategy: { kind: 'explicit', to: 'codex' },
      payload: { prompt: 'rm -rf build && git push --force' },
      title: 'a destructive instruction',
    })
    if (danger.kind !== 'suspended') throw new Error('expected the dangerous task to park')
    console.log(`  → parked BEFORE any spawn (kind=${danger.kind}) — awaiting human approval`)
    const handle = parked.get(danger.taskId)
    if (!handle) throw new Error('parked task not captured')
    const denied = await hub.resumeTask('codex', handle.task, {
      ...(handle.state as object),
      decision: { approved: false, note: 'too destructive' },
    })
    console.log(`  → human denies → ${denied.kind}: ${denied.kind === 'failed' ? denied.error : ''}`)
    if (denied.kind !== 'failed') throw new Error('expected denial to fail closed')
  } finally {
    await hub.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Two coding agents, BOTH pointed at the same repo (shared cwd) → shared files. */
function makeCoder(id: string, ws: SharedWorkspace): SharedWorkspaceCli {
  return new SharedWorkspaceCli({
    id,
    capabilities: ['code'],
    command: process.execPath,
    args: [MOCK_CODER, '--agent', id, '--prompt', '{prompt}'],
    promptVia: 'arg',
    cwd: ws.dir,
    gate: dangerousCommandGate(),
    onChunk: (_taskId, chunk) => process.stdout.write(`        │ ${chunk.text.trimEnd()}\n`),
  })
}

/** The agents that appended to PROGRESS.md, in append (= dispatch) order. */
function appendedAgents(progress: string): CodingAgent[] {
  const out: CodingAgent[] = []
  for (const line of progress.split('\n')) {
    const m = line.match(/^- \[(codex|deepseek-tui)\]/)
    if (m) out.push(m[1] as CodingAgent)
  }
  return out
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main().catch((err) => {
  console.error('[codex-deepseek-hub] fatal:', err)
  process.exit(1)
})
