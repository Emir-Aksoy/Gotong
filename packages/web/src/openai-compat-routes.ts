/**
 * openai-compat-routes.ts — OPENAI-M1/M2. The inbound OpenAI-compatible face.
 *
 *   POST /v1/chat/completions   非流式 + SSE 流式（M2）；`model` = agent id
 *   GET  /v1/models             这条 bearer 能调的 agent（≡ 上面接受的 model 集）
 *
 * 为什么存在：出站早就是 OpenAI 形状了（`llm-openai` 的 provider 就叫
 * `openai-compatible`），反过来那一半一直没有 —— 任何只会说
 * `POST /v1/chat/completions` 的东西（SDK / LangChain / Dify / Open WebUI /
 * Cursor）都没有一条路能把 hub 里的 agent 当成一个模型来调。补上它，
 * 「Gotong 里的一个 agent」就成了 OpenAI 生态眼里的一个 model id，**对方零改动**。
 * 完整设计与岔口记录见 docs/zh/OPENAI-COMPAT-API.md。
 *
 * 四条承重的边界（改这个文件前先读）：
 *
 *  ① **闸零绕过**。这条路上的调用与 `/me` 聊天走同一次 `hub.dispatch`、同一个
 *     governed 闸、同一份配额账本。所以 `tools`/`functions` 一律 400（接了就等于
 *     把执行权交到闸外面），park 也不折成 `tool_calls`（调用方会去执行闸刚拦下的
 *     那个动作）—— park 走 §park 那条正常回复。
 *  ② **无状态**。上下文以调用方发来的 `messages[]` 为准；hub 侧的 SESS 会话窗
 *     **既不读也不写**。偷偷混进去会让同一组 messages 在不同时刻答得不一样，
 *     而调用方无从得知自己少看了什么。
 *  ③ **人设不可经调用面改写**。`role:'system'` 的消息**被忽略**（`payload.system`
 *     这个缝确实存在且 `LlmAgent.buildRequest` 认它——正因为认，才不能从这儿喂）。
 *     同理 `model`/`temperature`/`max_tokens` 一类 per-task 覆盖也不透传：那些是
 *     agent 的主人配的，一个调用方不该能改别人 agent 的行为方式。
 *  ④ **零新旋钮**（116 冻结）。surface 接不接就是开关。
 *
 * **M2 流式的形状，以及它诚实在哪**（§4.6）：SSE 连接**立即建立并保持**（客户端不会
 * 干等到超时），但**内容 delta 只在最终结果定稿后发**，而且**只发一帧**。原因是带工具
 * 的 agent 会重放多轮，只有最后一轮的文本才是回复；把中间轮当 delta 发出去，累加起来
 * 就不等于最终答案——而 OpenAI 的 SSE 语义里**没有「整体替换」这个动作**。所以这里
 * 不假装分片：代价是首 token 延迟一点没改善，收益是**delta 累加永远逐字节等于非流式
 * 的那个答案**（`openai-compat-stream.test.ts` 拿这条当尺）。
 *
 * 由此带出一个必须写下来的取舍:**先验证、后开流**。所有形状类错误（400/404）都在开流
 * 之前发生，于是它们仍然是**真的 HTTP 状态码**；只有派发期的失败（agent 掉线、超时、
 * 上游炸）落在流里——那时 200 已经写出去了，改不了，只能发一帧 `error` 然后**收掉连接
 * 且不发 `[DONE]`**。不补 `[DONE]` 是刻意的：那会让客户端把一次截断当成正常收尾。
 *
 * 鉴权：既有 `aipk_` / `adm_` bearer（`resolveV4Auth`）—— OpenAI SDK 天生就发
 * `Authorization: Bearer …`，调用方什么都不用改，也不新开签发口。挂载点在
 * server.ts 的 **CSRF 门之前**（与 metrics / A2A 同一档：SDK 不是浏览器、不发
 * Origin、没有 ambient cookie 可供一次 CSRF 去花，**bearer 就是授权**）。
 *
 * 可见性：`/v1/models` 列的集合 **恰好等于** `/v1/chat/completions` 接受的集合
 * —— 同一个判定（BUTLER-CHAT 管家豁免 ∪ E4-M1 viewer grant），一处实现两处用。
 * 列表里没有的 model 与不存在的 model 同一个回答（404），不做探测面。
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Hub } from '@gotong/core'

import { readJsonBody, sendJson } from './http-helpers.js'
import {
  resolveV4Auth,
  type IdentitySurface,
  type LoginRateLimiterLike,
} from './identity-routes.js'
import type {
  InboxSurface,
  MeAgentAdminSurface,
  MeAgentListSurface,
  MeButlerChatSurface,
} from './me-routes-types.js'

/** 一次 completion 最多等多久。与 /me 聊天的缺省一致（那边可由 body 调，这边
 * 不开——OpenAI 协议里没有这个参数，凭空加一个非标准键没人会发）。 */
