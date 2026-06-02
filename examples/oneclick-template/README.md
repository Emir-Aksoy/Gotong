# 一键模板 — 客服知识助手

v5 Stream B「模板系统」的端到端样例。**一个文件**(`template.yaml`)描述一整套
架构 —— 1 个客服 agent + 1 个工单工作流 + 1 个可寻址知识库槽位 —— 导入后填一次
API key 就能跑。

模板(`aipehub.template/v1`)是 AipeHub 里「搬走一整套架构」的分享单元:它是
`aipehub.bundle/v1`(1 团队 + 1 工作流)的超集,能带 N 个 agent、N 个工作流、
N 个可寻址知识库,以及一份可选的、加密的敏感边车。

## 这个模板里有什么

```
  ┌─────────────────────────────────────────────────────────┐
  │  template.yaml  (aipehub.template/v1)                    │
  │                                                          │
  │   agents:        support-agent  ──┐                      │
  │                                   │ 自带 mcpServers       │
  │   workflows:     ticket-flow      │ (host spawn 时拉起)   │
  │                    └─ trigger: answer-ticket             │
  │                                   ▼                      │
  │   knowledgeBases: company_kb  ── chroma-mcp (本机向量库)  │
  │                    └─ presetData: <脱敏样例的 URL 指针>    │
  │                                                          │
  │   defaults.apiKeyPrompt:  DeepSeek  ← 导入时填一次        │
  └─────────────────────────────────────────────────────────┘
```

## 一键导入

```bash
# 1. 起一个 host(个人模式默认)
aipehub init
npx @aipehub/host
# 控制台会打印 admin URL,里面带 ?token=<admin-token>

# 2. 导入这个模板(admin UI →「工作流 / Agents」→ 导入,或用 curl)
curl -X POST -H "Authorization: Bearer <admin-token>" \
     -H 'content-type: application/json' \
     -d "$(jq -Rs '{template: .}' examples/oneclick-template/template.yaml)" \
     http://127.0.0.1:8745/api/admin/templates/import

# 3. 按 defaults.apiKeyPrompt 的提示填一次 DeepSeek API key
export DEEPSEEK_API_KEY=sk-...

# 4. （可选)按 presetData 指针拉取脱敏样例 KB,解压到 chroma-mcp 的 --persist-dir
#    curl -L https://example.com/company-kb-seed.tar.zst | tar --zstd -xf - \
#      -C .aipehub/knowledge/company-kb

# 5. 在工作流面板点「开始」跑 ticket-flow,payload: { "q": "退货政策是什么?" }
```

导入响应会逐项告诉你落地结果:

```json
{
  "ok": true,
  "template": { "name": "客服知识助手(一键模板)", "version": 1 },
  "team": { "created": [{ "id": "support-agent", ... }], "skipped": [], "spawnErrors": [] },
  "workflows": [{ "id": "ticket-flow", "ok": true }],
  "knowledgeBases": [{ "name": "company_kb", "wiring": "inline" }],
  "secretsApplied": 0, "encryptedSkipped": false, "personnelOmitted": false
}
```

## 知识库接线模型(决策 #4)

**框架永不吞知识内容。** 模板带的是「接线 + 指针」,不是文档本身:

- **接线**:agent 的 `mcpServers` 自带一个 `chroma-mcp` 子进程,host spawn 时拉起,
  把它的检索工具暴露给 agent 的 tool-use 循环。知识库槽位 `knowledgeBases[]` 是这套
  接线的**可寻址声明**(也是 Stream C 联邦 per-link 授权的目标)。
- **指针**:`presetData` 是一个 `{ kind: 'url' | 'artifact', ref }` 指针,指向一份
  打包好的脱敏样例快照。导入时只「上报」不「自动拉取」—— 由你显式下载并灌进自己的
  KB。真正的向量 / embedding / 文档**从不进 Hub**。

## 导出与分享:结构默认、内容加密、人员省略(决策 #5)

反过来,你也能把自己 hub 上的一套架构**导出**成这种模板:

```bash
curl -X POST -H "Authorization: Bearer <admin-token>" -H 'content-type: application/json' \
  -d '{ "name": "客服知识助手", "agentIds": ["support-agent"],
        "workflowIds": ["ticket-flow"],
        "knowledgeBases": [{ "name": "company_kb", "useMcpServer": "company_kb" }] }' \
  http://127.0.0.1:8745/api/admin/templates/export
```

导出有三档,**默认最安全**:

| 内容 | 默认 | 说明 |
|---|---|---|
| 结构(agent 配置 / 工作流 / KB 接线) | ✅ 明文带走 | 可公开分享 |
| 知识内容(字面 MCP 密钥) | ❌ 脱敏 | `${ENV}` 占位;`includeSecrets:true` 才进**加密边车**,密钥 (`encryptionKey`) 另行传递 |
| 人员(谁拥有这个 agent) | ❌ 整段省略 | `includePersonnel:true` 才导,且**写审计**;导入端永不还原(principal id 是 hub 本地的) |

加密边车用 AES-256-GCM,密钥**永不进文件**,在 HTTP 响应里单独返回(`encryptionKey`)。
导入端拿密钥才能解出真 secret,自动替回 agent 的 `${PLACEHOLDER}`。

## 看一眼它一定能用

`packages/web/tests/oneclick-template-example.test.ts` 把这个 `template.yaml` 读出来,
过一遍真解析器 + 真导入路由,断言 agent 落地、工作流导入、KB 槽位上报。改坏了模板,
CI 立刻红 —— 示例永不腐烂。

## 参见

- [`docs/zh/V5-B-FINAL.md`](../../docs/zh/V5-B-FINAL.md) — Stream B 模板系统完整设计
- [`docs/zh/RAG-VIA-MCP.md`](../../docs/zh/RAG-VIA-MCP.md) — chroma-mcp 等知识库 server 选型
- [`docs/zh/TEMPLATES.md`](../../docs/zh/TEMPLATES.md) — agent / team / bundle 模板格式
