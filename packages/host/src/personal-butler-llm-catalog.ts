/**
 * personal-butler-llm-catalog.ts — LSA-M3. The resident butler's BENIGN way to
 * answer "有没有(免费的)模型我可以加 / 怎么加个备用" — the legitimate,
 * role-separated redesign of the user's ③④ ask ("学会自己去找各种免费的 api key、
 * 自己管理").
 *
 * ── Why a STATIC catalog, not an LLM web-crawl ───────────────────────────────
 * The literal ask — 阿同 autonomously finds free keys online and manages them —
 * is refused by design (see docs/zh/LLM-STEWARDSHIP.md §③④):
 *   · registering an account is a PROHIBITED action (create-account/enter-password);
 *   · a "free key" scraped off the web is UNTRUSTED observed content (shared /
 *     leaked / ToS-violating — using it is exactly the abuse the framework rejects);
 *   · giving a prompt-injectable tool-loop WRITE access to the vault is an
 *     injection-surface explosion (one injection swaps the endpoint / exfiltrates).
 * So the role split: 阿同 DISCOVERS + SUGGESTS (this hand-authored constant, like
 * builtin-mcp-connectors — NOT a live web search, so no untrusted source can pose
 * as a credential), and the HUMAN registers, gets their own key, and enters it
 * into the vault. Credential WRITE stays owner+vault forever; this tool is read-only
 * suggestion. Same "接入≠授权 / 发现≠信任" as the C and NET tracks.
 *
 * ── What it renders ──────────────────────────────────────────────────────────
 * A curated shortlist of free / low-cost OpenAI-wire-compatible providers, each
 * with the honest free-tier truth (limits, not marketing), the official signup
 * link, a 3-step get-a-key guide, the base URL to configure, and the env var to
 * hold the key. Every fact here was verified against the provider's official docs
 * on 2026-07-14 (not from memory) — a member ACTS on these URLs, so a wrong base
 * URL would be a real harm.
 *
 * Benign, always offered (same class as list_my_capabilities — describing options
 * to the member's OWN owner touches nobody else). Zero LLM (pure constant render),
 * zero state, no new env knob, no host surface. The catalog is exported so the
 * anti-rot test pins it against the real constant (mirrors builtin-mcp-connectors).
 */

import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'

/** How "free" a provider really is — honest classification, not marketing. */
export type LlmProviderTier = 'free-quota' | 'trial' | 'low-cost'

/** One curated provider option the member can register for and add themselves. */
export interface ButlerLlmProviderOption {
  /** Stable slug (the anti-rot test pins the set). */
  id: string
  /** Display name. */
  name: string
  /** Honest tier: free-with-limits / trial-credit / cheap-but-paid. */
  tier: LlmProviderTier
  /**
   * OpenAI-wire-compatible base URL to configure (all current entries speak the
   * OpenAI protocol → configured as an "OpenAI 兼容" provider). Verified against
   * the provider's official docs 2026-07-14.
   */
  baseUrl: string
  /** One line — what it's good for. */
  whatFor: string
  /** HONEST cost/free truth: real limits or "not free", never marketing. */
  costTruth: string
  /** Official page where the HUMAN registers + creates a key (never 阿同). */
  signupUrl: string
  /** 3-step get-a-key guide — the steps the HUMAN performs. */
  signupSteps: readonly string[]
  /** Suggested env var name to hold the key (only the NAME reaches the framework). */
  envHint: string
}

/**
 * The curated shortlist. Deliberately SMALL and verified — this is the "指过去"
 * seed, not a mirror of the whole market (that would rot and can't be verified).
 * Every base URL / signup URL / free-tier limit below was checked against the
 * provider's official docs on 2026-07-14 via WebFetch (see LSA-M3 ledger).
 */
export const CURATED_LLM_PROVIDERS: readonly ButlerLlmProviderOption[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    tier: 'free-quota',
    baseUrl: 'https://openrouter.ai/api/v1',
    whatFor: '一个 key 聚合几百个模型(含多个免费模型),后端 provider 间自动容错切换',
    costTruth:
      '带 :free 后缀的模型免费,但限每天 50 次、每分钟 20 次;一次性充 $10 后免费模型升到每天 1000 次(每分钟不变)',
    signupUrl: 'https://openrouter.ai/keys',
    signupSteps: [
      '用 Google / GitHub 登录 openrouter.ai',
      '打开 openrouter.ai/keys 新建一个 API key',
      '复制 key(想用免费模型就挑模型名带 :free 后缀的)',
    ],
    envHint: 'OPENROUTER_API_KEY',
  },
  {
    id: 'groq',
    name: 'Groq',
    tier: 'free-quota',
    baseUrl: 'https://api.groq.com/openai/v1',
    whatFor: '自研 LPU 芯片,推理极快;跑开源模型(Llama / Qwen 等)延迟很低',
    costTruth: '有免费档,按每分钟请求数 / token 数(RPM / TPM)限流;超出要升付费档',
    signupUrl: 'https://console.groq.com/keys',
    signupSteps: [
      '登录 console.groq.com',
      '打开 console.groq.com/keys 新建一个 API key',
      '复制 key',
    ],
    envHint: 'GROQ_API_KEY',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    tier: 'free-quota',
    baseUrl: 'https://api.cerebras.ai/v1',
    whatFor: '晶圆级芯片推理,速度极快;跑开源大模型(Llama / Qwen 等)',
    costTruth: '免费档每天 100 万 token、上下文 8192;更高要升付费档',
    signupUrl: 'https://cloud.cerebras.ai/',
    signupSteps: [
      '登录 cloud.cerebras.ai',
      '在控制台的 API Keys 里新建一个 key',
      '复制 key',
    ],
    envHint: 'CEREBRAS_API_KEY',
  },
  {
    id: 'together',
    name: 'Together AI',
    tier: 'trial',
    baseUrl: 'https://api.together.ai/v1',
    whatFor: '一站跑很多开源模型(Llama / Qwen / DeepSeek 等),按用量付费',
    costTruth: '注册免费,新账号有一笔试用额度 + 少量常驻免费模型;额度用完转按量付费',
    signupUrl: 'https://api.together.ai/settings/api-keys',
    signupSteps: [
      '注册登录 together.ai',
      '打开 api.together.ai/settings/api-keys 新建一个 key',
      '复制 key',
    ],
    envHint: 'TOGETHER_API_KEY',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    tier: 'low-cost',
    baseUrl: 'https://api.deepseek.com',
    whatFor: '自家强模型(deepseek-chat / deepseek-reasoner),中英俱佳,单价很低',
    costTruth: '非免费,但很便宜(按 token 计费,具体单价以官网为准);想要稳定质量又省钱时合适',
    signupUrl: 'https://platform.deepseek.com/api_keys',
    signupSteps: [
      '注册登录 platform.deepseek.com',
      '打开 platform.deepseek.com/api_keys 新建一个 key',
      '充一点余额(很便宜)后即可用',
    ],
    envHint: 'DEEPSEEK_API_KEY',
  },
]

