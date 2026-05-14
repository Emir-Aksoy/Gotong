/**
 * 集成测试：传统行业咨询全流程（含人工 review）
 *
 * 这是 templates/workflows/industry-consultation-flow.yaml 的端到端
 * 运行测试。它把这一波 v2.2 "Hub Services + 人在回路" 的所有零件
 * 串起来，证明改造后的管线真的能跑通：
 *
 *   bootstrap services (3 first-party plugins)
 *     ↓
 *   register industry-coach-pro (CoachAgent 子类，attached memory+artifact+datastore)
 *   register industry-research-analyst (普通 LlmAgent，attached datastore)
 *   register consultant-reviewer (HumanParticipant 子类，自动 complete)
 *   register WorkflowRunner(industry-consultation-flow)
 *     ↓
 *   admin 派 capability=consult-industry-with-human ⇒ 5 步全跑：
 *     intake → research → draft → human-review → finalize
 *
 * 覆盖的测试场景：
 *   1. 全流程 ok：5 个 step 都按顺序完成，output 完整
 *   2. memory 跨 run：第二次咨询时 intake 看到 prior_sessions=1
 *   3. artifact 真落盘：finalize 完成后 reports/<industry>-<id>.md 出现
 *   4. datastore.sessions 表确实多了一行：终稿落盘的同时记一条会话
 *   5. human-review 反馈被吸收：reviewer 给的 revisions 出现在终稿提示里
 *
 * 这就是改造后的"传统行业 AI 咨询"产品形态：AI 教练 + AI 研究员 +
 * 真人资深顾问三方协作；agent 状态由 Hub Services 持久化；workflow
 * 中嵌入一个 HUMAN-IN-THE-LOOP 步骤。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createLogger,
  Hub,
  HumanParticipant,
  Space,
  type Task,
  type TaskResult,
} from '@aipehub/core'
import { LlmAgent, MockLlmProvider, type LlmAgentOptions } from '@aipehub/llm'
import type {
  ArtifactHandle,
  DatastoreHandle,
  MemoryHandle,
  ServiceCtx,
} from '@aipehub/services-sdk'
import { parseWorkflow, WorkflowRunner } from '@aipehub/workflow'

import { bootstrapServices, type HubServices } from '../src/services/index.js'

const logger = createLogger('consult-e2e', { disabled: true })

// ── 工作流 YAML —— 测试里直接内联，与 templates/workflows/industry-consultation-flow.yaml
//    形状完全一致（手工保持同步）。改 yaml 时记得 mirror 这里。
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

/**
 * 模拟"宿主胶水代码"：能根据 task.payload.prompt 里的 [模式: X]
 * 标记切换 phase，并在合适时机调用 services（memory.recall /
 * memory.remember / artifact.write / datastore.sql.exec）。
 *
 * 真实部署里这个类会放到一个独立的 npm 包（比如
 * @aipehub/agent-industry-coach），通过 yaml 的 `kind: custom` +
 * `class:` 字段（v2.3 计划）由 LocalAgentPool 实例化。当下 LocalAgentPool
 * 只认 `kind: llm`，所以我们这里手工 register。
 */
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

    // Industry 提取（顺手当 file 名 + datastore 主键）
    const industryMatch = promptText.match(/客户行业：([^\n]+)/)
    const industry = industryMatch?.[1]?.trim() ?? 'unknown'

    // intake 阶段：先 recall，把 prior count 注入 prompt
    let actualPrompt = promptText
    let priorCount = 0
    if (phase === 'intake' && memory) {
      const past = await memory.recall({ query: '' })
      priorCount = past.length
      actualPrompt = `[prior_sessions=${priorCount}]\n${promptText}`
    }

    const req = this.buildRequest({
      ...task,
      payload: { prompt: actualPrompt },
    } as Task)
    const res = await this.provider.complete(req)
    const out = this.parseResponse(res, task)
    const text = (out as { text: string }).text

    // Phase-specific 后处理
    if (phase === 'intake' && memory) {
      await memory.remember({
        kind: 'episodic',
        text: `intake industry=${industry} task=${task.id.slice(0, 8)}`,
      })
    } else if (phase === 'finalize') {
      if (artifact) {
        const safe = industry.replace(/[^\w一-鿿-]/g, '_')
        await artifact.write(`reports/${safe}-${task.id.slice(0, 8)}.md`, text)
      }
      if (datastoreSessions) {
        await datastoreSessions.sql.exec(
          'INSERT INTO sessions (id, client_industry, recorded_at, outcome) VALUES (?, ?, ?, ?)',
          [task.id, industry, Date.now(), 'completed'],
        )
      }
      if (memory) {
        await memory.remember({
          kind: 'episodic',
          text: `finalize industry=${industry} task=${task.id.slice(0, 8)}`,
        })
      }
    }

    return { ...out, phase, industry, priorCount }
  }
}