const COMPLETION_TIMEOUT_MS = 120_000

/** park 回执里引用待批项标题时的长度顶（按码点）。 */
const PARK_TITLE_MAX_CHARS = 80

export interface OpenAiCompatCtx {
  identity: IdentitySurface
  hub: Hub
  /** 与 /me 共用的那把限流器：一条 bearer 循环打这个端点，与在网页上狂点聊天框
   * 受同一把闸管（per-user key，不与 IP-keyed 的登录预算撞车）。 */
  loginLimiter: LoginRateLimiterLike
  /** 目录：`/v1/models` 的候选集来源。缺席 ⇒ 空列表。 */
  meAgents: MeAgentListSurface | undefined
  /** grant 阶梯：非管家行的唯一访问判定。缺席 ⇒ 只有管家行可用。 */
  meAgentAdmin: MeAgentAdminSurface | undefined
  /** BUTLER-CHAT 豁免探针。缺席 ⇒ 一律走 grant 门（fail-closed）。 */
  meButlerChat: MeButlerChatSurface | undefined
  /** park 回执里引用待批项标题用；best-effort，缺席或抛错 ⇒ 用通用措辞。 */
  inbox: InboxSurface | undefined
}

// ---------------------------------------------------------------------------
// OpenAI 的错误信封。SDK 会读 `error.message` 直接抛给用户看，所以每一句都写成
// 人话，并且在能指路的时候指路。
// ---------------------------------------------------------------------------

function sendOpenAiError(
  res: ServerResponse,
  status: number,
  message: string,
  type: string,
  code?: string,
): void {
  sendJson(res, { error: { message, type, code: code ?? null, param: null } }, status)
}

/** 控制字符折成空格 + 按码点截断。进 API 响应正文的自由文本一律过这儿。 */
function clipText(raw: string, maxChars: number): string {
  let cleaned = ''
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0
    cleaned += cp < 0x20 || cp === 0x7f ? ' ' : ch
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim()
  const pts = Array.from(cleaned)
  return pts.length <= maxChars ? cleaned : pts.slice(0, maxChars - 1).join('') + '…'
}

// ---------------------------------------------------------------------------
// 访问判定 —— 列表与调用共用这一个，两处永不各说各话。
// ---------------------------------------------------------------------------

/**
 * 这个成员能不能对这个 agent 说话。逐字镜像 `/me` 聊天那道门：
 * 管家行豁免（BUTLER-CHAT：管家是每个成员的界面，目录本来就对全员显示它，
 * 那道 404 什么也没护住），其余一律要 grant 阶梯的 viewer 地板。
 * 探针抛错 ⇒ 当作不是管家（fail-closed，门照旧生效）。
 */
async function canChat(ctx: OpenAiCompatCtx, userId: string, agentId: string): Promise<boolean> {
  if (ctx.meButlerChat) {
    try {
      if ((await ctx.meButlerChat.isButlerAgent(agentId)) === true) return true
    } catch {
      /* fail-closed：探针出错 ⇒ 不是管家 ⇒ 下面的 grant 门说了算 */
    }
  }
  if (!ctx.meAgentAdmin) return false
  try {
    await ctx.meAgentAdmin.read(userId, agentId)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// messages[] → dispatch payload
// ---------------------------------------------------------------------------

interface ParsedChat {
  prompt: string
  history: { role: 'user' | 'assistant'; content: string }[]
}

class BadRequest extends Error {
  constructor(message: string, readonly code = 'invalid_request_error') {
    super(message)
  }
}

/**
 * 把一条 message 的 `content` 折成纯文本。字符串直接用；数组按新版 SDK 的
 * content-part 形状取 `type:'text'` 的部分拼起来。**非文本部分响亮拒**——
 * 图片要不要能进得由 agent 自己的视觉配置决定，这条路上悄悄丢掉一张图，
 * 调用方会以为模型看过了。
 */
function contentToText(content: unknown, where: string): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const p of content) {
      if (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text') {
        const t = (p as { text?: unknown }).text
        if (typeof t === 'string') {
          parts.push(t)
          continue
        }
      }
      throw new BadRequest(
        `${where}: 这条路只收文本内容（string，或只含 type:'text' 的 content 数组）。` +
          '图片/音频一类的多模态输入要由这个 agent 自己的配置决定，不能从调用面塞进来。',
      )
    }
    return parts.join('\n')
  }
  throw new BadRequest(`${where}: content 必须是字符串或 content-part 数组`)
}