/** Human-readable tier label. */
function tierZh(t: LlmProviderTier): string {
  switch (t) {
    case 'free-quota':
      return '免费额度'
    case 'trial':
      return '试用额度'
    case 'low-cost':
      return '低价'
  }
}

/**
 * The two RED LINES, rendered every time so the member always hears them (and the
 * model can't drift into offering to "just register it for you"): 阿同 never
 * registers / scrapes keys, and 阿同 only reads keys — writing stays owner+vault.
 */
const RED_LINES =
  '⚠️ 两条红线:① 注册账号、拿 key 只能你来,我不替你注册,也绝不去网上「捡」别人的 key' +
  '(那种多半泄露 / 违规,拿去调用正是该拒绝的滥用);② 我对你的 key 只读不写 —— 配好后我能看到' +
  '「用的哪个 provider、健不健康」(list_my_llms),但改 / 存 key 永远是你 + 金库的事。'

/** How to actually wire a chosen provider once the human has a key. */
const HOW_TO_WIRE =
  '拿到 key 后怎么用:你(或管理员)在 admin 的助手配置页新建 / 编辑一个 agent,provider 选' +
  '「OpenAI 兼容」,base URL 填上面那条,model 填该家的模型名,API key 走对应环境变量(只填变量名给' +
  '框架、密钥不入库)或金库。配好我就能调它了 —— 想让它当备用(某个挂了自动切),在那个 agent 的' +
  '「备用链 / fallbacks」里加一条即可。'

/** Render the suggestion card from the curated catalog (pure — the model summarizes it). */
export function renderProviderCatalog(options: readonly ButlerLlmProviderOption[]): string {
  const blocks = options.map((o) => {
    const steps = o.signupSteps.map((s, i) => `     ${i + 1}. ${s}`).join('\n')
    return [
      `【${tierZh(o.tier)}】${o.name} —— ${o.whatFor}`,
      `   · 费用真相:${o.costTruth}`,
      `   · base URL:${o.baseUrl}`,
      `   · 拿 key(你来做):\n${steps}`,
      `   · 注册页:${o.signupUrl}`,
      `   · key 放到环境变量:${o.envHint}`,
    ].join('\n')
  })
  return [
    '想给我(阿同)加个模型 / 找个更省的?这几个可以自己注册拿 key(我只给建议,注册和填 key 得你来):',
    '',
    blocks.join('\n\n'),
    '',
    HOW_TO_WIRE,
    '',
    RED_LINES,
  ].join('\n')
}

const DISCOVER_TOOL: LlmToolDefinition = {
  name: 'discover_llm_providers',
  description:
    '当用户想给你(阿同)加模型、找免费 / 便宜的模型、问「有没有免费的 api」「openrouter 能用吗」「怎么加个备用模型」这类时调用,拿到一份策展好的可选 provider 清单(含免费额度真相、注册链接、拿 key 三步、base URL、环境变量名)再答。清单是给你参考的骨架,用你自己的话、结合上下文回给用户,别整段照抄。铁律:你只负责发现和建议,注册账号 / 拿 key / 填 key 永远是用户自己来,你绝不替他注册、也绝不去网上找现成的 key。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

class ButlerLlmCatalogToolset implements LlmAgentToolset {
  listTools(): LlmToolDefinition[] {
    return [DISCOVER_TOOL]
  }

  async callTool(name: string): Promise<LlmToolCallResult> {
    if (name !== 'discover_llm_providers') {
      return { content: [{ type: 'text', text: `未知工具:${name}` }], isError: true }
    }
    return { content: [{ type: 'text', text: renderProviderCatalog(CURATED_LLM_PROVIDERS) }] }
  }
}

/**
 * Build the benign free-provider-discovery toolset (always offered — pure static
 * catalog render, no surface / deps needed).
 */
export function buildButlerLlmCatalogToolset(): LlmAgentToolset {
  return new ButlerLlmCatalogToolset()
}
