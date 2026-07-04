/**
 * battle-monk-training (战斗修士锻炼) — an Gotong case: a personal-growth hub for
 * the austere. A preceptor (the router LLM) reads the trainee's SITUATION and the
 * Codex, then routes ONLY the pillars — 肉身 / 心志 / 学识 — that fit today, each
 * writing the trainee's STATE into a persistent Codex (an Obsidian-style vault).
 * Themed for the grimdark-monastic aesthetic; an ORIGINAL homage, not affiliated
 * with or copying any rightsholder.
 *
 * ★ What changed (结合使用者的情况, 能力分派要合适) ★
 * The preceptor no longer blindly fans out all three pillars every day. It reads
 * how much the trainee actually has — time / energy / injury / a pillar to focus —
 * plus the Codex ranks, and routes accordingly:
 *   · a full, strong day → all three pillars at 满负荷;
 *   · a thin day (little time or low energy) → only the single most-behind pillar,
 *     at recovery intensity;
 *   · an injury → 肉身 is deferred, the session shifts to 心志 + 学识;
 *   · a named focus → that pillar is drilled first, bumping a lower-priority one.
 * The routing decision is a PURE function (`planSession`) the preceptor calls; a
 * real preceptor LLM makes the same call from the same context.
 *
 * Deterministic, no API key (situation-aware preceptor provider + deterministic
 * pillar drills), but the FILE I/O is real: a real temp Codex per scenario with
 * codex/{body,mind,lore}.md.
 *
 * Run:  pnpm demo:battle-monk-training
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, InMemoryStorage } from '@gotong/core'
import { DispatchToolset, LlmAgent } from '@gotong/llm'

import {
  setupCodex,
  readPillar,
  priorSteps,
  appendEntry,
  PILLARS,
  PILLAR_TITLE,
  type Codex,
  type Pillar,
} from './codex.js'
import { BATTLE_PILLARS, PillarAgent } from './pillar-agent.js'
import { createPreceptorProvider } from './preceptor-provider.js'
import { INTENSITY_TAG, type DailySituation, type Intensity } from './situation.js'

const PRECEPTOR_SYSTEM =
  '你是战斗修士会的督修。语气冷峻、简短、不留情面,不安慰、不寒暄。' +
  '先读修士今日状态(时间 / 精力 / 伤病 / 专攻)与档案进度,再决定今日操练哪几柱——' +
  '不要不顾状态把三柱全压上。时间紧或状态低,只取最落后一柱;伤病则停肉身,转练他柱;' +
  '点名专攻,则那一柱优先。让档案承载记录。'

interface Scenario {
  label: string
  note: string
  situation: DailySituation
  /** Extra ranked entries to pre-seed (to make "most-behind" routing observable). */
  seed?: Partial<Record<Pillar, number>>
  /** The pillars we assert got a NEW entry this session (the dispatched SET). */
  expectDrilled: Pillar[]
  /** The intensity we assert each new entry was tagged with. */
  expectIntensity: Intensity
}

const SCENARIOS: Scenario[] = [
  {
    label: '[A] 满日 — 时间足、状态高',
    note: '60 分钟 / 精力高 → 三柱全开,满负荷',
    situation: { minutes: 60, energy: 'high' },
    expectDrilled: ['body', 'mind', 'lore'],
    expectIntensity: 'max',
  },
  {
    label: '[B] 瘦日 — 时间紧、状态低',
    note: '15 分钟 / 精力低 → 只攻最落后一柱(学识),轻负荷恢复',
    situation: { minutes: 15, energy: 'low' },
    // 肉身 / 心志 已领先 → 学识唯一最落后,印证「资源稀缺,先补最落后」。
    seed: { body: 2, mind: 2 },
    expectDrilled: ['lore'],
    expectIntensity: 'recovery',
  },
  {
    label: '[C] 伤病 — 扭伤脚踝',
    note: '45 分钟 / 精力常 / 伤 → 停肉身,转练心志 + 学识',
    situation: { minutes: 45, energy: 'normal', ailment: '扭伤脚踝' },
    expectDrilled: ['mind', 'lore'],
    expectIntensity: 'standard',
  },
  {
    label: '[D] 专攻 — 点名学识',
    note: '40 分钟 / 精力常 / 专攻学识 → 学识优先,挤掉次要(心志顺延)',
    situation: { minutes: 40, energy: 'normal', focus: 'lore' },
    // capacity=2:专攻把学识提到首位 → 学识 + (其余最落后)肉身;心志被挤出。
    expectDrilled: ['lore', 'body'],
    expectIntensity: 'standard',
  },
]

