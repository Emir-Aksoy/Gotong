// 真实 DeepSeek API 端到端跑「传统行业咨询管线」+ 案主插话演示
//
// 这个 example 在 v2.3 升级版下做两件事：
//   1. 沿用 v2.2 测过的"完整 5 步咨询 + 真人 review"管线
//   2. 集成 v2.3 引入的 **case-conversation**：
//      - 每一步 agent 跑前自动 prepend case-memory 里的【对话历史】
//        和【已完成步骤产物】（host glue 用 case-context.ts helper 实现）
//      - 每一步跑完自动 record step output 到 case-memory
//      - 跑完 RUN 1 之后**模拟案主插话**：派一个 case-conversation 任务
//        给新引入的 case-manager agent，让它基于 RUN 1 的全部 case-memory
//        给出回应。这就证明了"workflow 之外的对话也能用上 case 全部历史"
//
// 关键设计：
//   - **caseId** 由调用方在 trigger payload 里显式提供（每次咨询独立）。
//     WorkflowRunner 在 dispatch 时把 `caseId: $trigger.payload.caseId`
//     透传给每个 step 的 payload，agent 从 task.payload.caseId 取到。
//   - **case-memory 是按 caseId 独立 attach 的**（owner =
//     `{kind:'workflow-run', id: caseId}`），三个 agent 共享同一个 case
//     的 memory 句柄。
//   - **agent-级 memory 仍然存在**（owner = `{kind:'agent', id:'industry-coach-pro'}`），
//     用来跨 case 持久"我做过 N 次咨询"信息（priorCount）。这两套机制
//     并行存在，互不冲突。
//
// 跑两次咨询（餐饮 / 零售）+ RUN 1 之后插一次 case-conversation。
// 预计 LLM 调用次数：5 + 1（插话）+ 5 = 11 次（含 finalize），约 USD
// $0.005-0.01，时间 100-150 秒。
//
// 跑前必须：
//   .env.local 在仓库根，内含 DEEPSEEK_API_KEY=sk-...
//   pnpm start 会用 tsx --env-file=../../.env.local，自动读取。

import { writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  Hub,
  HumanParticipant,
  Space,
  type Task,
  type TranscriptEntry,
} from '@aipehub/core'
import {
  bootstrapServices,
  recallCaseConversation,
  recallCaseStepOutputs,
  recordCaseConversation,
  recordCaseStepOutput,
  formatCaseContextBlock,
  type CaseContextBinding,
} from '@aipehub/host/services'
import { LlmAgent, type LlmAgentOptions } from '@aipehub/llm'
import { OpenAIProvider } from '@aipehub/llm-openai'
import type {
  ArtifactHandle,
  DatastoreHandle,
  MemoryHandle,
  ServiceCtx,
} from '@aipehub/services-sdk'
import { parseWorkflow, WorkflowRunner } from '@aipehub/workflow'

// ── 工作流定义（和 templates/workflows/industry-consultation-flow.yaml 同形状，
//    多了一个字段 `caseId` —— 案主插话要靠它定位 case-memory owner）
const WORKFLOW_YAML = `
schema: aipehub.workflow/v1
workflow:
  id: industry-consultation-flow
  name: 传统行业咨询
  trigger:
    capability: consult-industry-with-human
  steps:
    - id: intake
      dispatch:
        strategy: { kind: capability, capabilities: [intake-consultation] }
        title: 初访
        payload:
          caseId: $trigger.payload.caseId
          prompt: |
            [模式: intake]

            客户行业：$trigger.payload.industry
            客户角色：$trigger.payload.role
            客户自述：
            $trigger.payload.user_situation
    - id: research
      dispatch:
        strategy: { kind: capability, capabilities: [industry-research] }
        title: 行业研究
        payload:
          caseId: $trigger.payload.caseId
          prompt: |
            行业：$trigger.payload.industry
            初访问题清单：
            $intake.output
    - id: draft
      dispatch:
        strategy: { kind: capability, capabilities: [draft-consultation] }
        title: 草稿
        payload:
          caseId: $trigger.payload.caseId
          prompt: |
            [模式: draft]

            客户行业：$trigger.payload.industry
            客户自述：
            $trigger.payload.user_situation
            初访问题清单：
            $intake.output
            行业研究：
            $research.output
    - id: human-review
      dispatch:
        strategy: { kind: capability, capabilities: [consultant-review] }
        title: 顾问审稿
        payload:
          caseId: $trigger.payload.caseId
          industry: $trigger.payload.industry
          draft_report: $draft.output
    - id: finalize
      dispatch:
        strategy: { kind: capability, capabilities: [finalize-consultation] }
        title: 终稿
        payload:
          caseId: $trigger.payload.caseId
          prompt: |
            [模式: finalize]

            客户行业：$trigger.payload.industry
            草稿：
            $draft.output

            [reviewer 反馈]
            $human-review.output
  output:
    intake: $intake.output
    research: $research.output
    draft: $draft.output
    human_review: $human-review.output
    final: $finalize.output
`

