# family-learning-hub — 家长给孩子开 AI 订阅的家庭学习 hub (跨组织 · 管辖权 · AI 安全)

> 北极星 **第 1 层「我的 AI 桌面」+ 第 2 层「跨组织协作」的交点**:孩子有自己的 hub,
> 家长有自己的 hub,两者联邦;但「凭证(订阅)、数据、计费各归各家」反过来用——**订阅
> 在家长这边**,孩子借道使用,这本身就是**管辖权(jurisdiction)**。Hub 网络是**自由图,
> 不是层级树**:家长不"拥有"孩子的 hub,只是持有那条 link 上的契约。
>
> 这是继 `tea-supply-link`(奶茶店↔供货商)、`tea-chain-hq`(总部↔门店)之后的又一个
> **跨组织(cross-org)** 案例,直接吃 Stream G 的跨 hub 编排 + 出站审批闸 + P4-M4 的
> data-class 闸。和那两个不同:这个案例的"能力"是「上一课」,而它最硬的杠杆是 **AI 安全**
> ——家长清楚 AI 本身有隐患(乱花钱 / 说不该说的 / 做危险动作 / 数据外泄),要在**结构上**
> 把这些关住,而不是"相信 AI 会乖"。完整蓝图见
> [`docs/zh/FAMILY-LEARNING-HUB-DESIGN.md`](../../docs/zh/FAMILY-LEARNING-HUB-DESIGN.md)。

```
        孩子 hub (owner = 孩子, 我的 AI 桌面)         家长 hub (owner = 家长, 持订阅)
  ┌────────────────────────────────┐    per-link    ┌──────────────────────────────┐
  │ workflow: child-guided-lesson  │    信任契约    │  订阅 · LLM key · 配额        │
  │   tutor  → cap[tutor.teach] ───┼────────────────┼─▶ cap: tutor.teach            │
  │            dataClasses:        │   ① 授权调用   │     (/teach: 读 learning-     │
  │            [child-learning]    │                │      records 续上, 自评打标)  │
  │   record → cap[records.append] │                │  cap: report.to-guardian      │
  │            (本地, 主副本)      │   ◄────────────┼─  (oversight fork sink)       │
  │   report → cap[report.         │   ② 回这一课   └──────────────────────────────┘
  │            to-guardian] ───────┼───── fork ──────────────▲
  │            dataClasses:        │                         │ ④ 白名单外: 家长批准后才跨界
  │            [child-learning]    │                         │
  └────────────────────────────────┘                         │
            │  ① tutor 步派 capability                        │
            ▼                                                 │
  ┌────────────────────────────────┐   wrapOutbound           │
  │ peer wrapper (advertises        │──────────────────────────┘
  │   [tutor.teach,                 │   ② 主题白名单外 → 出站审批闸挂起
  │    report.to-guardian])         │   ③ 家长在 /me (或 IM) 批准
  │   wrapped in TopicWhitelistGate │
  └────────────────────────────────┘

  learning-records 主副本留孩子 hub 磁盘;家长收 fork 副本 = 数据复制 + 管辖权。
  孩子→第三方 那条 link 的 data-class 契约不含 child-learning → 孩子数据 fail-closed,流不出去。
```

## 两个交付物

| 交付物 | 是什么 | 跑 |
|---|---|---|
| **可跑 demo** | 三个 in-proc hub(孩子 + 家长 + 第三方),内联出站审批闸(`TopicWhitelistGate`)+ 两步恢复 + data-class 闸,确定性自断言 | `pnpm demo:family-learning-hub` |
| **可载入模板** | 家长 hub 一侧的 `aipehub.template/v1`(1 导师 agent + 1 跨组织工作流含 `human:` 白名单审批 + KB 槽位) | `pnpm demo:family-learning-hub:template` |

## ★ 模版和框架是分离关系(本案例的教学点,同 tea-supply-link)★

模板(`template/family-tutor.template.yaml`)**只**带「家长 hub 一侧的编排骨架」:`/teach`
风格的导师 agent、`tutor-teach` 工作流(含白名单审批)、`learning_records` KB 槽位、一次性
key 提示。

它**不**带、也**不能**带「跨组织的链接」本身:

