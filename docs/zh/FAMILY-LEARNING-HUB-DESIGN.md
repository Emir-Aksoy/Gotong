# 家庭学习 hub — 家长给孩子开 AI 订阅的联邦设计

> **这是设计文档(建之前的蓝图)**,不是 `*-FINAL` 收口文档。它把一个真实场景
> ——「家长给孩子开 AI 订阅,孩子能自主或跟随 AI 学习,家长要有管辖权,尤其 AI
> 本身有安全隐患」——映射到 AipeHub 已经做实的联邦 + 治理原语上,几乎零新机制。
> 落地按 §十一 的里程碑建 `examples/family-learning-hub`。
>
> 北极星:**框架永不跑 LLM**。Hub 只路由消息 / 派 task / 写 transcript / 发事件,
> 一切决策在参与者(agent / 人)手里。这条恰好是本场景最硬的「AI 安全」杠杆——
> AI 在结构上够不着危险动作,除非过闸(§四)。
>
> Last updated: 2026-06-15

---

## 锁定决策(用户已拍板)

| # | 决策 | 落点 |
|---|---|---|
| 1 | **两主权 hub 联邦**(孩子 hub 独立,授权调用家长订阅) | §二 |
| 2 | **管辖权来自「家长持订阅」经济咽喉** + per-link 信任契约 + transcript fork | §三 |
| 3 | **内容审核 = 自评打标**(AI 导师在输出里自标 `flagged`,最弱一档,靠多层兜底) | §八 · 决策 1.a |
| 4 | **无心跳,调用模型触发**(靠 `/teach` 的 `learning-records/` 文件状态当时钟) | §五 · §八 · 决策 2 |
| 5 | **主题白名单**(白名单内直接流,外 → 家长审批) | §七 · §八 · 决策 3 |
| 6 | **`learning-records` 主副本放孩子 hub**,每次更新 fork 一份给家长 | §六 |
| 7 | **AI 导师贴近 Matt Pocock 的 `/teach` skill**(文件优先、跨会话、按调用续上) | §五 |
| 8 | **产品形态 = 孩子端自建 app(`/me` PWA 起步)+ 家长端 IM 监督** | §九 |

---

## 一、场景与目标

家长买了一份 AI 订阅,想给孩子用来学习。孩子有两种学法:

- **跟随学习(带探索)**:AI 导师主导,按孩子进度出下一课。
- **自主学习(看探索)**:孩子自己探索,AI 导师在旁观察、把结果反馈家长。

家长要的不是「监控软件」,而是**管辖权(jurisdiction)**:决定孩子能学什么、花多少、
数据去哪、越界了谁拍板。而且家长清楚 **AI 本身有安全隐患**(乱花钱 / 说不该说的 /
做危险动作 / 数据外泄),要在结构上把这些关住,而不是「相信 AI 会乖」。

**这正好是北极星第一层(我的 AI 桌面)+ 第二层(跨组织协作)的交点**:孩子有自己的
hub,家长有自己的 hub,两者联邦;但「凭证(订阅)、数据、计费各归各家」反过来用——
**订阅在家长这边**,孩子借道使用,这本身就是管辖权。

---

## 二、为什么是两主权 hub 联邦(不是单 hub 监护)

最直觉的做法是单 hub:家长 = owner,孩子 = member。但用户选了**两主权 hub**,这个翻法
**更对**,理由:

1. **孩子也配有「我的 AI 桌面」**。孩子 hub 独立 = 孩子的自主探索可在本地、甚至用免费
   模型,不必每件事都过家长。这尊重孩子的学习自主性。
2. **管辖权的来源更干净——不是 RBAC 压人,而是经济咽喉**。订阅(LLM key)只在家长 hub,
   孩子 hub **根本拿不到 key**。「用 AI 导师」这件事每次都得**跨 hub 借道家长**。家长
   只要在那条 link 上设契约 / 断 link,就有真管辖权,不需要在孩子 hub 里塞一堆管控角色。
3. **数据治理天然分层**。孩子的学习数据是孩子 hub 的主权数据(§六 主副本在孩子 hub),
   家长拿的是 **fork 的副本**,用 data-class 闸锁死它不外泄到第三方(§四)。

> 对照 [`tea-supply-link`](../../examples/tea-supply-link)(奶茶店↔供货商)和
> [`tea-chain-hq`](../../examples/tea-chain-hq)(总部↔门店):那两个也是「一个 hub 的
> 工作流编排另一个 hub 的能力,走出站审批闸」。家庭学习 hub 是同一套**跨 hub 工作流
> 编排**(见 [`V5-G-FINAL.md`](V5-G-FINAL.md)),只是「能力」从「确认订单」换成「上一课」。

