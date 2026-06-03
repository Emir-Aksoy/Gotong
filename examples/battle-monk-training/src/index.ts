/**
 * battle-monk-training (战斗修士锻炼) — an AipeHub case: a personal-growth hub for
 * the austere. A preceptor (the router LLM) assesses the trainee and drives three
 * pillars — 肉身 / 心志 / 学识 — each writing the trainee's STATE into a persistent
 * Codex (an Obsidian-style vault). Themed for the grimdark-monastic aesthetic; an
 * ORIGINAL homage, not affiliated with or copying any rightsholder.
 *
 * Deterministic, no API key (mock preceptor + deterministic pillar drills), but
 * the FILE I/O is real: a real temp Codex with codex/{body,mind,lore}.md.
 *
 *   [1] one "今日操练" goal → the preceptor routes across all three pillars.
 *   [2] each pillar appends the next rank's directive to its state file, reading
 *       the PRIOR rank for continuity (the Codex stores evolving user state).
 *   [3] the Codex carries one growing log per pillar; the next session resumes.
 *
 * To drive it for real: swap the deterministic pillar drills for real LlmAgents
 * (a provider that writes each directive) and the mock preceptor for a real one —
 * the hub wiring is identical. Point the Codex at your Obsidian vault via
 * mcp-obsidian (see the loadable template + README).
 *
 * Run:  pnpm demo:battle-monk-training
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, InMemoryStorage } from '@aipehub/core'
import { DispatchToolset, LlmAgent } from '@aipehub/llm'

import {
  setupCodex,
  readPillar,
  readIndex,
  priorSteps,
  PILLARS,
  PILLAR_TITLE,
} from './codex.js'
import { BATTLE_PILLARS, PillarAgent } from './pillar-agent.js'
import { createPreceptorProvider } from './preceptor-provider.js'

async function main(): Promise<void> {
  // A real Codex on disk: codex/{index,body,mind,lore}.md (baseline seeded).
  const dir = mkdtempSync(join(tmpdir(), 'aipe-battle-monk-'))
  const kb = setupCodex(dir)

  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()

  // Three pillar drills — each reads/writes the SAME Codex on disk.
  for (const spec of BATTLE_PILLARS) hub.register(new PillarAgent(kb, spec))

  // The preceptor: an LlmAgent that assesses + routes the session across the
  // three pillars by agentId through its DispatchToolset (allow-list = drills).
  const preceptorId = 'preceptor'
  hub.register(
    new LlmAgent({
      id: preceptorId,
      capabilities: ['route'],
      provider: createPreceptorProvider(),
      system:
        '你是战斗修士会的督修。语气冷峻、简短、不留情面,不安慰、不寒暄。评估修士状态,' +
        '把今日操练派给三柱:肉身(body)、心志(mind)、学识(lore)。让档案承载记录。',
      tools: DispatchToolset.create({
        hub,
        selfId: preceptorId,
        allowedAgents: BATTLE_PILLARS.map((s) => s.id),
      }),
    }),
  )

  console.log('\n=== AipeHub case: battle-monk-training (战斗修士锻炼) ===\n')
  console.log(`  codex: ${kb.codexDir}`)

  // --- [1] the preceptor routes one session across all three pillars ---------
  section('[1] 督修评估 + 三柱操练 (route across pillars)')
  const result = await hub.dispatch({
    from: 'human',
    strategy: { kind: 'capability', capabilities: ['route'] },
    payload: { prompt: '今日操练:评估并推进肉身、心志、学识三柱。' },
    title: '今日操练',
  })
  if (result.kind !== 'ok') throw new Error(`preceptor failed: ${JSON.stringify(result)}`)
  console.log(`\n  督修: ${(result.output as { text?: string }).text ?? '(no text)'}`)

  // --- [2] the Codex — one growing state log per pillar ----------------------
  section('[2] the Codex — one growing state log per pillar')
  for (const p of PILLARS) {
    console.log(`\n  codex/${p}.md (${PILLAR_TITLE[p]}):`)
    for (const line of readPillar(kb, p).trimEnd().split('\n')) console.log(`    │ ${line}`)
  }

  // --- [3] the Codex index (the interlinked home) ----------------------------
  section('[3] the Codex index (interlinked home)')
  for (const line of readIndex(kb).trimEnd().split('\n')) console.log(`    │ ${line}`)

  // Self-assert (doubles as a smoke test): every pillar advanced beyond its
  // baseline (≥2 ranked entries), and the new entry references the prior rank —
  // proof the Codex persists evolving user state across the session.
  for (const p of PILLARS) {
    if (priorSteps(kb, p) < 2) throw new Error(`expected pillar ${p} to advance past baseline`)
    if (!readPillar(kb, p).includes('承前')) {
      throw new Error(`expected pillar ${p} to reference its prior state`)
    }
  }

  await hub.stop()
  rmSync(dir, { recursive: true, force: true })
  section('done')
  console.log('  督修 routed all three pillars; each advanced and logged state to the Codex.\n')
  process.exit(0)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main().catch((err) => {
  console.error('[battle-monk-training] fatal:', err)
  process.exit(1)
})
