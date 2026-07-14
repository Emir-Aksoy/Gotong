# 内置 MCP 连接器目录 + 主流注册站搜索 + 架构师优先推荐可装配组件

> 用户原问:「我们组建工作流能调用的组件(mcp 连接)的资料有没有直接内置连接?
> 让工作流组建时优先看看可以直接组装的组件。」
>
> 本文记录这套「目录 + fetch 配方 + 架构师增强」的设计与用法。
> Last updated: 2026-06-23 · 里程碑 MCD-M1→M5 · 纯本地 main。

---

## 一、为什么(解决什么)

组建工作流时,「能调用的组件」对用户一直是黑箱。一条链路要走四层:

```
   workflow step  ──dispatch──▶  capability  ──由谁提供──▶  agent  ──能力来自──▶  MCP server
   (你在 YAML 里写的)            (一个能力标签)        (托管 agent)      (ManagedAgentSpec.useMcpServers)
```

所以「可直接组装的 MCP 组件」其实分两问:

1. **建 agent 时能挑哪些 MCP 连接?** —— 以前要自己知道 `uvx chroma-mcp` /
   `npx -y @elastic/mcp-server-elasticsearch` 这种命令,无从下手。
2. **组建工作流时,架构师知不知道哪些 capability 背后有真组件?** —— 以前不知道,
   于是 AI 会**编造** capability 名,生成跑不起来的工作流。

两个缺口都让「组装」变难,违北极星「我的 AI 桌面:不写代码,AI 帮我做实际的事」。
这套收口分别堵上:**目录 + 一键装**(缺口 1)+ **架构师优先推荐已装组件**(缺口 2)。

**关键:约 80% 积木早就存在。** 这不是造新东西,而是「接线 + 喂一条 dead seam +
一份常量目录 + 一个面板」。core / protocol / identity / runner / host 路由全程零改,
零 schema 变动,爆炸半径锁在 web + 两个架构师调用点 + 文档 + 一个防腐测试。

---

## 二、先查市面(「有现成的就指过去」的前提核实,2026-06)

用户拍板的前提是「主流站现成且能让 agent 去搜」。核实如下:

| 注册站 / 目录 | 角色 | 可被 agent 程序化搜? |
|---|---|---|
| **官方 MCP Registry** `registry.modelcontextprotocol.io` | Anthropic / GitHub / 微软 / PulseMCP 共建背书的**权威源**,托管指向 npm / PyPI / Docker 的 server 元数据 | ✅ 公开 REST `GET /v0/servers?search=`,游标翻页,有 OpenAPI |
| **PulseMCP / Glama / Smithery** | 抓取生态的**发现目录**(Glama 中期收录 ~37k server),各有自己的 API,社区还有「Registry MCP Server」包装器 | ✅ 各有 API |

> **注册站 vs 发现目录之分**:官方 Registry 是**权威元数据源**(谁发布了什么、装在哪);
> PulseMCP / Glama 这类是**发现层**(抓取 + 排名 + 富化展示)。我们指向**官方权威源**,
> 不赌第三方发现器的稳定性与排名口径。

**结论:主流权威源现成且可程序化搜 → 走「fetch 配方」指向官方 REST,不自建注册表;
另留一份轻量内置目录,当未来自建 MCP 导航站的种子。**

---

## 三、三个交付物

### 交付 1 — 内置连接器目录(浏览 + 一键装)

`packages/web/src/builtin-mcp-connectors.ts` 手写一组**框架级参考预设**
`BUILTIN_MCP_CONNECTORS`。注意这是**手写常量**,不是从 `examples/` 生成的模板
(对比 `builtin-templates.ts` 那个 AUTO-GENERATED 文件):这些是 `McpServerSpec`
级别的「积木」,手写比写生成器更轻。每条 `spec` 都过真 `validateMcpServersArray`
防腐(`tests/builtin-mcp-connectors.test.ts`),改坏即红。

当前目录(精简、可信、可装 —— 不追求覆盖全生态,那是 `discovery` 去搜的事):