### 拓扑

```
        孩子 hub (owner = 孩子, 我的 AI 桌面)        家长 hub (owner = 家长, 持订阅)
        ┌──────────────────────────────┐   per-link   ┌──────────────────────────────┐
        │  自主探索 agent(本地/免费模型)│   信任契约   │  订阅 · key · 配额            │
        │  learning-records/(主副本)   │ ───────────► │  AI 导师 · /teach 技能        │
        │   MISSION · RESOURCES · 进度  │  ① 授权调用  │  审批闸 · 主题白名单          │
        │                              │ ◄─────────── │  全部 transcript(oversight)  │
        └──────────────────────────────┘  ② 回下一课  └──────────────────────────────┘
                        │                  ③ fork 一份给家长 ▲
                        └───────────────────────────────────┘

  ① 孩子 hub 授权跨 hub 调用家长的 tutor.teach —— 模型调用在家长 hub,计家长订阅
  ② 导师按 /teach 读 learning-records 续上:「带探索」出下一课 / 「看探索」观察并反馈
  ③ 每次结果 fork 一份给家长 = 数据复制 + 管辖权(家长见全部 transcript,可断 link)
```

**两侧 hub 都是主权的**:各自有 owner、各自有 `.aipehub/` 目录、各自重启透明。它们之间
是一条**联邦 link**(mesh hub-link,见 [`FEDERATION-RUNBOOK.md`](FEDERATION-RUNBOOK.md)
的两机操作员流程)。家长是这条 link 的**资源提供方**,孩子是消费方。

---

## 三、管辖权 = 三根柱子(全是现成的)

家长的「管辖权」不是一个新功能,而是**三根已经做实的柱子**叠起来:

| 柱子 | 机制 | 现成出处 |
|---|---|---|
| **① 持订阅(经济咽喉)** | 模型 key 在家长 hub;孩子 hub 调 `tutor.teach` 跨 hub,LLM 在家长侧跑→**计家长订阅**;家长**断 link** 孩子立刻没 AI | OrgApiPool + 跨 hub 能力派发([Stream G](V5-G-FINAL.md));`revocation_state`([P4](V4-PHASE19-P4-FINAL.md)) |
| **② per-link 信任契约(在家长这侧设)** | 能力白名单 `outboundCaps` / 配额 `perLinkQuotaBudget` / 数据类 `allowedDataClasses` / 出站审批 `requireApprovalOutbound` / 可调 KB `allowedKnowledgeBases` | identity v15 + v17 per-peer 列([P4](V4-PHASE19-P4-FINAL.md) · [C-M1](V5-C-FINAL.md)) |
| **③ 全量 transcript fork(oversight)** | 导师在家长 hub 跑→那次辅导 transcript **原生**就在家长侧;孩子自主探索那部分→`report.to-guardian` 显式 fork;另可拉 `peer.transcript` | Phase 8 transcript + [Stream G day-5](V5-G-FINAL.md) `peer.transcript`(opt-in `share_transcript` v27) |

**关键认识:管辖权落在「谁持有订阅 + 谁设 link 契约」,不是「谁在谁的 hub 里当 admin」。**
这让孩子保留主权 hub,家长仍有真权力。三根柱子里**没有一根需要新写**——P4 的 per-link
契约、Stream G 的跨 hub 编排、Phase 8 的 transcript 全部 ship 过了。

---

## 四、AI 安全隐患怎么被结构性关住

把「AI 本身的安全隐患」拆成四类,每类对到一道**现成的闸**。核心是北极星第一条
**「框架不跑 LLM」**:AI 只能产出一个 Task,而**每个 Task 必须经派发,每次派发都穿闸**。
不是「信任 AI 会乖」,而是**AI 物理上碰不到危险面,除非过闸**。

