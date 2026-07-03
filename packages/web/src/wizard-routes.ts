/**
 * wizard-routes.ts — WIZ-M4b. 建流向导的 HTTP 面。
 *
 * 两个入口、五条路由，压同一个 host 侧向导核（WorkflowWizardService，经鸭子
 * surface 注入——web 运行时不依赖 host，见 docs/zh/SURFACE-PATTERN.md）：
 *
 *   admin（管理员建流，落盘走既有 admin 工作流路由，不在这里写）：
 *     POST /api/admin/workflows/wizard/prepare   ①确认卡+②盘点（零 LLM）
 *     POST /api/admin/workflows/wizard/compose   ③组装→④缺口→⑥校验闭环
 *
 *   member（成员建流，同意后经 createFromYaml 落成员闸落草稿）：
 *     POST /api/me/workflows/wizard/prepare
 *     POST /api/me/workflows/wizard/compose
 *     POST /api/me/workflows/wizard/approve      ⑤用户同意 → 同闸落盘（零 LLM）
 *
 * 为什么 approve 只有成员版：admin 拿到 compose 的 YAML 后走既有的 admin 草稿
 * /导入路由（那套 RBAC / 审计已在）；成员没有等价写路径，所以这里给一条压
 * `MeWorkflowCreateService.createFromYaml`（草稿上限 → LOCAL-ONLY → id 撞车 →
 * 结构硬闸 → owner 种子，与 create() 完全同闸）。
 *
 * 无状态：history 由客户端携带（WFEDIT 前例），服务端只清洗折进 prompt。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { readJsonBody, sendJson } from './http-helpers.js'

// ── 鸭子 surface（host 的 WorkflowWizardService / MeWorkflowCreateService 满足） ──

export interface WizardTurnDTO {
  role: 'user' | 'assistant'
  text: string
  failed?: boolean
}

export interface WizardComposeInput {
  task: string
  by: string
  clarifications?: string
  history?: ReadonlyArray<WizardTurnDTO>
  detail?: 'oneliner' | 'brief' | 'detailed'
}

export interface WorkflowWizardSurface {
  prepare(req: { task: string; by: string }): Promise<{
    task: string
    catalogText: string
    questions: string[]
    confirmText: string
    /** WIZ-M1 目录条目（UI 可选渲染更富的清单；文本版已够用）。 */
    catalog: ReadonlyArray<unknown>
  }>
  compose(req: WizardComposeInput): Promise<
    | {
        ok: true
        yaml: string
        explanation: string
        graph?: unknown
        gapAnalysis: unknown
        gapText: string
        installTemplateRefs: string[]
        repairRounds: number
        deepCheck?: unknown
      }
    | {
        ok: false
        reason: 'needs_user' | 'exhausted' | 'assistant_unavailable'
        explanation?: string
        errorsText?: string
        lastYaml?: string
        repairRounds: number
        detail?: string
      }
  >
}

/** `MeWorkflowCreateService.createFromYaml` 的投影（成员 approve 落盘用）。 */
export interface MeWizardCreateView {
  createFromYaml(req: { yaml: string; userId: string }): Promise<
    | { ok: true; workflowId: string; yaml: string }
    | { ok: false; reason: string; message: string; detail?: string }
  >
}

// ── 请求体解析（两入口共用） ────────────────────────────────────────────────

interface ParsedWizardBody {
  task: string
  clarifications?: string
  history?: WizardTurnDTO[]
  detail?: 'oneliner' | 'brief' | 'detailed'
}

/** task 必填非空；其余字段宽进（service 侧还会再清洗一遍）。null = 已回错误。 */
async function parseWizardBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<ParsedWizardBody | null> {
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, { error: (err as Error).message ?? 'bad body', code: 'bad_request' }, 400)
    return null
  }
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.task !== 'string' || b.task.trim().length === 0) {
    sendJson(res, { error: '缺少 task(想让工作流做什么,一句话)。', code: 'bad_request' }, 400)
    return null
  }
  const out: ParsedWizardBody = { task: b.task.trim() }
  if (typeof b.clarifications === 'string' && b.clarifications.trim().length > 0) {
    out.clarifications = b.clarifications
  }
  if (Array.isArray(b.history)) {
    out.history = b.history.filter(
      (t): t is WizardTurnDTO =>
        !!t &&
        typeof t === 'object' &&
        ((t as WizardTurnDTO).role === 'user' || (t as WizardTurnDTO).role === 'assistant') &&
        typeof (t as WizardTurnDTO).text === 'string',
    )
  }
  if (b.detail === 'oneliner' || b.detail === 'brief' || b.detail === 'detailed') {
    out.detail = b.detail
  }
  return out
}

function notWired(res: ServerResponse): void {
  sendJson(res, { error: '建流向导暂未启用(需要 AI 助手)。', code: 'not_wired' }, 503)
}

// ── admin 入口 ──────────────────────────────────────────────────────────────

