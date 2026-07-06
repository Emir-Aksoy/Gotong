/**
 * butler-onboarding-e2e — CARE-M4 验收门(计划原文的四条,全零 LLM 判卷:
 * 断言的是**注入进 prompt / 工具结果里的内容**,不是模型嘴里说了什么):
 *
 *   ① 空配置 hub 首聊:mock provider 收到的 system prompt 含现状卡字段
 *     (卡在 persona 之后 —— 尾部注入,不碰冻结块缓存前缀);
 *   ② 补齐配置后再聊:一字不注入 + gaps_cleared 自动持久化,且之后的
 *     回合止步于 state 读(不再体检);
 *   ③ 用户说「不用了」:set_onboarding_done 落盘 declined,缺口还在也
 *     永不再注入;
 *   ④ 粘了坏 key 做活体校验:check_llm_key 的 tool_result 里出现
 *     CARE-M1 翻译文案(401 → 「认证失败」),不是裸错误。
 *
 * 真 PersonalButlerAgent + 真 Hub + 真探针/状态文件;假的只有 LLM(脚本化
 * provider,同时是捕获器)和体检面(可变快照)。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, Space, type Logger } from '@gotong/core'
import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@gotong/llm'
import { PersonalButlerAgent } from '@gotong/personal-butler'

import type { AdminHealthSurface, HealthSnapshot } from '../src/admin-health.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import {
  buildButlerOnboardingProbe,
  buildButlerOnboardingToolset,
  type ButlerOnboardingKeyCheck,
} from '../src/personal-butler-onboarding.js'

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silentLogger
  },
}

const USER = 'u-1'

function snap(o: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    agents: [],
    agentsMissingKey: 0,
    managedCount: 1,
    onlineCount: 1,
    mcpServers: [],
    mcpUnwired: 0,
    spaceWritable: true,
    spacePath: '/tmp/x',
    checkedAt: '2026-07-06T00:00:00.000Z',
    ...o,
  }
}

/** 三缺口全开的空配置 hub 体检。 */
const GAPPY = snap({ managedCount: 1, agentsMissingKey: 1, imBridges: [], workflowCount: 0 })
/** 配齐后的体检。 */
const GREEN = snap({
  managedCount: 1,
  agentsMissingKey: 0,
  imBridges: [{ platform: 'telegram' }],
  workflowCount: 2,
})

type ProviderMode = 'plain' | 'decline' | 'check'

