/**
 * CARE-M4 — 开箱陪跑 (onboarding companion), the CARE capstone.
 *
 * A fresh hub's first chat usually happens BEFORE anything is configured — no
 * LLM key, no IM channel, no installed template. The butler is exactly the
 * right guide, but it can't guide what it can't see. This module makes the
 * decision to inject guidance a **zero-LLM structural derivation** at the
 * free-chat entry:
 *
 *   admin-health snapshot → key gaps? AND onboarding-state not done?
 *     → inject a 现状卡 (health-subset serialization) + the companion script
 *     → otherwise inject NOTHING (一字不注入)
 *
 * Honesty rules inherited from admin-health (FDE-M1b ladder): an ABSENT
 * optional field (`imBridges` / `workflowCount`) means the host didn't wire
 * that subsystem — that is "unknown", never a gap. Only a wired-and-empty
 * signal counts. The card therefore can't nag about things the host can't
 * even see.
 *
 * Completion is a one-way file (`butler/onboarding-state.json`): gaps cleared
 * (auto-detected, written by the probe) or the user says 不用了 (the
 * `set_onboarding_done` tool). Either way the probe short-circuits on the
 * state file forever after. Corrupt state reads as "not done" (宁重不漏 —
 * same posture as patrol-state): worst case the card shows once more; if the
 * gaps are really gone the probe immediately re-writes the completion.
 *
 * The 活体校验 (`check_llm_key`) is the read-only models-list probe — RES
 * 只读探测姿态: proves reachability + auth without generating a token. Its
 * failures speak through the CARE-M1 failure translator, not a second copy
 * table.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'

import type { AdminHealthSurface, HealthSnapshot } from './admin-health.js'
import { translateLlmFailure, type FailureLang } from './failure-translator.js'
import { probeLlmModels, type LlmModelsProbeResult } from './llm-models-probe.js'

// ---------------------------------------------------------------------------
// Gap derivation — pure, zero-LLM.
// ---------------------------------------------------------------------------

export interface OnboardingGaps {
  /** No managed LLM agent has a resolvable key (or there are none at all). */
  noLlmKey: boolean
  /** IM subsystem wired but zero live bridges. Absent field ⇒ NOT a gap. */
  noIm: boolean
  /** Workflow counting wired but zero workflows. Absent field ⇒ NOT a gap. */
  noTemplates: boolean
  any: boolean
}

export function deriveOnboardingGaps(s: HealthSnapshot): OnboardingGaps {
  // Key gap = the hub cannot run a single real LLM turn: no managed rows, or
  // every managed row's key fails to resolve. (missingKey is fail-open, so a
  // probe fault reads as "fine" — advisory posture, never a false alarm.)
  const noLlmKey = s.managedCount === 0 || s.agentsMissingKey >= s.managedCount
  const noIm = s.imBridges !== undefined && s.imBridges.length === 0
  const noTemplates = s.workflowCount !== undefined && s.workflowCount === 0
  return { noLlmKey, noIm, noTemplates, any: noLlmKey || noIm || noTemplates }
}

// ---------------------------------------------------------------------------
// The 现状卡 — serialized health subset + companion script.
// ---------------------------------------------------------------------------

/**
 * Render the injected card. Lists ONLY the gaps that are actually present and
 * numbers the script steps to match — the model never sees an instruction
 * about a subsystem that is fine (or unknown). Recommended order: key first
 * (nothing works without it), then IM, then the first template.
 */
export function buildOnboardingCard(gaps: OnboardingGaps, s: HealthSnapshot): string {
  const gapLines: string[] = []
  if (gaps.noLlmKey) {
    gapLines.push(
      `- LLM key:${s.managedCount - s.agentsMissingKey}/${s.managedCount} 个托管 agent 有可用 key —— 配好之前 agent 没法真正干活`,
    )
  }
  if (gaps.noIm) gapLines.push('- IM 通道:一条都没接 —— 用户现在只能在网页里跟你说话')
  if (gaps.noTemplates) gapLines.push('- 工作流模板:0 个 —— 还没装任何现成方案')

  const steps: string[] = []
  if (gaps.noLlmKey) {
    steps.push(
      '带用户配 LLM key:去管理页 Agents 卡选供应商、粘贴 key;粘完立刻用 check_llm_key 工具做只读活体校验(拉模型列表,不生成内容、不花 token),把结果口语化转告用户。',
    )
  }
  if (gaps.noIm) {
    steps.push('带用户接 IM 通道:管理页「设置 → IM 通道」贴机器人 token(Telegram 通常最快)。')
  }
  if (gaps.noTemplates) {
    steps.push('带用户装首个模板:推荐「模板画廊」里的「我的晨报」,装完带用户跑一次看到结果。')
  }

  return [
    '【现状卡 · 开箱陪跑】(hub 体检的系统注入,不是用户说的话)',
    'hub 当前的关键缺口:',
    ...gapLines,
    '',
    '你的陪跑任务(先问用户想不想让你带着配;愿意就逐关引导,一次只推进一关):',
    ...steps.map((t, i) => `${i + 1}. ${t}`),
    '规则:',
    '- 用户表示不需要/别再提 → 调 set_onboarding_done 工具记下来,这张卡以后不再出现。',
    '- 缺口全部补齐后系统会自动停止注入,不用你做任何事。',
    '- 不要把本卡内容说成是用户提供的信息。',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Completion state — `butler/onboarding-state.json`, hub-level intent.
// ---------------------------------------------------------------------------

export interface OnboardingState {
  done: boolean
  reason: 'gaps_cleared' | 'declined'
  at: string
}

/** Missing / corrupt / wrong-shape all read as "not done" (宁重不漏). */
export async function readOnboardingState(file: string): Promise<OnboardingState | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    const v = JSON.parse(raw) as Partial<OnboardingState> | null
    if (
      v &&
      typeof v === 'object' &&
      v.done === true &&
      (v.reason === 'gaps_cleared' || v.reason === 'declined')
    ) {
      return { done: true, reason: v.reason, at: typeof v.at === 'string' ? v.at : '' }
    }
    return null
  } catch {
    return null
  }
}