| 隐患 | 闸 | 现成机制 |
|---|---|---|
| **AI 做危险动作**(删文件 / 花钱 / 对外发 / 调外部服务) | 能力边界 + dispatch 白名单 + **出站边闸** | Phase 10(`DispatchToolset` + ancestry/环路/深度 gate)+ [Item 2](V5-H-FINAL.md)(A2A/ACP/mesh 出站全过 data-class+配额闸) |
| **孩子数据外泄** | data-class allowlist 锁死 | [P4-M4](V4-PHASE19-P4-FINAL.md) `checkOutboundDataClasses` —— 把孩子学习数据标 `child-learning`,任何 `allowedDataClasses` 不含它的出站边一律拒(fail-closed) |
| **AI 用太多**(烧钱 / 沉迷 / 时长失控) | 配额 fail-closed | [Phase 17](V4-PHASE17-FINAL.md)(token/成本预算 pre-call peek,**用完即停**)+ per-link `perLinkQuotaBudget` 限孩子那条 link |
| **AI 说不该说的**(不当内容 / 有害建议 / 越界主题) | 内容自评打标 + 主题白名单 → 家长审批 | §五(导师自标 `flagged`)+ §七(白名单外 park 到家长收件箱,[Phase 16](V4-PHASE16-FINAL.md) 两步恢复) |

外加 **agent 自身高危动作闸**:若导师 agent 想改授权 / 删审计 / 改安全配置,
`authorizeAgentAction` 命中封闭高危清单→`requires_human`,走收件箱([0-M2](V5-0-FINAL.md))。

**纵深防御**:这些闸是**叠加**的,不是择一。最弱的一环(内容自评,§八)由「全量
transcript 兜底 + 主题白名单硬边界」补强。一道闸被绕过,还有下一道。

---

## 五、AI 导师 = Matt Pocock `/teach` skill 移植

用户要导师**尽量贴近 Matt Pocock 开源的 `/teach` skill**。这个 skill 的设计正好是
AipeHub 的母语——**文件优先、跨会话、按调用续上**:

| `/teach` 文件 | 作用 | 在本设计里 |
|---|---|---|
| `MISSION.md` | 捕获「为什么学 / 当前水平 / 成功标准 / 学习偏好」 | 孩子首次开课时导师对话生成,落孩子 hub |
| `RESOURCES.md` | 选好的学习材料 | 导师按 mission 生成,可接 KB(mcp-obsidian) |
| 互动课(HTML + 音频 + 测验) | 一课的交付 | 导师产出,推到孩子端 app(§九) |
| `learning-records/` | 跨会话进度,**每课更新** | **主副本在孩子 hub**(§六),fork 给家长 |

### ✅ TEACH-M1→M3:`/teach` 方法论 + 文件优先工作区已忠实复刻

用户:「查看 `/teach` 这个 skill,这个工作流要做到复刻这样的有一个专门的导师的功能。如果什么
达不到,就补上。」拍板的忠实度天花板 = **方法论 + 工作区产物**(不含 HTML/音频/浏览器渲染,
那是消费端 app 层 §九)。三个里程碑做实:

| 里程碑 | 复刻了什么 | 在哪 |
|---|---|---|
| **TEACH-M1** | `/teach` **方法论核心** —— 纯 planner `planTeach`:使命锚定(第一课先立「为什么学」)→ 最近发展区(一小步)→ 先知识(一个要点,难度是敌人)后技能(回忆练习,难度是工具)→ 每课引一手来源 → **选项等长**的小测(长度不泄露答案)→ 有理解证据才记一条 **ADR 式** learning-record(不是流水账)→ 术语表。结构化 `Lesson` 类型 + 导师两侧(确定性 `LessonTutorStandin` + 真 `FamilyTutorAgent`)都按这套出课 | `src/teach.ts` · `src/participants.ts` · `src/real-agents.ts` |
| **TEACH-M2** | `/teach` **文件优先工作区产物** —— `writeTeachWorkspace` 把结构化 `Lesson` 落成 `learning-records/<learnerId>/` 下的 `MISSION.md`(第一课确立后持久,不重写)、`RESOURCES.md`(累积去重)、`GLOSSARY.md`(术语累积去重)、`lessons/NNNN-slug.md`(每课都写)、`records/NNNN-slug.md`(**仅有理解证据时写** = ADR 式学习档案,非流水账)。确定性写者与真 LLM 导师 prompt 声明的同一形状,与 mcp-obsidian 读者对齐 | `src/teach-workspace.ts` |
| **TEACH-M3** | 模板 `system:` prompt 对齐到完整 `/teach` 方法论(9 步 + 结构化 JSON 输出契约 + 自评 `flagged`),`family-tutor.template.yaml` 导入 `aipehub start` 即得一个忠实的 `/teach` 导师;web 防腐门保持绿(只钉能力/工作流结构,不钉 prompt 文本) | `template/family-tutor.template.yaml` |

**忠实度天花板(§九)**:复刻**方法论 + 文件产物**即止——HTML / 音频 / 浏览器渲染的互动课
**仍留给消费端 app 层**(原生孩子 app 的前端产品工程,§九 + §十二①)。导师产出的是结构化课程
(JSON → 工作区文件),把它渲染成孩子点得动的互动界面是独立的一层。

