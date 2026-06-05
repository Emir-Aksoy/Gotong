/**
 * index.real.ts — the one-shot REAL-run version of personal-coding-hub.
 *
 * Same hub wiring as the interactive cli.ts (both consume real-agents.ts), but
 * this runs a SINGLE goal and exits — handy for scripted / CI-ish smoke runs.
 * For a keep-typing session use `pnpm demo:personal-coding-hub:cli` instead.
 *
 * THREE auth layers stay strictly separate ON PURPOSE (see real-agents.ts):
 *   ① Router brain = MiniMax (M2.1) via OpenAIProvider — MINIMAX_API_KEY, passed
 *      EXPLICITLY, never via OPENAI_API_KEY (which codex reads).
 *   ② claude-code / codex = real CliParticipants under their OWN CLI login.
 *
 * Run (router only, cheap — validates MiniMax routing, in-process stand-in coders):
 *   STUB_CODERS=1 MINIMAX_API_KEY=sk-... pnpm demo:personal-coding-hub:real -- "<goal>"
 * Run (real — drives Claude Code + Codex via their own logins):
 *   MINIMAX_API_KEY=sk-... pnpm demo:personal-coding-hub:real -- "<goal>"
 *
 * SAFETY: throwaway git repo, dangerousCommandGate on, each CLI sandboxed to the
 * workspace (claude --permission-mode acceptEdits, codex --sandbox workspace-write).
 */

import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, InMemoryStorage } from '@aipehub/core'

import { makeRouter, makeCoder, stripThink, MINIMAX_MODEL, MINIMAX_BASE_URL } from './real-agents.js'
import { setupSharedWorkspace, readProgress, initGitRepo } from './workspace.js'

async function main(): Promise<void> {
  const apiKey = process.env.MINIMAX_API_KEY
  if (!apiKey) {
    console.error('\n[real] 缺 MINIMAX_API_KEY —— 路由模型(MiniMax)需要它。')
    console.error('  用法: MINIMAX_API_KEY=sk-... pnpm demo:personal-coding-hub:real -- "<goal>"\n')
    process.exit(2)
  }
  const stub = process.env.STUB_CODERS === '1'
  const goal =
    process.argv
      .slice(2)
      .filter((a) => a !== '--') // pnpm forwards a literal `--` separator
      .join(' ')
      .trim() ||
    'Create a file greet.js that exports a function greet(name) returning the string `Hello, ${name}!`.'

  console.log('\n=== personal-coding-hub (REAL, one-shot) ===')
  console.log(`  router : MiniMax ${MINIMAX_MODEL} @ ${MINIMAX_BASE_URL}`)
  console.log(`  coders : ${stub ? 'in-process stand-ins (STUB_CODERS=1)' : 'claude-code + codex (各自 CLI 登录, 不注入 key)'}`)
  console.log(`  goal   : ${goal}\n`)

  const dir = mkdtempSync(join(tmpdir(), 'aipe-coding-real-'))
  const ws = setupSharedWorkspace(dir)
  initGitRepo(dir) // so the real CLIs don't print `fatal: not a git repository`
  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()
  hub.register(makeCoder('claude-code', ws, stub))
  hub.register(makeCoder('codex', ws, stub))
  hub.register(makeRouter(hub, apiKey))

  try {
    const result = await hub.dispatch({
      from: 'human',
      strategy: { kind: 'capability', capabilities: ['route'] },
      payload: { prompt: goal },
      title: 'real coding goal',
    })
    console.log(`\n  🧭 router → ${result.kind}`)
    if (result.kind === 'ok') {
      console.log(`     ${stripThink((result.output as { text?: string }).text ?? '') || '(no text)'}`)
    } else {
      console.log(`     ${JSON.stringify(result)}`)
    }

    console.log('\n── PROGRESS.md (handoff log) ' + '─'.repeat(28))
    console.log(readProgress(ws).trimEnd() || '(empty)')

    console.log('\n── workspace files ' + '─'.repeat(38))
    for (const f of readdirSync(ws.dir)) console.log(`  · ${f}`)
  } finally {
    await hub.stop()
    // Keep the temp repo so you can inspect what the agents actually wrote.
    console.log(`\n  workspace kept at: ${ws.dir}`)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('[personal-coding-hub real] fatal:', err)
  process.exit(1)
})
