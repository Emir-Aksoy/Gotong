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

import { Hub, InMemoryStorage } from '@gotong/core'

import { makeRouter, makeCoder, stripThink, ROUTER_ID, MINIMAX_MODEL, MINIMAX_BASE_URL } from './real-agents.js'
import { setupSharedWorkspace, readProgress, initGitRepo, type SharedWorkspace } from './workspace.js'
import { loadPolicy, savePolicy, applyPolicyEdit, describePolicy } from './policy.js'
import { type RoutingPolicy } from './routing.js'

const META_HELP = [
  '  meta 命令 (以 : 开头):',
  '    :help          显示这份帮助',
  '    :files         列出工作区文件',
  '    :progress      打印 PROGRESS.md (两个 agent 的交接日志)',
  '    :roster        打印当前「总分工层」(谁在岗 / 谁主理 / 预算)',
  '    :policy <大白话>  用大白话改总分工层, 例: :policy codex 今天不在岗',
  '    :quit          退出 (别名 :q / :exit)',
  '  其它任何输入都会作为「编码目标」派给路由模型, 由它决定派给 claude-code / codex。',
  '  你也可以在目标里直接点名 (显式分派), 例: 交给 codex 实现这个登录按钮。',
].join('\n')

/** Print the standing arrangement (the 总分工层) — what `:roster` shows. */
function printRoster(policy: RoutingPolicy): void {
  console.log('── 总分工层 ' + '─'.repeat(32))
  for (const line of describePolicy(policy)) console.log(line)
}

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
  const dir = mkdtempSync(join(tmpdir(), 'gotong-coding-cli-'))
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

  // The standing arrangement (总分工层) lives as a FILE next to the workspace, so
  // copying the repo carries it and `:policy` edits survive restarts. loadPolicy
  // defaults the roster on first run (no file yet).
  const policyFile = join(ws.dir, 'routing-policy.json')
  let policy = loadPolicy(policyFile)

  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()
  hub.register(makeCoder('claude-code', ws, stub))
  hub.register(makeCoder('codex', ws, stub))
  hub.register(makeRouter(hub, apiKey, policy))

  console.log('\n=== personal-coding-hub (交互式 CLI) ===')
  console.log(`  router : MiniMax ${MINIMAX_MODEL} @ ${MINIMAX_BASE_URL}`)
  console.log(`  coders : ${stub ? 'in-process stand-ins (STUB_CODERS=1)' : 'claude-code + codex (各自 CLI 登录, 不注入 key)'}`)
  console.log(`  repo   : ${ws.dir}${ephemeral ? ' (临时, 退出后保留供查看)' : ' (--cwd)'}`)
  console.log(`  policy : ${policyFile}`)
  printRoster(policy)
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
        const name = text.slice(1).split(/\s+/)[0]
        // :roster / :policy need the live policy + router, which live in this
        // closure — so they're handled here, not in the stateless handleMeta.
        if (name === 'roster') {
          printRoster(policy)
          continue
        }
        if (name === 'policy') {
          const instruction = text.slice(1).replace(/^policy\b\s*/, '').trim()
          if (!instruction) {
            console.log('  用法: :policy <大白话>  例: :policy codex 今天不在岗 / 让 claude-code 主理')
            continue
          }
          const edit = applyPolicyEdit(policy, instruction)
          if (!edit.understood) {
            console.log('  没听懂这条分工调整, 换个说法 (例: codex 不在岗 / claude-code 主理 / 预算限单)。')
            continue
          }
          // The file is the source of truth; re-register the router so its system
          // prompt reflects the new arrangement (the real LLM brain re-reads it).
          policy = edit.policy
          savePolicy(policyFile, policy)
          hub.unregister(ROUTER_ID)
          // apiKey is guarded non-null at startup; narrowing is lost in this closure.
          hub.register(makeRouter(hub, apiKey!, policy))
          for (const c of edit.changes) console.log(`  ✓ ${c}`)
          printRoster(policy)
          continue
        }
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