export interface WizardAdminRoutesCtx {
  wizard: WorkflowWizardSurface | undefined
  /** server.ts 的 requireAdmin 闭包（返回 null 时已自行回 401）。 */
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<{ id: string } | null>
}

const ADMIN_PREFIX = '/api/admin/workflows/wizard/'

/** 处理 admin 向导路由；未命中返回 false（交回 server.ts 主链）。 */
export async function handleWizardAdminRoute(
  ctx: WizardAdminRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (!path.startsWith(ADMIN_PREFIX)) return false
  const admin = await ctx.requireAdmin(req, res)
  if (!admin) return true
  if (method !== 'POST') {
    sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
    return true
  }
  if (!ctx.wizard) {
    notWired(res)
    return true
  }
  const sub = path.slice(ADMIN_PREFIX.length)
  if (sub === 'prepare') {
    const body = await parseWizardBody(req, res)
    if (!body) return true
    sendJson(res, await ctx.wizard.prepare({ task: body.task, by: admin.id }))
    return true
  }
  if (sub === 'compose') {
    const body = await parseWizardBody(req, res)
    if (!body) return true
    const r = await ctx.wizard.compose({
      task: body.task,
      by: admin.id,
      ...(body.clarifications ? { clarifications: body.clarifications } : {}),
      ...(body.history ? { history: body.history } : {}),
      ...(body.detail ? { detail: body.detail } : {}),
    })
    // ok:false 也是 200——那是向导的正常对话状态（反问/缺口），不是 HTTP 错误。
    sendJson(res, r)
    return true
  }
  sendJson(res, { error: `unknown wizard route: ${path}` }, 404)
  return true
}

// ── member 入口（me-routes.ts 里薄分发到这，控它的行数预算） ────────────────

export interface MeWizardRoutesCtx {
  wizard: WorkflowWizardSurface | undefined
  create: MeWizardCreateView | undefined
  /** me-routes 的 checkMeRateLimit 闭包（组装烧 LLM，与 create/edit 同纪律）。 */
  rateOk: (action: string) => boolean
}

const ME_PREFIX = '/api/me/workflows/wizard/'

/** 处理成员向导路由；未命中返回 false。调用方已解析会话 userId（永不信客户端）。 */
export async function handleMeWizardRoute(
  ctx: MeWizardRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  userId: string,
): Promise<boolean> {
  if (!path.startsWith(ME_PREFIX)) return false
  if (method !== 'POST') {
    sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
    return true
  }
  const sub = path.slice(ME_PREFIX.length)

  if (sub === 'prepare') {
    if (!ctx.wizard) {
      notWired(res)
      return true
    }
    const body = await parseWizardBody(req, res)
    if (!body) return true
    sendJson(res, await ctx.wizard.prepare({ task: body.task, by: userId }))
    return true
  }

  if (sub === 'compose') {
    if (!ctx.wizard) {
      notWired(res)
      return true
    }
    if (!ctx.rateOk('me-wf-wizard')) {
      sendJson(res, { error: '组装得太频繁了,过一会儿再试。', code: 'rate_limited' }, 429)
      return true
    }
    const body = await parseWizardBody(req, res)
    if (!body) return true
    const r = await ctx.wizard.compose({
      task: body.task,
      by: userId,
      ...(body.clarifications ? { clarifications: body.clarifications } : {}),
      ...(body.history ? { history: body.history } : {}),
      ...(body.detail ? { detail: body.detail } : {}),
    })
    sendJson(res, r)
    return true
  }

  if (sub === 'approve') {
    // ⑤ 用户同意 → 零 LLM 落盘。闸全在 host 服务里（草稿上限 / LOCAL-ONLY /
    // id 撞车 / 结构硬闸 / owner 种子），路由只递会话 userId。
    if (!ctx.create) {
      sendJson(res, { error: '工作流新建暂未启用(需要 AI 助手)。', code: 'not_wired' }, 503)
      return true
    }
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (err) {
      sendJson(res, { error: (err as Error).message ?? 'bad body', code: 'bad_request' }, 400)
      return true
    }
    const yaml = (body as Record<string, unknown> | null)?.yaml
    if (typeof yaml !== 'string' || yaml.trim().length === 0) {
      sendJson(res, { error: '缺少 yaml(向导 compose 返回的那份)。', code: 'bad_request' }, 400)
      return true
    }
    const r = await ctx.create.createFromYaml({ yaml, userId })
    if (!r.ok) {
      // 与 /api/me/workflows/create 的 statusForCreateReason 同映射（两入口同闸，
      // 客户端重试逻辑不该因走了向导而变）；createFromYaml 零 LLM，只会出这几种。
      const status =
        r.reason === 'cross_hub' || r.reason === 'id_exists'
          ? 409
          : r.reason === 'draft_cap'
            ? 429
            : 422
      sendJson(res, { error: r.message, code: r.reason, ...(r.detail ? { detail: r.detail } : {}) }, status)
      return true
    }
    sendJson(res, { ok: true, workflowId: r.workflowId })
    return true
  }

  sendJson(res, { error: `unknown wizard route: ${path}` }, 404)
  return true
}
