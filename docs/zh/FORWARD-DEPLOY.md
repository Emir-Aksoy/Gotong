# 前置部署 playbook — 用 Gotong 给一个团队 / 一段生活装上智能体网络（FDE）

> 这是一份**方法论文档**：把「专用 agent 工作流开发 + 大模型前置部署（FDE,
> Forward-Deployed Engineering）」这件事拆成五段流水线，每段映射到 Gotong
> 已有的工具和过关判据。目标读者是「要替别人（团队 / 家人 / 客户 / 自己的
> 下个月）把智能体网络装进真实流程」的那个人——不要求会写代码。
>
> 状态：**§二～§四今天就能照做**（映射的全是已落地能力，每处给指针）；
> **§五「方案包 schema」是 FDE-M1 的设计草案**，尚未实现，字段名在 M1
> 收口前允许改。
>
> Last updated: 2026-07-04 · FDE-M0

---

## 一、FDE 是什么，为什么 Gotong 适合做这个

**前置部署**指的是：工程师（或懂行的使用者）走进一个真实流程——一个团队的
报价审批、一家小店的排班、一个人的每日晨报——把 AI 从「聊天框里问答」变成
「常驻在流程里干活」。这活的难点从来不是模型，而是四件事：

1. **翻译**：把人嘴里的流程变成机器能执行的工作流，还要让当事人看懂并拍板；
2. **对接**：接上这家的真实系统（日历 / 知识库 / IM / 既有 agent），凭证不外泄；
3. **验收**：在**他们的**用例上证明能跑，而不是在 demo 上；
4. **移交**：装完人走，对方自己能改、能停、能换 key——不产生对部署者的依赖。

Gotong 的三条北极星守则恰好压住 FDE 的三个经典事故源：

- **框架不跑 LLM** → 部署进去的是可审计的路由和文件，不是黑盒（事故源：没人说得清 AI 到底干了什么）；
- **人和 agent 同一个 `Participant`** → 人在环是结构而不是补丁，审批 / 接管随处可插（事故源：自动化越过了该问人的地方）；
- **状态全是磁盘文件** → 复制 `.gotong/` 目录 = 搬走整个部署，移交无魔法（事故源：部署完只有部署者会伺候它）。

**民主化目标**：下面这条五段流水线，一个不写代码的人也应该能走完。每段列
「用什么 → 做什么 → 什么算过关」；过关判据尽量是**框架能自己验证的东西**
（会红的门、体检、试跑），不是「感觉可以了」。

---

## 二、五段流水线：每段用什么，做到什么算过关

```
 ① 发现/翻译 → ② 构建/对接 → ③ 部署 → ④ 验收/试运行 → ⑤ 观察/移交
 (把流程说清)   (组件接起来)   (跑起来)   (在真用例上过)    (人走系统留)
```

### ① 发现 / 翻译：把人嘴里的流程变成看得懂的工作流

| 用什么 | 干什么 |
|---|---|
| [`WORKFLOW-WIZARD.md`](WORKFLOW-WIZARD.md) 六段建流向导 | **主路径**。确认任务 → 盘点已有组件 → 组装 → **衡量任务和资源（人也算资源）** → 提议由用户调整/同意 → 校验闭环。三入口：admin / 成员 `/me` / 管家 IM 大白话 |
| [`WORKFLOW-ARCHITECT.md`](WORKFLOW-ARCHITECT.md) 架构师 | 大白话 → YAML + 中文讲解 + 配图，适合「先出个草稿再谈」 |
| [`WORKFLOW-DAG-VIZ.md`](WORKFLOW-DAG-VIZ.md) 只读流程图 | **给当事人看的**。拍板前把 DAG 摆给流程的主人，指着图确认「这步谁批、这步出 hub」 |
| [`AI-WORKFLOW-EDITOR.md`](AI-WORKFLOW-EDITOR.md) 大白话改流 | 部署后当事人自己微调的入口，发现阶段就该告诉对方它存在 |

**过关判据**：向导第⑥段校验绿（结构合法、能力都有人服务或缺口已列明）+
流程主人在第⑤段「提议」上**明确拍了板**。缺口（比如「需要一个还没有的
日历连接器」）不是错误——向导会把它列成三补法之一，带着缺口清单进②。

