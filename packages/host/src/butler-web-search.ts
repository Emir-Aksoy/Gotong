/**
 * butler-web-search.ts — WSE:把「联网搜索」变成阿同 key 即用的一类能力。
 *
 * LSA-M2 把两条官方搜索连接器(Tavily 托管 http / Brave stdio)放进了目录,但
 * 「阿同自己就能搜」在现状下仍有两道断点,本模块一次收口:
 *
 *   1. **装配断点** —— 目录路径要面板两步(装连接器 + 把 server 挂进管家行的
 *      `useMcpServers`)。这里补 env 快路:`TAVILY_API_KEY` / `BRAVE_API_KEY`
 *      在环境里 ⇒ host 自动把对应目录 spec 追加到**管家行**的 MCP specs
 *      ({@link detectButlerWebSearchSpecs} + {@link mergeButlerBonusMcpSpecs},
 *      pool 只对 butler 行调用;成员自己配的同名 server 永远赢)。
 *   2. **分级断点** —— 两家官方 server 都没标 `readOnlyHint`(2026-07-16 对
 *      tavily-ai/tavily-mcp 与 brave/brave-search-mcp-server 源码逐字核过:
 *      Tavily 工具定义零 annotations;Brave 只有 title+openWorldHint),工具名
 *      (`tavily_search`/`brave_web_search`)又不以 read 动词开头,按
 *      `defaultMcpToolClass` 的 fail-safe 全落 governed —— 每搜一次 park 一次。
 *      {@link classifyButlerMcpTool} 补 server 级只读知识:这两台 server 的
 *      工具面全是「读外部世界」(搜网页/抽正文/搜新闻),不存在「写用户数据」
 *      的对象;server 自己的显式声明(annotations)仍然最大 —— 未来某工具真标了
 *      destructiveHint,我们照 govern。
 *
 * ── 为什么 env 名不带 GOTONG_ 前缀 ────────────────────────────────────────
 * 探测名被目录 spec 的占位钉死:spec 里写的是 `${TAVILY_API_KEY}`,凭证解析
 * (`envSecretSource`)按这个名字查 process.env —— 探测名 ≠ 占位名的话,挂上也
 * 展不开。且这两个名字是 Tavily/Brave 生态的惯例凭证名(与目录 `needsEnv`、
 * 面板提示一致,一份 key 两条路径通用),同 `MEM0_API_KEY` 先例:连接器凭证,
 * 非 GOTONG_* 行为旋钮。
 *
 * ── 授权论证(为什么设了 key 就自动挂管家)─────────────────────────────────
 * 把 key 放进 host 环境本身就是最粗粒度的 opt-in:面板路径装连接器时 key 进
 * vault,env 里根本不需要有 —— env 里出现 TAVILY_API_KEY 的唯一动机就是「让
 * 这台 hub 的 AI 能搜」。要精细控制(只给某台 agent 不给管家)的部署,走面板
 * vault 路径即可,两条路互不干扰。数据边界照旧诚实:搜索词离盒是目录里
 * `dataLeavesBox: true` 早已披露的既定事实;把搜到的东西拿去对外发仍是
 * governed 动作(接入 ≠ 授权)。
 */

import type { McpServerSpec } from '@gotong/core'
import { BUILTIN_MCP_CONNECTORS } from '@gotong/web'

import { defaultMcpToolClass, NAME_SEP, type ButlerMcpTool } from './personal-butler-mcp.js'

/** 目录里的两条官方搜索连接器(LSA-M2)。specs / env 名 / server 名全从目录
 * 条目派生 —— 单一事实源,防两份漂移(防腐测试钉住条目存在性与形状)。 */
const WEB_SEARCH_CONNECTOR_IDS = ['tavily-web-search', 'brave-web-search'] as const

const WEB_SEARCH_CONNECTORS = WEB_SEARCH_CONNECTOR_IDS.map((id) =>
  BUILTIN_MCP_CONNECTORS.find((c) => c.id === id),
).filter((c): c is NonNullable<typeof c> => c !== undefined)

/** server 级只读名单(= 目录条目的 spec.name:'tavily' / 'brave')。 */
export const WEB_SEARCH_READONLY_SERVERS: readonly string[] = WEB_SEARCH_CONNECTORS.map(
  (c) => c.spec.name,
)

/**
 * 管家 MCP 工具的 read/write 分级 —— `defaultMcpToolClass` 外面包一层
 * 官方搜索 server 的只读知识。优先级:server 显式 annotations > read 动词
 * 名启发 > **搜索 server 名单** > fail-safe write。名单只接住「毫无信号」
 * 的兜底段,server 自己声明的 write 永远尊重。
 */
export function classifyButlerMcpTool(tool: ButlerMcpTool): 'read' | 'write' {
  const cls = defaultMcpToolClass(tool)
  if (cls === 'read') return 'read'
  const a = tool.annotations
  // 显式声明过 write(readOnlyHint:false / destructiveHint:true)→ 尊重,不豁免。
  if (a?.readOnlyHint === false || a?.destructiveHint === true) return 'write'
  const sep = tool.name.indexOf(NAME_SEP)
  if (sep > 0 && WEB_SEARCH_READONLY_SERVERS.includes(tool.name.slice(0, sep))) return 'read'
  return 'write'
}

/**
 * env 快路探测:目录条目声明的凭证 env(`needsEnv`)全都非空 ⇒ 返回该条目的
 * spec(原样引用,key 只以 `${NAME}` 占位在 spec 里,明文永不进来 —— 展开发生
 * 在 spawn 时的 `envSecretSource`)。没设 key ⇒ `[]` ⇒ 全链路字节不变。
 */
export function detectButlerWebSearchSpecs(
  env: Record<string, string | undefined>,
): McpServerSpec[] {
  const out: McpServerSpec[] = []
  for (const c of WEB_SEARCH_CONNECTORS) {
    const needs = c.needsEnv ?? []
    if (needs.length === 0) continue
    if (needs.every((k) => (env[k] ?? '').trim() !== '')) out.push(c.spec)
  }
  return out
}

/**
 * 把 host 探测到的 bonus specs 并进管家行已解析的 MCP specs。同名让位 ——
 * 成员/管理员自己配的 server(inline 或 useMcpServers)永远赢,bonus 只补缺。
 * bonus 为空时原数组原样返回(零分配,非管家路径字节不变)。
 */
export function mergeButlerBonusMcpSpecs(
  resolved: McpServerSpec[],
  bonus: readonly McpServerSpec[],
): McpServerSpec[] {
  if (bonus.length === 0) return resolved
  const have = new Set(resolved.map((s) => s.name))
  const extra = bonus.filter((s) => !have.has(s.name))
  return extra.length === 0 ? resolved : [...resolved, ...extra]
}