| 这件事 | 住在哪 |
|---|---|
| 哪个 peer 是孩子的 hub | **运行时** peer 配置(host `installPeerLink` / admin「联邦」tab) |
| 出站放行哪些 capability(`outboundCaps`) | **运行时** per-link 信任契约 |
| 孩子数据的 data-class 契约(`allowedDataClasses`) | **运行时** per-link 信任契约 |
| 越界主题是否需家长审批(`requireApprovalOutbound`) | **运行时** per-link 信任契约 |
| 工作流的 `tutor` 步 | 只写一个 **capability 名**(`tutor.teach`),**从不点名某个 peer** |
| 孩子 hub 的自主探索 agent + 两侧 link 配置 | 都不在模板里 |

换句话说:**模板是「可搬走的骨架」,链接是「落地时各自配的运行时契约」**。一份模板,多个
家庭各自连各自孩子的 hub,凭证 / 数据 / 计费互不串线。这正是「自由图,不是层级树」落到一个
具体的家庭安全场景。

## ★ 这个 case 比 tea-supply-link 多一层:出站审批闸 **和** 工作流 `human:` 步 ★

`tea-supply-link` 只有一种审批形态(运行时出站审批闸)。这个家庭学习 case 把**同一个家长
策略**用两种等价形态各演示一次:

- **可跑 demo(FL-M1)用运行时出站审批闸** `TopicWhitelistGate`:家长在 link 上设主题白名单,
  白名单外的 `tutor.teach` 任务挂起在家长收件箱,批准了才跨界。这一层对工作流**透明**,所以
  孩子 hub 的 `child-guided-lesson.yaml` 里**没有** `human:` 步。
- **可载入模板(FL-M2)用工作流 `human:` 步**:`tutor-teach` 工作流里有一个 `guardian-approval`
  步,`when: "$screen.output.allowed == false"` 条件触发,`human:` 糖脱糖成 `aipehub.human/v1`。

**为什么 `human:` 步必须住在家长 hub 侧(本设计最关键的正确性约束)**:本地 `human:` 步只能
指派给**本 hub 的用户**。审批人是家长,家长是**家长 hub** 的本地用户——所以白名单审批只能放在
家长 hub 的工作流里。孩子 hub 的工作流只管发起 + 记录 + fork,**不**在本地放审批步(指派不到
家长)。这也是为什么模板(=家长侧)带 `human:` 步,而 demo 的孩子侧工作流不带。

> 对比 cafe-ops(店内加班审批,店长和发起人在同一个 hub):那里 `human:` 步天然指派得到同
> hub 的店长。这里审批要**跨组织**,所以要么走运行时出站审批闸(demo),要么把审批步放在
> **持审批人**的那个 hub(模板)。

## 管辖权 = 三根柱子(全是现成的)

家长的"管辖权"不是一个新功能,而是三根已经做实的柱子叠起来——**关键认识:管辖权落在
「谁持有订阅 + 谁设 link 契约」,不是「谁在谁的 hub 里当 admin」**。这让孩子保留主权 hub,
家长仍有真权力。

| 柱子 | 机制 | demo 里看得到 |
|---|---|---|
| **① 持订阅(经济咽喉)** | 模型 key 只在家长 hub;`tutor.teach` 在家长侧跑 = 计家长订阅;家长**断 link** 孩子立刻没 AI | 两节课都"跨到家长 hub"才上(`tutor.taught.length === 2`) |
| **② per-link 信任契约(在家长这侧设)** | 能力白名单 `outboundCaps` / 数据类 `allowedDataClasses` / 出站审批(主题白名单) | `installPeerLink` 那段:通告 `[tutor.teach, report.to-guardian]`、契约 `[child-learning]`、白名单外需家长批 |
| **③ 全量 transcript fork(oversight)** | 导师在家长 hub 跑 → 那次辅导 transcript 原生在家长侧;`report.to-guardian` 显式 fork | 家长收件箱共收 2 份 fork 小结(`guardianInbox.received.length === 2`) |

## AI 安全隐患怎么被结构性关住(四道闸,纵深叠加)

核心是北极星第一条**「框架不跑 LLM」**:AI 只能产出一个 Task,而**每个 Task 必须经派发,
每次派发都穿闸**。不是"信任 AI 会乖",而是 **AI 物理上碰不到危险面,除非过闸**。