/**
 * 最后一条 user 消息是这一轮的问句，它之前的进 `payload.history`。
 *
 * 两条 provider 安全规则与 SESS 窗的 `render()` **刻意一致**：连续同角色合并、
 * 尾部 user 丢弃（当前句由 `LlmAgent.buildRequest` 紧接着追加，两条背靠背的
 * user 会打破严格交替的 provider）。
 */
function parseMessages(raw: unknown): ParsedChat {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BadRequest('messages 必须是非空数组')
  }
  const kept: { role: 'user' | 'assistant'; content: string }[] = []
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i]
    if (!m || typeof m !== 'object') throw new BadRequest(`messages[${i}] 必须是对象`)
    const role = (m as { role?: unknown }).role
    if (role === 'system' || role === 'developer') {
      // 边界③ —— 人设在 agent spec 里。静默忽略是刻意的：几乎每个客户端都会
      // 默认塞一条 system，为它 400 会把这条路对大多数工具关死；而它「不生效」
      // 这件事写在文档的诚实边界里。
      continue
    }
    if (role === 'tool' || role === 'function') {
      throw new BadRequest(
        '这条路不接外部工具循环（边界①：执行权不出治理闸）。' +
          '要让 agent 用工具，在 hub 里给它配工具，它自己会用。',
        'unsupported_parameter',
      )
    }
    if (role !== 'user' && role !== 'assistant') {
      throw new BadRequest(`messages[${i}].role 只能是 user / assistant / system`)
    }
    kept.push({ role, content: contentToText((m as { content?: unknown }).content, `messages[${i}]`) })
  }
  const last = kept[kept.length - 1]
  if (!last || last.role !== 'user') {
    throw new BadRequest('最后一条消息必须是 role:"user"（这一轮要问的话）')
  }
  const prompt = last.content.trim()
  if (!prompt) throw new BadRequest('最后一条 user 消息的内容不能为空')

  const prior = kept.slice(0, -1)
  const merged: { role: 'user' | 'assistant'; parts: string[] }[] = []
  for (const m of prior) {
    const tail = merged[merged.length - 1]
    if (tail && tail.role === m.role) tail.parts.push(m.content)
    else merged.push({ role: m.role, parts: [m.content] })
  }
  while (merged.length > 0 && merged[merged.length - 1]!.role === 'user') merged.pop()
  return { prompt, history: merged.map((m) => ({ role: m.role, content: m.parts.join('\n\n') })) }
}

/**
 * 那些「忽略了就等于撒谎」的参数一律响亮拒。
 * 反过来 `temperature`/`top_p`/`max_tokens`/`stop`/`seed` 静默忽略并写进文档——
 * 拒了会挡掉几乎所有客户端，而它们不生效只是「没调到参」，不是「我骗了你」。
 */