// ── 给三个 agent 用的 system prompt（精简版，跟模板对齐）
const COACH_SYSTEM = `你是「行业陪练教练」，帮传统行业老板做 AI 转型咨询。

根据 user 消息开头的 [模式: intake/draft/finalize] 标记切换格式：

- [模式: intake]：用 4-7 个具体问题反问客户，把业务摸清。
  输出格式：
    ## 我想先了解几件事
    1. ...
    2. ...
- [模式: draft]：综合素材出方案草稿。
  输出格式：标题 + 客户画像 + 痛点 + AI 切入建议（速赢/中期/战略）+ 风险
- [模式: finalize]：吸收 reviewer 反馈出终稿。
  输出格式：终稿 + 执行摘要 + 30 天路线图 + KPI

宿主胶水**可能**在你的 user prompt 头部预填一段
\`## 当前 case 的已有上下文（请在回答时考虑）\` 段落，里面有【对话
历史】（含案主在 workflow 中途的插话）+【已完成步骤产物】。出现时：
  - 引用对话历史里案主**新补充的事实**到你输出中（不要重复原文）
  - 优先呼应案主插话提出的新议题

通用约束：中文，简洁，不卖弄。不造行业数据。控制在 600 字以内。`

const RESEARCH_SYSTEM = `你是「行业研究分析师」。每次任务收到一段客户初访信息，输出：

## 对标案例
（如有数据就列 3-5 个；本次默认 datastore 为空，写"（无）"）

## 关键洞察（3-5 条）
基于通识对该行业的判断。

## 给 coach 的 3 个提醒
具体到行业土壤问题。

宿主胶水可能预填 \`## 当前 case 的已有上下文\` 段——里面【对话历史】
若包含案主插话补充的事实，要把它纳入"关键洞察"和"3 个提醒"。

中文，不超过 400 字。`

const CASE_MANAGER_SYSTEM = `你是「案主任务管家」。case 主路径有 5 步
（intake → research → draft → human-review → finalize），由其他 agent
完成。**你的活**：在主路径之外接收案主的插话提问 / 补充事实 / 重写请求，
基于 case-memory 里已有上下文给出简短回应 + 路由建议。

宿主胶水会在你的 user prompt 头部预填
\`## 当前 case 的已有上下文（请在回答时考虑）\`，里面【对话历史】+
【已完成步骤产物】是这个 case 走到现在为止发生的全部事情。**你必须
读懂它再答**，不要重新问案主"目前进展如何"——上下文里已经有了。

输出严格三段（每段标题用 ## 开头）：

## 回应
给案主看的简短中文回复，控制在 200 字以内。不抄写历史原文，引用 1-2 句即可。

## 我的判断
一句话写"我把这条请求理解成 X"。

## 路由建议
单行输出，三选一：
- \`[路由建议: 自己已回答，无需派发]\`
- \`[路由建议: dispatch capability=<能力名> 给 <agent 角色>]\`
- \`[路由建议: 需要案主补充信息，请等待回复]\`

判断准则：
1. 元数据查询 / 流程状态 → 自己答，不派发
2. 案主补充新事实 → 一句话确认收到，不派发（事实已入 memory）
3. 行业 benchmark 问题 → 建议 dispatch industry-research
4. 想重写 / 加段草稿 → 建议 dispatch draft-consultation
5. 模棱两可时偏向"不派发"（派发=贵）

硬约束：中文，称"您"，不造数据，不给方案细节（那是 coach 的活）。`

