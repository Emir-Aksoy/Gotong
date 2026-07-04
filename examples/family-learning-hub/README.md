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
> 把这些关住,而不是"相信 AI 会乖"。
>
> **生产硬化已完成**(从「确定性 demo」到「真两机可部署」):四道安全闸经**真求值器**钉死、
> 分层内容审核、真 ws 两 host 联邦、真 DeepSeek 导师、家长 IM 监督、孩子 `/me` 自助。照着
> 上线见 [`docs/zh/FAMILY-LEARNING-GO-LIVE.md`](../../docs/zh/FAMILY-LEARNING-GO-LIVE.md);完整
> 蓝图见 [`docs/zh/FAMILY-LEARNING-HUB-DESIGN.md`](../../docs/zh/FAMILY-LEARNING-HUB-DESIGN.md)。

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

## 交付物(确定性可跑 + 真实可上线)

| 交付物 | 是什么 | 跑 |
|---|---|---|
| **6 剧情确定性 demo** | 经**真 WorkflowRunner + 真求值器 + 真收件箱**跑家长 `tutor-teach` 工作流,钉死两处 fail-open + 分层审核 + data-class 锁。无 key | `pnpm demo:family-learning-hub` |
| **真 ws 两 host 联邦** | `acceptHubLinks`/`connectHubLink` + `bearerAuth` + per-link 契约;白名单外跨真 socket 挂起、错 token 握手被拒。无 key | `pnpm demo:family-learning-hub:federation` |
| **家长端 IM 监督桥** | 越界 / flagged 审批推家长 IM、批 / 拒回推(复用管家 async 回推);跨家长隔离 no-leak。无 key | `pnpm demo:family-learning-hub:im` |
| **真 DeepSeek 导师(opt-in)** | 真 `LlmAgent` 导师接进真工作流,链条自检(无 key 退确定性) | `FL_REAL=1 DEEPSEEK_API_KEY=… pnpm demo:family-learning-hub:real` |
| **可载入模板 ×2** | 家长侧 `family-tutor.template.yaml`(导师 + 工作流含两 `human:` 审批 + KB 槽位)+ 孩子侧 `child-desk.template.yaml`(两 `surface.me` 工作流 + KB 槽位,0 LLM agent) | `pnpm demo:family-learning-hub:template` |
| **孩子 `/me` 自助验收门** | 真 `WorkflowController` 上证孩子经 `/me` 自助发起、`learner_id` 强制不可伪造 | `pnpm --filter @gotong/host test family-child-me-e2e` |

> **从哪起步**:先跑 6 剧情 demo 看清四道闸,再跑 `:federation` 看真 ws,最后照
> [`FAMILY-LEARNING-GO-LIVE.md`](../../docs/zh/FAMILY-LEARNING-GO-LIVE.md) 上两机真部署
> (Tier 0 hermetic → Tier 1 真引擎单机 → Tier 2 两台主权机)。

## ★ 模版和框架是分离关系(本案例的教学点,同 tea-supply-link)★

模板(`template/family-tutor.template.yaml`)**只**带「家长 hub 一侧的编排骨架」:`/teach`
风格的导师 agent、`tutor-teach` 工作流(含两 `human:` 审批步)、`learning_records` KB 槽位、
一次性 key 提示。

它**不**带、也**不能**带「跨组织的链接」本身:

| 这件事 | 住在哪 |
|---|---|
| 哪个 peer 是孩子的 hub | **运行时** peer 配置(host `installPeerLink` / admin「联邦」tab) |
| 出站放行哪些 capability(`outboundCaps`) | **运行时** per-link 信任契约 |
| 孩子数据的 data-class 契约(`allowedDataClasses`) | **运行时** per-link 信任契约 |
| 越界主题是否需家长审批(`requireApprovalOutbound`) | **运行时** per-link 信任契约 |
| 工作流的 `tutor` 步 | 只写一个 **capability 名**(`tutor.teach`),**从不点名某个 peer** |
| 确定性闸参与者(`topic.screen` / `content.moderate` / `records.append` …) | **运行时**接线的 example 代码(`src/participants.ts`),非模板托管 agent |

换句话说:**模板是「可搬走的骨架」,链接 + 确定性闸参与者是「落地时各自配的运行时件」**。
一份模板,多个家庭各自连各自孩子的 hub,凭证 / 数据 / 计费互不串线。这正是「自由图,不是
层级树」落到一个具体的家庭安全场景。