export async function writeOnboardingState(file: string, state: OnboardingState): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

// ---------------------------------------------------------------------------
// The context probe — wired into `PersonalButlerAgent({ contextProbe })`.
// ---------------------------------------------------------------------------

export interface ButlerOnboardingProbeDeps {
  stateFile: string
  /** LAZY health surface (main.ts builds adminHealth after the factory). */
  health: () => AdminHealthSurface | undefined
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }
  /** Injectable clock (tests). */
  now?: () => number
}

/**
 * Build the per-turn probe. Ordering is cheapest-first: one small state-file
 * read short-circuits every turn after completion; the health snapshot (still
 * pure static checks) only runs while onboarding is live. Every failure path
 * returns null — the companion must never take normal chat down with it.
 */
export function buildButlerOnboardingProbe(
  deps: ButlerOnboardingProbeDeps,
): () => Promise<string | null> {
  const now = deps.now ?? Date.now
  return async () => {
    const state = await readOnboardingState(deps.stateFile)
    if (state?.done) return null
    const health = deps.health()
    if (!health) return null // no health surface wired — can't judge, don't nag
    let snap: HealthSnapshot
    try {
      snap = await health.snapshot()
    } catch (err) {
      deps.logger?.warn('butler onboarding: health snapshot failed — skipping injection', { err })
      return null
    }
    const gaps = deriveOnboardingGaps(snap)
    if (!gaps.any) {
      // Gaps cleared — persist completion so every later turn stops at the
      // state read. A write failure just retries next turn; either way THIS
      // turn injects nothing (the gaps really are gone).
      try {
        await writeOnboardingState(deps.stateFile, {
          done: true,
          reason: 'gaps_cleared',
          at: new Date(now()).toISOString(),
        })
      } catch (err) {
        deps.logger?.warn('butler onboarding: state write failed — will retry next turn', { err })
      }
      return null
    }
    return buildOnboardingCard(gaps, snap)
  }
}

// ---------------------------------------------------------------------------
// 活体校验 — the key-check closure (pool target → read-only models probe).
// ---------------------------------------------------------------------------

/** Structural mirror of `LocalAgentPool.resolveLlmProbeTarget`'s result. */
export type OnboardingProbeTarget =
  | { status: 'ok'; agentId: string; provider: string; apiKey: string; baseURL?: string }
  | { status: 'mock'; agentId: string }
  | { status: 'no_key'; agentId: string; provider: string }
  | { status: 'no_agent' }

export type OnboardingKeyCheckOutcome =
  | { status: 'ok'; agentId: string; provider: string; modelCount?: number; latencyMs: number }
  | { status: 'fail'; agentId: string; provider: string; error: unknown }
  | { status: 'mock'; agentId: string }
  | { status: 'no_key'; agentId: string; provider: string }
  | { status: 'no_agent' }

export type ButlerOnboardingKeyCheck = (agentId?: string) => Promise<OnboardingKeyCheckOutcome>