| id | 展示名 | 分类 | 用途一句话 | 需要的环境变量 |
|---|---|---|---|---|
| `mcp-registry-search` | MCP 注册站搜索(fetch) | `discovery` | 联网取数,去官方注册站实时搜几万个 server | — |
| `chroma-rag` | Chroma 向量知识库 | `rag` | 本地向量 RAG:灌文档 + 相似度检索 | — |
| `obsidian-notes` | Obsidian 笔记库 | `notes` | 连本地 Obsidian(需 Local REST API 插件):全文搜 + 读笔记 | `OBSIDIAN_API_KEY` |
| `notion-notes` | Notion 笔记 / 文档 | `notes` | 连你的 Notion:搜索 / 读写页面与数据库(Notion 官方 server) | `NOTION_TOKEN` |
| `todoist-tasks` | Todoist 任务 | `tasks` | 连你的 Todoist:查看 / 新建 / 完成任务(Doist 官方 server)⚠️数据离盒 | `TODOIST_API_KEY` |
| `mem0-memory` | Mem0 记忆云 | `memory` | 把 AI 长期记忆托管到 Mem0 云:存事实 + 语义召回(官方托管 MCP,Bearer 头)⚠️数据离盒 | `MEM0_API_KEY` |
| `elasticsearch` | Elasticsearch 搜索索引 | `search` | 查 ES 索引:列索引 / 看 mapping / query DSL | `ES_URL` `ES_API_KEY` |
| `tavily-web-search` | Tavily 联网搜索 | `web` | 给 AI 接通用互联网搜索(专为 LLM 优化,返回干净正文):搜网页 / 抽正文 / 爬站(官方托管 remote,Bearer 头)⚠️数据离盒 | `TAVILY_API_KEY` |
| `brave-web-search` | Brave 联网搜索 | `web` | 给 AI 接 Brave 搜索引擎(独立索引 / 注重隐私):网页 / 新闻 / 本地 / 图片(官方 stdio)⚠️数据离盒 | `BRAVE_API_KEY` |
| `filesystem` | 本地文件系统 | `files` | 读写指定沙箱目录的文件(官方参考实现) | — |

> **「接入现实生活」track(C)**:`notion-notes` / `todoist-tasks` 是把目录伸向日常
> 生活工具的第一批(C-M1),都是**厂商官方 server + 静态 token**(非 OAuth)。生态里
> **日历 / 邮件 / 记账**等已整体迁到「托管远程 + OAuth」,那层由 **C-M2** 补出站 OAuth
> 后接入 —— 见 [REAL-LIFE-CONNECTORS.md](REAL-LIFE-CONNECTORS.md)。

> **「记忆升级」track(MU-M4):外部记忆 provider + 数据离盒披露原语**。`mem0-memory`
> 把管家的长期记忆托管到 **Mem0 云**(官方现推**托管远程 HTTP + Bearer** 端点
> `https://mcp.mem0.ai/mcp`,静态 stdio 版随 OpenMemory 退场 —— 同 C-M2 抓到的
> 「托管+令牌」市场大势)。同轮引入 `BuiltinMcpConnector.dataLeavesBox` **诚实披露
> 原语**:凡把你的数据搬去第三方云的连接器(mem0 记忆 / Notion / Todoist)都标 `true`,
> 面板对这类卡**无条件**印醒目的「数据离开本机」提示(不靠每条 caveat 自觉)。三条边界
> 不破:**全走 MCP 框架不存第二份**(搬走 `.gotong/` 无残留)、**凭证只 `${MEM0_API_KEY}`
> 占位进 header**(密钥不入库)、**接入≠授权**(挂上工具能读写云记忆,真同步私密内容仍过
> 管家 governed 闸)。见 [MEMORY-UPGRADE.md](MEMORY-UPGRADE.md)。

> **「管家 LLM 自省与自治」track(LSA-M2):通用 web search 落 `web` 分类**。之前目录只有
> `mcp-registry-search`(搜 MCP 注册站)、`obsidian`/`chroma`(搜本地),**没有一个搜互联网** ——
> `web` 分类一直预留空着。LSA-M2 补两条**厂商官方**通用搜索:`tavily-web-search`(Tavily 官方
> **托管远程 HTTP + Bearer**,专为 LLM 优化返回干净正文)+ `brave-web-search`(Brave 官方 **stdio**,
> 独立索引注重隐私)。三边界同 C/MU:**全走 MCP 不存数据**、**凭证 `${NAME}` 占位**、**接入≠授权**
> (搜索是 benign 读,但「把搜到的东西拿去对外发」仍过管家 governed 闸)。两条都标 `dataLeavesBox`
> —— 搜索词 + key 都发往第三方云。**隐私红线钉进防腐测试**:Tavily 的 key 只走 `Authorization`
> 头,**绝不进 URL query**(即便官方也支持 `?tavilyApiKey=`,我们不走 —— 敏感值永不放查询串)。
> 接上后管家的 `list_my_capabilities` 自省清单里就真有 websearch 了。见 [LLM-STEWARDSHIP.md](LLM-STEWARDSHIP.md)。

