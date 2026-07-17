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
// LSA-M6 — the catalog DATA moved to @gotong/llm so the `gotong model` CLI
// selector shares the same constant (cli cannot depend on host: host→cli
// already exists for backup()). Re-exported here so every existing consumer
// and the anti-rot test keep their import path unchanged.
import { CURATED_LLM_PROVIDERS, llmProviderTierZh, type ButlerLlmProviderOption } from '@gotong/llm'

export { CURATED_LLM_PROVIDERS }
export type { ButlerLlmProviderOption, LlmProviderTier } from '@gotong/llm'

const tierZh = llmProviderTierZh

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