const log = (...args: unknown[]): void => {
  const ts = new Date().toISOString().slice(11, 23)
  // eslint-disable-next-line no-console
  console.log(`[${ts}]`, ...args)
}

const banner = (text: string): void => {
  const line = '─'.repeat(78)
  log('')
  log(line)
  log('━━', text)
  log(line)
}

// ── case-memory factory: 每个 caseId 第一次出现时 lazy-attach 一个 memory
//    handle，owner={kind:'workflow-run', id:caseId}。三个 agent 共享同一
//    个 handle，所以 coach 写的对话 / step 产物，case-manager 立刻看见。
type CaseMemoryFor = (caseId: string) => Promise<MemoryHandle>

// ── 通用 host glue: 跑前 prepend ctx，跑后 record step output
async function withCaseContext<T>(opts: {
  task: Task
  caseMemoryFor: CaseMemoryFor
  stepLabel: string
  rawPrompt: string
  /** 跑 LLM 用拼好的 prompt；返回 LLM 输出文本 */
  callLlm: (promptWithContext: string) => Promise<{ text: string; extra?: T }>
  /** 默认 true: 写回 step output 到 case-memory */
  recordOutput?: boolean
  /** 默认 'system'：写回对话历史时的 source 名（用于 case-manager 的回应） */
  recordAsConversation?: 'user' | 'manager' | 'coach' | 'analyst' | 'reviewer' | 'system' | null
}): Promise<{ text: string; binding: CaseContextBinding; extra?: T }> {
  const caseId = (opts.task.payload as { caseId?: string } | undefined)?.caseId ?? 'unknown-case'
  const memory = await opts.caseMemoryFor(caseId)
  const binding: CaseContextBinding = { caseId, memory }

  const [conversation, stepOutputs] = await Promise.all([
    recallCaseConversation(binding),
    recallCaseStepOutputs(binding),
  ])
  const ctxBlock = formatCaseContextBlock({ conversation, stepOutputs })

  const fullPrompt = ctxBlock ? `${ctxBlock}\n---\n\n${opts.rawPrompt}` : opts.rawPrompt
  log(`[${opts.stepLabel}] case=${caseId.slice(0, 18)} convo=${conversation.length} stepOuts=${stepOutputs.length}`)

  const { text, extra } = await opts.callLlm(fullPrompt)

  // 默认 record this step's output（按 stepId = stepLabel）
  if (opts.recordOutput !== false) {
    await recordCaseStepOutput(binding, { stepId: opts.stepLabel, text })
  }
  // 可选 record 为对话历史
  if (opts.recordAsConversation) {
    await recordCaseConversation(binding, {
      source: opts.recordAsConversation,
      text,
      stepId: opts.stepLabel,
    })
  }

  return { text, binding, ...(extra !== undefined ? { extra } : {}) }
}

// ── 教练 agent —— 多 phase + agent-级 memory + case-级 memory
class CoachAgent extends LlmAgent {
  private readonly caseMemoryFor: CaseMemoryFor

  constructor(opts: LlmAgentOptions & { caseMemoryFor: CaseMemoryFor }) {
    super(opts)
    this.caseMemoryFor = opts.caseMemoryFor
  }