分类单一真相源 = `MCP_CONNECTOR_CATEGORIES`(`discovery` / `rag` / `notes` /
`tasks` / `memory` / `search` / `files` / `web`)。防腐测试钉死:目录顺序固定、id / 展示名 / `spec.name`
三者各自唯一、`category` 必在允许集、整组过 `validateMcpServersArray`、`dataLeavesBox`
标记集固定(增删即可见 diff)、且**每个 `needsEnv` 凭证只能以 `${NAME}` 占位出现在
`spec.env`(stdio)或 `headers`(http/sse,如 mem0 的 `Bearer ${MEM0_API_KEY}`)里、绝不写明文**
(连「写一半的占位」`${ES_API_KEY` 都会被逮)。

**catalog 路由**:`GET /api/admin/mcp-connectors/catalog` → `{ connectors: [...] }`,
仅 `requireAdmin`。这是**纯 web 常量**,不需要 host surface(安装才用既有
`mcpRegistry`)。

**一键安装**:目录卡片的「安装」按钮 POST 到**早就存在**的
`POST /api/admin/mcp-servers`(`{ spec, description }`)。装完即进 hub 的 MCP
注册表(`mcp-servers.json`),agent 表单的 `useMcpServers` 勾选框里立刻出现该项。
目录只读 + 安装 —— **改命令 / 删仍走既有「MCP 集成」标签页**,目录不是 MCP 编辑器。

> **凭证不入库**:`needsEnv` 的卡片提示「在 host 环境设 `X`(只填变量名)」。spec 里
> 写的是 `${X}` 占位,spawn 子进程时对 host 环境展开。密钥从不进 `mcp-servers.json`,
> 从不过 UI 表单。

> **关于 `env` 与 `PATH`**:`McpStdioServerSpec.env` 一旦设置,子进程**只**拿到你列的
> key(SDK 默认继承被丢掉)。所以带凭证的连接器(obsidian / es)必须显式带上
> `PATH: '${PATH}'`,否则 `uvx` / `npx` 可能找不到。不设 env 的连接器
> (chroma / fetch / filesystem)走完整默认继承,无需操心。

### 交付 2 — fetch 配方(主流注册站搜索)

「让 agent 去主流站搜」**不是**自研搜索服务,而是目录里的一条 `discovery` 连接器:
一个通用**联网取数(fetch)**MCP server + 一份内置的官方注册站 REST 搜索配方。
agent 挂上即可实时检索几万个公开 server。

连接器预设(`mcp-registry-search`):

```jsonc
{
  "name": "registry_search",
  "command": "uvx",
  "args": ["mcp-server-fetch"]   // 官方参考 fetch server,PyPI `mcp-server-fetch`,uvx 即装即跑
}
```

**搜索配方** —— 给 agent 的指令里教它请求官方注册站:

```
# 按关键词搜公开 MCP server
GET https://registry.modelcontextprotocol.io/v0/servers?search=<关键词>

# 游标翻页
GET https://registry.modelcontextprotocol.io/v0/servers?search=<关键词>&cursor=<上一页返回的 nextCursor>
```

返回里每个 server 带名字、描述、以及指向 npm / PyPI / Docker 的安装坐标 —— agent
读到后就能告诉你「装这个、命令是 `uvx xxx`」,你再回目录的「MCP 集成」标签页手动
登记(本次不做「搜到即自动装」,见 §五推迟项)。

> **⚠️ SSRF 诚实警示**:通用 fetch 是**宽能力** —— 它能请求任意 URL,近似 SSRF。
> 目录把它框定为「注册站搜索」用途、admin 知情 opt-in、卡片标注风险。**只给信任的
> agent**,别挂到会被不可信输入(外部消息 / 网页内容)驱动的 agent 上,否则注入的
> 指令可能让它打内网地址。同理 `filesystem` 也带读写警示。

### 交付 3 — 架构师优先推荐可装配组件(喂 dead seam)

工作流架构师(`@gotong/workflow-assistant` 的 `WorkflowAssistantAgent`,
cap `workflow:assist`)早就**完整消费**一条 `contextHints.mcpServers?: string[]`
输入 —— `renderUserMessage()` 会把它渲染成 prompt 里的「Available MCP servers:」
清单。但这条 seam 从 Phase 13 起**从没人喂**。MCD-M4 把它接活:

- **admin 路径**(纯前端即可,web mirror + host input 类型早含 `mcpServers`、路由
  verbatim 转发):`admin-src/mcp.js` 加一个 DOM-free 的
  `loadInstalledMcpServerNames()`,自取 `/api/admin/mcp-servers`;
  `admin-wf-assist.js` 在 author 模式提交时填 `contextHints.mcpServers`。
  (这里解了一个 eager-agent / lazy-mcp 不对称:admin SPA 开机即拉 agents/workflows,
  但 MCP 列表是懒加载的,所以**提交时新取一遍** server 名,不靠可能还是冷的缓存。)