| 隐患 | 闸 | demo 里看得到 |
|---|---|---|
| **AI 说不该说的 / 越界主题** | 内容自评打标 + 主题白名单 → 家长审批 | [A]「投资理财」白名单外 → 挂起等家长批;导师自评 `flagged === true`(决策 1.a) |
| **孩子数据外泄** | data-class allowlist 锁死(fail-closed) | [C] 同一 `child-learning` 任务发家长通、发第三方拒(`outbound_data_class_denied`) |
| **AI 做危险动作 / 对外发** | 能力边界 + dispatch 白名单 + 出站边闸 | 跨 hub 出口只放行 `outboundCaps` 里的能力;别的一律选不中 |
| **AI 用太多(烧钱 / 时长)** | 配额 fail-closed | 生产里 per-link `perLinkQuotaBudget` + Phase 17 预算 peek(本 demo 故意不演,见下「进阶可叠加」) |

**纵深防御**:这些闸是**叠加**的,不是择一。最弱的一环(内容自评,AI 自己判自己)由「全量
transcript 兜底 + 主题白名单硬边界 + 家长事后可见」三层补强。一道闸被绕过,还有下一道。

## 这个 demo 证明了什么(确定性,无需 API key)

| 剧情 | 结果 |
|---|---|
| **[A] 白名单外(投资理财)** | 孩子工作流跑到 `tutor` 步 → 主题白名单外 → **挂起**在出站审批闸(这一课还没用到家长订阅)→ 家长 `/me` 收件箱 1 条待办 → 家长批准 → 导师**跨 hub** 上第 1 课(模型在家长 hub,计家长订阅)+ **自评把"投资理财"内容打了标** → 回流孩子 hub → `records.append` 把档案**主副本**写到孩子 hub 磁盘 → `report.to-guardian` fork 一份给家长。 |
| **[B] 白名单内(分数运算)** | 预先批准,**不挂起**:导师续上第 2 课(同一学习者,进度递增 = `/teach` 文件状态当时钟),"分数运算"不触发自评标记,记档(累计 2 条),fork 给家长(共 2 份)。无收件箱待办。 |
| **[C] 数据外泄闸** | 孩子 hub 还连了一个**第三方** peer,其契约不含 `child-learning`。同一个 `child-learning` 任务发家长**通**、发第三方**拒**(`outbound_data_class_denied`)。第三方一条孩子数据都没收到——**孩子数据只流向家长,流不到第三方**。 |

**进度 / 标记是确定性算的,不是 LLM 算的**(同 cafe-ops 的加班金额、tea-supply-link 的报价):
导师 stand-in 按学习档案续课号、按关键词自评打标;真实模式(FL-M4,可选)才换成真 DeepSeek。

## 为什么 host-free(同 cafe-ops / cross-hub-workflow / tea-supply-link 先例)

这个 demo 只依赖 `@aipehub/core` + `@aipehub/workflow` + `@aipehub/inbox`,把宿主机的两个组件
**内联成可见的 ~40 行**,让机制不被埋在 host 二进制里:

- `TopicWhitelistGate` = `packages/host/src/outbound-approval.ts` 的 `ApprovalGatedParticipant`
  的最小镜像,**做成 selective**:`report.to-guardian`(oversight fork)直通不设闸;`tutor.teach`
  按家长的主题白名单筛,白名单外才 park。生产里它由 `installPeerLink` 的 `wrapOutbound` 钩子装上。
- `resolveApproval` = `packages/host/src/inbox-service.ts` `HostInboxService.resolve` 两步恢复的
  手写镜像(**子闸严格先于父 workflow**)。生产里它由 `/me` 收件箱点一下批准触发。

真正的跨 hub 链路是真的:`createInprocHubLinkPair` + `installPeerLink`(都来自 `@aipehub/core`),
三个真 `Hub`,真 `parseWorkflow` + `WorkflowRunner`,真 `checkOutboundDataClasses` 闸(由
`installPeerLink({allowedDataClasses})` 装在出站边)。

## 孩子从 `/me` 自助发起一课(自助验证 · C-M3)