  protected override async handleTask(task: Task): Promise<unknown> {
    const memory = this.services.memory  // agent-级 memory (跨 case)
    const artifact = this.services.artifact
    const datastoreSessions = this.services.datastore?.sessions

    const payload = task.payload as { prompt?: string; caseId?: string } | undefined
    const promptText = payload?.prompt ?? ''
    const phase: 'intake' | 'draft' | 'finalize' | 'unknown' = promptText.includes('[模式: intake]')
      ? 'intake'
      : promptText.includes('[模式: draft]')
        ? 'draft'
        : promptText.includes('[模式: finalize]')
          ? 'finalize'
          : 'unknown'

    const industryMatch = promptText.match(/客户行业：([^\n]+)/)
    const industry = industryMatch?.[1]?.trim() ?? 'unknown'

    // agent-级 memory recall (cross-case priorCount)
    let priorCount = 0
    let promptWithPrior = promptText
    if (phase === 'intake' && memory) {
      const past = await memory.recall({})
      priorCount = past.length
      promptWithPrior = `[prior_sessions=${priorCount}]\n${promptText}`
    }

    banner(`[coach] phase=${phase} industry=${industry} priorCount=${priorCount}`)

    const stepLabel = phase === 'unknown' ? 'coach' : phase
    const { text, binding } = await withCaseContext({
      task,
      caseMemoryFor: this.caseMemoryFor,
      stepLabel,
      rawPrompt: promptWithPrior,
      // 也把 coach 的产物以"conversation"形式写一份，case-manager 能感知
      recordAsConversation: 'coach',
      callLlm: async (fullPrompt) => {
        log('── prompt to LLM (head 600 chars) ──')
        log(fullPrompt.slice(0, 600) + (fullPrompt.length > 600 ? '\n  ...[truncated]' : ''))
        const t0 = Date.now()
        const req = this.buildRequest({ ...task, payload: { prompt: fullPrompt } } as Task)
        const res = await this.provider.complete(req)
        const elapsed = Date.now() - t0
        const out = this.parseResponse(res, task)
        const t = (out as { text: string }).text
        log(`── DeepSeek replied in ${elapsed}ms, tokens in=${res.usage?.inputTokens ?? '?'} out=${res.usage?.outputTokens ?? '?'} stop=${res.stopReason} ──`)
        log('── output (full) ──')
        log(t)
        return { text: t, extra: { elapsed } as const }
      },
    })

    // 阶段性的 agent-级 memory 写入（跨 case）+ artifact / datastore
    if (phase === 'intake' && memory) {
      await memory.remember({
        kind: 'episodic',
        text: `intake industry=${industry} task=${task.id.slice(0, 8)} preview=${text.slice(0, 80)}`,
      })
      log(`[coach] memory.remember (agent-level): "intake industry=${industry}"`)
    } else if (phase === 'finalize') {
      if (artifact) {
        const safe = industry.replace(/[^\w一-鿿-]/g, '_')
        const fileName = `reports/${safe}-${task.id.slice(0, 8)}.md`
        await artifact.write(fileName, text)
        log(`[coach] artifact.write "${fileName}" (${text.length} chars)`)
      }
      if (datastoreSessions) {
        await datastoreSessions.sql.exec(
          'INSERT INTO sessions (id, client_industry, recorded_at, outcome) VALUES (?, ?, ?, ?)',
          [task.id, industry, Date.now(), 'completed'],
        )
        log(`[coach] datastore.sessions INSERT industry=${industry} outcome=completed`)
      }
      if (memory) {
        await memory.remember({
          kind: 'episodic',
          text: `finalize industry=${industry} task=${task.id.slice(0, 8)}`,
        })
        log(`[coach] memory.remember (agent-level): "finalize industry=${industry}"`)
      }
    }

    return { text, phase, industry, priorCount, caseId: binding.caseId }
  }
}

class ResearchAgent extends LlmAgent {
  private readonly caseMemoryFor: CaseMemoryFor

  constructor(opts: LlmAgentOptions & { caseMemoryFor: CaseMemoryFor }) {
    super(opts)
    this.caseMemoryFor = opts.caseMemoryFor
  }

