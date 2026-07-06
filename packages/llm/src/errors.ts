/**
 * CARE-M1 — provider 错误 → 类型化 kind 的纯函数分类器。
 *
 * 为什么放在 @gotong/llm 而不是各 provider 包:分类靠的是鸭子读法
 * (status / name / code / message / cause / 响应体),Anthropic SDK、
 * OpenAI SDK、undici fetch、Node net 错误的形状在这一层是可合并的;
 * 放这里则 host / im-bridge / 管家不必依赖任何具体 SDK 就能分类。
 * 与 agent.ts 的 isAuthFailure(窄,宁漏勿错杀 key)和 llm-openai 的
 * isTransientError(只答「该不该重试」)不同,这里回答的是「该怎么
 * 跟人解释」——三者判据可以重叠,职责不同,故意不合并。
 *
 * 分类是启发式:错不装懂。凑不齐证据一律 'unknown',由上层的诚实
 * 兜底文案带原文出场,绝不猜一个像样的病名。
 */

/** 可翻译成大白话的错误类别(host 侧 failure-translator 逐一配文案)。 */
export type LlmErrorKind =
  | 'auth'
  | 'quota'
  | 'rate_limited'
  | 'network'
  | 'model_not_found'
  | 'timeout'
  | 'unknown'

interface ErrShape {
  name?: unknown
  code?: unknown
  status?: unknown
  message?: unknown
  cause?: { name?: unknown; code?: unknown; message?: unknown }
  // OpenAI SDK: err.error = 响应体 {message,type,code};
  // Anthropic SDK: err.error = {type:'error', error:{type,message}}。
  error?: {
    code?: unknown
    type?: unknown
    message?: unknown
    error?: { type?: unknown; message?: unknown }
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 把散落在各层的文字证据合成一份小写检索文本。 */
function evidenceText(e: ErrShape): string {
  return [
    str(e.message),
    str(e.cause?.message),
    str(e.code),
    str(e.cause?.code),
    str(e.error?.code),
    str(e.error?.type),
    str(e.error?.message),
    str(e.error?.error?.type),
    str(e.error?.error?.message),
  ]
    .join(' ')
    .toLowerCase()
}

function names(err: object): string {
  const e = err as ErrShape & { constructor?: { name?: unknown } }
  return [str(e.name), str(e.constructor?.name), str(e.cause?.name)].join(' ')
}

export function classifyLlmError(err: unknown): LlmErrorKind {
  if (!err || typeof err !== 'object') return 'unknown'
  const e = err as ErrShape
  const status = typeof e.status === 'number' ? e.status : 0
  const text = evidenceText(e)
  const nm = names(err)
  const code = str(e.code) || str(e.cause?.code)

  // 顺序即优先级,先到先得:
  // timeout 先于 network——ETIMEDOUT / UND_ERR_*_TIMEOUT 同时长着网络
  // 错误的脸,但「超时」文案(换快模型/稍后再试)比「网络不通」可操作。
  if (
    /timeout/i.test(nm) ||
    ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code) ||
    /\btimed?.{0,1}out\b/.test(text)
  ) {
    return 'timeout'
  }

  // quota 先于 rate_limited 与 auth——OpenAI 把「额度耗尽」装在 429 里
  // (insufficient_quota),DeepSeek 用 402,Anthropic 用 400 说 credit
  // balance;若被当成限流,「稍等再试」会误导用户干等一个要充值的问题。
  if (
    status === 402 ||
    /insufficient[_ ]quota|exceeded your current quota|insufficient balance|credit balance|billing/.test(text)
  ) {
    return 'quota'
  }

  // 403 并入 auth:key 有效但无权(组织被禁/模型未开通),对用户的
  // 动作是同一件事——去核对凭证与账号权限。
  if (
    status === 401 ||
    status === 403 ||
    /authenticationerror|permissiondenied/i.test(nm) ||
    /authentication_error|permission_error|invalid api key|invalid x-api-key|incorrect api key/.test(text)
  ) {
    return 'auth'
  }

  // 529 是 Anthropic 的 overloaded——服务端过载,给用户的话术与限流
  // 一致(稍后再试),归并一类。
  if (
    status === 429 ||
    status === 529 ||
    /ratelimit/i.test(nm) ||
    /rate.?limit|overloaded_error|too many requests/.test(text)
  ) {
    return 'rate_limited'
  }

  // 404 只有带着「model」字样才敢断言是模型名问题;裸 404 可能是
  // base URL 路径配错(Ollama 的 "404 page not found"),不装懂,落
  // unknown 让原文自己说话。
  if (
    code === 'model_not_found' ||
    /model_not_found/.test(text) ||
    ((status === 404 || /notfounderror/i.test(nm)) && /model/.test(text))
  ) {
    return 'model_not_found'
  }

  if (
    ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET'].includes(code) ||
    /apiconnectionerror/i.test(nm) ||
    /fetch failed|socket hang up|premature close|getaddrinfo/.test(text) ||
    (status >= 500 && status <= 599)
  ) {
    return 'network'
  }

  return 'unknown'
}

/**
 * 供「原文如下」兜底用的安全摘要:永不 throw,永远给回一段有限长度、
 * 带得上 status 的原文——unknown 场景下这段文字就是全部诊断依据。
 */
export function llmErrorSummary(err: unknown, maxLen = 300): string {
  let out: string
  if (err instanceof Error) {
    const e = err as ErrShape
    const status = typeof e.status === 'number' ? ` (http ${e.status})` : ''
    out = `${err.name}${status}: ${err.message}`
  } else if (err && typeof err === 'object') {
    try {
      out = JSON.stringify(err)
    } catch {
      out = Object.prototype.toString.call(err)
    }
  } else {
    out = String(err)
  }
  return out.length > maxLen ? `${out.slice(0, maxLen)}…` : out
}