- **成员路径**(host 服务改):`MeWorkflowCreateService` 与 `MeWorkflowEditService`
  的 `contextHints()` 加可选 `mcpServerNames?` 依赖 + 转 async + best-effort
  try/catch;`main.ts` 共享一个
  `async () => (await space.mcpServers()).map(r => r.spec.name)` 闭包注入两个服务。

效果:架构师 prompt 得知「这些 MCP 后端可用」→ **优先围绕已装组件建工作流、少编造**。

> **deepCheck 仍不校验 MCP server 名** —— server 名**不是 capability**(它低一层),
> 没有运行时 inventory 可校验。`inventoryFromContextHints` 故意忽略 `mcpServers`。
> 架构师的 deepCheck 只查 agent / capability / step ref 那些「parseWorkflow 接受了
> 但运行时会爆」的事,MCP 名不在其列。喂 `mcpServers` 只是给 prompt 提示,不是加闸。

---

## 四、架构诚实(边界)

- **框架不存知识、不连集群**:目录里的连接器 spec 只是「spawn 什么子进程」的配方。
  hub 不存向量 / 文档 / 索引,不连 Chroma / ES / Obsidian —— 全走 MCP 子进程
  (同 [RAG-VIA-MCP](RAG-VIA-MCP.md) / [KB-CONNECTORS](KB-CONNECTORS.md) 一脉)。
- **目录在 hub 装,架构师优先用已装**:安装是 admin 的事(`POST /api/admin/mcp-servers`);
  成员只在架构师里**用**已装的组件,不自己装(MCP 是 admin 管的资源)。
- **跨 hub 两层闸不变**:联邦时,某 hub 装的 MCP server 提供给 peer 仍过两层 ——
  MCP server 自身的 ACL + Gotong 的 per-link KB allowlist(C-M1 `gateKnowledgeBaseRpc`)。
  目录不改这套。
- **诚实失败**:catalog 路由逐条 try/catch(理论上常量不会炸);fetch / filesystem
  这类宽能力连接器卡片显式标 caveat。装 discovery 连接器后**不会自动建** agent,
  也**不会搜到即自动装** —— 都留给人确认。

---

## 五、显式推迟

1. **自建 MCP 导航站** —— 本目录是它的种子,不是它本身。
2. **专用「注册站搜索」社区 server 当目录条目** —— 用户选了 fetch 配方;真要更顺手可
   后补一条 `search` 类目项,但那是「赌第三方搜索器稳定性」的决策,留给那时。
3. **成员侧 `/me` 自助装 MCP 连接器** —— MCP 是 admin 管的;成员只在架构师里用已装的。
4. **架构师把每个 agent 标注「MCP / KB-backed」的更细粒度提示** —— 本次只喂扁平
   server 名清单(= 既有 seam 形状)。
5. **deepCheck 校验 MCP server 名** —— server 名非 capability,无运行时 inventory
   可校验,保持现状。
6. **一键装 discovery 连接器后自动建一个「MCP 侦察兵」agent / 搜到即自动装** ——
   本次只装连接器 + 文档配方,建 agent / 登记搜到的 server 仍走既有表单。

---

## 六、相关文档

| 想知道什么 | 读哪 |
|---|---|
| MCP 接入(client + server)总览 | [MCP.md](MCP.md) |
| RAG —— 向量检索 via MCP(框架不存知识) | [RAG-VIA-MCP.md](RAG-VIA-MCP.md) |
| 知识库连接器(Obsidian / Elasticsearch / 向量 RAG) | [KB-CONNECTORS.md](KB-CONNECTORS.md) |
| 工作流架构师(大白话 → YAML + 按深度讲解 + 配图;消费 `contextHints`) | [WORKFLOW-ARCHITECT.md](WORKFLOW-ARCHITECT.md) |
| AI 辅助 workflow 编辑(assistant + deepCheck) | [AI-WORKFLOW-EDITOR.md](AI-WORKFLOW-EDITOR.md) |

---

## 里程碑

| 里程碑 | 交付 |
|---|---|
| MCD-M1 | 内置连接器目录数据 `builtin-mcp-connectors.ts` + 防腐测试(每条过真 `validateMcpServersArray`) |
| MCD-M2 | catalog 路由 `GET /api/admin/mcp-connectors/catalog` + 路由测试 |
| MCD-M3 | admin「MCP 集成」标签页:内置连接器目录面板 + 一键安装(POST 既有 `/api/admin/mcp-servers`) |
| MCD-M4 | 架构师优先推荐可装配组件 —— 喂 dead seam `contextHints.mcpServers`(admin 前端 + 两个成员 host 服务) |
| MCD-M5 | 本文档 + 交叉链 + CLAUDE.md 登记 + 全量回归 |