  protected override async handleTask(task: Task): Promise<unknown> {
    const payload = task.payload as { prompt?: string; caseId?: string } | undefined
    const promptText = payload?.prompt ?? ''
    banner('[researcher] industry-research step')

    const { text } = await withCaseContext({
      task,
      caseMemoryFor: this.caseMemoryFor,
      stepLabel: 'research',
      rawPrompt: promptText,
      recordAsConversation: 'analyst',
      callLlm: async (fullPrompt) => {
        log('── prompt to LLM (head 500 chars) ──')
        log(fullPrompt.slice(0, 500) + (fullPrompt.length > 500 ? '\n  ...[truncated]' : ''))
        const t0 = Date.now()
        const req = this.buildRequest({ ...task, payload: { prompt: fullPrompt } } as Task)
        const res = await this.provider.complete(req)
        const elapsed = Date.now() - t0
        const out = this.parseResponse(res, task)
        const t = (out as { text: string }).text
        log(`── DeepSeek replied in ${elapsed}ms, tokens in=${res.usage?.inputTokens ?? '?'} out=${res.usage?.outputTokens ?? '?'} stop=${res.stopReason} ──`)
        log('── output (full) ──')
        log(t)
        return { text: t }
      },
    })
    return { text }
  }
}

// 案主任务管家 —— 处理 case-conversation 类型的插话
class CaseManagerAgent extends LlmAgent {
  private readonly caseMemoryFor: CaseMemoryFor

  constructor(opts: LlmAgentOptions & { caseMemoryFor: CaseMemoryFor }) {
    super(opts)
    this.caseMemoryFor = opts.caseMemoryFor
  }

  protected override async handleTask(task: Task): Promise<unknown> {
    const payload = task.payload as { question?: string; caseId?: string } | undefined
    const question = payload?.question ?? '(无问题)'
    const caseId = payload?.caseId ?? 'unknown-case'

    banner(`[case-manager] received user question (case=${caseId.slice(0, 18)})`)
    log('── user question ──')
    log(question)

    // 案主提问要先 record 为 conversation 'user'，**然后**recall + 进 LLM
    // —— 这样 case-manager 的 prompt 也能看到自己将要回答的这条问题
    const memory = await this.caseMemoryFor(caseId)
    await recordCaseConversation({ caseId, memory }, { source: 'user', text: question })

    const { text } = await withCaseContext({
      task,
      caseMemoryFor: this.caseMemoryFor,
      stepLabel: 'case-conversation',
      rawPrompt: `案主向您提问：\n${question}`,
      recordAsConversation: 'manager',  // 写回自己的回应
      recordOutput: false,              // 这不算 step 产物
      callLlm: async (fullPrompt) => {
        log('── prompt to LLM (head 800 chars) ──')
        log(fullPrompt.slice(0, 800) + (fullPrompt.length > 800 ? '\n  ...[truncated]' : ''))
        const t0 = Date.now()
        const req = this.buildRequest({ ...task, payload: { prompt: fullPrompt } } as Task)
        const res = await this.provider.complete(req)
        const elapsed = Date.now() - t0
        const out = this.parseResponse(res, task)
        const t = (out as { text: string }).text
        log(`── DeepSeek replied in ${elapsed}ms, tokens in=${res.usage?.inputTokens ?? '?'} out=${res.usage?.outputTokens ?? '?'} stop=${res.stopReason} ──`)
        log('── output (full) ──')
        log(t)
        return { text: t }
      },
    })
    return { text, caseId }
  }
}

class AutoReviewer extends HumanParticipant {
  feedback: unknown = {
    approved: true,
    revisions:
      '把 quick-win 第 1 条改成"先用 SaaS 试 2 周再考虑自建"。注意客户提到团队规模有限，工具 onboarding 成本要算进去。',
    reviewer: '李老师（自动模拟）',
  }

  protected override onTaskAvailable(task: Task): void {
    banner('[reviewer] human-in-the-loop — auto-completing in 200ms')
    log('── draft received for review (head 200 chars) ──')
    const draftPayload = task.payload as { draft_report?: { text?: string } } | undefined
    const draftText = draftPayload?.draft_report?.text ?? '(unable to read)'
    log(draftText.slice(0, 200) + (draftText.length > 200 ? ' ...[truncated]' : ''))
    log('── reviewer feedback ──')
    log(JSON.stringify(this.feedback, null, 2))
    setTimeout(() => this.complete(task.id, this.feedback), 200)
  }
}

