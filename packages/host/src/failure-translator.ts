/**
 * CARE-M1 — LLM 失败翻译官:类型化 kind → 大白话 + 修复指路。
 *
 * 为什么只管文案:host 域的病(IM token 失效 / 端口占用 / 磁盘)已有
 * admin-health / workspace-check 出事实与 fix,这里不重复判定,只把
 * @gotong/llm 的 classifyLlmError 结果翻成人话。纯函数、不读 env——
 * 语言由调用方传入(host 的 GOTONG_DEFAULT_LANG 已在装配层解析过,
 * 这里再读一遍就有两个真相源)。
 *
 * unknown 的铁律:不装懂。headline 直说「不认识」,detail 带原文摘要
 * ——错误的病名比没有病名更害人(用户会按错的方子抓药)。
 *
 * 修复指路只指真实存在的表面:管理页 Agents 卡(供应商/模型/key 都在
 * 那配)、`gotong setting check`、`gotong doctor`。不发明不存在的锚点。
 */

import { classifyLlmError, llmErrorSummary, type LlmErrorKind } from '@gotong/llm'

export type FailureLang = 'zh' | 'en'

export interface LlmFailureTranslation {
  kind: LlmErrorKind
  /** 一句大白话:出了什么事。 */
  headline: string
  /** 一句修复指路:去哪、做什么。 */
  fix: string
  /** 仅 unknown 携带:原文摘要,诚实兜底的全部依据。 */
  detail?: string
}

const COPY: Record<LlmErrorKind, Record<FailureLang, { headline: string; fix: string }>> = {
  auth: {
    zh: {
      headline: '大模型拒绝了我们的 API key(认证失败)。',
      fix: '到管理页 Agents 卡核对这个 agent 的供应商和 key;或在服务器上跑 `gotong setting check` 做配置体检。',
    },
    en: {
      headline: 'The LLM provider rejected our API key (authentication failed).',
      fix: 'Check this agent\'s provider and key on the admin Agents page, or run `gotong setting check` on the server.',
    },
  },
  quota: {
    zh: {
      headline: '大模型账户的余额或额度不够了。',
      fix: '去供应商控制台充值或提额;或到管理页 Agents 换一个 key / 换一家供应商。',
    },
    en: {
      headline: 'The LLM account is out of credit or over its quota.',
      fix: 'Top up in the provider console, or switch the key/provider on the admin Agents page.',
    },
  },
  rate_limited: {
    zh: {
      headline: '请求太密,被大模型限流了。',
      fix: '稍等几分钟再试;经常出现就降低并发,或升级供应商套餐。',
    },
    en: {
      headline: 'Too many requests — the LLM provider is rate-limiting us.',
      fix: 'Wait a few minutes and retry; if it keeps happening, lower concurrency or upgrade the provider plan.',
    },
  },
  network: {
    zh: {
      headline: '连不上大模型服务(网络不通,或服务端出了故障)。',
      fix: '检查服务器的网络/代理和 base URL 配置;`gotong doctor` 能帮你体检环境。',
    },
    en: {
      headline: 'Cannot reach the LLM service (network trouble, or the provider is down).',
      fix: 'Check the server\'s network/proxy and the base URL; `gotong doctor` can run an environment check-up.',
    },
  },
  model_not_found: {
    zh: {
      headline: '配置里的模型名不存在,或这个 key 没权限用它。',
      fix: '到管理页 Agents 核对模型名——可能拼错、下线,或要先在供应商侧开通。',
    },
    en: {
      headline: 'The configured model does not exist, or this key has no access to it.',
      fix: 'Check the model name on the admin Agents page — it may be misspelled, retired, or not enabled for this key.',
    },
  },
  timeout: {
    zh: {
      headline: '等大模型回话,等超时了。',
      fix: '稍后重试;老是超时就换个响应更快的模型,或检查网络链路。',
    },
    en: {
      headline: 'Timed out waiting for the LLM to respond.',
      fix: 'Retry later; if it times out often, switch to a faster model or check the network path.',
    },
  },
  unknown: {
    zh: {
      headline: '我不认识这个错——不猜病名,原文在下面,照原文查最快。',
      fix: '把原文交给管理员,或查 host 日志定位。',
    },
    en: {
      headline: 'I don\'t recognize this error — no guessing; the original text is below.',
      fix: 'Hand the original text to your admin, or check the host logs.',
    },
  },
}

/** kind 已知时直接取文案(CARE-M2 的边沿播报只有 kind 没有原始错误)。 */
export function translateLlmFailureKind(kind: LlmErrorKind, lang: FailureLang): LlmFailureTranslation {
  const copy = COPY[kind][lang]
  return { kind, headline: copy.headline, fix: copy.fix }
}

/** 从原始错误一步到位:分类 + 文案 + unknown 的原文兜底。 */
export function translateLlmFailure(err: unknown, lang: FailureLang): LlmFailureTranslation {
  const kind = classifyLlmError(err)
  const out = translateLlmFailureKind(kind, lang)
  if (kind === 'unknown') out.detail = llmErrorSummary(err)
  return out
}
