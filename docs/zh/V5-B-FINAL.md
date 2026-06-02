# v5 · Stream B — 模板系统 / 搬走一整套架构（小结）

> 状态: **Stream B 完**（B-M1 ~ B-M5）。接在 Stream 0 + A（归属泛化）之后——
> 有了「谁拥有什么」，才谈得上「把一套拥有的东西打包搬走 / 分享」。v5 其余流
> （D / 0 / A 已完，C 待做）另出各自小结。
>
> Last updated: 2026-06-02

---

## 一、为什么做（北极星缺口）

北极星第 1 层是「我的 AI 桌面:5 分钟跑起来，不写代码」。到 v4，一个人能在
admin UI 里手搓 agent / 工作流 / 知识库接线——但**搬不走、分享不了**。`bundle/v1`
能打包「1 团队 + 1 工作流」，可它装不下「N 个 agent + N 个工作流 + 可寻址知识库 +
一键 API key 提示」这种**一整套架构**。

模板（`aipehub.template/v1`）就是这个分享单元:

> 一个文件描述一整套架构。导出端把自己 hub 上选中的 agent / 工作流 / KB 接线渲染成
> 结构清单；导入端拿这个文件，一键把架构落地到自己的 hub——凭证、数据、知识各归各家。

两条**锁定决策**贯穿始终（用户 2026-05-31 拍板「全按推荐」）:

- **决策 #4 — 模板带「结构 + 引用」，永不带知识内容。** KB 接线走 MCP server 引用 +
  一个可选的 `presetData`「指针」（url / artifact ref），指向打包好的快照。向量 /
  embedding / 文档**从不进 Hub**，跟 D3「Hub 不碰知识内容」一脉相承。
- **决策 #5 — 导出三档闸,默认最安全。** 结构默认明文带走；知识内容（字面 MCP 密钥）
  导出即**对称加密**（密钥另传）；人员信息（谁拥有这个 agent）默认**整段省略**，要导
  得显式 opt-in + 写审计。

不变量（贯穿）:

- **框架不跑 LLM / 不碰内容**:模板渲染只搬 agent 的 config（id / capability / provider /
  model / system / MCP 接线），never who-owns-it、never 文档内容。
- **导出 = 导入的逆**:渲染（`renderTemplate`）的结构必须能原样过解析器（`parseTemplate`），
  导入端再把它落回 hub。两半共用一套 manifest 契约，靠 round-trip 测试钉死不漂移。

---

## 二、动了什么（逐里程碑）

| M | commit | 干了啥 |
|---|---|---|
| **B-M1** | `6298ae0` | `aipehub.template/v1` manifest 格式 + `parseTemplate` + validate。agent 校验整段委托给 `parseManifest` 的 team 路径（一个 agent 信任边界，不重写规则）；workflow 块当不透明 yaml 原样保留（workflow runtime 仍是唯一 schema 权威）；KB 槽位 `name`（`KB_NAME_RE`）+ `mcpServer` 内联 XOR `useMcpServer` 引用 + `presetData` 指针；`defaults.apiKeyPrompt`。 |
| **B-M2** | `9db56c2` | 结构导出（`renderTemplate` = `parseTemplate` 的逆）。`POST /api/admin/templates/export` 从 Space 拉 agent config、从 host 拉工作流授权 yaml，渲染成 manifest，再过 `parseTemplate` 当**完整性闸**。默认结构安全:无人员（按构造）、无知识内容（只 MCP 接线）、无字面 secret（`scrubAgentSecrets` 把非 `${...}` 值占位成 `${KEY}`）。 |
| **B-M3** | `898b788` | 敏感（opt-in）导出权限闸。`includeSecrets` / `includePersonnel` → 把脱敏 secret（MCP-first 模型里「知识内容」≈ 到达知识源的字面密钥）+ 人员（`resource_grants` 归属）收进 `{secrets?, personnel?}`，AES-256-GCM 加密成边车 `template.encrypted`，密钥 `encryptionKey` **单独**在响应里返回（永不进文件）。每次敏感导出写 `template_export` 审计。 |
| **B-M4** | `dbadb23` | 模板导入（B-M2/B-M3 的逆）。`POST /api/admin/templates/import`:`parseTemplate` → 拿另传的密钥解密边车 → upsert 每个 agent（skip-existing、`lifecycle.start`、注入 secret） → import N 工作流（逐 id 软上报） → 上报 KB 槽位（**不**自动接线，决策 #4） → `reconcileHeartbeats`。**人员永不还原**（principal id 是 hub 本地的，跨 hub 不通用），只置 `personnelOmitted`。 |
| **B-M5** | （本提交） | 一键模板示例 + 文档。`examples/oneclick-template/`（`template.yaml` 客服 agent + 工单工作流 + KB 槽位带 presetData 指针 + apiKeyPrompt）+ 防腐验收测试（读实拼盘过真解析器 + 真导入路由）+ 本文 + README + CLAUDE.md 收口。 |

---

## 三、数据流端到端（导出 → 分享 → 导入）

