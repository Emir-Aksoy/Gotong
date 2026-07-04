# 家庭学习 hub — go-live runbook（家长给孩子开 AI 订阅）

> 这是一份**真家庭 / 操作员能照着跑**的上线手册。把
> [`examples/family-learning-hub`](../../examples/family-learning-hub) 从「确定性 demo」带到
> 「两台主权 host + 真 LLM 导师 + 真 mcp-obsidian + 四道安全闸真生效」。
>
> 它**复用**两份已有 runbook，不重复它们：
> - 真 DeepSeek key + 真 Obsidian vault 接线 → [`HANDS-ON-HUBS.md §三`](HANDS-ON-HUBS.md)
> - 铸 peer token / 暴露 ws / 双边登记 peer / per-link 信任契约 / `/me` 收件箱批准 →
>   [`FEDERATION-RUNBOOK.md`](FEDERATION-RUNBOOK.md)
>
> 本文只补**家庭学习这个垂直特有的东西**：两侧导入哪个模板、接哪些确定性闸参与者、
> 白名单 / 内容审核规则怎么配、孩子从 `/me` 发起、家长批准。完整设计蓝图见
> [`FAMILY-LEARNING-HUB-DESIGN.md`](FAMILY-LEARNING-HUB-DESIGN.md)。

---

## 0. 心智模型（先读这 5 条）

1. **两台主权 hub，不是一台多租户。** 孩子有自己的 hub（owner = 孩子，持学习档案**主副本**，
   **没有** AI 订阅），家长有自己的 hub（owner = 家长，持**订阅 / LLM key** + 导师 + 治理）。
   两者用一条联邦 mesh link 连。**模型在家长 hub 跑 = 计家长订阅。** 家长不"拥有"孩子的 hub，
   只持有那条 link 上的契约——自由图，不是层级树。

2. **管辖权 = 三根柱子。** ① 家长持订阅（经济咽喉，断 link 孩子立刻没 AI）；② per-link 信任契约
   （家长这侧设）；③ 全量 transcript fork（家长拿一份监督副本）。

3. **AI 安全 = 四道闸，纵深叠加。** ① 主题白名单 + 内容自评 → 家长审批；② data-class allowlist
   锁孩子数据（`child-learning`，fail-closed）；③ 能力边界 + 出站边闸；④ 配额 fail-closed。
   北极星第一条「框架不跑 LLM」是地基：AI 只能产出 Task，每个 Task 必须过闸。

4. **分层内容审核（两层都保留，规则引擎可选）。** 底层 = 导师**自评打标**（始终在，最弱一档）；
   第二层 = 确定性**审核规则引擎**（家长配禁词 / 分类清单，**空清单 = 关闭 = opt-out**）。两层
   都接进同一个家长审批闸。详见 §3。

5. **审批步必须住家长 hub 侧。** 本地 `human:` 步只能指派给**本 hub 的用户**；审批人是家长，家长
   是**家长 hub** 的本地用户——所以白名单审批 + 内容审核审批都是**家长 hub 工作流**里的 `human:`
   步。孩子 hub 的工作流只发起 / 记录 / fork，**不**带本地审批步。

---

## 1. 三个验证层（诚实分层，照 HANDS-ON-HUBS 先例）

「可实际使用」不是一个开关，是一条从 hermetic 到真机的爬坡。**结构**全被自动化测试钉死，只有
**真 LLM token 调用 + 真 Obsidian 读写 + 真两机网络**这几步要你的 key / 机器：

| 层 | 跑什么 | 要 key？ | 证明什么 |
|---|---|---|---|
| **Tier 0 — hermetic demos** | `pnpm demo:family-learning-hub`（6 剧情）/ `:federation`（真 ws）/ `:im`（IM 审批回推）+ `pnpm --filter @gotong/host test family-child-me-e2e` | 否 | 四道闸 + 分层审核 + 真 ws 握手/鉴权 + 孩子 `/me` 自助 dispatch 契约全绿 |
| **Tier 1 — 真引擎单机** | `FL_REAL=1 DEEPSEEK_API_KEY=sk-… pnpm demo:family-learning-hub:real` | DeepSeek key | 真 `LlmAgent` 导师接进真工作流，链条跑通（导师被调 / 课记主副本 / fork 投家长 / 闸生效） |
| **Tier 2 — 两台主权机** | 两个 `gotong start` + 真 ws 联邦（本文 §2） | DeepSeek key + 两台机 | 真家庭部署：孩子机发起 → 跨真 socket 到家长机导师 → 白名单外 / flagged 家长批 → 回流 + 记录 + fork |