设计 §九:孩子的 first-class 入口是 `/me` PWA —— 孩子自己在浏览器里发起一课,不经家长操作。
孩子侧可载入模板 [`template/child-desk.template.yaml`](template/child-desk.template.yaml) 的两条工作流
(`child-guided-lesson` / `child-autonomous-explore`)都 `surface.me` enabled,且声明
`user_scope_field: learner_id` —— **`/me` 强制 `payload.learner_id = 发起成员自己的 userId`**,
孩子只能为**自己**发起,改不了 `learner_id` 替别人发起。

**durable 验收(确定性,无需 host / 浏览器):**
[`packages/host/tests/family-child-me-e2e.test.ts`](../../packages/host/tests/family-child-me-e2e.test.ts)
把这条契约跑在真 `WorkflowController` 上:读**实文件**孩子模板 → 经**真** admin
`/api/admin/templates/import` 路由导入(落 **0 个 LLM agent** —— 订阅在家长 hub,孩子借道)→ 一个非
admin 的**孩子 member** 经 `/api/me/workflows` 看见课、经 `/api/me/dispatch` 发起 `learn.request`
→ 断言 `learner_id` 被强制成自己的 userId、伪造的 `someone-else` **一个任务都到不了**
(trigger / 跨组织 `tutor` 借道 / 本地 `records.append` / fork 给家长 四步都没有),内部的
capability / userScopeField **不泄漏**到 `/me`。

```bash
pnpm --filter @aipehub/host test family-child-me-e2e
```

**真机预览(可选,go-live 时人工核对):** 起一个生产 host(`aipehub start`,见 D-M1 runbook)→
admin 导入孩子模板 → 接好三个本地确定性参与者(`records.append` / `report.to-guardian` /
`explore.local`,见 [`src/participants.ts`](src/participants.ts))→ 加一个孩子 member → 用孩子账号
开 `/me`(PWA Home tab)发起一课。
> ⚠️ 预览静态资源前先**清掉 PWA service worker**(scope `/`),否则可能看到旧的 `/me` 壳
> (memory `preview-sw-stale-static-assets`)。本里程碑不改任何 SPA / 静态代码 —— `/me` 的动态
> 表单渲染是 Phase 14 / P1 早已 ship 的能力,这里只是把孩子的课接上去验证。

## 文件

| 文件 | 作用 |
|---|---|
| `workflows/child-guided-lesson.yaml` | **孩子 hub 侧**声明式工作流:`tutor`(跨组织 `tutor.teach`,标 `child-learning`)→ `record`(本地主副本)→ `report`(跨组织 fork,标 `child-learning`)。**YAML 里没有任何 peer 的名字,也没有 `human:` 步**(审批在家长侧)。 |
| `src/standins.ts` | 四个确定性 stand-in:`TutorStandin`(`/teach` 风格,按档案续课号 + 关键词自评打标)、`GuardianInboxStandin`(收 fork)、`ChildDeskStandin`(写本地 `learning-records/`)、`ThirdPartyStandin`(必须收到 0 条孩子数据)。 |
| `src/index.ts` | 三个 in-proc hub + 内联 `TopicWhitelistGate` 出站审批闸 + 两步恢复镜像 + 三剧情确定性自断言。 |
| `template/family-tutor.template.yaml` | **家长 hub 一侧**的可载入模板(1 导师 + 1 跨组织工作流含 `human:` 白名单审批 + KB 槽位)。**链接 + 孩子侧 + 白名单值都不在里面。** |
| `src/load-template.ts` | 载入演示(config-preview,不起 mcp-obsidian、不开 peer 链接)。 |

## 对应的生产组件

| demo 内联 | 生产真东西 |
|---|---|
| `TopicWhitelistGate`(selective) | `host/src/outbound-approval.ts` `ApprovalGatedParticipant`(`installPeerLink({wrapOutbound})`)+ 主题白名单作为家长的 per-link 策略 |
| `resolveApproval` 两步恢复 | `host/src/inbox-service.ts` `HostInboxService.resolve` + `/me` 收件箱(或 IM,见设计 §九)点批准 |
| `parked` Map(suspendNotifier) | identity `suspended_tasks` 表 + resume sweep |
| `allowedDataClasses` 出站闸 | `core` `checkOutboundDataClasses`(P4-M4,mesh/A2A/ACP 出站边共用同一纯函数) |
| `remoteCapabilities` / `outboundCaps` 手动穿线 | `host/src/peer-registry.ts` 从 per-link 信任契约自动穿(admin「联邦」tab 编辑) |
| `TutorStandin`(家长 hub 的 `/teach` 导师) | 家长自己的 AipeHub,`tutor.teach` 由 LlmAgent(DeepSeek + mcp-obsidian 读 `learning-records/`)服务 |

