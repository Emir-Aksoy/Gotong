/**
 * cli.ts — the interactive command-line launcher for personal-coding-hub.
 *
 * The user asked to "start them from a command line" rather than a one-shot
 * script — so this opens a readline loop you keep typing coding goals into,
 * and the MiniMax router dispatches each one to claude-code / codex live.
 *
 * Same three-auth-layer wiring as index.real.ts (see real-agents.ts):
 *   ① router brain = MiniMax (M2.1) via OpenAIProvider — needs MINIMAX_API_KEY,
 *      passed EXPLICITLY (never as OPENAI_API_KEY, which codex reads).
 *   ② claude-code / codex = real CLIs, each under its OWN login. No key injected.
 *
 * Usage:
 *   MINIMAX_API_KEY=sk-... pnpm demo:personal-coding-hub:cli
 *   MINIMAX_API_KEY=sk-... pnpm demo:personal-coding-hub:cli -- --cwd /path/to/repo
 *   STUB_CODERS=1 MINIMAX_API_KEY=sk-... pnpm demo:personal-coding-hub:cli   # dry run
 *
 * Type a goal at `coding-hub>` and press enter to dispatch it. Meta commands
 * (prefix `:`): :help  :files  :progress  :quit
 *
 * SAFETY: a throwaway git repo by default (or your `--cwd` repo); dangerousCommandGate
 * on; each CLI sandboxed to the workspace (claude acceptEdits / codex workspace-write).
 */

import { createInterface, type Interface } from 'node:readline'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Hub, InMemoryStorage } from '@aipehub/core'

import { makeRouter, makeCoder, stripThink, MINIMAX_MODEL, MINIMAX_BASE_URL } from './real-agents.js'
import { setupSharedWorkspace, readProgress, initGitRepo, type SharedWorkspace } from './workspace.js'

const META_HELP = [
  '  meta 命令 (以 : 开头):',
  '    :help      显示这份帮助',
  '    :files     列出工作区文件',
  '    :progress  打印 PROGRESS.md (两个 agent 的交接日志)',
  '    :quit      退出 (别名 :q / :exit)',
  '  其它任何输入都会作为「编码目标」派给路由模型, 由它决定派给 claude-code / codex。',
].join('\n')

/** Parse argv: drop pnpm's literal `--`, pull out `--cwd <dir>`. */
function parseArgs(argv: string[]): { cwd?: string } {
  const args = argv.filter((a) => a !== '--')
  let cwd: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd') {
      cwd = args[i + 1]
      i++
    }
  }
  return { cwd }
}

/**
 * Prepare the shared workspace. With `--cwd` we point at a REAL repo and seed the
 * two shared files only if absent (never clobber). Otherwise a throwaway temp dir,
 * git-init'd so the CLIs don't print `fatal: not a git repository`.
 */
function prepareWorkspace(cwdArg?: string): { ws: SharedWorkspace; ephemeral: boolean } {
  if (cwdArg) {
    const dir = resolve(cwdArg)
    if (!existsSync(dir)) {
      console.error(`[cli] --cwd 目录不存在: ${dir}`)
      process.exit(2)
    }
    return { ws: setupSharedWorkspace(dir, { overwrite: false }), ephemeral: false }
  }
  const dir = mkdtempSync(join(tmpdir(), 'aipe-coding-cli-'))
  const ws = setupSharedWorkspace(dir)
  initGitRepo(dir)
  return { ws, ephemeral: true }
}