**先把 Tier 0 跑绿**（看清骨架、确认闸真生效），再上 Tier 1（你的 key 验真模型），最后 Tier 2
（两机真部署）。每一层后端零改，只是换前端 / 换网络。

> **诚实边界（example-first）**：导师（`teach.lesson`）+ 工作流 + KB 槽位**经模板导入进真
> `gotong start`**（一等公民）。但**确定性闸参与者**（`topic.screen` / `content.moderate` /
> `records.append` / `report.to-guardian` / `explore.local`）是**运行时接线的 example 代码**
> （[`src/participants.ts`](../../examples/family-learning-hub/src/participants.ts)）——它们是确定性
> capability 参与者，**不能**当模板里的托管 agent（同 CLI / ACP 编码 agent 不能进模板）。所以
> Tier 2 的家长 / 孩子 host 是「`gotong start` + 复制 / 适配 `src/participants.ts` 的薄接线」。把
> 这个垂直 fold 进生产 host `main.ts` 是**显式推迟**项（设计 §十二 ④，北极星 example-first：模板
> 即产品化载体）。`src/index.real.ts` 已是这层薄接线的可跑参照。

---

## 2. Tier 2 — 两台主权机真部署

下面以 **家长机（hub-parent）** 和 **孩子机（hub-child）** 为两端。联邦对称，登记动作镜像。

### Step 1 — 家长机：起 host + 导入导师模板 + 接真 DeepSeek / Obsidian

家长机起一个生产 host（`gotong start`），按 [`HANDS-ON-HUBS.md §三`](HANDS-ON-HUBS.md) 准备
DeepSeek key + 连你自己的 Obsidian vault 到 `learning_records` KB 槽位，然后**导入家长模板**：

```
admin UI → 模板 → 导入 → 贴 examples/family-learning-hub/template/family-tutor.template.yaml
```

导入后家长 hub 落地：

- **1 个托管 LLM 导师 agent**（`family-tutor`，cap `teach.lesson`，挂 mcp-obsidian → 读 `learning-records/`
  续上 + 输出结构化 lesson + `flagged` 自评）；
- **1 条 `tutor-teach` 工作流**：`screen` →（`guardian-approval` 白名单外审批）→ `teach` →
  `moderate`（规则引擎）→（`mod-approval` 内容审核审批）；两个审批是 `human:` 步，指派家长；
- **`learning_records` KB 槽位**（presetData 指针，内容不在模板里）。

> 模板**只点名** `topic.screen` / `content.moderate` 两个 capability，**不**带服务它们的参与者
> ——下一步运行时接。

### Step 2 — 家长机：接确定性闸参与者 + 设白名单 / 审核规则

把家长侧的三个确定性 capability 参与者接进家长 host（example-first：复制 / 适配
[`src/participants.ts`](../../examples/family-learning-hub/src/participants.ts)）：

| capability | 参与者 | 配什么 |
|---|---|---|
| `topic.screen` | `TopicScreenParticipant` | **主题白名单**（家长发布；白名单内直接学，白名单外 → `guardian-approval`）。返回结构化 `{allowed, reason}` ★ |
| `content.moderate` | `ModerationParticipant` | **审核规则清单**（`{id,label,pattern}[]`；命中关键词 → flagged → `mod-approval`）。**空清单 = 关闭**。返回 `{flagged, reasons}` |
| `report.to-guardian` | `ReportToGuardianParticipant` | 收 oversight fork（家长的监督副本 sink） |

> ★ **关键安全点（已修的 fail-open 洞）**：`topic.screen` / `content.moderate` **必须**是
> **确定性参与者**，返回真布尔 `allowed` / `flagged`。**绝不能**把它们派给 LLM 导师——LLM 返回
> 自由文本没有 `allowed` 字段，工作流的 `when: $screen.output.allowed == false` 会读不到 →
> 求值 false → 审批步被**静默跳过** → 白名单外主题零审批直达导师。确定性闸还杜绝 prompt 注入
> 成 `allowed:true`。Tier 0 的 [A]/[F] 剧情经**真求值器**把这条钉死。

### Step 3 — 孩子机：起 host + 导入孩子模板 + 接 records.append / explore.local