export function buildOnboardingKeyCheck(deps: {
  resolveTarget: (agentId?: string) => Promise<OnboardingProbeTarget>
  /** Injectable probe (tests). Default: the real read-only models-list GET. */
  probe?: (input: {
    provider: string
    apiKey: string
    baseURL?: string
  }) => Promise<LlmModelsProbeResult>
}): ButlerOnboardingKeyCheck {
  const probe = deps.probe ?? probeLlmModels
  return async (agentId) => {
    let target: OnboardingProbeTarget
    try {
      target = await deps.resolveTarget(agentId)
    } catch {
      return { status: 'no_agent' }
    }
    if (target.status !== 'ok') return target
    const res = await probe({
      provider: target.provider,
      apiKey: target.apiKey,
      ...(target.baseURL ? { baseURL: target.baseURL } : {}),
    })
    if (res.ok) {
      return {
        status: 'ok',
        agentId: target.agentId,
        provider: target.provider,
        ...(res.modelCount !== undefined ? { modelCount: res.modelCount } : {}),
        latencyMs: res.latencyMs,
      }
    }
    return { status: 'fail', agentId: target.agentId, provider: target.provider, error: res.error }
  }
}

// ---------------------------------------------------------------------------
// The benign toolset — `set_onboarding_done` + `check_llm_key`.
// ---------------------------------------------------------------------------

export interface ButlerOnboardingToolDeps {
  stateFile: string
  /**
   * The 活体校验 closure. LAZY getter: main.ts can only bind it after the
   * agent pool starts, while the toolset is built at butler-create time —
   * an unbound getter answers honestly instead of crashing the tool.
   */
  keyCheck: () => ButlerOnboardingKeyCheck | undefined
  /** CARE-M1 translator language (the host's resolved default lang). */
  lang: FailureLang
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void }
  /** Injectable clock (tests). */
  now?: () => number
}

const DONE_TOOL: LlmToolDefinition = {
  name: 'set_onboarding_done',
  description:
    '用户明确表示不需要配置陪跑(「不用了」「别再提了」之类)时调用。记下这个选择后,系统不再往对话里注入配置现状卡。只在用户明确拒绝时用,不要自作主张。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

const CHECK_TOOL: LlmToolDefinition = {
  name: 'check_llm_key',
  description:
    '只读检查托管 agent 的 LLM key 是否真的可用:拉一次供应商的模型列表,不生成内容、不消耗 token。用户刚粘贴或更换 key 后,用它做活体校验并把结果口语化转告。',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: '要检查的 agent id;不填则检查默认那行(管家自己用的)。' },
    },
    additionalProperties: false,
  },
}

class ButlerOnboardingToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerOnboardingToolDeps) {}

  listTools(): LlmToolDefinition[] {
    return [DONE_TOOL, CHECK_TOOL]
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (name === 'set_onboarding_done') return this.setDone()
    if (name === 'check_llm_key') return this.checkKey(args)
    return text(`未知工具:${name}`, true)
  }

  private async setDone(): Promise<LlmToolCallResult> {
    const now = this.deps.now ?? Date.now
    try {
      await writeOnboardingState(this.deps.stateFile, {
        done: true,
        reason: 'declined',
        at: new Date(now()).toISOString(),
      })
    } catch (err) {
      this.deps.logger?.error('butler onboarding: set_onboarding_done write failed', { err })
      return text('没记上(写入失败),待会儿再试一次吧。', true)
    }
    return text('好,记下了:之后我不再主动提配置的事。想配的时候随时叫我。')
  }

  private async checkKey(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const keyCheck = this.deps.keyCheck()
    if (!keyCheck) return text('key 校验通道还没就绪(host 尚在启动),稍等片刻再试。', true)
    const agentId = typeof args.agentId === 'string' && args.agentId.trim() ? args.agentId.trim() : undefined
    const out = await keyCheck(agentId)
    switch (out.status) {
      case 'no_agent':
        return text('现在还没有任何托管 LLM agent——先去管理页 Agents 卡建一个,再回来校验 key。')
      case 'mock':
        return text(`「${out.agentId}」用的是 mock 供应商(演示模式),不需要 key,没什么可校验的。`)
      case 'no_key':
        return text(
          `「${out.agentId}」(供应商 ${out.provider})还没有能解析到的 key——先带用户把 key 粘上,再来做活体校验。`,
        )
      case 'ok': {
        const count = out.modelCount !== undefined ? `,能看到 ${out.modelCount} 个模型` : ''
        return text(
          `✅ key 有效:「${out.agentId}」(${out.provider})连通了${count}(耗时 ${out.latencyMs}ms)。这是只读检查,没有消耗 token。`,
        )
      }
      case 'fail': {
        // CARE-M1 translator — one copy table for every LLM failure surface.
        const t = translateLlmFailure(out.error, this.deps.lang)
        const detail = t.detail ? `\n原文摘要:${t.detail}` : ''
        return text(`❌ key 校验没过:${t.headline}\n修复:${t.fix}${detail}`, true)
      }
    }
  }
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] }
}

/** Build the benign onboarding toolset. Always offered while the butler is on
 *  (a key re-check stays useful long after onboarding completes); the CARD is
 *  what stops appearing once the state file says done. */
export function buildButlerOnboardingToolset(deps: ButlerOnboardingToolDeps): LlmAgentToolset {
  return new ButlerOnboardingToolset(deps)
}
