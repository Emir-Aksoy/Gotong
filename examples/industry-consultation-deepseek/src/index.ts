// 真实 DeepSeek API 端到端跑「传统行业咨询管线」
//
// 复刻 packages/host/tests/industry-consultation-flow.test.ts 的形状，
// 但把 MockLlmProvider 换成真 OpenAIProvider（baseURL = DeepSeek，
// model = deepseek-v4-flash），并把每一步的 prompt / output /
// token 用量 / 耗时全部 console.log 出来 —— 方便人工肉眼看一遍
// "AI 教练 + 研究员 + 真人 review" 真的能跑。
//
// 关键设计：
//   - 跑两次咨询（餐饮 → 零售），第二次的 intake phase 应该看到
//     memory.recall 返回 priorCount ≥ 1，证明 Hub Services 的
//     memory 状态在真 LLM 调用下也工作。
//   - HumanParticipant 用一个"立刻自动 complete"的子类替代真人 worker
//     UI 点击 —— 真实环境里这一步会等真人审稿。
//   - 工作空间用 .aipehub-consult-real-deepseek/ 放在仓库根目录，
//     .gitignore 已覆盖 .aipehub-* 前缀，跑完不进仓库历史。
//
// 跑前必须：
//   .env.local 在仓库根，内含 DEEPSEEK_API_KEY=sk-...
//   pnpm start 会用 tsx --env-file=../../.env.local，自动读取。
//
// 输出形式：
//   - 控制台 STDOUT：每个 step 都有 header 横线 + 时间 + token 用量
//   - artifact markdown 路径见 main() 收尾的"Done. To inspect:"段
//   - sessions datastore 同上
//   - memory jsonl 同上

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
import { bootstrapServices } from '@aipehub/host/services'
import { LlmAgent } from '@aipehub/llm'
import { OpenAIProvider } from '@aipehub/llm-openai'
import type {
  ArtifactHandle,
  DatastoreHandle,
  MemoryHandle,
  ServiceCtx,
} from '@aipehub/services-sdk'
import { parseWorkflow, WorkflowRunner } from '@aipehub/workflow'

// ── 工作流定义（和模板里 industry-consultation-flow.yaml 同形状）
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
          prompt: |
            行业：$trigger.payload.industry
            初访问题清单：
            $intake.output
    - id: draft
      dispatch:
        strategy: { kind: capability, capabilities: [draft-consultation] }
        title: 草稿
        payload:
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
          industry: $trigger.payload.industry
          draft_report: $draft.output
    - id: finalize
      dispatch:
        strategy: { kind: capability, capabilities: [finalize-consultation] }
        title: 终稿
        payload:
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

通用约束：中文，简洁，不卖弄。不造行业数据。控制在 600 字以内。`

const RESEARCH_SYSTEM = `你是「行业研究分析师」。每次任务收到一段客户初访信息，输出：

## 对标案例
（如有数据就列 3-5 个；本次默认 datastore 为空，写"（无）"）

## 关键洞察（3-5 条）
基于通识对该行业的判断。

## 给 coach 的 3 个提醒
具体到行业土壤问题。