function transcriptDescribe(e: TranscriptEntry): string {
  switch (e.kind) {
    case 'task':
      return `TASK    ${e.data.from} → "${e.data.title ?? '(untitled)'}" via ${e.data.strategy.kind}`
    case 'task_result':
      return `RESULT  ${e.data.kind === 'ok' ? 'ok' : e.data.kind === 'failed' ? `failed:${e.data.error}` : 'cancelled'} by ${'by' in e.data ? e.data.by : '?'}`
    case 'participant_joined':
      return `JOIN    ${e.data.id} (${e.data.participantKind}) caps=[${e.data.capabilities.join(',')}]`
    default:
      return `${e.kind}`
  }
}

async function runOneConsultation(opts: {
  hub: Hub
  label: string
  caseId: string
  payload: { industry: string; role: string; user_situation: string }
}): Promise<void> {
  banner(`▶▶▶  RUN ${opts.label}: dispatching workflow trigger (case=${opts.caseId})`)
  log(`payload = ${JSON.stringify({ caseId: opts.caseId, ...opts.payload }, null, 2)}`)

  const t0 = Date.now()
  const result = await opts.hub.dispatch({
    from: 'system',
    strategy: { kind: 'capability', capabilities: ['consult-industry-with-human'] },
    payload: { caseId: opts.caseId, ...opts.payload },
    title: `consultation: ${opts.payload.industry}`,
  })
  const totalMs = Date.now() - t0

  banner(`▶▶▶  RUN ${opts.label} COMPLETE in ${totalMs}ms`)
  if (result.kind === 'ok') {
    const out = result.output as Record<string, { text?: string; phase?: string }>
    log(`✓ all 5 steps OK`)
    for (const k of ['intake', 'research', 'draft', 'human_review', 'final']) {
      const v = out[k]
      const preview =
        typeof v === 'object' && v !== null && 'text' in v
          ? String(v.text).slice(0, 60).replace(/\n/g, ' ')
          : JSON.stringify(v).slice(0, 60)
      log(`  • ${k.padEnd(13)} ${preview}…`)
    }
  } else {
    log(`✗ FAILED: ${result.kind}`)
    log(JSON.stringify(result, null, 2))
  }
}

