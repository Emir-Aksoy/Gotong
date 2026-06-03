/**
 * personal-coding-hub — a case AipeHub can carry: one router LLM actively manages
 * Claude Code + Codex, and the two share project-level files.
 *
 * The story (deterministic, no API key — mock LLM + mock CLIs, but the FILE
 * SHARING is real: a real temp repo with a real AGENTS.md + PROGRESS.md):
 *
 *   [1] a person hands ONE goal to a router LlmAgent. The router decides who does
 *       what and dispatches across two coding agents via `dispatch_task`:
 *       claude-code drafts → codex implements.
 *   [2] both coding agents run with their `cwd` set to the SAME repo, so they
 *       share AGENTS.md (spec) and PROGRESS.md (the handoff log). The final
 *       PROGRESS.md carries one entry from EACH agent — proof they shared it.
 *   [3] a destructive task parks BEFORE the CLI spawns (the action gate); a human
 *       denies it and it fails closed — the CLI never ran.
 *
 * To drive the REAL agents: swap `command`/`args` for a `CLI_PRESETS` entry
 * (claude-code / codex), give each its API key via `env`, and swap the mock
 * router provider for a real one. The hub wiring is identical.
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

import { setupSharedWorkspace, readProgress } from './workspace.js'
import { SharedWorkspaceCli } from './shared-workspace-cli.js'
import { createRouterProvider } from './router-provider.js'

const MOCK_CODER = fileURLToPath(new URL('./mock-coder.mjs', import.meta.url))

/** Parked tasks captured from the hub's suspend notifier (id → task + state). */
const parked = new Map<TaskId, { task: Task; state: unknown }>()

async function main(): Promise<void> {
  // A real shared project repo on disk: AGENTS.md (spec) + PROGRESS.md (log).
  const dir = mkdtempSync(join(tmpdir(), 'aipe-coding-hub-'))
  const ws = setupSharedWorkspace(dir)

  const hub = new Hub({
    storage: new InMemoryStorage(),
    suspendNotifier: (task, _by, s) => {
      parked.set(task.id, { task, state: s.state })
    },
  })
  await hub.start()

  // Two coding agents, BOTH pointed at the same repo (shared cwd) — that is what
  // lets them share AGENTS.md + PROGRESS.md. A safety gate parks destructive
  // commands before they ever spawn.
  const makeCoder = (id: string): SharedWorkspaceCli =>
    new SharedWorkspaceCli({
      id,
      capabilities: ['code'],
      command: process.execPath,
      args: [MOCK_CODER, '--agent', id, '--prompt', '{prompt}'],
      promptVia: 'arg',
      cwd: ws.dir,
      gate: dangerousCommandGate(),
      onChunk: (_taskId, chunk) => process.stdout.write(`        │ ${chunk.text.trimEnd()}\n`),
    })
  hub.register(makeCoder('claude-code'))
  hub.register(makeCoder('codex'))

  // The router: an LlmAgent that actively decides who does what, dispatching by
  // agentId through its DispatchToolset (allow-list = the two coders).
  const routerId = 'router'
  hub.register(
    new LlmAgent({
      id: routerId,
      capabilities: ['route'],
      provider: createRouterProvider(),
      system:
        'You route coding tasks across claude-code (planning/drafting) and codex ' +
        '(implementation). Dispatch by agentId; let PROGRESS.md carry the handoff.',
      tools: DispatchToolset.create({
        hub,
        selfId: routerId,
        allowedAgents: ['claude-code', 'codex'],
      }),
    }),
  )

  console.log('\n=== AipeHub case: personal-coding-hub ===\n')
  console.log(`  shared repo: ${ws.dir}`)

  // --- [1] the router actively manages both agents ------------------------
  section('[1] router routes ONE goal across Claude Code + Codex')
  const result = await hub.dispatch({
    from: 'human',
    strategy: { kind: 'capability', capabilities: ['route'] },
    payload: { prompt: 'Add a /health endpoint to the service.' },
    title: 'ship a /health endpoint',
  })
  if (result.kind !== 'ok') throw new Error(`router failed: ${JSON.stringify(result)}`)
  console.log(`\n  🧭 router: ${(result.output as { text?: string }).text ?? '(no text)'}\n`)

  // --- [2] prove they shared the project files ----------------------------
  section('[2] shared PROGRESS.md — the handoff trail')
  const progress = readProgress(ws)
  console.log(
    progress
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n'),
  )
  // Self-assert (this example doubles as a smoke test): BOTH agents must have
  // appended to the SAME progress file — that is the shared-workspace proof.
  if (!progress.includes('- [claude-code]') || !progress.includes('- [codex]')) {
    throw new Error('expected BOTH agents to append to the shared PROGRESS.md')
  }

  // --- [3] safety: a destructive task parks before spawning ---------------
  section('[3] action gate — destructive task fails closed')
  parked.clear()
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

  await hub.stop()
  rmSync(dir, { recursive: true, force: true })
  section('done')
  console.log('  Router managed both agents; they shared AGENTS.md + PROGRESS.md; the gate held.\n')
  process.exit(0)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main().catch((err) => {
  console.error('[personal-coding-hub] fatal:', err)
  process.exit(1)
})