/**
 * Fake "资深顾问"：每收到一条 consultant-review 任务，立刻自动
 * complete with a canned review payload. 真实环境里这是 worker UI
 * 上一个人手动点 Complete 后填的 JSON。
 */
class AutoReviewer extends HumanParticipant {
  // 可被测试逐 case 覆盖
  reviewFeedback: unknown = {
    approved: true,
    revisions:
      'quick-win 第 2 条改成"先用 SaaS 试 2 周再考虑自建"；mid-term 删第 3 条',
    reviewer: '李老师',
  }

  // 收到 task → 下一 microtask 自动完成。setImmediate 避开同步
  // 解析 race；当然真实 worker 是 UI 点击事件触发的。
  protected override onTaskAvailable(task: Task): void {
    setImmediate(() => {
      this.complete(task.id, this.reviewFeedback)
    })
  }
}

describe('industry consultation flow — e2e (services + human review)', () => {
  let root: string
  let space: Space
  let hub: Hub
  let services: HubServices
  let runner: WorkflowRunner
  let coach: CoachAgent
  let researcher: LlmAgent
  let reviewer: AutoReviewer
  let coachCtx: ServiceCtx
  let researcherCtx: ServiceCtx

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aipe-consult-e2e-'))
    await rm(root, { recursive: true, force: true })
    const opened = await Space.init(root, { name: 'consult-test' })
    space = opened.space
    hub = new Hub({ space })
    await hub.start()

    // Stage plugins.json with all three first-party plugins (so the
    // host-anchored resolver picks them all up at bootstrap).
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

    const boot = await bootstrapServices({ space, hub, logger })
    expect(boot.errors).toHaveLength(0)
    services = boot.services

    // Attach services for the coach (memory + artifact + datastore:sessions)
    const coachOwner = { kind: 'agent' as const, id: 'industry-coach-pro' }
    const memAttach = await services.attach({
      type: 'memory',
      impl: 'file',
      owner: coachOwner,
      config: {},
    })
    const artAttach = await services.attach({
      type: 'artifact',
      impl: 'file',
      owner: coachOwner,
      config: { name: 'consultation-reports' },
    })
    const sessionsAttach = await services.attach({
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
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_industry ON sessions(client_industry);`,
      },
    })
    coachCtx = {
      memory: memAttach.handle as MemoryHandle,
      artifact: artAttach.handle as ArtifactHandle,
      datastore: {
        sessions: sessionsAttach.handle as DatastoreHandle,
      },
    }

    // Attach services for the research analyst (only datastore:cases)
    const researcherOwner = { kind: 'agent' as const, id: 'industry-research-analyst' }
    const casesAttach = await services.attach({
      type: 'datastore',
      impl: 'sqlite',
      owner: researcherOwner,
      config: {
        name: 'cases',
        schema: `CREATE TABLE IF NOT EXISTS cases (
          id TEXT PRIMARY KEY,
          industry TEXT NOT NULL,
          company_size TEXT,
          revenue_rmb INTEGER,
          employees INTEGER,
          pain_point TEXT,
          recorded_at INTEGER NOT NULL
        );`,
      },
    })
    researcherCtx = {
      datastore: { cases: casesAttach.handle as DatastoreHandle },
    }

    // Mock providers — return phase-aware canned text so tests are
    // deterministic but the prompt still looks realistic to the agent.
    const coachProvider = new MockLlmProvider({
      reply: (req) => {
        const userMsg = req.messages[req.messages.length - 1]?.content ?? ''
        if (userMsg.includes('[模式: intake]')) {
          return '## 我想先了解几件事\n1. 您的业务一句话怎么概括？\n2. 每天最花时间的 3 件事？\n3. 已经用了哪些数字工具？\n4. 团队几个人？\n5. 您的预算意向？\n## 您方便的话，请逐条回答；之后我会出一份初步方案。'
        }
        if (userMsg.includes('[模式: draft]')) {
          return '# 行业 AI 转型方案草稿（初稿）\n## 一、客户画像\n（基于 intake + 行业研究的画像）\n## 三、AI 切入点建议\n- 🟢 速赢：…\n- 🟡 中期：…\n- 🔴 战略：…\n## 五、需要顾问 review 的 3 个判断'
        }
        if (userMsg.includes('[模式: finalize]')) {
          const reviewMatch = userMsg.match(/\[reviewer 反馈\]\s*([\s\S]*?)$/)
          const reviewText = reviewMatch?.[1]?.trim() ?? ''
          return `# 行业 AI 转型方案（终稿 v1）\n> 已采纳资深顾问 N 条修订意见 —— 整合了 reviewer 反馈\n\n[已吸收 reviewer 内容: ${reviewText.slice(0, 120)}]`
        }
        return '(coach unknown phase)'
      },
    })

    const researchProvider = new MockLlmProvider({
      reply: () =>
        '## 对标案例（来自 cases datastore）\n（无）\n## 关键洞察\n- **洞察**：…\n- **依据**：通识\n## 给 coach 的 3 个提醒\n1. 关注行业法规\n2. 注意人员结构\n3. 客户付费习惯',
    })

    // Instantiate participants
    coach = new CoachAgent({
      id: 'industry-coach-pro',
      capabilities: [
        'intake-consultation',
        'draft-consultation',
        'finalize-consultation',
      ],
      provider: coachProvider,
      services: coachCtx,
    } as LlmAgentOptions)

    researcher = new LlmAgent({
      id: 'industry-research-analyst',
      capabilities: ['industry-research'],
      provider: researchProvider,
      services: researcherCtx,
    } as LlmAgentOptions)

    reviewer = new AutoReviewer({
      id: 'auto-consultant',
      capabilities: ['consultant-review'],
    })

    // Build + register the workflow runner
    const definition = parseWorkflow(WORKFLOW_YAML)
    runner = new WorkflowRunner({ definition, hub })

    hub.register(coach)
    hub.register(researcher)
    hub.register(reviewer)
    hub.register(runner)
  })

  afterEach(async () => {
    await services.shutdownAll()
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  // ───────────────────────────────────────────────────────────────
  // Test 1: 全流程 ok —— 5 步按顺序完成，output 有完整结构
  // ───────────────────────────────────────────────────────────────
  it('all 5 steps complete in order; output has intake/research/draft/human_review/final', async () => {
    const result: TaskResult = await hub.dispatch({
      from: 'system',
      strategy: {
        kind: 'capability',
        capabilities: ['consult-industry-with-human'],
      },
      payload: {
        industry: '餐饮',
        role: '早餐店老板',
        user_situation: '我们是 8 个人的早餐店，每天最烦的事是手工记账。',
      },
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return

    const out = result.output as Record<string, unknown>
    expect(out).toHaveProperty('intake')
    expect(out).toHaveProperty('research')
    expect(out).toHaveProperty('draft')
    expect(out).toHaveProperty('human_review')
    expect(out).toHaveProperty('final')

    // Intake 必须由 coach 的 intake phase 产出
    const intake = out.intake as { phase: string; text: string }
    expect(intake.phase).toBe('intake')
    expect(intake.text).toContain('我想先了解几件事')

    // Research 不带 phase 字段（普通 LlmAgent），看 text 即可
    const research = out.research as { text: string }
    expect(research.text).toContain('对标案例')

    // Draft 是 coach 的 draft phase
    const draft = out.draft as { phase: string; text: string }
    expect(draft.phase).toBe('draft')
    expect(draft.text).toContain('草稿（初稿）')

    // Human review 是 AutoReviewer 自动 complete 的 JSON
    const review = out.human_review as { approved: boolean; reviewer: string }
    expect(review.approved).toBe(true)
    expect(review.reviewer).toBe('李老师')

    // Final 是 coach 的 finalize phase，必须吸收了 reviewer 反馈
    const final = out.final as { phase: string; text: string; industry: string }
    expect(final.phase).toBe('finalize')
    expect(final.industry).toBe('餐饮')
    expect(final.text).toContain('终稿')
    // The mock reply echoes back the reviewer feedback into the draft text
    expect(final.text).toContain('已吸收 reviewer 内容')
  })

  // ───────────────────────────────────────────────────────────────
  // Test 2: memory 跨 run —— 第二次 intake 时 priorCount=2
  //   (一次 intake.remember + 一次 finalize.remember = 2 个 episodic entries)
  // ───────────────────────────────────────────────────────────────
  it('memory carries across runs — second consultation sees priorCount=2 in intake', async () => {
    await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['consult-industry-with-human'] },
      payload: {
        industry: '餐饮',
        role: '老板',
        user_situation: '8 人早餐店。',
      },
    })

    const second = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['consult-industry-with-human'] },
      payload: {
        industry: '零售',
        role: '店长',
        user_situation: '3 家便利店。',
      },
    })

    expect(second.kind).toBe('ok')
    if (second.kind !== 'ok') return
    const secondIntake = (second.output as { intake: { priorCount: number } }).intake
    expect(secondIntake.priorCount).toBe(2)
  })

  // ───────────────────────────────────────────────────────────────
  // Test 3: artifact 真落盘 —— finalize 后磁盘上有 reports/<id>.md
  // ───────────────────────────────────────────────────────────────
  it('finalize writes a markdown report to disk under artifact root', async () => {
    const result = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['consult-industry-with-human'] },
      payload: {
        industry: '制造',
        role: '车间主任',
        user_situation: '20 人五金加工厂，每天工时统计很乱。',
      },
    })
    expect(result.kind).toBe('ok')

    // The artifact root is <space>/services/artifact/file/agent/<agentId>/
    // The CoachAgent writes to reports/<safe-industry>-<taskId8>.md
    const artifactRoot = join(
      space.paths.services,
      'artifact',
      'file',
      'agent',
      'industry-coach-pro',
    )
    // List contents to find the written file
    const { readdir } = await import('node:fs/promises')
    const reportsDir = join(artifactRoot, 'reports')
    expect(existsSync(reportsDir)).toBe(true)
    const files = await readdir(reportsDir)
    expect(files.length).toBeGreaterThan(0)
    const reportFile = files.find((f) => f.startsWith('制造-') && f.endsWith('.md'))
    expect(reportFile).toBeDefined()
    const content = await readFile(join(reportsDir, reportFile!), 'utf8')
    expect(content).toContain('终稿')
  })

  // ───────────────────────────────────────────────────────────────
  // Test 4: datastore.sessions 表里多了一行
  // ───────────────────────────────────────────────────────────────
  it('finalize writes one row into datastore.sessions per completed run', async () => {
    await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['consult-industry-with-human'] },
      payload: {
        industry: '物流',
        role: '调度员',
        user_situation: '小型快递点',
      },
    })

    const sessionsHandle = coachCtx.datastore!.sessions as DatastoreHandle
    const rows = await sessionsHandle.sql.query<{
      id: string
      client_industry: string
      outcome: string
    }>('SELECT id, client_industry, outcome FROM sessions')
    expect(rows.length).toBe(1)
    expect(rows[0]!.client_industry).toBe('物流')
    expect(rows[0]!.outcome).toBe('completed')
  })

  // ───────────────────────────────────────────────────────────────
  // Test 5: human-review 反馈被吸收 —— 终稿的 prompt 真的看到 revisions
  // ───────────────────────────────────────────────────────────────
  it('reviewer feedback (rejection path) flows into the finalize prompt', async () => {
    // Override the auto-reviewer's canned reply for this case.
    reviewer.reviewFeedback = {
      approved: false,
      revisions: '请删掉 strategic 段，过早。',
      reviewer: '王老师',
    }

    const result = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['consult-industry-with-human'] },
      payload: {
        industry: '教育',
        role: '校长',
        user_situation: '8 人补习班。',
      },
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const final = (result.output as { final: { text: string } }).final
    // Mock provider echoes the [reviewer 反馈] segment into the final
    // text — we check the rejection feedback flowed through end-to-end.
    expect(final.text).toContain('王老师')
    expect(final.text).toMatch(/strategic|过早|删掉/)
  })
})