/** Handle a `:`-prefixed meta command. Returns 'quit' to end the loop. */
function handleMeta(cmd: string, ws: SharedWorkspace): 'quit' | 'ok' {
  const name = cmd.slice(1).split(/\s+/)[0]
  switch (name) {
    case 'help':
      console.log(META_HELP)
      return 'ok'
    case 'files':
      console.log('  workspace files:')
      for (const f of readdirSync(ws.dir)) console.log(`    · ${f}`)
      return 'ok'
    case 'progress':
      console.log('── PROGRESS.md ' + '─'.repeat(30))
      console.log(readProgress(ws).trimEnd() || '(empty)')
      return 'ok'
    case 'quit':
    case 'q':
    case 'exit':
      return 'quit'
    default:
      console.log(`  未知命令: :${name} (试试 :help)`)
      return 'ok'
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.MINIMAX_API_KEY
  if (!apiKey) {
    console.error('\n[cli] 缺 MINIMAX_API_KEY —— 路由模型(MiniMax)需要它。')
    console.error('  用法: MINIMAX_API_KEY=sk-... pnpm demo:personal-coding-hub:cli\n')
    process.exit(2)
  }
  const stub = process.env.STUB_CODERS === '1'
  const { cwd } = parseArgs(process.argv.slice(2))
  const { ws, ephemeral } = prepareWorkspace(cwd)

  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()
  hub.register(makeCoder('claude-code', ws, stub))
  hub.register(makeCoder('codex', ws, stub))
  hub.register(makeRouter(hub, apiKey))

  console.log('\n=== personal-coding-hub (交互式 CLI) ===')
  console.log(`  router : MiniMax ${MINIMAX_MODEL} @ ${MINIMAX_BASE_URL}`)
  console.log(`  coders : ${stub ? 'in-process stand-ins (STUB_CODERS=1)' : 'claude-code + codex (各自 CLI 登录, 不注入 key)'}`)
  console.log(`  repo   : ${ws.dir}${ephemeral ? ' (临时, 退出后保留供查看)' : ' (--cwd)'}`)
  console.log(`\n${META_HELP}\n`)

  const rl: Interface = createInterface({ input: process.stdin, output: process.stdout, prompt: 'coding-hub> ' })

  // A serial queue, NOT a per-line async handler: a coding goal takes seconds
  // (a real CLI run), and we must finish the in-flight one before the next line —
  // and crucially must NOT exit on stdin EOF while a dispatch is still running
  // (the bug a naive `rl.on('close')` hits when goals are piped in). Lines pile
  // into `queue`; `drain()` empties it one at a time; shutdown waits for empty.
  const queue: string[] = []
  let draining = false
  let inputEnded = false
  let quitting = false
  let shuttingDown = false

  async function shutdown(): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    rl.close()
    await hub.stop()
    if (ephemeral) console.log(`\n  workspace kept at: ${ws.dir}`)
    console.log('  再见。')
    process.exit(0)
  }

  async function drain(): Promise<void> {
    if (draining) return // a drain is already in flight; it will see the new items
    draining = true
    while (queue.length > 0 && !quitting) {
      const text = queue.shift()!.trim()
      if (!text) continue
      if (text.startsWith(':')) {
        if (handleMeta(text, ws) === 'quit') quitting = true
        continue
      }
      try {
        const result = await hub.dispatch({
          from: 'human',
          strategy: { kind: 'capability', capabilities: ['route'] },
          payload: { prompt: text },
          title: 'coding goal',
        })
        console.log(`\n  🧭 router → ${result.kind}`)
        if (result.kind === 'ok') {
          console.log(`     ${stripThink((result.output as { text?: string }).text ?? '') || '(no text)'}`)
        } else {
          console.log(`     ${JSON.stringify(result)}`)
        }
      } catch (err) {
        console.error('  ✗ dispatch failed:', err)
      }
    }
    draining = false
    if (quitting || inputEnded) {
      await shutdown()
    } else {
      rl.prompt()
    }
  }

  rl.prompt()
  rl.on('line', (line) => {
    queue.push(line)
    void drain()
  })
  // First SIGINT requests a graceful stop (finishes any in-flight dispatch); a
  // second one while still draining hard-exits.
  rl.on('SIGINT', () => {
    if (quitting) process.exit(130)
    quitting = true
    void drain()
  })
  // stdin EOF (piped input ran out, or Ctrl-D): finish the queue, THEN shut down.
  rl.on('close', () => {
    inputEnded = true
    void drain()
  })
}

main().catch((err) => {
  console.error('[personal-coding-hub cli] fatal:', err)
  process.exit(1)
})