async function askCaseManager(opts: {
  hub: Hub
  caseId: string
  question: string
}): Promise<void> {
  banner(`▶▶▶  USER INTERJECTION  (case=${opts.caseId.slice(0, 18)})`)
  log(`question: ${opts.question}`)
  const t0 = Date.now()
  const result = await opts.hub.dispatch({
    from: 'system',
    strategy: { kind: 'capability', capabilities: ['case-conversation'] },
    payload: { caseId: opts.caseId, question: opts.question },
    title: `case-conversation: ${opts.question.slice(0, 40)}`,
  })
  const totalMs = Date.now() - t0
  banner(`▶▶▶  USER INTERJECTION COMPLETE in ${totalMs}ms`)
  if (result.kind === 'ok') {
    const out = result.output as { text?: string }
    log(`✓ case-manager replied:`)
    log(out.text ?? '(no text)')
  } else {
    log(`✗ FAILED: ${result.kind}`)
  }
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    log('✗ DEEPSEEK_API_KEY env var missing.')
    log('  Set one in .env.local at repo root, or pass via:')
    log('  DEEPSEEK_API_KEY=sk-... pnpm --filter @aipehub/example-industry-consultation-deepseek start')
    process.exit(1)
  }

  const ROOT = join(process.cwd(), '..', '..', '.aipehub-consult-real-deepseek')
  log(`workspace dir: ${ROOT}`)
  if (existsSync(ROOT)) {
    log('  (clearing previous run)')
    await rm(ROOT, { recursive: true, force: true })
  }
  await mkdir(ROOT, { recursive: true })

  const { space } = await Space.init(ROOT, { name: 'consult-real' })
  const hub = new Hub({ space })
  await hub.start()

  await writeFile(
    join(space.paths.services, 'plugins.json'),
    JSON.stringify(
      {
        plugins: [
          '@aipehub/service-memory-file',
          '@aipehub/service-artifact-file',
          '@aipehub/service-datastore-sqlite',
        ],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )

  banner('Bootstrapping Hub Services')
  const boot = await bootstrapServices({ space, hub })
  log(`✓ ready: ${boot.ready.map((p) => `${p.type}:${p.impl}`).join(', ')}`)
  if (boot.errors.length > 0) {
    log(`✗ errors: ${boot.errors.map((e) => e.packageName).join(', ')}`)
    process.exit(1)
  }

  const provider = new OpenAIProvider({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-v4-flash',
    name: 'deepseek',
    maxTokensField: 'max_tokens',
  })

  // ── agent-级 services（跨 case 持久；coach 才用）
  const coachOwner = { kind: 'agent' as const, id: 'industry-coach-pro' }
  const memA = await boot.services.attach({
    type: 'memory', impl: 'file', owner: coachOwner, config: {},
  })
  const artA = await boot.services.attach({
    type: 'artifact', impl: 'file', owner: coachOwner,
    config: { name: 'consultation-reports' },
  })
  const sessA = await boot.services.attach({
    type: 'datastore', impl: 'sqlite', owner: coachOwner,
    config: {
      name: 'sessions',
      schema: `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        client_industry TEXT NOT NULL,
        client_role TEXT,
        quick_win_count INTEGER DEFAULT 0,
        mid_term_count INTEGER DEFAULT 0,
        strategic_count INTEGER DEFAULT 0,
        recorded_at INTEGER NOT NULL,
        outcome TEXT
      );`,
    },
  })
  const coachCtx: ServiceCtx = {
    memory: memA.handle as MemoryHandle,
    artifact: artA.handle as ArtifactHandle,
    datastore: { sessions: sessA.handle as DatastoreHandle },
  }

  // ── case-级 memory factory: 每个 caseId 第一次访问时 attach 一个新 handle
  const caseMemoryCache = new Map<string, MemoryHandle>()
  const caseMemoryFor: CaseMemoryFor = async (caseId) => {
    const cached = caseMemoryCache.get(caseId)
    if (cached) return cached
    const attached = await boot.services.attach({
      type: 'memory', impl: 'file',
      owner: { kind: 'workflow-run', id: caseId },
      config: {},
    })
    const handle = attached.handle as MemoryHandle
    caseMemoryCache.set(caseId, handle)
    log(`[case-memory] attached fresh handle for case=${caseId.slice(0, 24)}`)
    return handle
  }

  // ── Participants
  const coach = new CoachAgent({
    id: 'industry-coach-pro',
    capabilities: ['intake-consultation', 'draft-consultation', 'finalize-consultation'],
    provider,
    system: COACH_SYSTEM,
    model: 'deepseek-v4-flash',
    maxTokens: 1500,
    temperature: 0.5,
    services: coachCtx,
    caseMemoryFor,
  })
  const researcher = new ResearchAgent({
    id: 'industry-research-analyst',
    capabilities: ['industry-research'],
    provider,
    system: RESEARCH_SYSTEM,
    model: 'deepseek-v4-flash',
    maxTokens: 1000,
    temperature: 0.5,
    caseMemoryFor,
  })
  const caseManager = new CaseManagerAgent({
    id: 'case-manager',
    capabilities: ['case-conversation'],
    provider,
    system: CASE_MANAGER_SYSTEM,
    model: 'deepseek-v4-flash',
    maxTokens: 800,
    temperature: 0.4,
    caseMemoryFor,
  })
  const reviewer = new AutoReviewer({
    id: 'auto-consultant',
    capabilities: ['consultant-review'],
  })

  const definition = parseWorkflow(WORKFLOW_YAML)
  const runner = new WorkflowRunner({ definition, hub })

  hub.onEvent((e) => {
    log(`[hub] seq=${String(e.seq).padStart(2, '0')} ${transcriptDescribe(e)}`)
  })

  hub.register(coach)
  hub.register(researcher)
  hub.register(caseManager)
  hub.register(reviewer)
  hub.register(runner)

  // ────── RUN 1: 餐饮 ──────
  const case1 = `case-${Date.now()}-餐饮`
  await runOneConsultation({
    hub,
    label: '1/2 (餐饮 - 8 人早餐店)',
    caseId: case1,
    payload: {
      industry: '餐饮',
      role: '早餐店老板',
      user_situation:
        '我们是 8 个人的早餐店，开了 3 年了。每天最烦的事是手工记账 + 食材损耗算不清。客户主要是周边居民和早高峰白领。已经用了微信群通知员工 + Excel 流水账。预算先看看 1-3 万。',
    },
  })

  // ────── 案主插话：基于 RUN 1 的全 case 历史 ──────
  await askCaseManager({
    hub,
    caseId: case1,
    question:
      '看完终稿了，我有个新顾虑：8 人小店里有 2 个阿姨快 60 岁了，对新工具特别抵触。速赢方案里第一条改成 SaaS，会不会让她们直接抗拒？',
  })

  // ────── RUN 2: 零售 ──────（验证 agent-级 memory 跨 case；这是另一个 case，
  //                  case-memory 不会串）
  const case2 = `case-${Date.now()}-零售`
  await runOneConsultation({
    hub,
    label: '2/2 (零售 - 3 家便利店)',
    caseId: case2,
    payload: {
      industry: '零售',
      role: '店长',
      user_situation:
        '我管 3 家社区便利店，员工 12 人。最大问题是补货决策慢 —— 经常今天卖完明天还断货，或者囤多了过期。用 ERP（顺丰丰修品）+ 微信。老板让我看看 AI 能不能预测补货。预算谈不上严，先做 30 天试点。',
    },
  })

  // ── 收尾：dump agent-级 sessions + 两个 case 的 case-memory
  banner('Post-run inspection')
  const sessions = await (sessA.handle as DatastoreHandle).sql.query<{
    id: string
    client_industry: string
    outcome: string
    recorded_at: number
  }>('SELECT id, client_industry, outcome, recorded_at FROM sessions ORDER BY recorded_at')
  log(`datastore.sessions has ${sessions.length} row(s):`)
  for (const row of sessions) {
    log(`  • ${new Date(row.recorded_at).toISOString()} | ${row.client_industry} | ${row.outcome} | id=${row.id.slice(0, 8)}`)
  }

  const memoryHandle = memA.handle as MemoryHandle
  const memSnap = await memoryHandle.recall({})
  log(`agent-level memory has ${memSnap.length} episodic entries (cross-case):`)
  for (const m of memSnap) {
    log(`  • ${m.text}`)
  }

  for (const [cid, mh] of caseMemoryCache) {
    const all = await mh.recall({ k: 200 })
    log(`case-memory[${cid.slice(0, 24)}] has ${all.length} entries:`)
    for (const m of all) {
      const meta = m.meta as { source?: string; topic?: string; stepId?: string } | undefined
      log(`  • [${meta?.topic ?? '?'}, ${meta?.source ?? '?'}${meta?.stepId ? '@' + meta.stepId : ''}] ${m.text.slice(0, 80).replace(/\n/g, ' ')}…`)
    }
  }

  log('')
  log('Done. To inspect:')
  log(`  artifact reports: ${ROOT}/services/artifact/file/agent/industry-coach-pro/reports/`)
  log(`  datastore file:   ${ROOT}/services/datastore/sqlite/agent/industry-coach-pro/sessions.sqlite`)
  log(`  agent-memory:     ${ROOT}/services/memory/file/agent/industry-coach-pro/episodic.jsonl`)
  log(`  case-memory dirs: ${ROOT}/services/memory/file/workflow-run/<caseId>/episodic.jsonl`)

  await boot.services.shutdownAll()
  await hub.stop()
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('FATAL', err)
  process.exit(1)
})