```
  Hub A (导出端)                          Hub B (导入端)
  ┌────────────────────────┐             ┌────────────────────────┐
  │ Space: agent configs   │             │                        │
  │ host: workflow yaml     │             │                        │
  │ identity: resource_grants│            │                        │
  └───────────┬────────────┘             └───────────▲────────────┘
              │ POST /templates/export               │ POST /templates/import
              ▼                                       │
   renderTemplate()                          parseTemplate()
     · 渲染 agent config                        · 校验结构（agent 走 team 解析器）
     · scrubAgentSecrets → ${KEY} 占位          · 解密边车（拿另传的 encryptionKey）
     · 收集 secrets / personnel                · upsert agent + 注入 secret
     · parseTemplate 完整性闸                    · import 工作流（软上报）
     · [opt-in] AES-256-GCM 加密成边车           · 上报 KB 槽位（不自动接线）
              │                                       │
              ▼                                       ▲
   { ok, template, encryptionKey? }  ───── 分享 ─────┘
     · template.yaml  → 公开可分享（结构明文）        （encryptionKey 走另一条
     · encryptionKey  → 私下另传（永不进文件）         secure channel）
```

一句话:**结构走文件、密钥走另一条道、人员根本不走、内容压根没进过门。**

---

## 四、关键设计决策

1. **agent 校验只有一个信任边界。** `parseTemplateAgents` 把 agent 数组重新包成
   `aipehub.team/v1` 文档丢给 `parseManifest`——id 规则 / provider 白名单 / mcpServers
   形状 / 重名检测全复用，模板解析器一行 agent 规则都不重写。

2. **workflow 块不透明。** 模板从不看 workflow 的 trigger / steps，只抽 `id` 去重，
   其余原样 re-serialize 成 `aipehub.workflow/v1` yaml 交给 workflow importer。
   workflow runtime 仍是唯一 schema 权威，schema 演进零波及模板层。

3. **「知识内容」在 MCP-first 模型里 = 字面 MCP 密钥。** Hub 不存知识内容（D3），
   所以没有「原始知识」可导。诚实的映射:能泄密的是到达知识源的那把字面密钥——
   `includeSecrets` 加密它；`includePersonnel` 加密 `resource_grants` 归属。

4. **结构 = 敏感导出的严格子集。** `includeSecrets` 纯加性:结构永远保留
   `${PLACEHOLDER}` 引用，真值骑在加密边车里（占位符 → 真值的映射）。所以敏感导出
   就是结构导出 + 一个边车，导入端从解密的边车里替回去。一份模板公开分享时绝不漏 secret。

5. **完整性闸跑在边车之前。** `parseTemplate` 校验的是干净结构，**先**校验**再**挂
   `encrypted` 字段——解析器对加密一无所知，加密字段没有结构意义。

6. **人员解密但永不还原。** principal id（`user:alice`）是 hub 本地的——hub A 的
   alice ≠ hub B 的 alice。导入端解出人员只为完整性，**故意不写 grant**，只置
   `personnelOmitted` 旗标。归属是搬不走的，得在新 hub 重新授权。

7. **「最高权限」= `requireAdmin`，不造假的超级管理员。** admin 路由的操作者就是
   hub operator，本身即顶层。额外保护是「opt-in + 加密 + 审计」三件套，不是再叠一层
   假角色。

8. **示例即验收门。** `examples/oneclick-template/template.yaml` 被一个 web 测试读出来
   过真解析器 + 真导入路由。示例改坏 → CI 立刻红。一份「装在文档里」的样例永不腐烂。

---

## 五、测试 / 验证

| 包 | 新增 | 覆盖 |
|---|---|---|
| `web` (template-manifest) | parse + render + B-M4 sidecar 单测 | `encrypted?` round-trip / `injectAgentSecrets`（占位符替真值、不可变深拷贝、未知占位符放过）|
| `web` (template-crypto) | 7 | AES-256-GCM round-trip / 密钥不在 blob 里 / fresh key+IV / 错密钥 / 错长度 / 篡改 / 未知 algo |
| `web` (template-routes) | export 路由 14（含 B-M3 4） | 结构默认无边车无审计 / `includeSecrets` 加密边车密钥另传 / `includePersonnel` 写审计 / 503 缺人员源 |
| `web` (template-import-routes) | 10 | land/skip/软上报/400s + 全套边车互操作（密钥→注入 / 无密钥→skip / 错密钥→400 / 人员省略）|
| `web` (oneclick-template-example) | 4 | 防腐:读实拼盘过真解析器 + 真导入路由 |

全量 `web` 634 + `host` 506 绿，`pnpm -C packages/web build`（tsc）干净。

---

## 六、不做 / 后续

- **admin UI 导出 / 导入面板**:目前是 HTTP 路由 + curl + admin「Agents/工作流」导入入口。
  专门的「选 agent / 工作流 / KB → 导出模板」可视化面板推迟（决策点,可后补）。
- **presetData 自动拉取**:导入只上报 KB 槽位的 presetData 指针,不自动下载/解压快照——
  由导入端显式做(决策 #4 故意不自动接线)。一键「拉取并灌库」按钮是后续。
- **模板版本化 / 生命周期**:工作流有 Phase 15 的 draft→published 状态机,模板本身暂无;
  需要时再上(`template_revisions` 同构)。
- **跨 hub 模板市场 / 签名**:模板分享目前是手工传文件。可发现的模板 registry + 出处签名
  是更大的一块,留给生态层。
- **Stream C 衔接**:KB 槽位的「可寻址 `name`」就是 C-M1「可调用知识库入 per-link 契约」的
  授权目标——B 把槽位立起来,C 给它接联邦授权维度。

---

## 七、一句话

**模板把「一整套架构」做成一个可分享的文件:结构走文件、密钥走另一条道、人员根本不走、
内容压根没进过门。** 导出是渲染 + 三档闸,导入是逆向落地 + 人员不还原,两半共用一套
manifest 契约靠 round-trip 钉死。一键示例自己就是验收门。