function rejectUnsupported(body: Record<string, unknown>): void {
  if (body.tools !== undefined || body.functions !== undefined || body.tool_choice !== undefined) {
    throw new BadRequest(
      '这条路不接 tools / functions（边界①：执行权不出治理闸）。' +
        'agent 的工具在 hub 里配，由 hub 侧的闸管。',
      'unsupported_parameter',
    )
  }
  if (typeof body.n === 'number' && body.n !== 1) {
    throw new BadRequest('n 只能是 1：一次派发就是一次回答，返回 1 条却说好了 n 条是撒谎。', 'unsupported_parameter')
  }
  if (body.logprobs || body.logit_bias !== undefined || body.top_logprobs !== undefined) {
    throw new BadRequest('logprobs / logit_bias 这条路给不出：hub 不跑模型，拿不到那些数。', 'unsupported_parameter')
  }
  // `stream_options.include_usage` 是「请把 usage 发给我」。这条路**结构上**没有 usage
  // （非流式那边整个字段都缺席，理由同：报 0 会被读成免费）。收下再不发就是撒谎，
  // 所以响亮拒——与 §4.7 那条「忽略了就等于撒谎的一律拒」同一把尺。
  const so = body.stream_options
  if (so !== undefined && so !== null) {
    if (typeof so !== 'object' || Array.isArray(so)) {
      throw new BadRequest('stream_options 必须是对象', 'invalid_request_error')
    }
    if ((so as { include_usage?: unknown }).include_usage === true) {
      throw new BadRequest(
        'stream_options.include_usage 这条路给不出：TaskResult 不带 token 数（真账在 hub 的用量账本里）。',
        'unsupported_parameter',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// park —— 岔口 a
// ---------------------------------------------------------------------------

/**
 * 一个 governed 动作被挂起时对调用方说的话。
 *
 * **为什么是 200 + 一条正常回复**：调用方是个 SDK，非 2xx 会被它当传输故障重试；
 * 而 park 不是故障，它是一次成功的、正确的、需要人点头的对话轮。用错误码表达它，
 * 等于把「等你确认」变成「服务坏了」。语义上也不算撒谎——那确实是助手说的话。
 *
 * **为什么不折成 tool_calls**：调用方看到 tool_call 就会去执行，而那正是闸刚拦下
 * 的那个动作（边界①）。
 *
 * 标题是 best-effort：suspend notifier 先写 `suspended_tasks` 后写待批项，与这次
 * dispatch 的 resolve 之间有一个竞态窗；查不到就用通用措辞，**绝不编一个**。
 */
async function parkMessage(ctx: OpenAiCompatCtx, userId: string, taskId: string): Promise<string> {
  let title: string | undefined
  if (ctx.inbox) {
    try {
      const pending = await ctx.inbox.listPending(userId)
      const hit = pending.find((it) => it.itemId === taskId)
      const raw = hit ? (typeof hit.title === 'string' && hit.title.trim() ? hit.title : hit.prompt) : undefined
      if (typeof raw === 'string' && raw.trim()) title = clipText(raw, PARK_TITLE_MAX_CHARS)
    } catch {
      /* best-effort：读不到就说通用措辞 */
    }
  }
  const what = title ? `这件事(${title})` : '这件事'
  return (
    `${what}需要你先确认一下，我已经把它放进你的收件箱了。` +
    '请到网页「我的 → 收件箱」点确认或拒绝——批了我就接着做。' +
    '这次对话我先停在这儿；想知道后续结果，批完再问我一次。'
  )
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

function extractText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object') {
    const t = (output as { text?: unknown }).text
    if (typeof t === 'string') return t
  }
  return output === undefined || output === null ? '' : JSON.stringify(output)
}

/**
 * 顶层 `/v1/*` 全归这儿：认得的两条自己答，其余出一个 OpenAI 形状的 404，
 * 好让 SDK 的报错读得懂（掉进通用 404 会给调用方一页 HTML）。
 * 返回 true = 已应答。
 */
export async function handleOpenAiCompatRoute(
  ctx: OpenAiCompatCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path !== '/v1' && !path.startsWith('/v1/')) return false

  const auth = resolveV4Auth(ctx.identity, req)
  if (!auth.user || !auth.role) {
    sendOpenAiError(
      res,
      401,
      '缺少或无效的 API key。请在 Authorization 头里带一把 hub 的成员令牌（aipk_…）。',
      'invalid_request_error',
      'invalid_api_key',
    )
    return true
  }
  const userId = auth.user.id

  if (method === 'GET' && (path === '/v1/models' || path === '/v1/models/')) {
    await handleListModels(ctx, res, userId)
    return true
  }
  if (method === 'POST' && path === '/v1/chat/completions') {
    await handleChatCompletion(ctx, req, res, userId)
    return true
  }
  sendOpenAiError(
    res,
    404,
    `这台 hub 的 OpenAI 兼容面只有 GET /v1/models 与 POST /v1/chat/completions（收到 ${method} ${path}）。`,
    'invalid_request_error',
    'unknown_url',
  )
  return true
}

async function handleListModels(
  ctx: OpenAiCompatCtx,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  if (!ctx.meAgents) {
    sendJson(res, { object: 'list', data: [] })
    return
  }
  let rows: { id: string }[]
  try {
    rows = await ctx.meAgents.listForMembers()
  } catch (err) {
    sendOpenAiError(res, 500, err instanceof Error ? err.message : String(err), 'api_error')
    return
  }
  const data: { id: string; object: 'model'; created: number; owned_by: string }[] = []
  const created = Math.floor(Date.now() / 1000)
  for (const row of rows) {
    if (await canChat(ctx, userId, row.id)) {
      data.push({ id: row.id, object: 'model', created, owned_by: 'gotong' })
    }
  }
  sendJson(res, { object: 'list', data })
}

async function handleChatCompletion(
  ctx: OpenAiCompatCtx,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  // 每次 completion 都是一次对外 LLM 调用 —— 与 /me 聊天同一把限流器、同一份
  // per-user 预算，一条 bearer 循环打它不会比在网页上狂点便宜。
  if (!ctx.loginLimiter.check(`openai-compat:${userId}`)) {
    res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '60' })
    res.end(
      JSON.stringify({
        error: { message: '请求太频繁，过一分钟再试。', type: 'rate_limit_error', code: 'rate_limit_exceeded', param: null },
      }),
    )
    return
  }
  const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined
  if (!body || typeof body !== 'object') {
    sendOpenAiError(res, 400, '请求体必须是 JSON 对象', 'invalid_request_error')
    return
  }
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) {
    sendOpenAiError(res, 400, 'model 必填：填一个 agent id（GET /v1/models 列出你能调的）', 'invalid_request_error')
    return
  }
  // 形状先于存在性：一个奇形怪状的 id 不该有机会走到 hub 面前。与成员建 agent
  // 时的字符集同一套。
  if (model.length > 64 || !/^[a-zA-Z0-9_.-]+$/.test(model)) {
    sendOpenAiError(res, 404, `没有这个 model: ${clipText(model, 32)}`, 'invalid_request_error', 'model_not_found')
    return
  }
  // M2:`stream` 只认布尔。别的类型响亮拒——一个 `stream:"true"` 静默按非流式走,
  // 客户端会一直等一个永远不来的 `[DONE]`。
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    // code 留空：与本文件其它「一般性形状错」同一套（M1 的 BadRequest 也是）。
    sendOpenAiError(res, 400, 'stream 必须是布尔值：true 走 SSE，false / 缺省走一次性 JSON', 'invalid_request_error')
    return
  }
  const wantStream = body.stream === true
  let parsed: ParsedChat
  try {
    rejectUnsupported(body)
    parsed = parseMessages(body.messages)
  } catch (err) {
    if (err instanceof BadRequest) {
      sendOpenAiError(res, 400, err.message, 'invalid_request_error', err.code === 'invalid_request_error' ? undefined : err.code)
      return
    }
    throw err
  }
  // 不存在的 model 与没权限的 model 同一个回答 —— 不做探测面。
  if (!(await canChat(ctx, userId, model))) {
    sendOpenAiError(res, 404, `没有这个 model: ${model}`, 'invalid_request_error', 'model_not_found')
    return
  }

  const id = 'chatcmpl-' + randomUUID().replace(/-/g, '')
  const created = Math.floor(Date.now() / 1000)

  // 非流式:等结果,一次性发。
  if (!wantStream) {
    const out = await runCompletion(ctx, userId, model, parsed)
    if (!out.ok) {
      sendOpenAiError(res, out.status, out.message, out.type, out.code)
      return
    }
    sendJson(res, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: out.content }, finish_reason: 'stop' }],
      // `usage` 整个字段缺席是刻意的：TaskResult 不带 token 数（用量走
      // `usageSink` 进账本），报 0 会被读成「这次调用免费」。真账在用量面板。
    })
    return
  }

  // 流式:**先开流再派发**。到这一行为止所有形状类错误都已经用真 HTTP 状态码发过了;
  // 从这一行起 200 已经写出去,改不了。
  const stream = beginStream(res, { id, created, model })
  const out = await runCompletion(ctx, userId, model, parsed)
  if (!out.ok) {
    stream.fail(out)
    return
  }
  stream.finish(out.content)
}