async function main(): Promise<void> {
  console.log('\n=== Gotong case: battle-monk-training (战斗修士锻炼) ===')
  console.log('  督修按修士「今日状态」分派能力 —— 不再不顾状况三柱全压。\n')

  for (const s of SCENARIOS) await runScenario(s)

  section('done')
  console.log('  四种状态,四种分派:满日全开 / 瘦日只补最落后 / 伤病停肉身 / 专攻优先。')
  console.log('  能力分派结合了使用者的情况,而非盲目扇出。\n')
  process.exit(0)
}

async function runScenario(s: Scenario): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gotong-battle-monk-'))
  const kb = setupCodex(dir)
  for (const p of PILLARS) seed(kb, p, s.seed?.[p] ?? 0)

  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()
  for (const spec of BATTLE_PILLARS) hub.register(new PillarAgent(kb, spec))
  const preceptorId = 'preceptor'
  hub.register(
    new LlmAgent({
      id: preceptorId,
      capabilities: ['route'],
      provider: createPreceptorProvider(),
      system: PRECEPTOR_SYSTEM,
      tools: DispatchToolset.create({
        hub,
        selfId: preceptorId,
        allowedAgents: BATTLE_PILLARS.map((spec) => spec.id),
      }),
    }),
  )

  try {
    section(s.label)
    console.log(`  ${s.note}`)

    // The preceptor reads the situation + the Codex ranks from its prompt (a real
    // one would read the trainee's message + the Codex via mcp-obsidian).
    const before = snapshot(kb)
    const ranks = Object.fromEntries(PILLARS.map((p) => [p, before[p]]))
    const prompt =
      '今日操练。\n' +
      `今日状态: ${JSON.stringify(s.situation)}\n` +
      `档案进度: ${JSON.stringify(ranks)}`

    const result = await hub.dispatch({
      from: 'human',
      strategy: { kind: 'capability', capabilities: ['route'] },
      payload: { prompt },
      title: s.label,
    })
    if (result.kind !== 'ok') throw new Error(`[${s.label}] preceptor failed: ${JSON.stringify(result)}`)
    const after = snapshot(kb)
    const drilled = PILLARS.filter((p) => after[p] > before[p])

    console.log(`\n  督修: ${(result.output as { text?: string }).text ?? '(no text)'}`)
    console.log(`  分派: ${drilled.map((p) => PILLAR_TITLE[p]).join('、') || '无'}`)
    for (const p of drilled) {
      console.log(`    codex/${p}.md ◂ ${lastEntry(kb, p)}`)
    }

    // Self-assert (doubles as a smoke test): the dispatched SET equals what the
    // situation should produce — proof the routing fitted the trainee's state,
    // not a blind fan-out. (A pillar that wrongly drilled, or wrongly didn't,
    // changes the set and trips this.)
    const expected = [...s.expectDrilled].sort().join(',')
    const got = [...drilled].sort().join(',')
    if (got !== expected) {
      throw new Error(`[${s.label}] expected drilled {${expected}}, got {${got}}`)
    }
    // And each new entry carries the expected intensity tag (situation → load).
    const tag = INTENSITY_TAG[s.expectIntensity]
    for (const p of drilled) {
      if (!lastEntry(kb, p).includes(tag)) {
        throw new Error(`[${s.label}] pillar ${p} entry missing intensity tag 「${tag}」`)
      }
    }
  } finally {
    await hub.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Pre-add `extra` ranked entries to a pillar (counts toward priorSteps/rank). */
function seed(kb: Codex, pillar: Pillar, extra: number): void {
  for (let i = 1; i <= extra; i++) appendEntry(kb, pillar, `- [第${i}阶·种子] 预置历史`)
}

function snapshot(kb: Codex): Record<Pillar, number> {
  return Object.fromEntries(PILLARS.map((p) => [p, priorSteps(kb, p)])) as Record<Pillar, number>
}

function lastEntry(kb: Codex, p: Pillar): string {
  const lines = readPillar(kb, p).trimEnd().split('\n')
  return lines[lines.length - 1] ?? ''
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main().catch((err) => {
  console.error('[battle-monk-training] fatal:', err)
  process.exit(1)
})