孩子机起一个生产 host（`gotong start`），**导入孩子模板**：

```
admin UI → 模板 → 导入 → 贴 examples/family-learning-hub/template/child-desk.template.yaml
```

导入后孩子 hub 落地 **2 条 `surface.me` 工作流** + `learning_records` KB 槽位，**但 0 个 LLM
agent**——订阅在家长 hub，孩子借道：

- `child-guided-lesson`（trigger `learn.request`）：`tutor`（跨组织 `tutor.teach`，标
  `child-learning`）→ `record`（本地 `records.append` 主副本）→ `report`（跨组织 fork，标 `child-learning`）；
- `child-autonomous-explore`（trigger `explore.request`）：纯本地 `explore.local`，**不借订阅**。

接孩子侧两个本地确定性参与者（同 example-first）：`RecordsAppendParticipant`（cap `records.append`，
真写 `learning-records/` **主副本**到孩子 hub 磁盘）+ 一个 `explore.local` 参与者。

### Step 4 — 铸 peer token + 双边登记 peer + per-link 契约

照 [`FEDERATION-RUNBOOK.md` Step 1–4](FEDERATION-RUNBOOK.md) 做（不重复细节），**家庭学习特有的
契约值**：

**孩子机**（出站到家长，调导师）登记家长 peer：

```json
POST /api/admin/identity/peers
{
  "peerId": "hub-parent",
  "endpointUrl": "wss://parent.example.com:4000",
  "peerToken": "<铸的同一个 token>",
  "outboundCaps": ["tutor.teach", "report.to-guardian"],
  "allowedDataClasses": ["child-learning"],
  "requireApprovalOutbound": false,
  "perLinkQuotaBudget": 200
}
```

**家长机**（入站接受孩子）镜像登记孩子 peer（同一 token）：

```json
POST /api/admin/identity/peers
{
  "peerId": "hub-child",
  "endpointUrl": "wss://child.example.com:4000",
  "peerToken": "<同一个 token>",
  "acl": { "capabilities": ["tutor.teach", "report.to-guardian"] }
}
```

家庭学习的契约要点：

- **`allowedDataClasses: ["child-learning"]`**：孩子数据只在这条 link 上携带。**孩子如果还连了
  别的 peer（第三方），那条 link 的契约不含 `child-learning` → 孩子数据 fail-closed，流不出去**
  （Tier 0 [C] 剧情钉死）。
- **`outboundCaps` 只列 `tutor.teach` + `report.to-guardian`**：通告=授权，孩子只能跨界调这两个。
- **审批走家长 hub 工作流的 `human:` 步**（§5 约束），所以这里 **`requireApprovalOutbound: false`**
  ——白名单 / 内容审核审批已经在家长的 `tutor-teach` 工作流里（`guardian-approval` / `mod-approval`），
  不在 link 层重复设。
  > （对比纯出站审批闸玩法：若你想把审批放在 link 层而非工作流 `human:` 步，就开
  > `requireApprovalOutbound: true`——这是 Tier 0 `:federation` demo 演示的等价形态。两条路别同时开，
  > 否则审批两次。生产推荐工作流 `human:` 步，因为它能区分「白名单外」vs「内容 flagged」两种原因。）
- **`perLinkQuotaBudget`**：给孩子那条 link 配每窗口任务上限，超额 fail-closed（限花费 / 时长）。

### Step 5 — 孩子机：加一个孩子 member

孩子 hub 的 owner（孩子，或代管的家长）在 admin 加一个**孩子 member**（role=member）。这个
member 就是孩子在 `/me` 的身份。**多孩子** = 同一孩子 hub 加多个 member，靠 `learner_id`
（`userScopeField`）隔离。

### Step 6 — 孩子从 `/me` 发起一课

孩子用自己的账号开 `/me`（PWA Home tab）→ 看到「跟 AI 导师学一课」→ 填主题 → 发起。

- `/me` **强制** `payload.learner_id = 孩子自己的 userId`——孩子只能为**自己**学，改不了
  `learner_id` 替别人发起（[`family-child-me-e2e.test.ts`](../../packages/host/tests/family-child-me-e2e.test.ts)
  钉死这条契约）。
- 主题在白名单内 → 直接跨真 socket 到家长导师上课；白名单外 → 在家长 hub 的工作流挂起，等家长批。

