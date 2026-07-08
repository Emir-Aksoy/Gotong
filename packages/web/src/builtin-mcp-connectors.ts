// 内置 MCP 连接器目录 —— 组建工作流 / 建 agent 时「可直接组装的组件」清单。
//
// 心智模型(为什么这个文件存在):一个 workflow step `dispatch` 到一个
// **capability** → capability 由一个 **agent** 提供 → agent 的能力常来自它挂的
// **MCP server**(`ManagedAgentSpec.useMcpServers`)。所以「能直接组装的 MCP 组件」
// 对用户一直是黑箱:得自己知道 `npx -y @elastic/mcp-server-elasticsearch` 这种命令。
// 这份目录把若干框架级参考预设摆出来,admin 一键装进 hub 的 MCP 注册表
// (`POST /api/admin/mcp-servers`,既有路由),agent 表单里就能按名勾选。
//
// 这是**手写的框架级常量**,不是从 examples/ 生成的模板(对比 builtin-templates.ts
// 那个 AUTO-GENERATED 文件)。每条 `spec` 都过真 `validateMcpServersArray` 防腐
// (见 tests/builtin-mcp-connectors.test.ts),改坏即红。
//
// 「主流注册站搜索」走 **fetch 配方**(decision,本会话用户拍板):目录里放一个
// 通用联网取数(fetch)连接器,文档内置官方注册站的 REST 搜索配方
// (`GET https://registry.modelcontextprotocol.io/v0/servers?search=<kw>`)。零自研
// 注册表、不赌第三方搜索器、指向的是官方权威源;agent 挂上即可实时搜几万个 server。

import type { McpServerSpec } from '@gotong/core'

/**
 * 允许的连接器分类。导出当单一真相源 —— 防腐测试拿它校验每条 `category` 合法,
 * UI 也可据此分组。`discovery` 是「去主流注册站找更多」的入口类,其余按组件用途分。
 */
export const MCP_CONNECTOR_CATEGORIES = [
  'discovery',
  'rag',
  'notes',
  'tasks',
  'memory',
  'search',
  'files',
  'web',
] as const

export type McpConnectorCategory = (typeof MCP_CONNECTOR_CATEGORIES)[number]

/** 目录里的一条内置 MCP 连接器(浏览 + 一键装,不是 MCP 编辑器)。 */
export interface BuiltinMcpConnector {
  /** 稳定的目录 id(与 spec.name 解耦,给 UI / catalog 当 key)。 */
  id: string
  /** 人类可读的展示名(卡片标题)。与 `spec.name`(技术标识 / 工具前缀)分开。 */
  name: string
  /** 用途分类,必在 {@link MCP_CONNECTOR_CATEGORIES} 里。 */
  category: McpConnectorCategory
  /** 一句话用途 —— 给非技术用户看「这东西能干嘛」。 */
  whatFor: string
  /** 官网 / 文档主页,帮用户了解前置条件(装 uv/node、开插件等)。 */
  homepage?: string
  /**
   * 用户**必须**自己在 host 环境里设的环境变量名(凭证类)。UI 据此提示
   * 「只填变量名,密钥不入库」。spec.env 里这些 key 一律是 `${NAME}` 占位
   * (spawn 时对 host 环境展开),绝不在目录里写明文(防腐测试钉死)。
   */
  needsEnv?: string[]
  /** 风险提示 —— 宽能力连接器(fetch / filesystem)的诚实警示。 */
  caveat?: string
  /**
   * **数据离盒告知**(MU-M4,北极星第 1 层「凭证/数据只在本机」的诚实披露原语):
   * `true` = 用这个连接器,你的内容会**离开本机**发往第三方云(SaaS)。面板据此对
   * 这类卡**无条件**印一条醒目的「数据离开本机」提示(不靠每条 caveat 自觉写),让
   * 「接入前就知道数据去哪」成为结构保证而非文案善意。诚实覆盖:凡是把用户数据搬去
   * 外部云的都标(mem0 记忆云 / Notion / Todoist 云 API),本地进程(chroma 本地 /
   * filesystem / obsidian 本地 REST)不标。尤其记忆连接器(dataLeavesBox 的首要对象)
   * ——「接入≠授权」:挂上工具能读写 ≠ 自动把你的私密记忆同步出去,那仍是管家的
   * governed 动作,得你点头。
   */
  dataLeavesBox?: boolean
  /** 溯源:这条预设在哪个 example / 包里被演示过(可核对,非字节相等)。 */
  sourceRef?: string
  /** 装进 hub MCP 注册表的实际配置。安装 = `POST /api/admin/mcp-servers {spec}`。 */
  spec: McpServerSpec
}

