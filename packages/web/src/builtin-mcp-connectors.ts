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