中文，不超过 400 字。`

const log = (...args: unknown[]): void => {
  // 让所有输出带一个时间戳，方便追"哪一步用了多久"
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

// ── 模拟"宿主胶水代码"：用 services + 多 phase 切换
class CoachAgent extends LlmAgent {
  protected override async handleTask(task: Task): Promise<unknown> {
    const memory = this.services.memory
    const artifact = this.services.artifact
    const datastoreSessions = this.services.datastore?.sessions

    const payload = task.payload as { prompt?: string } | undefined
    const promptText = payload?.prompt ?? ''
    const phase: 'intake' | 'draft' | 'finalize' | 'unknown' = promptText.includes(
      '[模式: intake]',
    )
      ? 'intake'
      : promptText.includes('[模式: draft]')
        ? 'draft'
        : promptText.includes('[模式: finalize]')
          ? 'finalize'
          : 'unknown'

    const industryMatch = promptText.match(/客户行业：([^\n]+)/)
    const industry = industryMatch?.[1]?.trim() ?? 'unknown'

    let actualPrompt = promptText
    let priorCount = 0
    if (phase === 'intake' && memory) {
      const past = await memory.recall({})
      priorCount = past.length
      actualPrompt = `[prior_sessions=${priorCount}]\n${promptText}`
    }

    banner(`[coach] phase=${phase} industry=${industry} priorCount=${priorCount}`)
    log('── prompt to LLM (head 400 chars) ──')
    log(actualPrompt.slice(0, 400) + (actualPrompt.length > 400 ? '\n  ...[truncated]' : ''))

    const t0 = Date.now()
    const req = this.buildRequest({
      ...task,
      payload: { prompt: actualPrompt },
    } as Task)
    const res = await this.provider.complete(req)
    const elapsed = Date.now() - t0
    const out = this.parseResponse(res, task)
    const text = (out as { text: string }).text

    log(`── DeepSeek replied in ${elapsed}ms, tokens in=${res.usage?.inputTokens ?? '?'} out=${res.usage?.outputTokens ?? '?'} stop=${res.stopReason} ──`)
    log('── output (full) ──')
    log(text)

    if (phase === 'intake' && memory) {
      await memory.remember({
        kind: 'episodic',
        text: `intake industry=${industry} task=${task.id.slice(0, 8)} preview=${text.slice(0, 80)}`,
      })
      log(`[coach] memory.remember (episodic): "intake industry=${industry}"`)
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
        log(`[coach] memory.remember (episodic): "finalize industry=${industry}"`)
      }
    }

    return { ...out, phase, industry, priorCount, elapsedMs: elapsed }
  }
}

// 普通研究 agent — 不需要 service operation，只让 LLM 出洞察
class ResearchAgent extends LlmAgent {
  protected override async handleTask(task: Task): Promise<unknown> {
    const payload = task.payload as { prompt?: string } | undefined
    const promptText = payload?.prompt ?? ''
    banner('[researcher] industry-research step')
    log('── prompt to LLM (head 300 chars) ──')
    log(promptText.slice(0, 300) + (promptText.length > 300 ? '\n  ...[truncated]' : ''))

    const t0 = Date.now()
    const req = this.buildRequest(task)
    const res = await this.provider.complete(req)
    const elapsed = Date.now() - t0
    const out = this.parseResponse(res, task)
    const text = (out as { text: string }).text

    log(`── DeepSeek replied in ${elapsed}ms, tokens in=${res.usage?.inputTokens ?? '?'} out=${res.usage?.outputTokens ?? '?'} stop=${res.stopReason} ──`)
    log('── output (full) ──')
    log(text)

    return { ...out, elapsedMs: elapsed }
  }
}

// 模拟真人资深顾问 —— 收到 task 立刻自动 complete with canned feedback
class AutoReviewer extends HumanParticipant {
  feedback: unknown = {
    approved: true,
    revisions:
      '把 quick-win 第 1 条改成"先用 SaaS 试 2 周再考虑自建"。注意客户提到团队 8 人，工具 onboarding 成本要算进去。',
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
    // 200ms 假装真人在思考。设 0 也工作，加 200 让日志可读
    setTimeout(() => this.complete(task.id, this.feedback), 200)
  }
}

// ── transcript 监听器：每个 hub 事件落到日志（独立标签）
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

// ────────────────────────────────────────────────────────────────────────
async function runOneConsultation(opts: {
  hub: Hub
  label: string
  payload: { industry: string; role: string; user_situation: string }
}): Promise<void> {
  banner(`▶▶▶  RUN ${opts.label}: dispatching workflow trigger`)
  log(`payload = ${JSON.stringify(opts.payload, null, 2)}`)

  const t0 = Date.now()
  const result = await opts.hub.dispatch({
    from: 'system',
    strategy: {
      kind: 'capability',
      capabilities: ['consult-industry-with-human'],
    },
    payload: opts.payload,
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

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    log('✗ DEEPSEEK_API_KEY env var missing.')
    log('  Set one in .env.local at repo root, or pass via:')
    log('  DEEPSEEK_API_KEY=sk-... pnpm --filter @aipehub/example-industry-consultation-deepseek start')
    process.exit(1)
  }

  const ROOT = join(process.cwd(), '..', '..', '.aipehub-consult-real-deepseek')
  log(`workspace dir: ${ROOT}`)
  // Fresh start every run — easier to read the artifact / memory / sqlite files.
  if (existsSync(ROOT)) {
    log('  (clearing previous run)')
    await rm(ROOT, { recursive: true, force: true })
  }
  await mkdir(ROOT, { recursive: true })

  // ── Space + Hub
  const { space } = await Space.init(ROOT, { name: 'consult-real' })
  const hub = new Hub({ space })
  await hub.start()

  // ── plugins.json (all three first-party plugins)
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

  // ── Provider: real DeepSeek
  const provider = new OpenAIProvider({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-v4-flash',
    name: 'deepseek',
    maxTokensField: 'max_tokens', // DeepSeek wants legacy field
  })

  // ── Attach services for the two agents
  const coachOwner = { kind: 'agent' as const, id: 'industry-coach-pro' }
  const memA = await boot.services.attach({
    type: 'memory',
    impl: 'file',
    owner: coachOwner,
    config: {},
  })
  const artA = await boot.services.attach({
    type: 'artifact',
    impl: 'file',
    owner: coachOwner,
    config: { name: 'consultation-reports' },
  })
  const sessA = await boot.services.attach({
    type: 'datastore',
    impl: 'sqlite',
    owner: coachOwner,
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

  // ── Participants
  const coach = new CoachAgent({
    id: 'industry-coach-pro',
    capabilities: [
      'intake-consultation',
      'draft-consultation',
      'finalize-consultation',
    ],
    provider,
    system: COACH_SYSTEM,
    model: 'deepseek-v4-flash',
    maxTokens: 1500,
    temperature: 0.5,
    services: coachCtx,
  })
  const researcher = new ResearchAgent({
    id: 'industry-research-analyst',
    capabilities: ['industry-research'],
    provider,
    system: RESEARCH_SYSTEM,
    model: 'deepseek-v4-flash',
    maxTokens: 1000,
    temperature: 0.5,
  })
  const reviewer = new AutoReviewer({
    id: 'auto-consultant',
    capabilities: ['consultant-review'],
  })

  // ── Workflow runner
  const definition = parseWorkflow(WORKFLOW_YAML)
  const runner = new WorkflowRunner({ definition, hub })

  // ── transcript listener: emit one line per event for the audit trail
  hub.onEvent((e) => {
    log(`[hub] seq=${String(e.seq).padStart(2, '0')} ${transcriptDescribe(e)}`)
  })

  hub.register(coach)
  hub.register(researcher)
  hub.register(reviewer)
  hub.register(runner)

  // ────── RUN 1: 餐饮 ──────
  await runOneConsultation({
    hub,
    label: '1/2 (餐饮 - 8 人早餐店)',
    payload: {
      industry: '餐饮',
      role: '早餐店老板',
      user_situation:
        '我们是 8 个人的早餐店，开了 3 年了。每天最烦的事是手工记账 + 食材损耗算不清。客户主要是周边居民和早高峰白领。已经用了微信群通知员工 + Excel 流水账。预算先看看 1-3 万。',
    },
  })

  // ────── RUN 2: 零售 ──────（验证 memory 跨 run）
  await runOneConsultation({
    hub,
    label: '2/2 (零售 - 3 家便利店)',
    payload: {
      industry: '零售',
      role: '店长',
      user_situation:
        '我管 3 家社区便利店，员工 12 人。最大问题是补货决策慢 —— 经常今天卖完明天还断货，或者囤多了过期。用 ERP（顺丰丰修品）+ 微信。老板让我看看 AI 能不能预测补货。预算谈不上严，先做 30 天试点。',
    },
  })

  // ── 收尾：把 sessions 表全 dump，验证两次咨询都落盘
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
  log(`memory has ${memSnap.length} episodic entries (cross-run):`)
  for (const m of memSnap) {
    log(`  • ${m.text}`)
  }

  log('')
  log('Done. To inspect:')
  log(`  artifact reports: ${ROOT}/services/artifact/file/agent/industry-coach-pro/reports/`)
  log(`  datastore file:   ${ROOT}/services/datastore/sqlite/agent/industry-coach-pro/sessions.sqlite`)
  log(`  memory jsonl:     ${ROOT}/services/memory/file/agent/industry-coach-pro/episodic.jsonl`)

  await boot.services.shutdownAll()
  await hub.stop()
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('FATAL', err)
  process.exit(1)
})
