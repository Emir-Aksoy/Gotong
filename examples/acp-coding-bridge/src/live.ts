/**
 * LIVE ACP integration — drive a REAL Claude Code / Codex over ACP (NON-HERMETIC).
 *
 * This is the "眼见为实" companion to the deterministic demo (index.ts): instead
 * of the mock ACP server, it spawns a REAL ACP bridge from `ACP_PRESETS` and runs
 * a real coding session end-to-end. It proves the OpenClaw property in the flesh:
 * one held session, two tasks dispatched to it, context preserved between them.
 *
 *   1. spawn the bridge once → initialize → session/new  (= "from startup")
 *   2. dispatch a benign coding task → OBSERVE the real `session/update` stream
 *   3. dispatch a SECOND task to the SAME session → it builds on task 1's work
 *      (context held — the whole point)
 *   4. terminate (session/cancel + kill)
 *
 * NOT in CI. Needs the bridge installed AND its underlying agent logged in. Runs
 * in a throwaway `mkdtemp` repo so the agent can write freely without touching
 * your tree. A destructive tool still escalates (the gate is fail-closed); a
 * standalone live run has no inbox, so an escalation is reported and the run ends.
 *
 * Run:
 *   ACP_LIVE=1 ACP_AGENT=claude-code-acp pnpm --filter @gotong/example-acp-coding-bridge start:live
 *   ACP_LIVE=1 ACP_AGENT=codex-acp        pnpm --filter @gotong/example-acp-coding-bridge start:live
 *
 * Env:
 *   ACP_LIVE=1               required — a guard so this never runs by accident
 *   ACP_AGENT=<preset>       which ACP_PRESETS entry (default: claude-code-acp)
 *   ACP_PROMPT_TIMEOUT_MS    per-turn ceiling (default 180000 = 3 min)
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, InMemoryStorage, type Task, type TaskId } from '@gotong/core'
import { AcpParticipant } from '@gotong/acp-agent'

import { ACP_PRESETS } from './presets.js'

const parked = new Map<TaskId, { task: Task; state: unknown }>()

async function main(): Promise<void> {
  if (process.env.ACP_LIVE !== '1') {
    console.error('Refusing to run: set ACP_LIVE=1 to confirm a non-hermetic live run.')
    console.error('  ACP_LIVE=1 ACP_AGENT=claude-code-acp pnpm --filter @gotong/example-acp-coding-bridge start:live')
    process.exit(2)
  }

  const agentKey = process.env.ACP_AGENT ?? 'claude-code-acp'
  const preset = ACP_PRESETS[agentKey]
  if (!preset) {
    console.error(`Unknown ACP_AGENT="${agentKey}". Known presets: ${Object.keys(ACP_PRESETS).join(', ')}`)
    process.exit(2)
  }

  const promptTimeoutMs = Number(process.env.ACP_PROMPT_TIMEOUT_MS ?? 180_000)
  const cwd = mkdtempSync(join(tmpdir(), 'acp-live-'))

  section(`LIVE ACP — ${preset.label}`)
  console.log(`  command : ${preset.command} ${preset.args.join(' ')}`)
  console.log(`  auth    : ${preset.auth}`)
  console.log(`  cwd     : ${cwd} (throwaway)`)
  console.log(`  timeout : ${promptTimeoutMs}ms per turn`)

  // claude-code-acp refuses to launch when it detects it is nested inside another
  // Claude Code session (CLAUDECODE=1) — "Nested sessions ... will crash all active
  // sessions". That is precisely the case when this script is run from within a
  // Claude Code terminal. Warn early so the failure is understood, not mysterious.
  if (agentKey === 'claude-code-acp' && process.env.CLAUDECODE) {
    console.warn(
      '\n  ⚠ Detected CLAUDECODE — you are inside a Claude Code session. claude-code-acp\n' +
        '    will REFUSE to launch (its nesting guard). Run this in a PLAIN terminal\n' +
        '    (not inside Claude Code), or target a different agent via ACP_AGENT.',
    )
  }

  const hub = new Hub({
    storage: new InMemoryStorage(),
    suspendNotifier: (task, _by, s) => {
      parked.set(task.id, { task, state: s.state })
    },
  })
  await hub.start()

  const coder = new AcpParticipant({
    id: agentKey,
    capabilities: ['code'],
    command: preset.command,
    args: preset.args,
    cwd,
    promptTimeoutMs,
    // Stream the real agent's output so you can watch it work.
    onChunk: (_taskId, chunk) => {
      if (chunk.text) process.stdout.write(chunk.text)
    },
    // Surface the bridge's own stderr — when a turn fails with an opaque
    // `-32603 Internal error`, the real reason (auth, sandbox, …) is logged here.
    onStderr: (chunk) => process.stderr.write(dim(`[bridge] ${chunk}`)),
    // Default gate: a destructive tool escalates (fail-closed). A benign file
    // write passes inline — the standalone live run can't host an approval.
  })
  hub.register(coder)

  try {
    section('[1] OBSERVE — a benign coding task (real session/update stream)')
    const r1 = await dispatch(
      hub,
      'Create a file named greet.js that exports a function greet(name) returning the string `Hello, ${name}!`. Keep it minimal — no extra files.',
    )
    reportTurn('task 1', r1)

    section('[2] HOLD — a SECOND task on the SAME session (context preserved)')
    const r2 = await dispatch(
      hub,
      'In that same greet.js, add a second export greetLoudly(name) that returns greet(name) in upper case. Reuse the greet function you just wrote.',
    )
    reportTurn('task 2', r2)

    if (r2.kind === 'ok') {
      console.log('\n  ✓ Two tasks ran on ONE held ACP session — the agent built task 2 on task 1.')
      console.log(`  ✓ Session id: ${coder.sessionId}`)
      console.log(`  ✓ Inspect the result: ls -la ${cwd}`)
    }

    section('[3] TERMINATE — close the session + kill the bridge')
    await coder.onShutdown()
    console.log('  → session closed, child terminated.')
  } catch (err) {
    reportError(err, preset.command)
  } finally {
    await hub.stop().catch(() => {})
    await coder.onShutdown().catch(() => {})
    rmSync(cwd, { recursive: true, force: true })
  }

  section('done')
}

async function dispatch(hub: Hub, prompt: string) {
  return hub.dispatch({
    from: 'human',
    strategy: { kind: 'capability', capabilities: ['code'] },
    payload: { prompt },
  })
}

function reportTurn(label: string, result: { kind: string; taskId?: TaskId; output?: unknown; error?: string }): void {
  console.log() // close the streamed line
  if (result.kind === 'ok') {
    const out = result.output as { stopReason?: string }
    console.log(`  → ${label}: ok (stopReason=${out?.stopReason ?? '?'})`)
  } else if (result.kind === 'suspended') {
    const handle = result.taskId ? parked.get(result.taskId) : undefined
    const st = handle?.state as { tool?: { title?: string } } | undefined
    console.log(`  → ${label}: PARKED — the agent requested a tool the gate escalated` + (st?.tool?.title ? ` ("${st.tool.title}")` : ''))
    console.log('    (in production this becomes a /me inbox approval; a standalone live run stops here)')
  } else {
    console.log(`  → ${label}: ${result.kind}${result.error ? ` — ${result.error}` : ''}`)
    if (process.env.CLAUDECODE) {
      console.log(
        '    (likely the claude-code-acp nesting guard — see the ⚠ above. The handshake\n' +
          '     [initialize + session/new] still reached the real bridge; only the turn is blocked.)',
      )
    }
  }
}

function reportError(err: unknown, command: string): void {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`\n  ✗ live run failed: ${msg}`)
  if (/ENOENT|spawn/i.test(msg)) {
    console.error(`\n  The ACP bridge "${command}" was not found / failed to spawn. To install:`)
    console.error('    claude-code-acp : npx -y @zed-industries/claude-code-acp   (rides Claude Code login: run `claude` once)')
    console.error('    codex-acp       : install per its README                   (rides Codex login: run `codex` once)')
    console.error('\n  马来西亚网络从国际 CDN 拉包偶发 SSL 解密失败 / unexpected eof。按全局约定:')
    console.error('    用 brew curl + 重试: /opt/homebrew/opt/curl/bin/curl --retry 8 --retry-all-errors --connect-timeout 30 ...')
    console.error('    或先 `npm config set fetch-retries 8` 再 `npx -y @zed-industries/claude-code-acp --help` 预热缓存。')
  } else if (/auth|login|unauthor|401|403/i.test(msg)) {
    console.error('\n  Looks like an auth problem — the underlying agent is not logged in.')
    console.error('    Run the agent once interactively (`claude` / `codex`) and sign in, then retry.')
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

/** Dim ANSI so the bridge's own logs read as background noise, not our output. */
function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