/** 一次 completion 的结果：要么一段正文，要么一个「本该是什么 HTTP 错误」的描述。 */
type CompletionOutcome =
  | { readonly ok: true; readonly content: string }
  | {
      readonly ok: false
      readonly status: number
      readonly message: string
      readonly type: string
      readonly code?: string
    }

/**
 * 派发一次并把 `TaskResult` 归一成正文。
 *
 * 两条路（流式 / 非流式）**共用这一处**。分成两份实现就等于让「delta 累加 === 非流式
 * 答案」那条判据去比两个各自演化的东西——那条尺当天就废了。
 */
async function runCompletion(
  ctx: OpenAiCompatCtx,
  userId: string,
  model: string,
  parsed: ParsedChat,
): Promise<CompletionOutcome> {
  let result: unknown
  try {
    result = await Promise.race([
      ctx.hub.dispatch({
        from: userId,
        // 与 /me 聊天同一份归属：配额按人记账，orgId 'local' 标同 hub 来源。
        origin: { orgId: 'local', userId },
        strategy: { kind: 'explicit', to: model },
        payload: { prompt: parsed.prompt, ...(parsed.history.length > 0 ? { history: parsed.history } : {}) },
        title: `openai-compat — ${userId}`,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('completion wait timeout')), COMPLETION_TIMEOUT_MS),
      ),
    ])
  } catch (err) {
    return {
      ok: false,
      status: 504,
      message: err instanceof Error ? err.message : String(err),
      type: 'api_error',
      code: 'timeout',
    }
  }

  const r = result as { kind?: string; taskId?: string; output?: unknown; error?: string; reason?: string }
  switch (r.kind) {
    case 'ok':
      return { ok: true, content: extractText(r.output) }
    case 'suspended':
      return { ok: true, content: await parkMessage(ctx, userId, typeof r.taskId === 'string' ? r.taskId : '') }
    case 'no_participant':
      return {
        ok: false,
        status: 503,
        message: `「${model}」现在不在线：${r.reason ?? 'no participant'}`,
        type: 'api_error',
        code: 'model_offline',
      }
    case 'cancelled':
      return {
        ok: false,
        status: 502,
        message: `这次派发被取消：${r.reason ?? 'cancelled'}`,
        type: 'api_error',
        code: 'cancelled',
      }
    default:
      return { ok: false, status: 502, message: r.error ?? '派发失败', type: 'api_error', code: 'upstream_error' }
  }
}