**边界注意**：该问人的步骤在这一段就钉死（`HITL` 步 / inbox 审批步），
别等上线了再补。人对流程的否决点是需求的一部分，不是运维选项。参见
[`HUMAN.md`](HUMAN.md) · [`HITL-GLOSSARY.md`](HITL-GLOSSARY.md)。

### ② 构建 / 对接：组件接起来，凭证各归各家

| 用什么 | 干什么 |
|---|---|
| [`TEMPLATE-GALLERY.md`](TEMPLATE-GALLERY.md) 模板画廊 + [`FLAGSHIP-TEMPLATES.md`](FLAGSHIP-TEMPLATES.md) | **先翻画廊再造轮子**：50 个 example（[`EXAMPLES.md`](EXAMPLES.md) 分七级）+ 旗舰模板，多数场景改模板比从零快 |
| [`PARTICIPANT.md`](PARTICIPANT.md) | 真要写代码时：**20 行一个 Participant**，agent / 人 / 服务同一契约 |
| [`AGENT-ADAPTER-CONTRACT.md`](AGENT-ADAPTER-CONTRACT.md) + [`QUICK-CONNECT.md`](QUICK-CONNECT.md) | 对方已有 agent（Claude Code / Codex / LangGraph / CrewAI / A2A / ACP…）：过「双向 + 五控制缝（可观测/可拦截/可移交/可续跑/可终止）」验收门再上岗，接管粒度对表 Tier 1/2 |
| [`MCP-CONNECTOR-DIRECTORY.md`](MCP-CONNECTOR-DIRECTORY.md) + [`KB-CONNECTORS.md`](KB-CONNECTORS.md) · [`RAG-VIA-MCP.md`](RAG-VIA-MCP.md) | 接数据源（日历 / 笔记 / 知识库）全走 MCP，**框架不存知识**；连接器目录里挑，运行时挂到 agent 上 |

**过关判据**：agent 出现在 roster 且能力注册可见；配置体检
（[`EASE-OF-USE-DEEPENING.md`](EASE-OF-USE-DEEPENING.md)，admin「设置」页）无红；
外接 agent 过了适配器契约验收门。

**边界注意**：凭证**装时进这台 hub 的 vault**（或成员自带 key 走 `/me`
凭证面），模板和工作流定义里永远不出现 key。今天连接器需求还是散文
（模板 README 里写「要读真实日历自己挂 MCP」）——这是已知缺口，§五的
方案包槽位就是冲它去的。

### ③ 部署：按拓扑选路径，15 分钟见首条结果

| 场景 | 用什么 |
|---|---|
| 本机先跑通 | 根目录 [`QUICKSTART.md`](../../QUICKSTART.md)（5 分钟漏斗，`pnpm check:first-result` 是会红的承重门） |
| 裸 VPS / 云 | `deploy/cloud-quickstart.sh --clone` 一条命令 + [`GO-LIVE.md`](GO-LIVE.md) 的 **T2 部署 TTFR 分钟账**（预算 15 分钟、7 步逐步验收锚点） |
| Docker | compose 路径（[`GO-LIVE.md`](GO-LIVE.md) §T3.1a/b），首启向导三步（含 IM token 粘贴）走完即活 |
| 完全不碰命令行的人 | [`PORTABLE-BUNDLE.md`](PORTABLE-BUNDLE.md) 便携包，下载双击即跑 |
| 多方 / 跨组织 | [`FEDERATION-RUNBOOK.md`](FEDERATION-RUNBOOK.md) 两机操作员 runbook，`GOTONG_PROFILE=federation` 把跨 hub 视角摆到首屏 |

**过关判据**：GO-LIVE 分钟账的 7 个锚点逐个绿（healthz → admin 链接 →
首启向导 → IM 首条回复）。**部署没有「大概好了」——每步有锚点。**

### ④ 验收 / 试运行：在他们的用例上过，不是在 demo 上

