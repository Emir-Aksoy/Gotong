// 内置出站 OAuth 连接器目录 —— C-M2-M5b。
//
// 心智模型(为什么这个文件存在):现实生活的连接器生态已整体迁到「托管远程
// HTTP + OAuth」—— 日历 / 邮件 / 记账不再发静态 token,而是「用 X 登录」拿一枚
// 会过期的 access token,注入远程 MCP 的 `Authorization: Bearer …` 头。C-M2 的
// M1–M4 把这条管道打通了(纯核 → vault 存储 → connect 流 → 活令牌注入 + 后台
// 刷新),但每接一个 provider,admin 都得自己去查四样东西:授权端点、令牌端点、
// 该填哪个 scope、以及「为什么拿不到 refresh_token」(Google 的 access_type=offline
// 坑)。这份目录把这些**市场真相**逐条烤进预设,admin 只需填自己注册的 OAuth
// 应用三件套(client_id / client_secret / 回调 URI),其余照抄。
//
// 这是**手写的框架级常量**(对比 AUTO-GENERATED 的 builtin-templates.ts),每条预设
// 的 `mcpServer` 都过真 `validateMcpServersArray` 防腐(见
// tests/builtin-oauth-connectors.test.ts),端点/scope 都对着 provider 官方文档
// (`sourceRef`)逐字核过,改坏即红。
//
// —— 三条边界(与 C-track 同源)——
//   ① 全走 MCP,框架不存数据:目录只给「怎么连」,连上后数据仍在 provider,搬走
//      `.gotong/` 无连接器数据尾巴。
//   ② 凭证纪律:预设里**没有**任何 client_id / client_secret 字段(结构性防泄漏);
//      `mcpServer` 的 bearer 头是**固定注入 ref** `${OAUTH_ACCESS_TOKEN}`,绝不明文
//      (M4a 按连接器的 mcpServerName 解析成该连接器的活令牌)。防腐测试钉死。
//   ③ 接入 ≠ 授权行动:挂上工具能读能写,但 agent 真发邮件 / 改日程仍过 personal-
//      butler 的 governed 审批闸 —— 目录只负责「连得上」,不负责「敢让它动」。
//
// —— 为什么现在只有 Google 两条 ——
// M1 核的令牌交换只做 `client_secret_post`(密钥进 body)。Google 收 body 密钥 ✓,
// 故日历 + Gmail 端到端可信。Notion-OAuth 的令牌端点**要 HTTP Basic 认证**,M1 还
// 不做,硬塞进去交换必 401 —— 那是坏预设,违背「做可信」,故 Notion-OAuth 显式推迟
// (笔记域 C-M1 的静态 token `notion-notes` 已覆盖;要 OAuth 版先给 M1 加
// client_secret_basic)。宁可少而可信,不铺不能用的卡。

import type { McpHttpServerSpec } from '@gotong/core'

/**
 * admin **必须**在安装时提供的字段 —— 他们自己在 provider 注册的 OAuth 应用三件套,
 * **永不烤进目录**(边界②)。UI 据此提示「这三样填你自己的」,其余照抄预设。
 * 回调 URI 是本 hub 的 `<公开地址>/api/oauth/callback`(M3b 固定路径),admin 既要
 * 在 provider 的「已授权重定向 URI」里登记它,也要在这里填一致的值。
 */
export const OAUTH_CONNECTOR_ADMIN_FIELDS = ['clientId', 'clientSecret', 'redirectUri'] as const

/**
 * 允许的生活域分类。单一真相源 —— 防腐测试拿它校验每条 `category` 合法,UI 也可据此
 * 分组。保持精简,只登已发的域;`finance` / `notes` / `tasks` 等随可信预设到位再加。
 */
export const OAUTH_CONNECTOR_CATEGORIES = ['calendar', 'email'] as const

export type OAuthConnectorCategory = (typeof OAUTH_CONNECTOR_CATEGORIES)[number]