> ⚠️ 预览 `/me` 静态资源前先**清掉 PWA service worker**（scope `/`），否则可能看到旧壳
> （memory `preview-sw-stale-static-assets`）。

### Step 7 — 家长批准（`/me` 收件箱 或 IM）

白名单外主题 / 内容 flagged 时，家长 hub 的工作流挂起，写一条 approval 待办到**家长的 `/me`
收件箱**。家长两条路批准：

- **`/me` 收件箱**：家长开自己的 `/me` → 收件箱 → 看到「白名单外主题审批」/「内容审核审批」→ 批 / 拒。
- **IM 旁路监督**（opt-in，example-first）：把审批推到家长自己的 Telegram / 微信，批 / 拒结果回推。
  复用管家的 async 审批回推（[`examples/im-steward-bridge`](../../examples/im-steward-bridge) 已做实），
  家庭学习的 IM 监督桥见 [`src/im-oversight.ts`](../../examples/family-learning-hub/src/im-oversight.ts)
  （Tier 0 `pnpm demo:family-learning-hub:im` 演示批 / 拒 + 跨家长隔离 no-leak）。

**批准** → 任务才真过 socket，导师上课，回流孩子 hub 记档 + fork 给家长。**拒绝** → fail-closed，
导师从未被联系，这一课不上（Tier 0 [F] 剧情钉死「拒绝真能拦」）。

### Step 8 — 观察（监督 + 控制面）

- **学习档案主副本**：在孩子 hub 磁盘 `learning-records/<learner_id>/`。
- **家长的监督 fork**：每跑一课，家长 `report.to-guardian` 收一份小结副本。
- **跨 hub 轨迹**（opt-in，孩子 hub 设 `shareTranscript: true`）：家长在运行详情拉
  `peer.transcript` 看孩子本地探索那部分（[`FEDERATION-RUNBOOK.md` Step 8](FEDERATION-RUNBOOK.md)）。
- **控制面计数**（opt-in `shareSummary: true`）：隐私安全的资产 / 活动 / 健康计数，永不原始行。

---

## 3. 分层内容审核怎么配（两层都保留，规则引擎可选）

纵深防御（设计 §四）。两层**叠加**，不是择一：

```
导师产出 lesson
   │
   ├─ 层 1（始终在）= 导师自评打标 flagged   ← 最弱一档，AI 自己判自己
   │
   └─ 层 2（可选）= ModerationParticipant 规则引擎 flagged   ← 家长配禁词/分类清单
            │
            ▼
   家长审批闸:  when: $teach.output.flagged == true || $moderate.output.flagged == true
            │
   任一层标了 → 家长 /me 收件箱审内容 → 批/拒
```

- **层 1 自评**（决策 1.a，始终在）：导师 system prompt 让模型在结构化输出里自标 `flagged` /
  `flagReason`。因为辅导在家长 hub 跑，flag + 内容**原生落家长 transcript**。
- **层 2 规则引擎**（可选）：`ModerationParticipant` 持一份家长配的规则清单
  （`{id, label, pattern}[]`），对导师输出**事前预筛**，命中 → `{flagged, reasons}`。
  - **空规则清单 = 永不 flag = 关闭**（opt-out）；
  - **填规则 = 开启**（opt-in），逐条 `pattern` 子串匹配（topic / title / body / flagReason）。
- **两层接进同一个 `mod-approval` 闸**：关掉规则引擎（空清单）只剩自评底层兜底；自评漏了的，
  规则引擎能补（Tier 0 [D]「游戏外挂」剧情：自评没标，规则引擎拦下 → 家长审）。

> 自评是最弱一环（AI 判自己），靠「主题白名单硬边界 + 可选规则引擎 + 全量 transcript 家长可见」
> 三层补强。要更强可后续再加第二个模型审。

---

## 4. 安全清单（家庭部署专属，叠加 FEDERATION-RUNBOOK §3）

- [ ] **订阅 key 只在家长 hub vault**——孩子 hub 不持任何 LLM key，物理上借家长的道。
- [ ] **`allowedDataClasses` 锁 `child-learning`**——孩子学习数据只走家长那条 link；任何其它
      peer 的契约**不含** `child-learning` → fail-closed 流不出去。
- [ ] **`topic.screen` / `content.moderate` 是确定性参与者**——绝不派给 LLM（否则 fail-open，
      审批被静默跳过）。
