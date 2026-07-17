/**
 * provider-catalog.ts — the curated LLM provider catalog (data only).
 *
 * Moved here from `@gotong/host`'s personal-butler-llm-catalog (LSA-M6) so BOTH
 * consumers share ONE constant without a dependency cycle:
 *
 *   - the butler's benign `discover_llm_providers` tool (host — renders the
 *     suggestion card with the two red lines);
 *   - the `gotong model` interactive selector (cli — the CLI cannot depend on
 *     `@gotong/host`: host already depends on cli for `backup()`, so the data
 *     lives in this light package both can import).
 *
 * The catalog is a HAND-AUTHORED static constant, not a live web search — that
 * is a security stance, not laziness (see LSA-M0 / docs/zh/LLM-STEWARDSHIP.md
 * §③④): no untrusted observed content can pose as a credential source, and
 * registering / scraping keys stays a HUMAN act forever. Every base URL /
 * signup URL / free-tier limit was verified against the provider's official
 * docs on 2026-07-14 (see LSA-M3 ledger) — a member ACTS on these URLs, so a
 * wrong base URL would be a real harm. The host anti-rot test pins the set.
 */

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
    id: 'gemini',
    name: 'Google Gemini',
    tier: 'free-quota',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    whatFor: 'Google 自家 Gemini(Flash / Flash-Lite 等),上下文超长,走 OpenAI 兼容层直接用',
    costTruth:
      '免费档慷慨(Flash-Lite 约每天 1000 次、免信用卡),具体额度以 Google AI Studio 实时为准;' +
      '注意:免费档的输入 / 输出可能被 Google 用于改进产品(在意隐私就别拿它跑私密内容)',
    signupUrl: 'https://aistudio.google.com/apikey',
    signupSteps: [
      '用 Google 账号登录 aistudio.google.com',
      '打开 aistudio.google.com/apikey 点「Create API key」',
      '复制 key(免信用卡即可用免费档)',
    ],
    envHint: 'GEMINI_API_KEY',
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

/** Human-readable tier label (shared by the butler card and the CLI picker). */
export function llmProviderTierZh(t: LlmProviderTier): string {
  switch (t) {
    case 'free-quota':
      return '免费额度'
    case 'trial':
      return '试用额度'
    case 'low-cost':
      return '低价'
  }
}