## ★ 同一个家长策略,两种等价审批形态各演示一次 ★

设计 §七:审批人是家长,家长是**家长 hub** 的本地用户。所以审批要么放在**持审批人**的那个
hub 的工作流 `human:` 步里,要么落在 link 层的运行时出站审批闸。这两种等价形态本案例**各用一个
可跑 demo 演示**:

- **6 剧情 demo(`src/index.ts`)= 工作流 `human:` 步**:`家长 hub` 本地跑 `tutor-teach` 工作流
  (`screen` →`guardian-approval`[`human:`]→`teach`→`moderate`→`mod-approval`[`human:`]),孩子的
  请求"到达"家长 hub,审批是家长 hub 的本地 `human:` 步。经**真求值器 + 真收件箱 + 两步恢复**跑。
- **真 ws 联邦 demo(`src/federation.ts`)= 运行时出站审批闸**:孩子 hub 跑 lesson 工作流,
  `tutor.teach` 任务在**出站边**(`installPeerLink` 的 `wrapOutbound`)被 `TopicWhitelistGate`
  按家长白名单拦,白名单外挂起在家长收件箱,批准了才跨真 socket。对孩子工作流**透明**(孩子侧
  无 `human:` 步)。

**为什么 `human:` 步必须住家长 hub 侧(本设计最关键的正确性约束)**:本地 `human:` 步只能指派给
**本 hub 的用户**。孩子 hub 的本地 `human:` 指派不到家长(家长是另一个 hub 的用户)。所以工作流
形态的审批住家长 hub;孩子侧要审批就走运行时出站审批闸。模板(=家长侧)带 `human:` 步正因如此。

> 对比 cafe-ops(店内加班审批,店长和发起人在同一个 hub):那里 `human:` 步天然指派得到同
> hub 的店长。这里审批要**跨组织**,所以分这两条路。

## 管辖权 = 三根柱子(全是现成的)

家长的"管辖权"不是一个新功能,而是三根已经做实的柱子叠起来——**关键认识:管辖权落在
「谁持有订阅 + 谁设 link 契约」,不是「谁在谁的 hub 里当 admin」**。这让孩子保留主权 hub,
家长仍有真权力。

| 柱子 | 机制 | demo 里看得到 |
|---|---|---|
| **① 持订阅(经济咽喉)** | 模型 key 只在家长 hub;`tutor.teach` 在家长侧跑 = 计家长订阅;家长**断 link** 孩子立刻没 AI | 每节课都"跨到家长 hub"才上(导师被联系次数 = 真上的课数) |
| **② per-link 信任契约(在家长这侧设)** | 能力白名单 `outboundCaps` / 数据类 `allowedDataClasses` / 出站审批(主题白名单) | `:federation` demo 的 `installPeerLink`:通告 `[tutor.teach, report.to-guardian]`、契约 `[child-learning]`、入站配额预算 |
| **③ 全量 transcript fork(oversight)** | 导师在家长 hub 跑 → 那次辅导 transcript 原生在家长侧;`report.to-guardian` 显式 fork | 家长每跑一课收一份 fork 小结 |

## AI 安全隐患怎么被结构性关住(四道闸,纵深叠加)

核心是北极星第一条**「框架不跑 LLM」**:AI 只能产出一个 Task,而**每个 Task 必须经派发,
每次派发都穿闸**。不是"信任 AI 会乖",而是 **AI 物理上碰不到危险面,除非过闸**。

| 隐患 | 闸 | demo 里看得到 |
|---|---|---|
| **AI 说不该说的 / 越界主题** | **确定性**主题白名单(返真布尔) + 内容自评打标 → 家长审批 | [A]「投资理财」白名单外 → 挂起等家长批;[F] 家长**拒绝**→ 这一课真的不上 |
| **AI 漏判内容** | 分层审核:自评(底层) + **可选规则引擎**(第二层) | [D] 自评漏了「游戏外挂」,规则引擎拦下;[E] 空规则清单 = 关闭,只剩自评 |
| **孩子数据外泄** | data-class allowlist 锁死(fail-closed) | [C] 同一 `child-learning` 任务发家长通、发第三方拒(`outbound_data_class_denied`) |
| **AI 做危险动作 / 对外发 / 烧钱** | 能力边界 + dispatch 白名单 + 出站边闸 + 配额 fail-closed | 跨 hub 出口只放行 `outboundCaps` 里的能力;`:federation` 设 per-link 入站配额预算 |

