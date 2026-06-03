# 知识库连接器 —— Obsidian / Elasticsearch / 向量 RAG（全走 MCP）

> Status: 设计落地（v5 Stream E / E3）
>
> Last updated: 2026-06-03
>
> Previous reading: `docs/zh/RAG-VIA-MCP.md`（向量 RAG via MCP，本文的母版 +
> `mcpServers` 字段完整 schema）+ `docs/zh/MCP.md`（Hub **作为** MCP server，
> 方向相反）。

## 一、设计立场:AipeHub 不存知识

跟 RAG 一样,**笔记库、搜索索引、向量库 一律不进 AipeHub**。`identity.sqlite`
里没有 documents 表、没有 vectors 表;host 不调 embedding API、不连你的
Elasticsearch 集群、不读你的 Obsidian vault。这些都通过
[Model Context Protocol](https://modelcontextprotocol.io) 接进来 —— 每个
agent 在自己的 `mcpServers` 里声明它要的 server,host 把它当子进程拉起,把
它的工具(`<server>__<tool>` 形式,分隔符 `__`)接进 agent 的 LLM tool-use loop。

「知识库连接器」因此**不是 AipeHub 的一个新子系统**,而是同一个 MCP 接入模式
的三种形态:

| 形态 | 数据长什么样 | worked example | server |
|---|---|---|---|
| 向量 RAG | embedding / 语义检索 | [`examples/rag-mcp/`](../../examples/rag-mcp/) | chroma-mcp / qdrant / pinecone |
| 文档库 | Markdown 笔记 + 全文搜索 | [`examples/obsidian-kb/`](../../examples/obsidian-kb/) | `uvx mcp-obsidian` |
| 搜索索引 | 结构化文档 + query DSL | [`examples/elasticsearch-kb/`](../../examples/elasticsearch-kb/) | `npx @elastic/mcp-server-elasticsearch` |

三者对 AipeHub 是同构的:agent YAML 里一段 `mcpServers`,host 一个子进程,
工具一个 namespace。换库就是换 server,agent 抽象零改。

这条路线的代价 + 收益跟 RAG 那篇完全一致(锁定零 / 迁移零 / `identity.sqlite`
保持小可备份 / 单文件二进制不受 native binding 拖累;代价是 admin UI 没有
「知识库管理」页 —— 那是各 server 自己的事)。详见 `docs/zh/RAG-VIA-MCP.md` 第一节。

## 二、配置:`mcpServers` 字段（一眼）

Obsidian 例:

```yaml
# examples/obsidian-kb/agents/obsidian-researcher.yaml
mcpServers:
  - name: obsidian
    command: uvx
    args: [mcp-obsidian]
    env:
      OBSIDIAN_API_KEY: ${OBSIDIAN_API_KEY}
```

Elasticsearch 例:

```yaml
# examples/elasticsearch-kb/agents/elasticsearch-researcher.yaml
mcpServers:
  - name: es
    command: npx
    args: [-y, "@elastic/mcp-server-elasticsearch"]
    env:
      ES_URL: ${ES_URL}
      ES_API_KEY: ${ES_API_KEY}
      OTEL_LOG_LEVEL: none      # 让 server 别在 stdio 上打 OpenTelemetry 日志
```

agent 看到的工具就是 `obsidian__search` / `es__list_indices` / `es__search` …
字段完整 schema(`name`/`command`/`args`/`env`/`cwd`、`${VAR}` 占位、每 agent
独占子进程的生命周期)在 `docs/zh/RAG-VIA-MCP.md` 第二节,本文不重复。

## 三、凭证

短版本跟 RAG 一篇相同:**`${VAR}` 占位 → host `process.env`(或加密 vault)
注入到 `mcpServers[].env`**,host 启动前 `export`。三个 example 的 README 各给了
逐步的 `export` 清单。要点:

- **永不把 `ES_API_KEY` / `OBSIDIAN_API_KEY` 硬编码进 YAML**。模板导出时
  非 `${...}` 的值会被 scrub 成占位符(见第六节),但源头就别写明文。
- **凭证不进 audit log**;走漏面在 MCP server 一侧,不在 AipeHub。

## 四、读 vs 写 —— 治理与人工复核

知识库连接器最大的脚枪是**写工具**。Obsidian server 暴露
`obsidian__append_content` / `patch_content` / `delete_file`;Elasticsearch
的 key 给了写权限就能改索引。三个 shipped agent 的 prompt **都是只读取向**的,
但 LLM 能调到的工具由 server 决定,不由 prompt 决定。

防护分三层,**按需叠加**:

1. **最小权限凭证** —— 给只读 API key(ES 在 Kibana 里 scope 到只读 + 限定
   索引;Obsidian 的 Local REST API key 控制不到读写,就靠后两层)。这是最硬的
   一层:agent 越不过 key 的权限。
2. **`governance` 元数据**(Phase 19 P5)—— 在 workflow 上声明
   `dataSensitivity` / `requiredCredentials` / `requiredHumanRoles`,admin 卡片
   出风险摘要徽章。**这是声明,不是执行闸** —— 它让风险可见,不自动拦。
3. **human-in-the-loop 步骤**(Phase 16)—— 真正要拦「删笔记 / 改索引」这种
   不可逆动作,在 workflow 里插一个 `human:` 步骤,派给一个人签字才往下走。
   这是执行闸。

一句话:**只读默认、写要显式、不可逆要人闸**。

## 五、配额

走通用 `mcp_calls` 指标,**不区分** RAG / 笔记搜索 / ES query —— AipeHub 看到的
只是一次 MCP 工具调用,判不出 server 内部是哪种操作,不同 server 的「一次调用」
成本也天差地别。两层 quota(AipeHub 侧 `mcp_calls` 上限挡死循环 + server 侧按
key 自管)详见 `docs/zh/RAG-VIA-MCP.md` 第五节,知识库连接器没有 KB-specific 的
计量代码。

## 六、跨 hub 知识共享 —— 两层闸

把某个 KB(= 一个共享 MCP server)开放给 peer hub 时,有**两层独立的闸**,
缺一不可:

**第一层:MCP server 自己的 ACL。** 共享 chroma / ES 集群在 server 侧做
IP allowlist + per-key 权限(只读 token、scope 到索引)。这是 RAG-VIA-MCP
「六-bis 跨 hub 知识共享」的结论:knowledge 是纯数据平面,客户端-服务端拓扑
+ 访问控制 MCP 协议天然处理,AipeHub 不在外面再封一层 shared_with 模型。

**第二层:AipeHub per-link 的 KB allowlist(v5 C-M1)。** 这是 RAG-VIA-MCP
写作时还没有的新东西。即使一个 KB 的 MCP server 在本 hub 共享了,**也不等于每个
peer 都能调它** —— 每条 peer link 有一个 `allowedKnowledgeBases` 契约
(identity v17 `allowed_knowledge_bases_json`):

| 值 | 含义 |
|---|---|
| `null`(默认) | 全部共享 KB 可调(legacy 兼容) |
| `[]` | 锁死 —— 该 peer 一个 KB 都调不到(hard lock) |
| `['kb-a', 'kb-b']` | 白名单 —— 只有这两个名字的 KB 可调 |

执行点在 `packages/host/src/peer-kb-gate.ts` 的纯函数
`gateKnowledgeBaseRpc(inner, allowed)`,它包住 per-link 的共享 RPC responder:

- `mcp.listShared`(发现)→ **过滤**,只返 name ∈ allowed 的行(off-list 的 KB
  连存在都不暴露);
- `mcp.listTools` / `mcp.callTool` → `params.server ∉ allowed` 一律**拒**
  (fail-closed backstop,挡住 peer 猜名字直调);
- 其余直透。

**匹配标识 = 共享 MCP server 名 = KB 槽位名**。这是诚实的执行点:KB 调用走的是
`mcp.callTool` RPC,不走 task dispatch,所以闸必须包 per-link 的 rpcResponder,
而不是看 task 字段。多组织隔离 E2E(`host/tests/stream-c-isolation-e2e.test.ts`)
钉死了「一个 home hub 连两个 peer,orgX 夹到 `['kb-a']`、orgY 全开,一次证 KB 轴
互不污染」。详见 `docs/zh/V5-C-FINAL.md`。

> 配套的还有节点级 data-class 闸(C-M2 + P4-M4):workflow 节点的
> `dataClasses` 盖到 `Task.dataClasses`,出站时按 per-link `allowedDataClasses`
> 判 —— KB allowlist 管「能调哪个库」,data-class 管「能带哪类数据出门」,两轴正交。

## 七、模板里的 KB 槽位 —— 带引用不带内容

用 `aipehub.template/v1` 模板搬走一整套 agent + workflow 时(v5 Stream B),
KB **永远以引用形式进模板,绝不带知识内容**(锁定决策 #4)。模板里的 KB 槽位是:

- `name` + 内联 `mcpServer` 配置(`XOR` `useMcpServer` 引用一个已装的共享 server);
- 可选 `presetData` 指针 —— 指向「该往这个库里灌什么」的来源(一个 URL / 一份
  manifest),**不是知识本身**。

也就是说模板搬走的是「这个 agent 需要一个叫 `knowledge` 的库 + 怎么接它」,
不是库里的几万条文档。导入方拿到模板后自己接自己的库(或按 `presetData` 指针
去灌)。这跟「AipeHub 不存知识」一脉相承 —— 连模板这种「打包搬家」场景也不破例。
详见 `docs/zh/V5-B-FINAL.md`。

## 八、故障排查

通用症状(`spawn ENOENT` / 工具列表空 / 工具名对不上 / 并发写冲突)跟 RAG 一篇
第七节同表,本文只补两个连接器特有的:

| 症状 | 原因 / 解法 |
|---|---|
| Obsidian:工具能列出但调用全 401/连不上 | Obsidian 没开,或「Local REST API」社区插件没启用/key 不对。`mcp-obsidian` 是通过那个插件的 HTTPS 端点(默认 `127.0.0.1:27124`)读 vault 的 —— 插件不在就没有数据源。 |
| Elasticsearch:`es__search` 报权限/索引不存在 | `ES_API_KEY` 的权限不够,或 scope 没覆盖那个索引。先让 agent `es__list_indices` 看 key 实际能看到哪些索引 —— agent 越不过 key 的权限。 |
| Elasticsearch:stdio 上一堆 OTel 噪声 | 没设 `OTEL_LOG_LEVEL=none`。官方 server 默认往 stderr 打 OpenTelemetry,会污染 MCP 的 stdio 通道。 |
| ES 官方 server「deprecated」警告 | 是真的 —— Elastic 把 standalone `@elastic/mcp-server-elasticsearch` 标了 deprecated(只修安全),转向 **Agent Builder MCP endpoint**(9.2.0+/Serverless)。新栈就把那个 remote endpoint 当远程 MCP server 接,不用子进程。见 elasticsearch-kb README「Which Elastic MCP server?」。 |

---

**另见**:

- `docs/zh/RAG-VIA-MCP.md` —— 向量 RAG via MCP,本文母版;`mcpServers` 完整
  schema、配额两层、跨 hub 共享的 MCP-server-侧 ACL 论证都在那。
- `examples/obsidian-kb/` / `examples/elasticsearch-kb/` —— 两个 worked example,
  各自 README 有逐步 quick-start。
- `docs/zh/V5-C-FINAL.md` —— per-link KB allowlist(第六节第二层闸)+ 多组织
  隔离 E2E 验收门。
- `docs/zh/V5-B-FINAL.md` —— 模板 KB 槽位(第七节,带引用不带内容)。
- `docs/zh/MCP.md` —— Hub **作为** MCP server(被 Claude / Cursor 调进来),
  方向相反。