/**
 * 内置连接器目录。`discovery` 一条(fetch 配方)+ 若干 Gotong 已演示过的开箱
 * 组件。保持精简、可信、可装 —— 不追求覆盖全生态(那是 `discovery` 去主流注册站
 * 搜的事)。
 *
 * 关于 `env` 与 `PATH`:`McpStdioServerSpec.env` 一旦设置,子进程**只**拿到你列的
 * key(SDK 默认继承被丢掉)。所以带凭证的连接器(obsidian/es)必须把
 * `PATH: '${PATH}'` 显式带上,否则 `uvx`/`npx` 可能找不到。不设 env 的连接器
 * (chroma/fetch/filesystem)走完整默认继承,无需操心。
 */
export const BUILTIN_MCP_CONNECTORS: BuiltinMcpConnector[] = [
  // —— discovery:fetch 配方,去主流注册站实时搜 ——
  {
    id: 'mcp-registry-search',
    name: 'MCP 注册站搜索(fetch)',
    category: 'discovery',
    whatFor:
      '联网取数连接器。给 agent 挂上后,用 fetch 工具请求官方注册站 REST API ' +
      '(GET https://registry.modelcontextprotocol.io/v0/servers?search=<关键词>),' +
      '从几万个公开 MCP server 里实时检索可挂载的组件 —— 找不到现成的就来这里找。',
    homepage: 'https://registry.modelcontextprotocol.io',
    caveat:
      '⚠️ 通用 fetch 可请求任意 URL(近似 SSRF)。只给信任的 agent,用途限注册站搜索;' +
      '别挂到会被不可信输入驱动的 agent 上。',
    sourceRef: 'docs/zh/MCP-CONNECTOR-DIRECTORY.md',
    // 官方参考 fetch server(Python,PyPI `mcp-server-fetch`,uvx 即装即跑)。
    spec: {
      name: 'registry_search',
      command: 'uvx',
      args: ['mcp-server-fetch'],
    },
  },

  // —— rag:本地向量知识库 ——
  {
    id: 'chroma-rag',
    name: 'Chroma 向量知识库',
    category: 'rag',
    whatFor:
      '本地向量知识库(RAG):把文档灌进集合,再按相似度检索。' +
      '工具 knowledge__add_to_collection / knowledge__query_collection。',
    homepage: 'https://www.trychroma.com',
    sourceRef: 'examples/rag-mcp',
    spec: {
      name: 'knowledge',
      command: 'uvx',
      args: ['chroma-mcp', '--persist-dir', '.gotong/knowledge/research'],
    },
  },

  // —— notes:Obsidian 笔记库 ——
  {
    id: 'obsidian-notes',
    name: 'Obsidian 笔记库',
    category: 'notes',
    whatFor:
      '连接本地 Obsidian 笔记库(需在 Obsidian 里启用「Local REST API」社区插件):' +
      '全文搜索 + 读取笔记。工具 obsidian__search / obsidian__get_file_contents。',
    homepage: 'https://obsidian.md',
    needsEnv: ['OBSIDIAN_API_KEY'],
    sourceRef: 'examples/obsidian-kb',
    // 只带必需的凭证 + PATH;HOST/PORT 省略走 mcp-obsidian 默认(127.0.0.1:27124)。
    spec: {
      name: 'obsidian',
      command: 'uvx',
      args: ['mcp-obsidian'],
      env: {
        OBSIDIAN_API_KEY: '${OBSIDIAN_API_KEY}',
        PATH: '${PATH}',
      },
    },
  },

  // —— notes:Notion 工作区(Notion 官方 server,静态内部集成 token)——
  {
    id: 'notion-notes',
    name: 'Notion 笔记 / 文档',
    category: 'notes',
    whatFor:
      '连接你的 Notion 工作区:搜索、读写页面与数据库。工具以 notion__ 前缀挂载。' +
      '前置 —— 在 Notion 建一个 internal integration 拿集成密钥(ntn_…),' +
      '并把要给 AI 用的页面 / 数据库「共享」给该集成:没共享的内容它看不到。',
    homepage: 'https://developers.notion.com/docs/get-started-with-mcp',
    needsEnv: ['NOTION_TOKEN'],
    // 云 SaaS:你的页面/数据库内容经该集成读写,数据离开本机(MU-M4 诚实披露)。
    dataLeavesBox: true,
    sourceRef: 'https://github.com/makenotion/notion-mcp-server(Notion 官方)',
    // 静态内部集成 token(非 OAuth)。env 一设子进程只继承列出的 key,故显式带 PATH。
    spec: {
      name: 'notion',
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      env: {
        NOTION_TOKEN: '${NOTION_TOKEN}',
        PATH: '${PATH}',
      },
    },
  },

  // —— tasks:Todoist 任务(Doist 官方 server,静态个人 API token)——
  {
    id: 'todoist-tasks',
    name: 'Todoist 任务',
    category: 'tasks',
    whatFor:
      '连接你的 Todoist:查看 / 新建 / 完成任务、管理项目与截止日期。工具以 todoist__ 前缀挂载。' +
      '前置 —— 在 Todoist 账号 Settings → Integrations → Developer 复制个人 API token。',
    homepage: 'https://github.com/Doist/todoist-mcp',
    needsEnv: ['TODOIST_API_KEY'],
    // 云 SaaS:本地 stdio 进程,但你的任务数据经 Todoist 云 API 往返(MU-M4 诚实披露)。
    dataLeavesBox: true,
    sourceRef: 'https://github.com/Doist/todoist-mcp(Doist 官方)',
    // 本地 stdio 走静态个人 API token;托管 ai.todoist.net/mcp 才走 OAuth(留 C-M2)。
    spec: {
      name: 'todoist',
      command: 'npx',
      args: ['-y', '@doist/todoist-mcp'],
      env: {
        TODOIST_API_KEY: '${TODOIST_API_KEY}',
        PATH: '${PATH}',
      },
    },
  },

  // —— memory:Mem0 记忆云(官方托管 MCP,数据离盒)——
  {
    id: 'mem0-memory',
    name: 'Mem0 记忆云',
    category: 'memory',
    whatFor:
      '把 AI 的长期记忆托管到 Mem0 云:add_memory 存下事实、search_memory 按语义召回。' +
      '工具以 mem0__ 前缀挂载。适合想要托管式、跨设备共享记忆层的用户 —— 由 Mem0 做' +
      '服务端的事实抽取与多信号检索(它的强项)。前置 —— 在 app.mem0.ai 注册拿平台 API key。',
    homepage: 'https://docs.mem0.ai/platform/mem0-mcp',
    needsEnv: ['MEM0_API_KEY'],
    // 数据离盒:记忆是最私密的东西,存进 Mem0 云 = 离开本机。面板据 dataLeavesBox 醒目告知。
    dataLeavesBox: true,
    caveat:
      '⚠️ 你的记忆会存到 Mem0 的云端(离开本机)。它是「托管记忆层」而非本机 .gotong/ 文件:' +
      '搬走目录不会带走 Mem0 里的数据,隐私边界也交给 Mem0。接入≠授权 —— 挂上工具只是让' +
      '管家「能」读写云记忆,真把私密内容同步出去仍是管家的 governed 动作,得你点头。',
    sourceRef: 'https://docs.mem0.ai/platform/mem0-mcp(Mem0 官方托管 MCP)',
    // 官方托管远程 MCP:Streamable HTTP + Bearer(密钥走 ${ENV} 占位,spawn 时对 host 环境
    // 展开,不落库)。静态 stdio 版已随 OpenMemory 退场,官方现推云端点 —— 与现代连接器
    // 「托管+令牌」大势一致(同 C-M2 抓到的市场真相)。
    spec: {
      name: 'mem0',
      transport: 'http',
      url: 'https://mcp.mem0.ai/mcp',
      headers: {
        Authorization: 'Bearer ${MEM0_API_KEY}',
      },
    },
  },

  // —— search:Elasticsearch 索引 ——
  {
    id: 'elasticsearch',
    name: 'Elasticsearch 搜索索引',
    category: 'search',
    whatFor:
      '查询 Elasticsearch 索引:列索引、看 mapping、跑 query DSL 搜索。' +
      '工具 es__list_indices / es__get_mappings / es__search。',
    homepage: 'https://www.elastic.co',
    needsEnv: ['ES_URL', 'ES_API_KEY'],
    caveat:
      'Elastic 已弃用独立 MCP server,后续方向是 Agent Builder 的 MCP 端点;' +
      '此预设走仍可用的 stdio 服务,长期可改成 http 端点 + bearer。',
    sourceRef: 'examples/elasticsearch-kb',
    spec: {
      name: 'es',
      command: 'npx',
      args: ['-y', '@elastic/mcp-server-elasticsearch'],
      env: {
        ES_URL: '${ES_URL}',
        ES_API_KEY: '${ES_API_KEY}',
        // 非凭证配置:压掉 server 在 stdio 上的 OpenTelemetry 日志。
        OTEL_LOG_LEVEL: 'none',
        PATH: '${PATH}',
      },
    },
  },

  // —— files:本地文件系统(宽能力,带警示)——
  {
    id: 'filesystem',
    name: '本地文件系统',
    category: 'files',
    whatFor:
      '读写指定目录下的文件(默认沙箱 .gotong/files,相对 host 工作目录)。' +
      '官方参考实现,常用于让 agent 读项目文件 / 产出物落盘。',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    caveat:
      '⚠️ 授予对该目录的读写权限。按需收窄路径,别指向敏感目录;' +
      'args 里的路径不做 ${ENV} 展开,要改请直接换成绝对路径。',
    sourceRef: '@modelcontextprotocol/server-filesystem(官方参考实现)',
    spec: {
      name: 'files',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.gotong/files'],
    },
  },
]
