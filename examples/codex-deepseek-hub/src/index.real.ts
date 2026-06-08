/**
 * index.real.ts — the one-shot REAL-run version of codex-deepseek-hub.
 *
 * Same hub wiring as the deterministic demo, but driving the REAL tools and
 * running a SINGLE goal end-to-end — handy for a scripted smoke / chain test.
 *
 * THREE auth layers stay strictly separate ON PURPOSE (see real-agents.ts):
 *   ① Router brain = DeepSeek (chat) via OpenAIProvider — DEEPSEEK_API_KEY, passed
 *      EXPLICITLY to the provider.
 *   ② codex          = a real CliParticipant under its OWN CLI login.
 *   ③ deepseek-tui   = a DeepSeek-backed terminal coder (configurable command),
 *      reading DEEPSEEK_API_KEY from the ambient env.
 *
 * Run (router only, cheap — validates DeepSeek routing, in-process stand-in coders):
 *   STUB_CODERS=1 DEEPSEEK_API_KEY=sk-... pnpm demo:codex-deepseek-hub:real -- "<goal>"
 * Run (real — drives codex + your DeepSeek TUI via their own auth):
 *   DEEPSEEK_API_KEY=sk-... pnpm demo:codex-deepseek-hub:real -- "<goal>"
 * Run (CHAIN SELF-CHECK, no LLM key — proves the WHOLE pipeline runs end-to-end with
 *   STUB_CODERS=1; the router brain falls back to a deterministic stand-in that still
 *   emits real dispatch tool-use; prints a ✅/❌ chain verdict, exit 0/1):
 *   STUB_CODERS=1 pnpm demo:codex-deepseek-hub:real -- "<goal>"
 *
 * SAFETY: throwaway git repo, dangerousCommandGate on, each coder sandboxed to the
 * workspace (codex --sandbox workspace-write; the DeepSeek TUI runs in the cwd).
 */

import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, InMemoryStorage } from '@aipehub/core'
import { DispatchToolset, LlmAgent } from '@aipehub/llm'

import { makeRouter, makeCoder, stripThink, DEEPSEEK_MODEL, DEEPSEEK_BASE_URL } from './real-agents.js'
import { createRouterProvider } from './router-provider.js'
import { setupSharedWorkspace, readProgress, initGitRepo } from './workspace.js'

async function main(): Promise<void> {
  // The router brain prefers a real LLM (DeepSeek). But for a CHAIN TEST — proving the
  // whole pipeline runs end-to-end — a hosted LLM key is NOT required: when
  // DEEPSEEK_API_KEY is absent we fall back to the deterministic router (the same
  // `createRouterProvider` the offline demo uses). It still emits REAL `dispatch_task`
  // tool-use the hub really routes; only the router's JUDGEMENT is the stand-in.
  const apiKey = process.env.DEEPSEEK_API_KEY
  const stub = process.env.STUB_CODERS === '1'
  const goal =
    process.argv
      .slice(2)
      .filter((a) => a !== '--') // pnpm forwards a literal `--` separator
      .join(' ')
      .trim() ||
    'Create a file greet.js that exports a function greet(name) returning the string `Hello, ${name}!`.'

  const routerBrain = apiKey
    ? `DeepSeek ${DEEPSEEK_MODEL} @ ${DEEPSEEK_BASE_URL} (real LLM)`
    : 'deterministic stand-in (real dispatch, no LLM key) — set DEEPSEEK_API_KEY for a hosted LLM brain'

  console.log('\n=== codex-deepseek-hub (REAL chain test, one-shot) ===')
  console.log(`  router : ${routerBrain}`)
  console.log(`  coders : ${stub ? 'in-process stand-ins (STUB_CODERS=1)' : 'codex + deepseek-tui (各自 CLI 登录 / DEEPSEEK_API_KEY, 不注入 router key)'}`)
  console.log(`  goal   : ${goal}\n`)

  const dir = mkdtempSync(join(tmpdir(), 'aipe-codex-deepseek-real-'))
  const ws = setupSharedWorkspace(dir)
  initGitRepo(dir) // so the real CLIs don't print `fatal: not a git repository`
  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()
  hub.register(makeCoder('codex', ws, stub))
  hub.register(makeCoder('deepseek-tui', ws, stub))
  if (apiKey) {
    hub.register(makeRouter(hub, apiKey)) // real DeepSeek brain
  } else {
    // Deterministic router brain — real dispatch tool-use, no LLM key. Same id/capability
    // as makeRouter so every downstream wire (dispatch, handoff, report) is identical.
    hub.register(
      new LlmAgent({
        id: 'router',
        capabilities: ['route'],
        provider: createRouterProvider(),
        system: 'Route the coding goal to the right coder(s); let PROGRESS.md carry the handoff.',
        tools: DispatchToolset.create({ hub, selfId: 'router', allowedAgents: ['codex', 'deepseek-tui'] }),
      }),
    )
  }

  let chainOk = false
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

    const progress = readProgress(ws)
    // Count handoff bullets TOLERANTLY: a real coder labels its own entry however it
    // likes (`- [codex]`, `- [deepseek-tui]`, `- [aider]`…). Asserting the EXACT label
    // would be asserting a RESULT detail; the chain test only cares that a handoff bullet
    // appeared at all (the seed PROGRESS.md has none — its instruction line starts `> `).
    const handoffs = progress.match(/^- \[/gm) ?? []
    console.log('\n── PROGRESS.md (handoff log) ' + '─'.repeat(28))
    console.log(progress.trimEnd() || '(empty)')

    console.log('\n── workspace files ' + '─'.repeat(38))
    for (const f of readdirSync(ws.dir)) console.log(`  · ${f}`)

    // CHAIN-TEST verdict — we assert the pipeline RAN THROUGH, not which coder it picked:
    // the router returned ok AND ≥1 coder appended a handoff entry to PROGRESS.md.
    chainOk = result.kind === 'ok' && handoffs.length >= 1
    const coderLabel = stub ? 'stand-in coders' : '真 CLI'
    console.log(
      chainOk
        ? `\n  ✅ 链条跑通: router → dispatch → ${coderLabel} (${handoffs.length} 次交接) → PROGRESS.md → 回报`
        : `\n  ❌ 链条未跑通 (router=${result.kind}, 交接=${handoffs.length})`,
    )
  } finally {
    await hub.stop()
    // Keep the temp repo so you can inspect what the coders actually wrote.
    console.log(`\n  workspace kept at: ${ws.dir}`)
  }
  process.exit(chainOk ? 0 : 1)
}

main().catch((err) => {
  console.error('[codex-deepseek-hub real] fatal:', err)
  process.exit(1)
})