/** 捕获器 + 脚本化 LLM:记录每个请求;按 mode 在首轮发一次工具调用。 */
class OnboardingProvider implements LlmProvider {
  readonly name = 'onboarding-e2e'
  readonly requests: LlmRequest[] = []
  constructor(private readonly mode: ProviderMode = 'plain') {}
  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(req)
    const last = req.messages[req.messages.length - 1]
    const content = last?.content
    const sawToolResult =
      Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')
    if (sawToolResult) {
      yield { type: 'text', text: '好的。' }
      yield { type: 'end', stopReason: 'end_turn' }
      return
    }
    if (this.mode === 'decline') {
      yield {
        type: 'tool_use',
        toolUse: { type: 'tool_use', id: 'd1', name: 'set_onboarding_done', input: {} },
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }
    if (this.mode === 'check') {
      yield {
        type: 'tool_use',
        toolUse: { type: 'tool_use', id: 'c1', name: 'check_llm_key', input: {} },
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }
    yield { type: 'text', text: '你好!' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

interface Rig {
  root: string
  hub: Hub
  stateFile: string
  holder: { snap: HealthSnapshot }
  snapshotCalls: { n: number }
}

describe('CARE-M4 — 开箱陪跑验收(注入内容断言,零 LLM 判卷)', () => {
  let r: Rig
  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'gotong-onb-e2e-'))
    const { space } = await Space.init(root, { name: 'onb-e2e' })
    const hub = new Hub({ space })
    await hub.start()
    r = {
      root,
      hub,
      stateFile: join(root, 'butler', 'onboarding-state.json'),
      holder: { snap: GAPPY },
      snapshotCalls: { n: 0 },
    }
  })
  afterEach(async () => {
    await r.hub.stop().catch(() => {})
    await rm(r.root, { recursive: true, force: true })
  })

  function healthSurface(): AdminHealthSurface {
    return {
      snapshot: async () => {
        r.snapshotCalls.n++
        return r.holder.snap
      },
    }
  }

  function butlerFor(
    id: string,
    mode: ProviderMode,
    keyCheck?: ButlerOnboardingKeyCheck,
  ): { butler: PersonalButlerAgent; provider: OnboardingProvider } {
    const provider = new OnboardingProvider(mode)
    const butler = new PersonalButlerAgent({
      id,
      provider,
      memory: openButlerMemory({ rootDir: join(r.root, 'mem'), userId: USER, logger: silentLogger }),
      system: '你是用户的私人管家。',
      benign: [
        buildButlerOnboardingToolset({
          stateFile: r.stateFile,
          keyCheck: () => keyCheck,
          lang: 'zh',
        }),
      ],
      contextProbe: buildButlerOnboardingProbe({
        stateFile: r.stateFile,
        health: healthSurface,
      }),
      maxToolRounds: 4,
    })
    r.hub.register(butler)
    return { butler, provider }
  }

  async function chat(to: string, text: string): Promise<void> {
    await r.hub.dispatch({ from: `user:${USER}`, strategy: { kind: 'explicit', to }, payload: text })
  }

  it('① 空配置首聊:system prompt 尾部出现现状卡(字段齐全,persona 在前)', async () => {
    const { provider } = butlerFor('butler:a', 'plain')
    await chat('butler:a', '你好')
    expect(provider.requests.length).toBeGreaterThan(0)
    const sys = provider.requests[0]!.system ?? ''
    expect(sys).toContain('【现状卡 · 开箱陪跑】')
    expect(sys).toContain('LLM key:0/1')
    expect(sys).toContain('IM 通道')
    expect(sys).toContain('工作流模板')
    expect(sys).toContain('check_llm_key')
    expect(sys).toContain('set_onboarding_done')
    // 尾部注入:persona 领跑,卡收尾 —— 冻结块 + persona 的缓存前缀不被打散。
    expect(sys.indexOf('你是用户的私人管家。')).toBeGreaterThanOrEqual(0)
    expect(sys.indexOf('你是用户的私人管家。')).toBeLessThan(sys.indexOf('【现状卡'))
  })

  it('② 补齐配置后再聊:一字不注入 + gaps_cleared 落盘 + 之后止步于 state 读', async () => {
    const { provider } = butlerFor('butler:b', 'plain')
    await chat('butler:b', '第一句') // 缺口在 → 注卡
    expect(provider.requests[0]!.system ?? '').toContain('【现状卡')

    r.holder.snap = GREEN
    await chat('butler:b', '第二句') // 缺口清零 → 不注 + 自动写完成态
    expect(provider.requests[1]!.system ?? '').not.toContain('【现状卡')
    const state = JSON.parse(await readFile(r.stateFile, 'utf8')) as { done: boolean; reason: string }
    expect(state).toMatchObject({ done: true, reason: 'gaps_cleared' })

    const before = r.snapshotCalls.n
    await chat('butler:b', '第三句') // 完成态 → 连体检都不再做
    expect(provider.requests[2]!.system ?? '').not.toContain('【现状卡')
    expect(r.snapshotCalls.n).toBe(before)
  })

  it('③「不用了」:declined 落盘;缺口还在也不再注入', async () => {
    const { provider } = butlerFor('butler:c', 'decline')
    await chat('butler:c', '不用了,配置的事别再提了')
    const state = JSON.parse(await readFile(r.stateFile, 'utf8')) as { done: boolean; reason: string }
    expect(state).toMatchObject({ done: true, reason: 'declined' })

    // 缺口依旧(holder 仍是 GAPPY),但下一回合一字不注入。
    await chat('butler:c', '随便聊聊')
    const lastReq = provider.requests[provider.requests.length - 1]!
    expect(lastReq.system ?? '').not.toContain('【现状卡')
  })

  it('④ 坏 key 活体校验:tool_result 出现 CARE-M1 翻译文案(认证失败)', async () => {
    const failCheck: ButlerOnboardingKeyCheck = async () => ({
      status: 'fail',
      agentId: 'helper',
      provider: 'deepseek',
      error: { status: 401, message: 'Invalid API key' },
    })
    const { provider } = butlerFor('butler:d', 'check', failCheck)
    await chat('butler:d', '我粘好 key 了,帮我看看能不能用')
    // 第二个请求是 tool_result 回填后的续轮 —— 断言工具结果内容(注入面),
    // 而不是模型的最终答复。
    const followUp = provider.requests.find((req) =>
      req.messages.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((b) => (b as { type?: string }).type === 'tool_result'),
      ),
    )
    expect(followUp).toBeDefined()
    const toolResults: string[] = []
    for (const m of followUp!.messages) {
      if (!Array.isArray(m.content)) continue
      for (const b of m.content) {
        const block = b as { type?: string; content?: unknown }
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          toolResults.push(block.content)
        }
      }
    }
    const joined = toolResults.join('\n')
    expect(joined).toContain('❌')
    expect(joined).toContain('认证失败')
    expect(joined).toContain('修复:')
  })
})