## 决策落地(锁定的三个 + 数据 / 模板分离)

| 决策 | 怎么落 | 诚实边界 |
|---|---|---|
| **1.a 内容自评打标** | 导师在课程输出里自标 `flagged`;因辅导在家长 hub 跑,flag + 内容**原生落家长 transcript** | 自评是**最弱一档**(AI 自己判自己),靠全量 transcript + 白名单硬边界 + 家长事后可见三层兜底;要更强可后续换"专门审核参与者"(设计 §十二) |
| **2 调用触发非心跳** | 靠 `/teach` 的 `learning-records/` 文件状态当时钟,每次孩子调用读档续上(demo 里 = 续课号递增) | 与 `/teach` 设计天生一致,**零额外机制**(不引 Stream D 心跳) |
| **3 主题白名单** | 白名单内直接流;白名单外 → 家长审批;白名单本身**家长发布、孩子改不了**(WFEDIT 出入口锁) | 白名单是"策略闸",审批是"例外口":大多数主题自由学,新主题家长一键放行 |
| **#4 模板带结构 + 引用,永不带内容** | KB 槽位 `learning_records` 只带「MCP 接线 + presetData 指针」;学习记录内容是孩子 hub 的磁盘文件,不在模板里 | 同 tea-supply-link / battle-monk-training 的「KB 存用户状态」先例 |
| **#5 + 本案例:跨组织链接也不在模板里** | 链接是运行时 per-link 信任契约(peer + outboundCaps + data-class + 审批策略),导入模板后到 admin「联邦」tab 配 | `tutor.teach` 步只写 capability,从不点名 peer |

## 安全边界(家长产品的诚实边界)

- **AI 不替孩子做决定,也不替家长做决定**:导师只"提议下一课 / 给反馈",**放不放行越界
  主题由家长拍板**,钱 / 配额是家长设的硬上限。框架不跑 LLM = 没有哪个 LLM 能自己决定花钱、
  外发、或绕过白名单。
- **这不是监控软件**:家长拿的是**学习记录的 fork 副本 + 越界审批权**,不是孩子设备的实时
  监视。孩子 hub 是孩子的主权空间。
- **不是教育 / 心理 / 医疗建议**:导师是学习辅助,不替代老师、心理或医疗专业判断。flagged
  内容走家长审批正是为了让人(家长)留在回路里。
- **数据**:孩子学习数据主副本在孩子 hub,fork 给家长,用 data-class 闸锁死不外泄第三方。
  生产凭证(订阅 key)只在家长 hub vault,本 example 永不读写真实 key。

## 进阶可叠加(本 demo 故意不做,保持聚焦)

- **per-link 配额(P4-M4)**:给孩子那条 link 配 `perLinkQuotaBudget` → 跨 hub 上课计入预算,
  超额 fail-closed(限花费 / 时长)。
- **节点级配额 + 成本账本(Phase 17)**:token / 成本 pre-call peek,用完即停。
- **transcript 主动拉取(Stream G day-5)**:家长拉 `peer.transcript`(孩子 hub opt-in
  `share_transcript`),看孩子本地自主探索那部分。
- **家长端 IM 审批(Stream SW Phase D)**:把越界审批推到家长自己的 Telegram / 微信
  (`examples/im-steward-bridge` 已做实 async 审批回推)。

详见 [`docs/zh/FAMILY-LEARNING-HUB-DESIGN.md`](../../docs/zh/FAMILY-LEARNING-HUB-DESIGN.md)(完整
设计蓝图)、[`docs/zh/V5-G-FINAL.md`](../../docs/zh/V5-G-FINAL.md)(跨 hub 工作流编排)与
[`docs/zh/HANDS-ON-HUBS.md`](../../docs/zh/HANDS-ON-HUBS.md)(上手 hub 目录)。
