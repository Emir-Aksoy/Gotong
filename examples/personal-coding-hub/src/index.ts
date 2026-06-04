/**
 * personal-coding-hub — a case AipeHub can carry: one router LLM actively manages
 * Claude Code + Codex, routing the RIGHT agents for each goal, and the two share
 * project-level files.
 *
 * ★ What changed (能力分派要合适) ★
 * The router no longer runs a fixed claude-code → codex pipeline for every goal.
 * It reads the goal and routes accordingly:
 *   · a trivial fix (typo / rename)        → Codex only, implement directly;
 *   · a review/explain ask (don't change)  → Claude Code only, no implementation;
 *   · a feature that needs design          → Claude Code drafts, Codex implements.
 * The routing is a PURE function (`planRoute`) the router calls; a real router LLM
 * makes the same call from the same goal.
 *
 * Deterministic, no API key (situation-aware router + mock CLIs), but the FILE
 * SHARING is real: a real temp repo with a real AGENTS.md + PROGRESS.md. Each
 * scenario asserts the SET of agents that appended to the shared PROGRESS.md
 * equals what the goal should route — proof the dispatch fitted the goal.
 *
 * To drive the REAL agents: swap `command`/`args` for a `CLI_PRESETS` entry
 * (claude-code / codex), give each its API key via `env`, and swap the router's
 * deterministic provider for a real one. The hub wiring is identical.
 *
 * Run:  pnpm demo:personal-coding-hub
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
import { type CodingAgent } from './routing.js'

const MOCK_CODER = fileURLToPath(new URL('./mock-coder.mjs', import.meta.url))

const ROUTER_SYSTEM =
  'You route a coding goal to the RIGHT agents — NOT a fixed pipeline. ' +
  'A trivial fix (typo / rename) → codex only, implement directly. ' +
  'A review/explain ask (do not change code) → claude-code only, no implementation. ' +
  'Anything that needs design first → claude-code drafts, then codex implements. ' +
  'Dispatch by agentId; let PROGRESS.md carry the handoff.'

interface RoutingScenario {
  label: string
  goal: string
  /** The agents we assert appended to the shared PROGRESS.md (the dispatched set). */
  expect: CodingAgent[]
}

const SCENARIOS: RoutingScenario[] = [
  {
    label: '[A] 功能(需先设计)',
    goal: 'Add OAuth login with refresh tokens to the auth service.',
    expect: ['claude-code', 'codex'],
  },
  {
    label: '[B] 琐碎修复',
    goal: 'Fix the typo in the README heading.',
    expect: ['codex'],
  },
  {
    label: '[C] 只审查不改',
    goal: 'Review auth.ts for security issues; do not change code.',
    expect: ['claude-code'],
  },
]

async function main(): Promise<void> {
  console.log('\n=== AipeHub case: personal-coding-hub ===')
  console.log('  路由按「目标」分派合适的编码 agent —— 不再每次都 claude-code → codex。\n')

  for (const s of SCENARIOS) await runRouting(s)
  await runActionGate()

  section('done')
  console.log('  路由结合了目标:功能派两个、琐碎只派 Codex、审查只派 Claude Code;安全闸照旧。\n')
  process.exit(0)
}

/** Run one routing scenario in its own repo + hub, assert the dispatched set. */
async function runRouting(s: RoutingScenario): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'aipe-coding-hub-'))
  const ws = setupSharedWorkspace(dir)
  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()
  hub.register(makeCoder('claude-code', ws))
  hub.register(makeCoder('codex', ws))
  const routerId = 'router'
  hub.register(
    new LlmAgent({
      id: routerId,
      capabilities: ['route'],
      provider: createRouterProvider(),
      system: ROUTER_SYSTEM,
      tools: DispatchToolset.create({ hub, selfId: routerId, allowedAgents: ['claude-code', 'codex'] }),
    }),
  )

  try {
    section(s.label)
    console.log(`  goal: ${s.goal}`)
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
  const dir = mkdtempSync(join(tmpdir(), 'aipe-coding-hub-'))
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
    const m = line.match(/^- \[(claude-code|codex)\]/)
    if (m) out.push(m[1] as CodingAgent)
  }
  return out
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main().catch((err) => {
  console.error('[personal-coding-hub] fatal:', err)
  process.exit(1)
})