| 用什么 | 干什么 |
|---|---|
| 定时卡「试跑」（[`WORKFLOW-SCHEDULES.md`](WORKFLOW-SCHEDULES.md)） | `POST /api/admin/workflow-schedules/<id>/fire` 立即跑一轮，**成员闸不可豁免**——试跑做不出成员自己做不到的事 |
| 真实用例 3～5 条 | 让流程主人给**真输入**（真的今天的报价单 / 真的 focus 主题），逐条跑，对着输出确认 |
| `@gotong/evals` 结构检查 | 输出的结构性断言（必要小节在不在、禁语出没出现），零 LLM、确定性、CI 可挂 |
| 管家运行播报（[`ledger/BUTLER-EMPOWER-FINAL.md`](ledger/BUTLER-EMPOWER-FINAL.md) BE-M5） | 成员 IM 里说「打开运行播报」，跑完零 LLM 播到 IM——验收「结果到人」而不只是「run 状态 done」 |

**过关判据**：真实用例全绿 + run 归属正确成员（审计里可查）+ 结果真的到
了该到的人（IM / inbox）。今天 evals 尚未接进 workflow 生命周期（publish
前只有结构校验没有行为校验）——已知缺口，见 §四 FDE-M2。

### ⑤ 观察 / 移交：人走，系统留

| 用什么 | 干什么 |
|---|---|
| 管家三只读 + 诊断闭环（BE-M1/M2） | 当事人在 IM 里问「我的助手最近跑得怎么样 / 体检一下」，不需要部署者在场 |
| audit / usage ledger / 配额 fail-closed | 谁跑了什么、花了多少、超没超配额——账在 hub 上，不在部署者脑子里 |
| [`SETTING-OPS-CONSOLE.md`](SETTING-OPS-CONSOLE.md) `setting` 控制台 | 对方 admin 大白话改运维设置（tier 边界内），换 key / 调阈值不求人 |
| 导出模板 → 画廊 / 社区（[`TEMPLATES.md`](TEMPLATES.md) · [`RECOGNITION-SYSTEM.md`](RECOGNITION-SYSTEM.md)） | 把这次部署沉淀成模板供下一次复用；共享进社区吃引用排行榜（纯荣誉） |

**移交过关判据**（部署者离场测试）：对方 admin 能独立完成——改一条调度 /
换一个 API key / 暂停一条工作流 / 读懂一次失败的播报。四件里有一件要打电
话问你，就还没移交完。

---

## 三、两条边界在每段怎么守

FDE 最容易在「装得快」的压力下破边界。下表是每段的守边清单：

**人 ↔ agent 边界**（人对流程的否决权是结构，不是礼貌）：

- ①：该问人的步骤钉成 HITL / inbox 审批步，写进定义；
- ②：外接 agent 的接管粒度对表（能改文件 / 花钱 / 对外发的至少 Tier 2）；
- ④：验收里至少含一条「审批步真的停下来等了人」的用例；
- ⑤：治理动作（管家 governed verbs）allow / approve / refuse 服务端权威，移交后依旧。

**个人 ↔ 公司边界**（凭证 / 数据 / 计费各归各家）：

- ②：凭证进**这台 hub** 的 vault 或成员自己的 `/me` 凭证面；模板不带 key（只带
  「要什么」——今天在 governance 的 `required_credentials`，M1 后是类型化槽位）；
- ②：**模板不带人员**——`userId` 进不了模板（晨报先例），装完在这台 hub 补人；
- ③：跨组织场景各起各的主权 hub 走联邦，**不要**把两家人塞进一台 hub 图省事；
- ④：跨 hub 的步在 DAG 上有「此步离开 hub」标注，验收时指给流程主人看；
- ⑤：计费账本 / 配额按成员归属，公司 hub 烧公司的 key，个人 hub 烧个人的。

---

## 四、诚实清单：今天的缺口 → FDE track 路线

| 缺口（今天的真实状态） | 强化 | 里程碑 |
|---|---|---|
| 连接器需求是散文：模板 README 写「要读日历自己挂 MCP」，装完体检不知道「缺日历连接器」 | 方案包 `requires.connectors[]` 类型化槽位 + 装后体检显示槽位状态 | **FDE-M1**（§五草案） |
| 行为验收靠人肉：evals 是独立包，publish 前只有结构校验，没有「在附带用例上跑一遍」 | 定义可附带 golden cases，publish 前 / 大白话改流后可跑（复用试跑成员闸 + evals 检查器） | **FDE-M2** |
| 「按方案开荒」未一条命令化：起 hub 之后装模板、建调度、跑验收全是手工续段 | quickstart 续段：起 hub → 装包 → 建调度 → 出验收报告 | **FDE-M3** |
| 冷启动只能从「说得清的任务」开始：没法从 SOP / 检查单导入草稿 | 向导第 0 段：贴 SOP → 出草稿进六段流程 | FDE-M4（候选） |