/**
 * SSE 心跳间隔。派发可能要等到 {@link COMPLETION_TIMEOUT_MS}（两分钟），中间隔着反代
 * 与客户端各自的空闲超时；心跳走 SSE 注释行，按规范被解析器忽略，只用来说「还活着」。
 */
const STREAM_HEARTBEAT_MS = 15_000

interface StreamHandle {
  /** 结果定稿：内容一帧 + 收尾帧 + `[DONE]`。 */
  finish(content: string): void
  /** 派发失败：一帧 `error` 然后收掉连接（**不发 `[DONE]`**）。 */
  fail(out: Extract<CompletionOutcome, { ok: false }>): void
}

/**
 * 开一条 SSE，并**立刻**把首帧（角色 delta）发出去。
 *
 * 首帧不是装饰：它让连接当场建立，客户端不会干等到自己超时——这正是 §4.6 选择
 * 「先开流、后派发」的理由，代价是从这一刻起 HTTP 状态码就锁死在 200 了。
 */
function beginStream(
  res: ServerResponse,
  head: { readonly id: string; readonly created: number; readonly model: string },
): StreamHandle {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // nginx 一类反代默认缓冲 proxy_pass 的响应体；缓冲了就等于没有流。
    'x-accel-buffering': 'no',
  })

  const chunk = (choice: Record<string, unknown>): void => {
    const frame = {
      id: head.id,
      object: 'chat.completion.chunk',
      created: head.created,
      model: head.model,
      choices: [{ index: 0, ...choice }],
    }
    res.write(`data: ${JSON.stringify(frame)}\n\n`)
  }

  chunk({ delta: { role: 'assistant' }, finish_reason: null })

  const beat = setInterval(() => res.write(': keep-alive\n\n'), STREAM_HEARTBEAT_MS)
  // 心跳不该把进程钉住（尤其是测试里）。
  beat.unref()
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    clearInterval(beat)
  }
  // 客户端半路挂断也要把定时器收掉。
  res.on('close', stop)

  return {
    finish(content: string): void {
      stop()
      // 内容**只发一帧** —— 不假装分片（见顶注）。空正文时一帧都不发，累加仍然等于 ''。
      if (content.length > 0) chunk({ delta: { content }, finish_reason: null })
      chunk({ delta: {}, finish_reason: 'stop' })
      res.write('data: [DONE]\n\n')
      res.end()
    },
    fail(out): void {
      stop()
      // 200 已经写出去了，改不了。`status` 这个键不是 OpenAI 标准的，放它是因为
      // 「这本该是个 503 还是 504」在流里**结构上无处可说**，丢掉就真的丢了；
      // 多一个键对任何解析器都是无害的。
      const frame = {
        error: { message: out.message, type: out.type, code: out.code ?? null, param: null, status: out.status },
      }
      res.write(`data: ${JSON.stringify(frame)}\n\n`)
      res.end()
    },
  }
}