/** 目录里的一条内置出站 OAuth 连接器预设(浏览 + 「用 X 登录」,不是 OAuth 编辑器)。 */
export interface BuiltinOAuthConnector {
  /** 稳定的目录 id(建议也当连接器 id)。给 UI / catalog 当 key。 */
  id: string
  /** 人类可读展示名(卡片标题)。 */
  name: string
  /** 生活域分类,必在 {@link OAUTH_CONNECTOR_CATEGORIES} 里。 */
  category: OAuthConnectorCategory
  /** 一句话用途 + 前置(怎么在 provider 注册 OAuth 应用)—— 给非技术用户看。 */
  whatFor: string
  /** provider 配置文档主页,帮 admin 完成前置(建 OAuth 客户端 / 启用 API)。 */
  homepage: string
  /** OAuth 授权端点(烤入的市场真相)。 */
  authorizationEndpoint: string
  /** OAuth 令牌端点(烤入)。 */
  tokenEndpoint: string
  /** provider 原生 scope(烤入,空格分隔)。绝不塞 `openid`。 */
  scope: string
  /**
   * provider 特有的额外授权参数(烤入)。最咬人的:Google 只在
   * `access_type=offline` 时发 refresh_token,`prompt=consent` 保证每次都拿到 ——
   * 没有它 M4b 的后台刷新无从保活,一小时后连接器就断。
   */
  extraAuthParams?: Record<string, string>
  /**
   * 这条连接器的活令牌喂给哪个 MCP server。`mcpServer.name` **就是**连接器的
   * `mcpServerName`(M4a 承重连接键):安装时 OAuth 连接器的 mcpServerName 取它,
   * M4a 的 secret source 按这个名把 `${OAUTH_ACCESS_TOKEN}` 解析成该连接器的活令牌。
   * bearer 头故意写死这个 ref,绝不明文(边界②)。
   */
  mcpServer: McpHttpServerSpec
  /** 溯源:端点 / scope 对着哪份 provider 官方文档核过(可核对,非字节相等)。 */
  sourceRef: string
}

/**
 * 内置出站 OAuth 连接器目录。目前只有 Google 两条(日历 + Gmail)—— 都对着 M1 核的
 * `client_secret_post` 端到端核过、正好填补「日历 / 邮件铁定是 OAuth 域」两个明确缺口。
 * 保持精简、可信、可连;宁缺毋滥(Notion-OAuth 等 M1 支持 client_secret_basic 再加)。
 */
export const BUILTIN_OAUTH_CONNECTORS: BuiltinOAuthConnector[] = [
  // —— calendar:Google 日历(Google 托管 MCP + Google OAuth)——
  {
    id: 'google-calendar',
    name: 'Google 日历',
    category: 'calendar',
    whatFor:
      '连接你的 Google 日历:让 AI 查看日程、创建 / 修改事件。工具经 Google 托管 MCP ' +
      '(calendarmcp.googleapis.com)挂载。前置 —— 在 Google Cloud Console 建一个 OAuth 2.0 ' +
      '客户端(Web 应用类型),把本 hub 的回调 URL(<公开地址>/api/oauth/callback)加进' +
      '「已授权的重定向 URI」,并在项目里启用 Google Calendar API。',
    homepage: 'https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/calendar',
    // Google 的坑:不带 access_type=offline 就没有 refresh_token,M4b 无从保活;
    // prompt=consent 确保重新授权时也照发(否则 Google 记得你授过就省略 refresh_token)。
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    mcpServer: {
      name: 'google_calendar',
      transport: 'http',
      url: 'https://calendarmcp.googleapis.com/mcp/v1',
      // M4a 按连接器 mcpServerName='google_calendar' 把此 ref 解析成活令牌;绝不明文。
      headers: { Authorization: 'Bearer ${OAUTH_ACCESS_TOKEN}' },
    },
    sourceRef:
      'https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server(Google 官方,2026-06 核)',
  },

  // —— email:Gmail(Google 托管 MCP + Google OAuth,同一套凭证模型)——
  {
    id: 'gmail',
    name: 'Gmail 邮件',
    category: 'email',
    whatFor:
      '连接你的 Gmail:让 AI 读邮件、起草 / 发送、管理标签。工具经 Google 托管 MCP ' +
      '(gmailmcp.googleapis.com)挂载。前置同 Google 日历 —— Google Cloud Console 建 OAuth 2.0 ' +
      '客户端、加回调 URI、启用 Gmail API(同一个客户端可同时勾日历 + Gmail 两个 scope)。',
    homepage: 'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    // gmail.modify = 读 + 起草 / 发送 / 打标签(不含永久删除)。真发信仍过 governed 审批闸
    // (边界③);嫌宽可在连接器里 PATCH 收窄成 gmail.readonly / gmail.send。
    scope: 'https://www.googleapis.com/auth/gmail.modify',
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    mcpServer: {
      name: 'gmail',
      transport: 'http',
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      headers: { Authorization: 'Bearer ${OAUTH_ACCESS_TOKEN}' },
    },
    sourceRef:
      'https://developers.google.com/workspace/gmail/api/reference/mcp(Google 官方,2026-06 核)',
  },
]

/** M4a 固定注入 ref —— 与 host `oauth-secret-source.ts` 的 OAUTH_ACCESS_TOKEN_REF 对齐。 */
export const OAUTH_ACCESS_TOKEN_BEARER = 'Bearer ${OAUTH_ACCESS_TOKEN}'