原则不变：每个里程碑一个小目标；新能力全走已有闸（成员闸 / 审批闸 / 体检），
不开新的旁路。

---

## 五、方案包 schema 草案（`gotong.solution-pack/v1`，FDE-M1 目标）

> **状态：设计草案，未实现。** M1 收口前字段名允许改；实现时以本节为
> 起点、以 M1 的收口文档为准。

### 设计原则

1. **扩展 `gotong.template/v1`，不另起炉灶**——方案包 = 模板 + 三个新块
   （槽位 / 调度建议 / 验收），画廊和 `templates/import` 路由照旧吃 template
   部分，新块由各自的面消费。认不出新块的旧 host 装完等于装了个普通模板
   （优雅降级）。
2. **不带凭证，只带槽位**——包声明「要一个日历类 MCP」，key 和具体挑哪家
   连接器是装的人在这台 hub 上的运行时决定。
3. **不带人员**——调度建议里没有 `userId`（晨报先例延伸）：装完在定时卡
   把人补上，语义 = 该成员自己点了「运行」。
4. **验收走成员闸**——acceptance 用例的执行复用手动试跑那道闸 + evals
   结构检查器，做不出成员自己做不到的事，零 LLM 判卷。

### 草案

```yaml
schema: gotong.solution-pack/v1
pack:
  # ── template 部分：与 gotong.template/v1 完全同构（name/description/
  #    version/agents/workflows/defaults），此处省略 ──
  name: 我的晨报（方案包版）
  agents: [...]
  workflows: [...]

  # ── 新块 1：连接器槽位（把散文变成机器可体检的声明）─────────────
  requires:
    connectors:
      - id: calendar            # 槽位名，体检显示用
        kind: mcp               # mcp | a2a | cli （对齐既有适配器面）
        capability: calendar.read   # 这个槽位要服务的能力（能力语言，不点名厂商）
        optional: true          # true = 缺了能跑但降级（晨报进诚实模式）
        hint: 连接器目录「日历」组任选其一；不挂则晨报按常识展开不编造日程
    credentials:                # governance.required_credentials 的包级汇总
      - deepseek

  # ── 新块 2：调度建议（无人员，装完补人）────────────────────────
  schedules:
    - workflowId: morning-brief
      cadence: { kind: daily, hour: 8 }
      note: 装完在「定时」卡选成员启用；试跑 POST .../fire

  # ── 新块 3：验收用例（golden cases，零 LLM 判卷）────────────────
  acceptance:
    - id: smoke-brief
      workflowId: morning-brief
      trigger: { focus: 高效开始这一天 }
      assert:                   # 复用 @gotong/evals 结构检查器词汇
        sections: [今日重点, 提醒, 今日一学]
        forbid: [作为一个AI, 我无法]
      note: 开箱无连接器状态下也必须绿（诚实模式即合格线）

  runbook: README.md            # 包内相对路径：移交手册（给对方 admin 读）
```

### 装载语义（M1 实现要点）

- 画廊装包：template 部分走既有 `templates/import` **一字不改**；
  `requires` 落进体检数据源——装完设置页显示「槽位 calendar：未挂
  （optional）」黄牌而非静默；
- `acceptance` 出现在 admin 工作流页：「跑验收」按钮 = 逐条走试跑闸 +
  evals 断言，出绿/红清单——这就是 FDE-M2 的地基；
- 明确**非目标**：不是包管理器（无版本依赖解析、无自动升级）、不装人、
  不带 key、不引入新权限面。

---

## 六、指针

- 上手案例合集：[`HANDS-ON-HUBS.md`](HANDS-ON-HUBS.md) ·
  第一个照本节方法打样的包：[`examples/morning-brief-hub`](../../examples/morning-brief-hub)
- 五段里每段的深文档：见 §二各表内链
- 边界的宪章依据：[`../../CHARTER.md`](../../CHARTER.md)（信任护城河）·
  [`SECURITY.md`](SECURITY.md)
- 全部里程碑账本：[`PROGRESS-LEDGER.md`](PROGRESS-LEDGER.md)
