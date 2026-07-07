# 接入现实生活 track(C)—— 让 AI 真能碰你的日常工具

> 北极星第 1 层「我的 AI 桌面:不写代码,AI 帮我做**实际**的事」的抓手。深度辅助
> 生活/工作的天花板,取决于 agent 能不能触达你**真实的**日历 / 邮件 / 消息 / 笔记 /
> 任务 / 记账。本 track 就是把这条触达面做宽、做可信。
>
> Last updated: 2026-07-07 · 里程碑 C-M1 done。

---

## 一、为什么(缺口)

框架早有完整的 MCP 连接器机制(见 [MCP-CONNECTOR-DIRECTORY.md](MCP-CONNECTOR-DIRECTORY.md)):
内置目录 + 一键装 + 架构师优先推荐已装组件。但目录里**一条现实生活工具都没有** ——
5 条内置全是知识 / 文件 / 检索类(fetch / chroma / obsidian / elasticsearch /
filesystem),分类里连 `calendar` / `email` / `tasks` 都不存在。一个普通人想让 AI
「看我今天的日程」「读我 Notion 里的笔记」「把这件事加进 Todoist」,**无从下手**。

用户在「还差多少」的战略盘点里拍板走 **C(接入现实生活)**:不是再加框架功能,而是
把触达现实生活的连接器面**做宽 + 做可信**,直接抬高「深度辅助」的天花板。

## 二、市场真相(先查市面的关键发现)

开工前按纪律核了官方 MCP 注册站(`registry.modelcontextprotocol.io`),一条**改变
路线的发现**:

- **现代生活连接器生态已整体迁到「托管远程 HTTP + OAuth」**。Notion 官方 = 托管
  `mcp.notion.com`(OAuth)、Todoist 官方 = 托管 `ai.todoist.net`(OAuth)、GitHub /
  Linear / Google / Microsoft 同理。**静态 token 的 stdio server 正在退场。**
- **日历**在注册站按 `google calendar` 搜**空** —— 没有干净的静态 token 日历 server。
  **日历 / 邮件 / 记账铁定是 OAuth 域(C-M2)。**
- 但生态里仍有**厂商官方 + 静态 token**的少数干净选择(Notion 自家 npm、Doist 自家
  npm 的本地 stdio 模式),配 Gotong 现成的 `${ENV}` 占位今天就能装能用。

**好消息**:出站连接的**管道已经通** —— `host/src/mcp-config.ts` 早已支持 http/sse
远程传输并把 `headers` 里的 `${TOKEN}` 从 host 环境 / vault 展开成 bearer。整个 track
唯一缺的硬件是 **出站 OAuth 的令牌获取流**(C-M2);OAuth2 原语(`oidc-client.exchangeCode`
+ `buildAuthorizationUrl`)也已存在(现只用于入站登录),搭出站不用从零起。

## 三、三条不可破边界

1. **全走 MCP,框架不存数据、不碰服务**。连接器 spec 只是「spawn 什么子进程 / 连哪个
   URL」的配方;hub 不存你的日历 / 邮件 / 笔记,全经 MCP 子进程或远程端点(同 RAG /
   KB 一脉)。搬走 `.gotong/` = 搬走全部,连接器不留数据尾巴。

2. **凭证纪律**。密钥只以 `${NAME}` 占位进 spec(C-M1,spawn 时对 host 环境展开)、
   或 OAuth 令牌进 **vault**(C-M2);**绝不**在目录 / 配置 / UI 表单里写明文。防腐测试
   钉死每个 `needsEnv` 只能是 `${NAME}` 占位。

3. **接入 ≠ 授权行动**(发现≠信任 在生活域的延伸)。装上连接器 = 给 agent 一件工具;
   但**高风险动作**(替你发邮件 / 花钱 / 删除)仍过既有 governed 审批闸(`personal-butler`
   的 allow/approve/refuse + 出站审批)。连上你的 Todoist **不等于** agent 能悄悄重排你
   的人生。这条让「深度辅助」可信,是本 track 与「随便挂个能干一切的 agent」的分界。

## 四、路线图

| 里程碑 | 交付 | 认证 | 状态 |
|---|---|---|---|
| **C-M1** | 现实生活连接器目录:笔记(Notion)/ 任务(Todoist)进内置目录,一键发现 + 装 | 静态 token(stdio) | ✅ done |
| **C-M2** | 出站 OAuth 连接器接入:日历 / 邮件 / 记账(Google / Microsoft / Notion-OAuth / Todoist-hosted)—— 「用 X 登录」按钮,令牌进 vault + 自动刷新,注入远程 MCP 的 bearer header | OAuth 2.1(出站) | 计划中 |
| **C-M3** | 动作安全加固(按需):agent 真发邮件 / 改日历 / 花钱时的审批闸打磨,复用既有 governed 闸 | — | 观察 |

## 五、里程碑记录

### C-M1 —— 现实生活连接器目录首批(静态 token)`6cd0a17`

`packages/web/src/builtin-mcp-connectors.ts` 加两条**厂商官方 + 静态 token**的生活域
连接器,并加 `tasks` 分类:

- **`notion-notes`**(分类 `notes`)—— Notion 官方 `@notionhq/notion-mcp-server`
  (`npx -y`,stdio),`needsEnv: NOTION_TOKEN`(内部集成密钥 `ntn_…`,在 Notion 开发者
  门户建 internal integration 拿,**非 OAuth**);whatFor 显式提示「要把页面/数据库
  共享给该集成,否则看不到」这个 Notion 特有前置。
- **`todoist-tasks`**(分类 `tasks`,新增)—— Doist 官方 `@doist/todoist-mcp`
  (`npx -y`,stdio),`needsEnv: TODOIST_API_KEY`(账号 Settings→Integrations 的个人
  API token);注记本地 stdio 走静态 token、托管版才 OAuth(留 C-M2)。

两条都对**官方 GitHub 仓库 README** 逐字核了命令与 token 环境变量(先查市面纪律,
不硬编造)。带凭证故显式带 `PATH: '${PATH}'`(env 一设子进程只继承列出的 key)。

零后端 / 路由 / schema 改动:一键装走既有 `POST /api/admin/mcp-servers`,catalog 路由
`GET /api/admin/mcp-connectors/catalog` 从常量派生,面板 `admin-src/mcp.js` 通用循环
渲染 —— 新条目自动出卡。爆炸半径锁在 web 常量 + 防腐测试 + 文档。

**验收**:防腐测试 `builtin-mcp-connectors.test.ts` 扩到 15 例(两条新 spec 各自过真
`validateMcpServersArray` + 无明文密钥 + id/名唯一 + 分类合法);catalog 路由测试
(真 HTTP)绿;web 全绿。

## 六、相关文档

| 想知道什么 | 读哪 |
|---|---|
| 连接器目录机制(内置目录 + 一键装 + 架构师优先推荐 + fetch 搜索配方) | [MCP-CONNECTOR-DIRECTORY.md](MCP-CONNECTOR-DIRECTORY.md) |
| MCP 接入(client + server)总览 | [MCP.md](MCP.md) |
| 凭证 / vault / 出站审批 | [SETTING-OPS-CONSOLE.md](SETTING-OPS-CONSOLE.md) |
| 有界治理 tool-loop(allow/approve/refuse,高风险动作过闸) | [ledger/PERSONAL-BUTLER-FINAL.md](ledger/PERSONAL-BUTLER-FINAL.md) |