**纵深防御**:这些闸是**叠加**的,不是择一。最弱的一环(内容自评,AI 自己判自己)由「确定性
主题白名单硬边界 + 可选规则引擎 + 全量 transcript 家长可见」三层补强。一道闸被绕过,还有下一道。

## 这个 demo 证明了什么(确定性,无需 API key)

`src/index.ts` 经**真 WorkflowRunner + 真求值器(predicate)+ 真 FileInboxStore + Phase 16
human-inbox broker** 跑家长 `tutor-teach` 工作流(不是内联 gate),把**两处 fail-open 漏洞**钉死:

| 剧情 | 结果 |
|---|---|
| **[A] 白名单外(投资理财)** | 跑到主题闸 → **挂起**等家长批 → 上课(自评把"投资理财"打标)→ 自评又触发内容审核 → 家长再批内容 → 记主副本 + fork。**挂起两次**(走 re-suspend 路径)。 |
| **[B] 白名单内(分数运算)** | 不挂起,直接续上第 2 课(进度递增 = `/teach` 文件状态当时钟),不触发任何审批。 |
| **[C] 数据外泄闸** | 同一 `child-learning` 任务发孩子 hub **通**(records.append)、发第三方 **拒**(`outbound_data_class_denied`)。第三方一条孩子数据都没收到。 |
| **[D] 内容命中规则(游戏外挂)** | 主题在白名单内,但内容被**规则引擎**标记 → 挂起在内容审核闸。**自评漏了**(外挂不是自评关键词)——这就是规则引擎(第二层)的价值。 |
| **[E] 关掉规则引擎(空清单)** | 同样的「外挂」内容 → 规则引擎 opt-out 不标 → 不挂内容闸,只剩自评底层兜底其它内容。 |
| **[F] 白名单外 + 家长拒绝(加密货币)** | 挂起等家长 → 家长**拒绝** → `teach` 步被 `when` 跳过 → **这一课不上,导师从未被联系**(钉死 workflow-level fail-open:拒绝真能拦)。 |

**钉死的两处 fail-open**:① **gate-level**——主题白名单是**确定性参与者**返真布尔 `{allowed}`,
审批闸的 `when: $screen.output.allowed == false` 读得到(若派给 LLM 返自由文本,`allowed` 读不到 →
求值 false → 审批步**静默跳过** → 白名单外零审批直达导师);② **workflow-level**——`teach`/`moderate`
guard 在 `… || $guardian-approval.output.approved == true`,家长拒绝真能拦住上课(否则拒绝只是把
`{approved:false}` 往下流,导师照常教)。