- [ ] **白名单孩子改不了**——白名单是家长发布的策略；即便给孩子「大白话改工作流」，WFEDIT 出入口
      锁保证孩子动不了 trigger 和跨 hub 出口（`tutor.teach` + 它的 `dataClasses`）。
- [ ] **审批人是家长 hub 本地用户**——`human:` 步指派家长，住家长 hub 工作流（不是孩子 hub）。
- [ ] **`perLinkQuotaBudget` 给孩子 link 封顶**——限花费 / 时长，防跑飞。
- [ ] **IM 监督 opt-in**——越界 / flagged 审批推家长自己的 IM；孩子学习数据**不**绕道 IM 平台
      （那会破坏 data-class 锁），IM 只推审批待办 + 计数，不推课程内容。
- [ ] **不读写真实 key**——本 example 与本 runbook 的所有自动化层永不读 / 写 / commit 真实订阅 key；
      key 在 Tier 1/2 从 `process.env` 读，永不入库 / 入 git。

---

## 5. 故障排查

| 症状 | 多半原因 / 处理 |
|---|---|
| 白名单外主题**没**触发审批，直接上课了 | `topic.screen` 被派给了 LLM 导师而非确定性参与者（fail-open）。确认导师 caps **只有** `teach.lesson`，`topic.screen` 由 `TopicScreenParticipant` 服务。 |
| 内容审核步从不 flag | 规则清单空（= opt-out）。这是正常的「关闭」态；要开就填 `{id,label,pattern}` 规则。 |
| 孩子发起课报 403 | 该 member 不是孩子 hub 的 member，或工作流没 `surface.me` enabled / 没发布（Model-B import 发布 rev1）。 |
| 跨 hub 上课报 `outbound_capability_denied` | 孩子那条 link 的 `outboundCaps` 没列 `tutor.teach`。补上（通告=授权）。 |
| 跨 hub 上课报 `outbound_data_class_denied:child-learning` | 该 link 的 `allowedDataClasses` 没含 `child-learning`。**这正是发给第三方时应有的拒绝**；发给家长那条 link 才该放行。 |
| 链路不通 / 错 token | 见 [`FEDERATION-RUNBOOK.md §4`](FEDERATION-RUNBOOK.md)。Tier 0 `:federation` demo 已证错 token 握手被拒。 |

---

## 6. 对应的 example 与验收门

| 这一步 | example / 测试 | 跑 |
|---|---|---|
| 四道闸 + 分层审核（真求值器） | `src/index.ts`（6 剧情 [A]-[F]） | `pnpm demo:family-learning-hub` |
| 真 ws 联邦 + bearer + per-link 契约 | `src/federation.ts`（14 断言） | `pnpm demo:family-learning-hub:federation` |
| 家长 IM 审批回推 + 跨家长隔离 | `src/im-oversight.ts` | `pnpm demo:family-learning-hub:im` |
| 真 DeepSeek 导师接进真工作流 | `src/index.real.ts`（opt-in key） | `FL_REAL=1 DEEPSEEK_API_KEY=… pnpm demo:family-learning-hub:real` |
| 孩子 `/me` 自助 dispatch 契约 | `packages/host/tests/family-child-me-e2e.test.ts` | `pnpm --filter @gotong/host test family-child-me-e2e` |
| 家长 / 孩子模板防腐门 | `packages/web/tests/{family-tutor,child-desk}-template.test.ts` | `pnpm --filter @gotong/web test` |

---

## 7. 延伸阅读

- [`FAMILY-LEARNING-HUB-DESIGN.md`](FAMILY-LEARNING-HUB-DESIGN.md) — 完整设计蓝图（管辖权 / 四道闸 / 产品形态）
- [`FEDERATION-RUNBOOK.md`](FEDERATION-RUNBOOK.md) — 两机联邦 onboarding（铸 token / 登记 peer / per-link 契约）
- [`HANDS-ON-HUBS.md`](HANDS-ON-HUBS.md) — 真 DeepSeek + Obsidian go-live + 验证锚点分层
- [`V5-G-FINAL.md`](./ledger/V5-G-FINAL.md) — 跨 hub 工作流编排（通告=授权 + 两步恢复）
- [`KB-CONNECTORS.md`](KB-CONNECTORS.md) — Obsidian / 向量 RAG 连接器 + 读写治理
- [`examples/family-learning-hub/README.md`](../../examples/family-learning-hub/README.md) — 案例总览 + 拓扑