**为什么完美契合两个锁定决策**:

- **决策 4「无心跳,调用模型触发」**:`/teach` 本来就不靠定时器——每次调用时**读
  `learning-records/` 知道学到哪、续上**。文件状态就是时钟。所以**不用 [Stream D 心跳](V5-D-FINAL.md)**,
  零额外机制。
- **北极星第三条「状态都是磁盘文件」**:`MISSION.md` / `learning-records/` 就是
  [`battle-monk-training`](../../examples/battle-monk-training) 那种「KB 存用户状态」
  的实例——复制目录 = 搬走孩子的整段学习旅程。

### 两个模式(都在「调用模型」那一刻触发,无心跳)

- **带探索(lead)**:孩子调用 → 跨 hub 到家长导师 → `/teach` 读 `learning-records/` →
  出下一课 → 回孩子 hub。
- **看探索(watch)**:孩子在自己 hub 本地探索 → 调用时导师**观察** + `report.to-guardian`
  把小结 fork 给家长 → 导师产出反馈。

lead vs watch 由孩子当次发起的工作流(或入参)决定,**不是 AI 自作主张**——决策权在
发起动作的人手里。

> 来源:[/teach skill 介绍(aihero.dev)](https://www.aihero.dev/learn-anything-with-my-teach-skill) ·
> [mattpocock/skills(GitHub,21 个 skill)](https://github.com/mattpocock/skills)。
> 移植的是**方法论与文件结构**(原创实现),不逐字搬运其代码/文案。

---

## 六、数据流:learning-records 主副本在孩子 hub

**决策 6**:孩子的学习记录是**孩子的主权数据**,主副本放孩子 hub;每次更新 fork 一份给
家长做监督。这比「主副本在家长 hub」更尊重孩子 hub 的独立性,且**正好实现用户要的
「数据传输时从家长这里也发一份」**——但方向是「孩子留原件,家长收副本」。

```
孩子发起一课
   │
   ├─(本地)写 learning-records/<date>.md         ← 主副本,孩子 hub 的磁盘
   │
   ├─(跨 hub)tutor.teach → 家长 hub 导师上课      ← 模型在家长 hub,transcript 原生留家长
   │                          dataClasses:[child-learning]
   │
   └─(跨 hub)report.to-guardian → 家长 hub        ← fork 一份小结给家长(oversight 副本)
                               dataClasses:[child-learning]
```

**三条「家长拿到一份」的路**(对应 §三 柱子 ③):
1. 导师在家长 hub 跑 → 那次辅导的 transcript **原生**就在家长 hub。
2. 孩子**本地自主探索**那部分(没调家长模型)→ `report.to-guardian` step 显式 fork。
3. 需要时家长拉 `peer.transcript`(孩子 hub opt-in `share_transcript`,[Stream G day-5](V5-G-FINAL.md))。

**data-class 锁**:跨 hub 的 step 都标 `dataClasses: ["child-learning"]`。家长那条 link 的
`allowedDataClasses` 含 `child-learning` → 放行;孩子 hub 若还连了**别的** peer,而那条
link 的 `allowedDataClasses` **不含** `child-learning` → 一律拒(fail-closed)。**孩子学习
数据只能流向家长,流不到第三方。**

---

## 七、两条工作流

> 设计要点:**内容审核与主题白名单的「审批」闸住在家长 hub 侧**(因为审批人=家长,
> 家长是家长 hub 的本地用户)。孩子 hub 的工作流只管发起 + 记录 + fork,**不**在本地放
> 审批步(本地 `human:` 只能指派给本 hub 用户,指派不到家长)。这是本设计最关键的一个
> 正确性约束。

### 工作流 A —— 带探索(孩子 hub 发起,跨 hub 借家长导师)

**孩子 hub** 侧(简单:发起→记录→fork):

```yaml
schema: aipehub.workflow/v1
id: child-guided-lesson
trigger: { capability: learn.request }       # 孩子 via /me
surface:
  me:
    enabled: true
    label: "跟 AI 导师学一课"
    inputSchema:
      - { id: topic, type: text, label: "今天想学什么?" }
    userScopeField: learner_id                # 强制 payload.learner_id = userId
steps:
  - id: tutor                                 # ① 跨 hub:调家长导师(模型在家长 hub,计家长订阅)
    dispatch: { capability: tutor.teach }     #    这能力只有家长 hub 通告 → 路由过去
    dataClasses: ["child-learning"]           #    标 data-class,过 per-link 闸
  - id: record                                # ③ 写回本地 learning-records(主副本)
    dispatch: { capability: records.append }
  - id: report                                # ④ fork 一份给家长(oversight)
    dispatch: { capability: report.to-guardian }
    dataClasses: ["child-learning"]
```

**家长 hub** 侧(`tutor.teach` 的实现——主题白名单 + 家长审批在这里):

```yaml
schema: aipehub.workflow/v1
id: tutor-teach
trigger: { capability: tutor.teach }          # 被孩子 hub 跨 hub 调用
steps:
  - id: screen                                # 主题白名单(家长配置的确定性查表)
    dispatch: { capability: topic.screen }
  - id: guardian-approval                     # 白名单外 → 家长批(assignee 是本 hub 用户 ✓)
    when: "$screen.output.allowed == false"
    human:
      assignee: $guardian
      kind: approval
      prompt: "孩子想学「白名单外」的主题,允许这次吗?"
  - id: teach                                 # /teach 导师上课(读 learning-records 续上)
    dispatch: { capability: teach.lesson }
```

**审批怎么流**:孩子调 `tutor.teach` → 家长 hub 工作流命中白名单外 → `human:` step **挂起**
(`NEVER_RESUME_AT`)+ 写家长收件箱 item。**孩子 hub 那一步看到的是「跨 hub step suspended」,
整个 run 等着**(Stream G 跨 hub 挂起 + 两步恢复,G-M2 已验收)。家长在 `/me` 收件箱
(或 IM,§九)批准 → 家长 hub 导师上课 → 结果跨 hub 回流孩子 hub。白名单**内**的主题
`when` 旁路,直接 `teach`,不挂起。

### 工作流 B —— 看探索(孩子本地探索,导师观察反馈)

**孩子 hub** 侧:

```yaml
schema: aipehub.workflow/v1
id: child-autonomous-explore
trigger: { capability: explore.start }        # 孩子 via /me
surface:
  me: { enabled: true, label: "我自己探索,导师在旁看", userScopeField: learner_id }
steps:
  - id: explore                               # 本地自主探索(孩子 hub,可免费模型)
    dispatch: { capability: explore.local }
  - id: record                                # 写本地 learning-records(主副本)
    dispatch: { capability: records.append }
  - id: tutor-watch                           # 跨 hub:导师观察 + 反馈(看一眼)
    dispatch: { capability: tutor.review }
    dataClasses: ["child-learning"]
  - id: report                                # fork 一份给家长
    dispatch: { capability: report.to-guardian }
    dataClasses: ["child-learning"]
```

**对比**:A 是「导师主导」(模型重心在家长 hub),B 是「孩子主导、导师旁观」(探索在
孩子 hub 本地,导师只 review)。两条都**孩子发起、调用即触发**,无心跳。

---

## 八、三个锁定决策怎么落

| 决策 | 怎么落 | 诚实边界 |
|---|---|---|
| **1.a 内容自评打标** | 导师在 `teach.lesson` 输出里自标 `flagged`;因辅导在家长 hub 跑,flag + 内容**原生落家长 transcript**,家长看得到 | 自评是**最弱一档**(AI 自己判自己)。靠 ① 全量 transcript 兜底 + ② 主题白名单硬边界 + ③ 家长事后可见,三层叠起来够用;要更强可后续换「专门审核参与者」(§十二) |
| **2 调用触发非心跳** | 靠 `/teach` 的 `learning-records/` 文件状态当时钟,每次孩子调用读文件续上 | 与 `/teach` 设计天生一致,**零额外机制**(不引 Stream D 心跳) |
| **3 主题白名单** | 白名单内主题直接流;白名单外 → 家长 hub `human:` 审批(§七工作流 A);白名单本身家长发布、**孩子改不了**(WFEDIT 出入口锁) | 白名单是「策略闸」,审批是「例外口」:大多数主题自由学,新主题家长一键放行 |

**白名单为什么孩子改不了**:即便将来给孩子「用大白话改自己工作流」的能力
([WFEDIT](V5-WFEDIT-FINAL.md)),出入口锁也保证成员**改不了 trigger 和跨 hub 出口**——
`tutor.teach` 这个跨 hub 出口、以及它带的 `dataClasses`,孩子逐字节动不了。

---

## 九、产品形态:孩子端自建 app + 家长端 IM 监督

**原则**:产品价值是「受控环境 / 安全 / 结构化教学 / 数据自主」时,**必须自己拥有
surface**;IM 给你触达和便利,给不了控制。这个家庭安全产品的核心卖点恰恰是「控制」,
所以北极星形态是**自建 app**:

1. **管辖权要可执行**:IM 是别人的平台,管不了屏幕时间、锁不住环境、挡不住孩子在同一
   app 里直接开原版 ChatGPT。app 才能让「受控环境」真的成立。
2. **内容边界 + data-class 自洽**:IM 消息过第三方服务器(Telegram/微信),跟 §六 的
   data-class 锁死 + fork-给家长**冲突**——孩子学习数据不该绕道别人服务器。
3. **`/teach` 的 UX 要真界面**:互动课、音频、测验、进度、scaffolding,纯聊天框做不出来。

**但不是二选一——AipeHub 架构让 surface 与引擎解耦**:hub + agent + workflow 后端完全不变,
IM bridge / `/me` PWA / 原生 app 只是同一套 `/me` API 的不同前端。所以最佳形态是**混合**:

- **孩子端 = 自建 app,从现成的 `/me` PWA 起步**([Phase 12 M9-M11](V4-PHASE12-FINAL.md):
  已移动响应式 + 可安装 + 你 100% 控制),不用从零写原生壳。
- **家长端 = IM 做旁路监督**:审批 / 告警推到家长自己的 Telegram/微信——**管家的 async
  审批回推([Stream SW Phase D](V5-STEWARD-FINAL.md),`examples/im-steward-bridge`)已做实
  这条**。家长不必专门开 app,就能批准越界请求、看告警,这正是 IM 「触达便利」的最佳用法。

**渐进路径(后端零改,不是架构豪赌)**:现在先用 IM 验证需求 → 再升 `/me` PWA → 要原生
再包壳。每一步后端不动,只换前端。

---

## 十、复用清单(每块用哪个现成机制,不重造)

| 需要 | 复用 | 出处 |
|---|---|---|
| 孩子 hub 授权调家长导师(跨 hub 能力派发) | 「通告=授权」`remoteCapabilities ← outboundCaps` + 两步恢复 + 三不变量 | [Stream G](V5-G-FINAL.md) |
| per-link 信任契约(能力/配额/data-class/审批/KB) | `peers` v15 + v17 + v23 + v27 列 | [P4](V4-PHASE19-P4-FINAL.md) · [C-M1](V5-C-FINAL.md) · [E5](V5-E5-FINAL.md) |
| 出站 data-class 闸(锁孩子数据) | `checkOutboundDataClasses`(mesh/A2A/ACP 共用纯函数) | [P4-M4](V4-PHASE19-P4-FINAL.md) · [Item 2](V5-H-FINAL.md) |
| 配额 fail-closed(限花费/时长) | `usage_ledger` + budget peek + per-link `FixedWindowLimiter` | [Phase 17](V4-PHASE17-FINAL.md) · [P4-M4](V4-PHASE19-P4-FINAL.md) |
| 家长审批越界主题(挂起→收件箱→恢复) | `human:` YAML 糖 → `aipehub.human/v1` + 两步恢复 | [Phase 16](V4-PHASE16-FINAL.md) |
| 成员(孩子)为自己发起 + 脱敏 agent | `surface.me` + `userScopeField` + `/me` 脱敏投影 | [Phase 14](V4-PHASE14-FINAL.md) · [P1](V4-PHASE19-P1-FINAL.md) |
| 孩子改不了出入口 | 自然语言编辑出入口锁 | [WFEDIT](V5-WFEDIT-FINAL.md) |
| 导师 = `/teach`(文件状态 + KB) | KB via mcp-obsidian + 「KB 存用户状态」先例 | [KB-CONNECTORS](KB-CONNECTORS.md) · [`battle-monk-training`](../../examples/battle-monk-training) |
| transcript fork(家长 oversight) | Phase 8 transcript + `peer.transcript`(opt-in) | [Stream G day-5](V5-G-FINAL.md) |
| 家长 IM 收审批 | 管家 async 审批回推 | [Stream SW Phase D](V5-STEWARD-FINAL.md) |
| 两机联邦 onboarding | `mint-peer-token` + admin peer 面板 + 信任契约编辑器 | [FEDERATION-RUNBOOK](FEDERATION-RUNBOOK.md) · [P1-M7](V6-ROUTE-B-P1-M7-PEER-ONBOARDING.md) |

**一根都不用新写。** 家庭学习 hub 是把这些零件接成一个完整故事,跟 `tea-supply-link` /
`tea-chain-hq` 同体例(跨组织面)。

---

## 十一、要建什么(`examples/family-learning-hub` 草图)

跟 [`tea-supply-link`](../../examples/tea-supply-link) 同体例(跨 hub,host-free 确定性 demo +
可载入模板)。**模版/框架分离**(决策见 [Stream B](V5-B-FINAL.md) #4):模板只带「家长 hub
一侧的导师 + 工作流骨架」,**跨组织的 link(哪个 peer 是孩子 / `outboundCaps` / 审批策略)
是运行时 peer 配置,既不在模板也不在工作流**——`tutor.teach` 步只写 capability,从不点名
peer。这正是 `tea-supply-link` 的教学点。

| 里程碑 | 交付 |
|---|---|
| **FL-M1** 确定性 demo | core+workflow+inbox,两 in-proc hub(孩子/家长)。补货式跑通:`learn.request`→跨 hub `tutor.teach`→主题白名单外挂起→家长批→上课回流→`records.append`(本地主副本)→`report.to-guardian`(fork)。内联 ~40 行出站审批闸 + 两步恢复镜像(同 `tea-supply-link`)。白名单内不挂起。**钱/进度确定性算,不是 LLM 算**。自断言可跑(无 key) |
| **FL-M2** 可载入模板 | `template/family-tutor.template.yaml`(家长 hub 侧):导师 agent(`/teach` 风格,挂 mcp-obsidian → `learning_records` KB 槽位)+ `tutor-teach` 工作流(含 `human:` 白名单审批)+ DeepSeek apiKeyPrompt。web 防腐门:读实文件过真 `parseTemplate` + 逐条 `workflows[]` 过真 `parseWorkflow`(证 `human:` 脱糖 + data-class 透传)+ 真 import |
| **FL-M3** 载入演示 + 文档 | `pnpm demo:family-learning-hub:template` config-preview + README(拓扑图 + 模版/框架分离表 + 两模式对比 + 安全边界)+ 接 [HANDS-ON-HUBS](HANDS-ON-HUBS.md) 目录 + CLAUDE.md 登记 |

**孩子 hub 侧 + 联邦 link 是运行时**:模板不带孩子 hub 的 explore agent 与两侧的 link 配置
(同 `tea-supply-link` 不把供货商 link 写进模板)。README 用一段「§5 链接是运行时不在模板」
讲清这个分离。

### 生产硬化(FL-M1→M3 之后,从「确定性 demo」到「真两机可部署」)— ✅ 已完成

用户:「把这个工作流强化到可以实际使用的水平,因为它可能是我们的一个核心卖点。」FL-M1→M3 是
host-free 确定性 demo + 家长侧模板。这一轮把它带到真两机可部署 + 真 LLM + 真安全闸。**底层机制
几乎全现成**(联邦 ws / 出站 data-class 闸 / 配额 / Phase 16 inbox 两步恢复 / LlmAgent /
mcp-obsidian / `/me` PWA / IM bridge),所以是「把现成零件接成真能部署的两主权 host + 补真缺口 +
产品形态收口」,不是新机制。

| 阶段 | 交付 |
|---|---|
| **A — 安全正确的确定性核心** | ★ **修 fail-open 安全洞**:`topic.screen` / `content.moderate` 必须是**确定性参与者**返结构化 `{allowed}`/`{flagged}`,**绝不**派给 LLM(否则 `when:` 读不到字段 → 求值 false → 审批步**静默跳过** → 白名单外零审批直达导师)。`src/participants.ts` 六个确定性闸参与者;demo 改跑**真** `tutor-teach` 工作流(真 `WorkflowRunner` + 真 predicate + 真 `FileInboxStore` + 两步恢复镜像)证两处 fail-open 修复(gate-level + workflow-level「拒绝真能拦」)+ **分层审核**;家长模板 `topic.screen` 从 LLM 下放成运行时确定性参与者 + 加 `moderate`/`mod-approval` 步;新孩子侧模板 `child-desk.template.yaml`。各 web 防腐门。 |
| **B — 真实模式(opt-in,非 hermetic)** | `src/real-agents.ts` 真 `LlmAgent` 导师(DeepSeek 默认 / 可换 Anthropic)+ 真 mcp-obsidian 读写 `learning-records/`;`src/index.real.ts` 两真 hub 跑真工作流,链条自检(`FL_REAL=1` + key 否则退确定性仍发真 dispatch)。 |
| **C — 两 host 真 ws 联邦 + 家长 IM 监督 + 孩子 `/me`** | `src/federation.ts` 真 `ws`(`acceptHubLinks`/`connectHubLink` + `bearerAuth`)+ per-link 契约(`allowedDataClasses:[child-learning]` + 配额 + `outboundCaps`)+ 出站审批闸 + 错 token 拒;`src/im-oversight.ts` 家长端 IM 监督桥(越界 / flagged 审批推 IM、批 / 拒回推、跨家长隔离 no-leak,复用 `im-steward-bridge` async 回推);`packages/host/tests/family-child-me-e2e.test.ts` 证孩子经 `/me` 自助发起、`learner_id` 强制不可伪造。 |
| **D — go-live runbook + 文档** | [`FAMILY-LEARNING-GO-LIVE.md`](FAMILY-LEARNING-GO-LIVE.md)(真家庭 / 操作员能照着跑:三验证层 Tier 0 hermetic → Tier 1 真引擎单机 → Tier 2 两台主权机;接 HANDS-ON-HUBS 真 DeepSeek/Obsidian + FEDERATION-RUNBOOK 两 host;分层审核怎么配 + 安全清单 + 故障排查)+ README 收口 + 本节 + CLAUDE.md 登记。 |

**诚实边界(example-first)**:导师 + 工作流 + KB 槽位**经模板导入进真 `aipehub start`**(一等
公民);但**确定性闸参与者**是运行时接线的 example 代码(`src/participants.ts`)——它们是确定性
capability 参与者,不能当模板托管 agent(同 CLI / ACP 编码 agent)。把本垂直 fold 进生产 host
`main.ts` 是**显式推迟**项(§十二 ④,北极星 example-first:模板即产品化载体)。`src/index.real.ts`
已是这层薄接线的可跑参照。

---

## 十二、显式推迟 / 开放问题

- ~~**更强的内容审核**(决策选了最弱的自评打标)~~ — ✅ **已做(生产硬化 A)**:分层审核落地,
  自评(底层,始终在)+ 确定性**规则引擎** `ModerationParticipant`(第二层,家长配禁词清单,
  空清单 = 关闭 = opt-out)叠加,两层接进同一个家长 `mod-approval` 闸。仍可后续再加「第二个
  模型审」当第三层。
- **孩子端 app 的真实现**(本设计 + 生产硬化只到 `/me` PWA 起步 + 形态论证 + go-live runbook):
  互动课渲染、音频、测验、家长 dashboard、onboarding/计费是独立前端 / 产品工程,不在本 example
  范围。两机部署照 [`FAMILY-LEARNING-GO-LIVE.md`](FAMILY-LEARNING-GO-LIVE.md)。
- **per-step 粒度审批**:现审批是「白名单外 / flagged 整课」级,不是「一课内某动作」级。
- **多孩子**:每个孩子一个 member(同一孩子 hub)用 `userScopeField` 隔离,还是各自一个
  孩子 hub?推荐前者(轻量);多 hub 留给真有多设备/多主权需求时。
- **跨重启在飞的跨 hub 审批**:沿用 Stream G / H2 的 sweep 幂等,不额外处理。
- ④ **把本垂直 fold 进生产 host `main.ts`**:现确定性闸参与者是运行时接线的 example 代码
  (`src/participants.ts`,北极星 example-first:模板即产品化载体)。等使用模式稳定再决定是否
  做成 `aipehub start` 的 first-class 配置。

---

## 十三、安全与边界声明(家长产品的诚实边界)

- **AI 不替孩子做决定,也不替家长做决定**:导师只「提议下一课 / 给反馈」,**放不放行
  越界主题由家长拍板**,钱/配额是家长设的硬上限。框架不跑 LLM = 没有哪个 LLM 能自己
  决定花钱、外发、或绕过白名单。
- **这不是监控软件**:家长拿的是**学习记录的 fork 副本 + 越界审批权**,不是孩子设备的
  实时监视。孩子 hub 是孩子的主权空间。
- **不是教育/心理/医疗建议**:导师是学习辅助,不替代老师、心理或医疗专业判断。
  flagged 内容走家长审批正是为了让人(家长)留在回路里。
- **数据**:孩子学习数据主副本在孩子 hub,fork 给家长,用 data-class 闸锁死不外泄第三方。
  生产凭证(订阅 key)只在家长 hub vault,本设计与 example 永不读写真实 key。

---

> **下一步**:按 §十一 FL-M1→M3 建 `examples/family-learning-hub`(确定性 demo →
> 可载入模板 → 载入演示 + 文档),一里程碑一小 commit,纯本地。FL-M4 真实模式 opt-in。