**进度 / 标记是确定性算的,不是 LLM 算的**(同 cafe-ops 的加班金额、tea-supply-link 的报价):
导师 stand-in 按学习档案续课号、按关键词自评打标;真实模式(`:real`,opt-in)才换成真 DeepSeek。

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
pnpm --filter @gotong/host test family-child-me-e2e
```

**真机预览(可选,go-live 时人工核对):** 见
[`FAMILY-LEARNING-GO-LIVE.md`](../../docs/zh/FAMILY-LEARNING-GO-LIVE.md) Step 6。
> ⚠️ 预览静态资源前先**清掉 PWA service worker**(scope `/`),否则可能看到旧的 `/me` 壳
> (memory `preview-sw-stale-static-assets`)。本垂直不改任何 SPA / 静态代码 —— `/me` 的动态
> 表单渲染是 Phase 14 / P1 早已 ship 的能力,这里只是把孩子的课接上去验证。

## 为什么 host-free(同 cafe-ops / cross-hub-workflow / tea-supply-link 先例)

这些 demo 只依赖 `@gotong/core` + `@gotong/workflow` + `@gotong/inbox`(+ `:federation`
另加 `@gotong/transport-ws`),把宿主机的组件**内联成可见的薄镜像**,让机制不被埋在 host 二进制里:

- **6 剧情 demo** 跑**真**家长 `tutor-teach` 工作流(真 `parseWorkflow` + `WorkflowRunner` + 真
  predicate + 真 `FileInboxStore` + `HumanInboxParticipant`);两步恢复(`HostInboxService.resolve` 的
  ~30 行手写镜像,**子闸严格先于父 workflow**)抽进 [`src/harness.ts`](src/harness.ts),与真实模式共用。
  生产里它由 `/me` 收件箱点一下批准触发。
- **真 ws 联邦 demo** 的 `TopicWhitelistGate` = `host/src/outbound-approval.ts` `ApprovalGatedParticipant`
  的最小镜像,**做成 selective**:`report.to-guardian`(oversight fork)直通;`tutor.teach` 按家长白名单
  筛,白名单外才 park。生产里它由 `installPeerLink` 的 `wrapOutbound` 钩子装上。

真正的跨 hub 链路是真的:`createInprocHubLinkPair`(6 剧情)/ `acceptHubLinks`+`connectHubLink`+
`bearerAuth`(联邦)+ `installPeerLink`,真 `checkOutboundDataClasses` 闸(由
`installPeerLink({allowedDataClasses})` 装在出站边)。

## 文件

| 文件 | 作用 |
|---|---|
| `src/teach.ts` | **TEACH-M1** —— `/teach` 方法论纯 planner `planTeach`:使命锚定 → 最近发展区 → 一个 concept(难度是敌人)→ 回忆 practice(难度是工具)→ 引一手来源 → **选项等长**小测 → 有证据才记 ADR 式 insight → 术语表。结构化 `Lesson` 类型的单一真相源(导师两侧 + 工作区写者 + 真模型 coerce 都用它)。 |
| `src/teach-workspace.ts` | **TEACH-M2** —— `writeTeachWorkspace` 把结构化 `Lesson` 落成文件优先工作区:`learning-records/<learnerId>/` 下的 `MISSION.md`(第一课确立后持久)、`RESOURCES.md` / `GLOSSARY.md`(累积去重)、`lessons/NNNN-slug.md`(每课写)、`records/NNNN-slug.md`(**仅有理解证据时写** = ADR 式学习档案,非流水账)。与真 LLM 导师 prompt 声明的同一形状、与 mcp-obsidian 读者对齐。 |
| `src/participants.ts` | 六个**确定性闸参与者**(被 hermetic demo + 真实模式共用):`TopicScreenParticipant`(`topic.screen`→真布尔 `{allowed}` ★fail-open 修复)、`ModerationParticipant`(`content.moderate`→`{flagged,reasons}`,空规则=关闭)、`LessonTutorStandin`(`/teach` 风格:经 `planTeach` 出**完整**结构化 `Lesson`,自评打标)、`RecordsAppendParticipant`(`records.append`,经 `writeTeachWorkspace` 写本地 `/teach` 工作区主副本)、`ReportToGuardianParticipant`(`report.to-guardian`,收 fork)、`ThirdPartyStandin`(必须收 0 条孩子数据)。 |
| `src/index.ts` | 6 剧情 demo:经**真**家长 `tutor-teach` 工作流跑 [A]-[F],钉死两处 fail-open + 分层审核 + data-class 锁;[D] 还钉死第 3 课的最近发展区**引用了第 2 课捕获的 insight**(`/teach` 档案驱动续课)。 |
| `src/harness.ts` | 共享底座:建两侧 hub + link + 真 WorkflowRunner + 真 inbox + ~30 行两步恢复镜像(被 6 剧情 demo 与真实模式共用)。 |
| `src/federation.ts` | 真 ws 两 host 联邦:`bearerAuth` 握手 + per-link 契约 + `TopicWhitelistGate` 出站审批 + 错 token 拒。 |
| `src/im-oversight.ts` + `src/im-oversight/` | 家长端 IM 监督桥:越界 / flagged 审批推 IM、批 / 拒回推、跨家长隔离 no-leak。 |
| `src/real-agents.ts` / `src/index.real.ts` | 真实模式(opt-in):真 `LlmAgent` 导师(DeepSeek)+ 真 mcp-obsidian + 链条自检(无 key 退确定性)。 |
| `workflows/tutor-teach.yaml` | **家长 hub 侧**工作流:`screen`→`guardian-approval`[human]→`teach`→`moderate`→`mod-approval`[human]。两个审批是家长 hub 本地 `human:` 步。 |
| `workflows/child-guided-lesson.yaml` | **孩子 hub 侧**工作流:`tutor`(跨组织,标 `child-learning`)→ `record`(本地主副本)→ `report`(跨组织 fork)。**YAML 里没有 peer 名,也没有 `human:` 步**(审批在家长侧)。 |
| `template/family-tutor.template.yaml` | **家长 hub 侧**可载入模板(1 导师 + 1 工作流含两 `human:` 审批 + KB 槽位)。 |
| `template/child-desk.template.yaml` | **孩子 hub 侧**可载入模板(两 `surface.me` 工作流 + KB 槽位,**0 LLM agent**)。 |
| `src/load-template.ts` | 载入演示(config-preview,不起 mcp-obsidian、不开 peer 链接)。 |

## 对应的生产组件

| demo 内联 | 生产真东西 |
|---|---|
| 家长 `tutor-teach` 工作流 + 两 `human:` 审批步 | 家长 hub 导入 `family-tutor.template.yaml`,`teach.lesson` 由 LlmAgent(DeepSeek + mcp-obsidian)服务 |
| `TopicScreenParticipant` / `ModerationParticipant`(确定性闸) | 运行时接线的 capability 参与者(`src/participants.ts`,example-first;fold 进 host main.ts 是显式推迟项) |
| `TopicWhitelistGate`(selective 出站闸) | `host/src/outbound-approval.ts` `ApprovalGatedParticipant`(`installPeerLink({wrapOutbound})`)+ 白名单作为家长 per-link 策略 |
| `resolveHumanStep` 两步恢复 | `host/src/inbox-service.ts` `HostInboxService.resolve` + `/me` 收件箱(或 IM)点批准 |
| `parked` Map(suspendNotifier) | identity `suspended_tasks` 表 + resume sweep |
| `allowedDataClasses` 出站闸 | `core` `checkOutboundDataClasses`(P4-M4,mesh/A2A/ACP 出站边共用同一纯函数) |
| `LessonTutorStandin`(家长 hub 的 `/teach` 导师) | `src/real-agents.ts` 的真 `LlmAgent`(DeepSeek + mcp-obsidian 读 `learning-records/`) |

## 决策落地(锁定的三个 + 数据 / 模板分离 + 分层审核)

| 决策 | 怎么落 | 诚实边界 |
|---|---|---|
| **1.a 内容自评打标 + 可选规则引擎** | 导师在输出里自标 `flagged`(底层,始终在);`ModerationParticipant` 持家长规则清单做事前预筛(第二层,空清单=关闭)。两层接进同一审批闸 | 自评是**最弱一档**(AI 判自己),靠确定性白名单硬边界 + 可选规则引擎 + 全量 transcript 三层兜底;要更强可后续加第二个模型审 |
| **2 调用触发非心跳** | 靠 `/teach` 的 `learning-records/` 文件状态当时钟,每次孩子调用读档续上 | 与 `/teach` 设计天生一致,**零额外机制**(不引 Stream D 心跳) |
| **3 主题白名单** | 白名单内直接流;白名单外 → 家长审批;白名单本身**家长发布、孩子改不了**(WFEDIT 出入口锁) | 白名单是"策略闸",审批是"例外口":大多数主题自由学,新主题家长一键放行 |
| **#4 模板带结构 + 引用,永不带内容** | KB 槽位 `learning_records` 只带「MCP 接线 + presetData 指针」;学习记录内容是孩子 hub 的磁盘文件,不在模板里 | 同 tea-supply-link / battle-monk-training 的「KB 存用户状态」先例 |
| **#5 + 本案例:跨组织链接也不在模板里** | 链接是运行时 per-link 信任契约(peer + outboundCaps + data-class + 审批策略),导入模板后到 admin「联邦」tab 配 | `tutor.teach` 步只写 capability,从不点名 peer |

## ✅ 复刻 Matt Pocock `/teach`:一个专门的导师(TEACH-M1→M3)

用户:「查看 `/teach` 这个 skill,这个工作流要做到复刻这样的有一个专门的导师的功能。如果什么
达不到,就补上。」拍板的忠实度天花板 = **方法论 + 文件优先工作区产物**(HTML / 音频 / 浏览器
渲染的互动课**留给消费端 app 层**,见下「忠实度天花板」)。

| 里程碑 | 复刻了 `/teach` 的什么 | 落点 |
|---|---|---|
| **TEACH-M1 方法论** | 使命锚定(第一课先立「为什么学」)→ 最近发展区(只推进一小步)→ 先知识(讲清**一个**要点,难度是敌人)后技能(回忆 practice,难度是工具)→ 每课**引一手来源** → **选项等长**的小测(长度不泄露答案)→ **有理解证据才**记一条 ADR 式 learning-record(不是流水账)→ 术语表。纯 planner `planTeach` + 结构化 `Lesson` 类型 | `src/teach.ts` |
| **TEACH-M2 工作区产物** | `MISSION.md`(确立后持久,不重写)、`RESOURCES.md` / `GLOSSARY.md`(累积去重)、`lessons/NNNN-slug.md`(每课写)、`records/NNNN-slug.md`(仅有证据时写 = ADR 式档案)。复制 `learning-records/<learnerId>/` 目录 = 搬走孩子整段学习旅程 | `src/teach-workspace.ts` |
| **TEACH-M3 模板导师** | 家长模板 `system:` prompt 对齐到完整 9 步 `/teach` 方法论 + 结构化 JSON 输出契约 + 自评 `flagged`。导入 `gotong start` 即得一个忠实的 `/teach` 导师(`teach.lesson` 由 LlmAgent 服务) | `template/family-tutor.template.yaml` |

**导师两侧同一套方法论**:hermetic demo 用 `LessonTutorStandin`(经 `planTeach` 出**完整**结构化
`Lesson`),真实模式用 `FamilyTutorAgent`(真 DeepSeek + mcp-obsidian,模型返 JSON → `coerceLesson`
解析成同一 `Lesson`,稀疏 / 畸形回复降级到 `planTeach` 基线)。安全契约不变:导师是**唯一** LLM,
四道确定性闸 + 自评 `flagged` 都不动。

**忠实度天花板**:复刻**方法论 + 文件产物**即止 —— HTML / 音频 / 浏览器渲染的互动课**仍是消费
端 app 层**(原生孩子 app 的前端产品工程,见「显式推迟 / 开放问题」§九 + §十二①)。导师产出的是
结构化课程(JSON → 工作区文件),把它渲染成孩子点得动的互动界面是独立的一层。

验证:`teach:selfcheck`(26 断言)+ `teach-workspace:selfcheck`(15 断言)+ `selfcheck`
(导师两侧 `/teach` 字段)+ `start`([D] 钉死 insight 驱动续课)全绿;web 防腐门只钉能力 /
工作流结构,**不**钉 prompt 文本,故方法论 prompt 可独立演进。

## 安全边界(家长产品的诚实边界)

- **AI 不替孩子做决定,也不替家长做决定**:导师只"提议下一课 / 给反馈",**放不放行越界
  主题由家长拍板**,钱 / 配额是家长设的硬上限。框架不跑 LLM = 没有哪个 LLM 能自己决定花钱、
  外发、或绕过白名单。
- **这不是监控软件**:家长拿的是**学习记录的 fork 副本 + 越界审批权**,不是孩子设备的实时
  监视。孩子 hub 是孩子的主权空间。IM 监督只推审批待办 + 计数,**不**把课程内容绕道 IM 平台
  (那会破坏 data-class 锁)。
- **不是教育 / 心理 / 医疗建议**:导师是学习辅助,不替代老师、心理或医疗专业判断。flagged
  内容走家长审批正是为了让人(家长)留在回路里。
- **数据**:孩子学习数据主副本在孩子 hub,fork 给家长,用 data-class 闸锁死不外泄第三方。
  生产凭证(订阅 key)只在家长 hub vault,本 example 永不读写真实 key(`:real` 从 `process.env` 读)。

## 进阶可叠加

- **per-link 配额(P4-M4)**:给孩子那条 link 配 `perLinkQuotaBudget` → 跨 hub 上课计入预算,
  超额 fail-closed(`:federation` demo 已设入站配额预算)。
- **节点级配额 + 成本账本(Phase 17)**:token / 成本 pre-call peek,用完即停。
- **transcript 主动拉取(Stream G day-5)**:家长拉 `peer.transcript`(孩子 hub opt-in
  `share_transcript`),看孩子本地自主探索那部分。
- **更强内容审核**:在自评 + 规则引擎之上再加第二个模型审,或对 flagged 强制人工复核。

详见 [`docs/zh/FAMILY-LEARNING-GO-LIVE.md`](../../docs/zh/FAMILY-LEARNING-GO-LIVE.md)(上线 runbook)、
[`docs/zh/FAMILY-LEARNING-HUB-DESIGN.md`](../../docs/zh/FAMILY-LEARNING-HUB-DESIGN.md)(完整设计蓝图)、
[`docs/zh/ledger/V5-G-FINAL.md`](../../docs/zh/ledger/V5-G-FINAL.md)(跨 hub 工作流编排)与
[`docs/zh/HANDS-ON-HUBS.md`](../../docs/zh/HANDS-ON-HUBS.md)(上手 hub 目录)。
