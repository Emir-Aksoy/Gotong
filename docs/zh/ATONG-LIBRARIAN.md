# 阿同图书馆员（LIB track）— 知识文件自治：侦察与计划

> **Status: M4 图书馆员已落（2026-07-17）— librarian reviewer 进 6h 维护链，opt-in `GOTONG_BUTLER_MEMORY_LIBRARIAN`（114→115，本 track 唯一新旋钮）；下一刀 capstone `examples/atong-librarian`**
>
> 用户定方向（2026-07-17 原话大意）：「阿同进一步进化的方向在于自主管理自己的
> 大量知识文件，它需要自己编排层级，不要浪费上下文，同时又能管理好知识——
> 包括我的状态、它的状态、它在做的事情、它手上的工具、它的知识。」
>
> 本文是 LIB track 的 M0：两路源码侦察（file:line 举证）+ 生产形状一手核实 +
> 市面对标 → 五域盘点 → 真缺口 → 设计 → 边界 → 里程碑阶梯 → 岔口。
> 实现里程碑在用户拍板岔口后开工。

---

## 一、一句话答案

五域里四域已有器官（探针尾卡 + `my_status` + 任务笔记本 + 两层工具面），
**真缺口集中在第五域「它的知识」**：阿同今天对自己的记忆只有**条目级**
自主权（`remember`/`forget` 五工具），**文件级为零**——不能创建知识文档、
不能编排层级、不能维护自己的索引。市面前沿（Letta 2026 的 MemFS/Context
Repositories + memory defragmentation）恰好收敛到「agent 自管文件树 +
维护期碎片整理」这个形状，而我们的地基（file-first、per-member ownerDir、
git 快照、6h 维护窗、两层工具面、≤500tk 策展卡先例）**全部已在**。
LIB track = 给阿同补上「图书馆员」器官：自著知识文件 + 自维护索引卡 +
维护期自主整理，全程守住治理边界（知识 ≠ 授权、热路径零 LLM、缓存前缀稳定）。

---

## 二、侦察记录（2026-07-17，两路子代理 + 生产一手 + 市面）

### 2.1 生产形状（真机 ssh 核实）

生产阿同（腾讯云，单成员）的记忆树今天只有 **4 个文件 / 64K / 单层深度**
（`<space>/butler/memory/user/<userId>/` 下）。「大量知识文件」还没发生——
**这是坏消息也是好消息**：坏在 track 的动机不是「抢救溢出」，好在**现在正是
定层级规则的最佳时机**（文件少，层级怎么定都不疼；等几百个文件再定就要带
迁移了）。本 track 的定位是**为规模化提前建器官**，不是救火。

### 2.2 记忆/知识存储侧（侦察路 A，均有 file:line）

磁盘布局（每成员命名空间 `<rootDir>/user/<userId>/`，`ownerDir` +
`assertSafeOwnerId` 挡穿越，`service-memory-file/src/paths.ts:44-47`）：

```
<space>/butler/
├─ memory/user/<userId>/
│  ├─ episodic.jsonl            ← 轮末自动捕获（capture.ts:55-63，上限 2000 字）
│  ├─ semantic.jsonl            ← 单文件多态：临时事实/分级 digest/簇画像/原子事实/
│  │                              技能 procedure/umbrella/links 图/双时态,全靠 meta 分型
│  ├─ tasks.json                ← 任务笔记本（TN，「在做的事」域）
│  ├─ recall-index.json         ← 倒排索引持久缓存
│  ├─ STATUS.md                 ← 6h 维护状态快照（投影，可重建）
│  ├─ DREAMS.md / SKILL.md      ← 复盘日记/技能索引投影——写端只在 example！
│  └─ .git/                     ← opt-in 快照仓（GOTONG_BUTLER_MEMORY_GIT）
├─ presence/user/<userId>/…     ← 刻意放记忆树外：每轮写不 churn git 快照
├─ prefs/user/<userId>/…        ←（factory.ts:281-286 同理）
└─ patrol-state.json            ← hub 巡检牌面
```

关键一手事实：

1. **写者矩阵清晰、单点扩展缝已备**：生产 6h 维护链
   `buildButlerMaintenanceReviewer`（`personal-butler-maintenance.ts:228-260`）
   只组 tiered → atomicFacts → [opt]reconcile → [opt]links 四个 reviewer，
   `composeReviewers` 逐个 best-effort。**要加后台「图书馆员」pass，往这条链
   加一个自门控 reviewer 即可，内核零改动。**
2. **条目级自主权满格、文件级为零**：`MemoryToolset` 五工具
   `remember`/`remember_procedure`/`refine_procedure`/`recall`/`forget`
   （`toolset.ts:121-125`）是一等公民；grep 全工具清单**没有任何**
   读/写/移动/重组**文件**的工具——STATUS/SKILL/DREAMS/recall-index 这些
   派生文件没有任何 agent 工具能碰。
3. **「agent 自著文档」管道半通**：SKILL.md 投影机制 + /me 隐私视图读取端
   已在生产（`butler-memory-service.ts:164-175`），但
   `skillFileReviewer`/`dreamingReviewer`/`procedureAuthoringReviewer` 的写端
   **只在 `examples/personal-butler` 里实跑过**（`maintenance.ts:41-46` 模块头
   明说故意缺席）。→ 新 track 不发明范式，接通半截管道。
4. **新文件工具的安全边界有现成模板**：任务笔记本的缝
   （host 侧 `ownerDir` 定位 + 断言安全 → 叶子模块只收绝对路径、纯
   fs + tmp+rename + 坏文件隔离改名 + 上限响亮拒绝，
   `factory.ts:275-278` / `task-notebook.ts:96-99,163-176`）照抄即可。
5. **上限/防护全套先例**：预算兜底 `enforceBudget` 8MiB/成员 keep-value 驱逐
   （`maintenance.ts:102-114`）；笔记本各字段显式上限**响亮拒绝不静默截断**；
   git 快照每成员独立仓、仅变更才 commit、best-effort 永不抛
   （`butler-memory-git.ts:109-150`）。

### 2.3 每轮上下文构成侧（侦察路 B，均有 file:line）

system 三层拼装（NA-M3 已把稳定/易变分家）：

```
on-wire system = [冻结记忆块][persona 人设]      ← req.system,稳定段,挂 cache_control
               + [探针尾卡×8]                    ← req.systemVolatile,永不挂缓存标
```

- 冻结块前置缝 `personal-memory/agent.ts:270-277`；探针尾缝
  `personal-butler/agent.ts:185-191`；anthropic 缓存断点
  `llm-anthropic/provider.ts:404-431`（稳定切片挂标，volatile 尾作不挂标第二块）。
- **冻结块每条消息重召回**（`frozenRefreshPerTask:true`，`factory.ts:605`）但
  渲染字节稳定（`frozen-block.ts:9-24` 纯序契约）——记忆没变 ⇒ 字节不变 ⇒
  缓存照常命中。**「重算 ≠ 变更」是缓存经济学的关键。**
- 探针 8 张（`factory.ts:619-642` 聚合）：时钟（永不 null）/A2 时段间隔/A3 语言
  /A4 渠道/A1 待批/SEN-M1 hub 红灯/开箱陪跑/任务笔记本 digest；
  **全 null ⇒ systemVolatile 不设 ⇒ 字节不变**（既有先例，新常驻卡必须沿用）。
- **工具面**：AFR 两层化后一等 30 工具 ≈4,947tk（16 benign + 7 governed +
  5 memory + 2 门；文档 prose 最新钉的是 M4 时 29 工具 ~4,769tk，M7 加
  `pack_backup` 后的 30/4947 未回写文档，本文顺手采信账本测试现值）+
  目录层 14 工具按需取。
- **度量缺口坐实**：仓库里**没有任何「每轮 prompt 段级 token 构成」度量**——
  两件既有度量件都只量工具 schema；NA track 显式推迟过此项
  （`NA-NATIVE-ADAPTATION.md:240`「每轮输入 token 构成打点面板」）。
  好消息：`estimateTokens` 尺（`butler-toolface-report.ts:68-81`）是纯函数，
  喂 persona/冻结块/探针段即得构成——**零成本可造，M1 接手无冲突**。
- **知识按需取的成熟模板**：`gotong_guide` 9 张策展卡（AFR-M4）——单工具 +
  目录页 + **每卡 ≤500tk 承重门**（`butler-guide.test.ts:57`，与 M1 同尺）+
  「知识≠授权」红线页脚。新 track 的「阿同自己的知识按需取」镜像它。
- **IM 路径没有多轮上下文窗**：每条 IM 消息是独立任务（`im-bridge.ts:442-444`
  不带 history），跨消息连续性全靠冻结块重召回——**阿同的「常驻自我」本来就
  活在 system 段里**，这正是索引卡该去的地方。

### 2.4 市面对标（2026-07-17 WebSearch）

- **Letta（前 MemGPT）2026 已把这条路走通**：MemFS/Context Repositories 把
  agent 记忆投影成 **git 版本化 markdown 文件树**，agent 靠工具**自己编辑
  自己的记忆**；2026 新出 **memory defragmentation**——先备份记忆文件系统，
  再派子代理重组文件（拆大文件、并重复项、整理成 **15–25 个聚焦文件**的
  干净层级）。（letta.com/blog/context-repositories、docs.letta.com）
- 我们与 Letta 的差异化不在文件机制（我们 file-first + git 快照早就有），在
  **治理边界**：知识 ≠ 授权（读到「该发邮件」仍要过 governed 闸）、热路径
  零 LLM（整理只在阿同自己的轮或 6h 窗）、缓存前缀稳定（Letta 不背 Anthropic
  缓存经济账）、per-member ownerDir 隔离（家庭 hub 多成员天然分库）。
- MU-M0（2026-07-08）的市面扫描结论「骨架已赌对：file-first + 双时态 +
  睡眠期整理 = 前沿收敛方向」在本轮复核后**继续成立且被 Letta 加强**。

---

## 三、五域盘点：四域有器官，一域是真缺口

| 用户五域 | 今天的器官（file:line） | 缺口判定 |
|---|---|---|
| **我的状态**（用户） | 记忆树自动捕获+原子事实+冻结块 top-100（`session.ts:91,103`）；presence/prefs sibling；A1 待批卡 | 器官在，但「哪些事实值得常驻」由 importance 排序说了算，阿同无策展权 → **并入知识域解** |
| **它的状态**（阿同） | SEN-M3 `my_status` 六块一卡（按需）+ STATUS.md 6h 快照 | ✅ 已覆盖 |
| **在做的事** | TN 任务笔记本 tasks.json + digest 复述卡（≤5 行） | ✅ 已覆盖 |
| **手上工具** | AFR 两层工具面（30 一等 + 14 目录）+ 度量 + tripwire | ✅ 已覆盖 |
| **它的知识** | semantic.jsonl 条目（事实/技能/digest）+ SKILL.md（写端 example-only）+ gotong_guide（框架静态卡） | ❌ **真缺口**：无文件级自主权、无自编排层级、无自维护索引 |

真缺口六条（全部有 §二 的源码举证）：

1. 文件级自主权为零（条目工具五个，文件工具零个）。
2. 层级是代码定的（importance 排序 + 簇 digest），不是阿同编排的。
3. 「自著文档」管道半通（SKILL.md 写端 example-only，生产没接）。
4. 每轮 prompt 段级度量不存在（NA 显式推迟，无人接手）。
5. 常驻知识的唯一通道（冻结块）不受阿同策展（top-100 importance，
   阿同不能说「这 5 条必须常驻、那 20 条归档到文件按需读」）。
6. 知识规模化后没有「先看目录再深读」的分层读法（recall 是扁平检索；
   gotong_guide 有目录形状但只装框架静态卡）。

---

## 四、设计：图书馆双层模型

核心比喻：**semantic.jsonl 是进货区，`knowledge/` 是上架区，阿同是图书馆员。**

```
对话轮（热路径,阿同自己的 LLM 轮）
  │ 自动捕获 → episodic.jsonl（不变,MU 既有）
  │ 6h 蒸馏 → semantic.jsonl 条目（不变,MU 既有:tiered/atomic/recon/links）
  │
  │ 【新】阿同轮内文件工具（benign,ownerDir 内）:
  │    list / read / write / archive 知识文件 + 维护 INDEX.md
  ▼
<rootDir>/user/<userId>/knowledge/
  ├─ INDEX.md                    ← 阿同自著的总索引（一行一指针,硬顶 ≤500tk）
  ├─ user/…​.md  self/…​.md  …    ← 层级由阿同自己编排,框架不预设目录学
  └─ archive/…                   ← 归档区（不真删,维护期 prune,git 兜底）

6h 维护窗（既有 LLM 窗口,maintenanceModel 可用低价模型）
  【新】librarian reviewer（opt-in）:
    promote（jsonl 成熟条目上架成文件）/ defrag（拆大并重,Letta 同型）/
    重写 INDEX.md / 顺手接通 SKILL.md 生产写端 / prune archive
```

四个设计要点：

1. **索引卡 = 阿同的「知道自己知道什么」**。INDEX.md 由阿同自著自维护
   （框架只给缝：读文件→注入 prompt + 硬顶承重门；内容一个字不生成——
   框架生成的目录已有 STATUS/SKILL 投影，**自著才是本 track 的主旨**）。
   注入位置见岔口 1；无文件 = null = 字节不变（探针先例）。
2. **文件工具镜像任务笔记本边界**：host 用 `ownerDir` 定位 + 断言安全，
   叶子纯 fs + tmp+rename + 坏文件隔离 + 显式上限响亮拒绝（文件数/单文件
   字节/总字节三顶）。全 benign——写**自己域内**的知识文件与写 tasks.json
   同级，不需要审批；**知识 ≠ 授权**：从知识文件读到的对外动作照旧过
   governed 闸（capstone 要有这条断言）。
3. **上下文经济学**：常驻的只有索引（≤500tk）+ 既有冻结块；知识本体
   永远按需 read（工具结果走 volatile 通道用完即走）。M1 先立段级度量尺，
   之后「常驻段总预算」上棘轮门（只降不升，line-budget 反号先例）——
   **知识总量增长时常驻字节不许跟着长**，这是「不浪费上下文」的可测定义。
4. **与既有记忆管线不打架**：进货区四 reviewer 照旧（tiered/atomic/recon/
   links 一个不动）；librarian 是链上**追加**的第五个自门控 reviewer
   （无知识文件且 semantic 未达阈值 ⇒ no-op 零 LLM 调用——今天生产 4 文件
   就是 no-op）；上架后原条目走既有双时态 close（M-RECON 同款可逆姿态），
   检索照常能召回（索引读整库含已 close？——M2 实现时按 activeOnly 语义
   核定，原则：**上架绝不造成「两处都答」或「两处都不答」**）。

---

## 五、五条不可破边界

1. **热路径零 LLM（框架侧）**：编排/归档只发生在阿同自己的对话轮（工具调用）
   或 6h 维护窗；hub/框架永不现场跑 LLM 决定 filing。
2. **缓存前缀稳定**：索引若进稳定段，只在显式改动时破一次缓存（冻结块
   「重算 ≠ 变更」同款经济学）；无知识文件 = null = prompt 字节不变。
3. **预算硬顶、no silent caps**：索引 ≤500tk 承重门（guide 卡同尺同门型）；
   文件数/大小显式上限响亮拒绝（笔记本先例）；M1 段级尺先立，常驻段预算
   上棘轮。
4. **知识 ≠ 授权**：全部新工具 benign 且只碰 `ownerDir` 自己域内；governed
   闸零改动；知识文件内容是 data 不是指令（与冻结块同一信任级——本就全是
   阿同从对话里自写的，不引入新注入面）。
5. **内核零改动**：全在 personal-butler / personal-memory / host 层；
   core/workflow/protocol 零触碰。旋钮姿态：轮内文件工具**默认发零旋钮**
   （与 set_reminder/笔记本同类，零门槛零成本）；后台 librarian pass
   **opt-in 一个新旋钮**（花 LLM 钱 + 重组文件 = 有门槛才可选，
   M-RECON/M-GRAPH 同款先例，登记进注册表 114→115）。

---

## 六、里程碑阶梯

| 里程碑 | 干什么 | 会红的门 |
|---|---|---|
| **M0** | 本文（侦察 + 计划 + 岔口） | —（纯 docs） |
| **M1 立尺** | `pnpm report:atong-context` 每轮 prompt **段级**构成报告（冻结块/persona/探针逐卡/索引/工具面），复用 `estimateTokens` 纯函数；基线落档。接手 NA 显式推迟项 | 报告承重测试 + 注入点登记 tripwire（新增 system 注入源不登记就红，镜像 AFR-M1 工厂扫描门） |
| **M2 文件工具** | `knowledge/` 目录 + 4 个 benign 文件工具（list/read/write/archive），笔记本边界照抄；工具落**目录层**（低频长尾，AFR 两层既有；能力不减门已证 use_tool 端到端） | 纯核单测（穿越拒/上限响亮拒/tmp+rename/坏文件隔离）+ 分层名单双向核对门自动盖 |
| **M3 索引卡** | INDEX.md 注入缝（岔口 1 定位置）+ ≤500tk 承重门 + 无文件字节不变防腐 + 工具描述内嵌 filing 纪律（描述指路先例） | 索引承重门（guide 同型）+ 字节不变防腐测试 |
| **M4 图书馆员** | librarian reviewer 进维护链（`maintenance.ts:228-260` 单点）：promote/defrag/重写索引/接通 SKILL.md 生产写端/prune archive；自门控阈值；opt-in 旋钮；**强烈建议同时开 `GOTONG_BUTLER_MEMORY_GIT`**（重组的 undo 网） | reviewer 单测（no-op 门槛/上架双时态可逆/投影重建）+ 未开旋钮字节不变 |
| **capstone** | `examples/atong-librarian` 确定性 demo：百文件知识树 + 小索引，失忆 agent 每轮只靠索引导航深读答题；四断言：①索引导航答对 ②常驻段字节不随知识总量长（M1 尺量）③归档不丢 ④**知识文件里「读到」的对外动作仍 park**（知识≠授权活证） | `pnpm demo:atong-librarian` exit 0 |

M5 以后按需：/me 知识页只读视图（骑 butler-memory-service 既有隐私视图形状）、
索引进 IM `/help` 面包屑——不预造。

---

## 七、岔口（2026-07-17 用户已全部拍板，均取推荐项）

**岔口 1：索引卡常驻在哪一段？** → **裁决：(a) 稳定缓存段**

| 选项 | 代价 | 收益 |
|---|---|---|
| **(a) 稳定缓存段**（persona 之后，冻结块同段）— **推荐** | 阿同改索引那一轮破一次缓存（之后重新命中，0.1× 读价） | 每轮都「知道自己知道什么」，且缓存摊薄后近乎免费；「重算≠变更」既有经济学直接适用 |
| (b) volatile 探针尾 | 永不进缓存，每轮全价付 ~500tk | 实现最简（骑 composeContextProbes 缝） |
| (c) 纯按需（目录层工具） | 零常驻成本 | 但阿同「不知道自己知道」，索引名存实亡——与 track 主旨相悖 |

**岔口 2：知识库与既有记忆树的关系？** → **裁决：(b) 双层：进货 + 上架**

| 选项 | 判定 |
|---|---|
| **(b) 双层：jsonl 进货区（自动）+ knowledge/ 上架区（策展），维护期 promote** — **推荐** | 与四个既有 reviewer 零打架，各自权威；Letta 单库模型的活我们用双时态 close 承接，可逆 |
| (a) 单库：阿同直接重组 semantic.jsonl 条目 | 撞既有 reviewer 管线假设（tiered 按簇、budget 按字节都预设条目形状），风险大收益小 |
| (c) 文件树全盘替换 jsonl | 破坏性重写 MU 全 track，不推荐不展开 |

**岔口 3：后台 librarian pass 的开关姿态？** → **裁决：(a) opt-in 新旋钮（114→115，M4 落地时登记）**

| 选项 | 判定 |
|---|---|
| **(a) opt-in 新旋钮（114→115，登记）** — **推荐** | 花 LLM 钱 + 自动重组文件 = 有门槛才可选（用户既定法则；M-RECON/M-GRAPH 同款）；轮内文件工具仍默认发 |
| (b) 默认发（骑 6h 链自门控） | 阈值门控下今天生产是 no-op，但「后台自动改我文件」默认开违反最小惊讶 |

---

## 八、显式不做（钉进文档防漂移）

1. **跨成员/跨 hub 知识共享**——per-member `ownerDir` 隔离是承重墙（家庭
   hub 的隐私底线），知识库永远每成员一座。
2. **外部向量库/云知识库当主存**——file-first 北极星；外部记忆已有 MU-M4
   Mem0 opt-in 侧面，不升主。
3. **框架热路径 LLM 自动归档**——边界①；「智能」在阿同的轮里和维护窗里。
4. **开放阿同改写 gotong_guide 框架卡**——框架知识是代码出货的策展物
   （防漂移防注入），阿同的知识与框架的知识**分库**：guide 卡讲框架，
   knowledge/ 讲这个家。
5. **重写既有记忆管线**——MU 四 reviewer 一个不动，librarian 只追加。
6. **INDEX.md 由框架代笔**——投影类文件（STATUS/SKILL）已有先例，代笔的
   目录不缺；**自著**才是「自己编排层级」的字面落点，框架只给缝和顶。

---

## 九、验收纪律（沿用全仓惯例）

每刀：包测试全绿 + host tsc 零错 + `pnpm check:guards` 四门 PASS（旋钮
预算见岔口 3 裁决；main.ts ≤3000 靠压注释净零）+ 新 builder 过 AFR 注册
三件套（分层名单/tripwire/防腐门）+ 文档 ✅ 块 + commit 显式列文件。

---

## 十、落地记录

### M1 立尺 ✅（2026-07-17）

**交付**：`packages/host/src/butler-context-report.ts`（段级度量纯核：
`measureContextFace` + `renderContextReport` + `VOLATILE_PROBE_REGISTRY` /
`INLINE_PROBE_MARKERS` 注册表；token 标尺直接 import AFR-M1 的
`estimateTokens`——前后可比靠同一把尺）+ 报告承重测试
`packages/host/tests/butler-context-report.test.ts`（6 例）+ 根脚本
**`pnpm report:atong-context`**。零行为改动：运行时路径不 import 本模块，
只有报告测试用它（AFR-M1 同款姿态）。

**度量姿态（防「量的不是真东西」）**：

- 八张 volatile 探针卡全部**真 builder 真点火**（tmp 目录 fixture：
  last-seen 写 26h 前时间戳过 3h 门、patrol-state 写 1 红 3 黄四张牌、
  onboarding 造三缺口体检快照、笔记本开三条真任务……），逐卡断言 non-null
  ——fixture 烂了立刻红，量出来的永远是当前实现的字节，不是手抄样张。
- **空态半边同样上秤**：除时钟（恒在）外七探针空态逐一断言 null，且
  `composeContextProbes` 组合后 = 时钟卡原文（胶水零附加字节）——「无信号
  = 字节不变」是缓存经济学的另一半，本次一并防腐进测试。
- stable 段的人设/冻结块是**代表性样本**（人设由成员自配、记忆因人而异），
  报告里如实标「样本」；冻结块满态断言 4000 字预算真的咬住（per-cluster
  省略行出现 + 程序区有代表）——量的是设计上限，不是注水数。
- **tripwire**：正则扫 `personal-butler-factory.ts` 的 `buildButler*Probe(`
  调用点集合 ≡ 注册表值集合；内联探针（notebook digest）用源码标记钉住；
  `composeContextProbes(` 全文件只准出现一次——工厂加探针不登记就红，
  报告永不无声漏量（镜像 AFR-M1 工具面扫描门）。

**基线（2026-07-17，estimateTokens 标尺，zh 卡 CJK≈1 tok/字）**：

| 段 | 项 | ~tokens |
|---|---|---|
| volatile | 每轮必付底价（仅时钟卡） | **~27** |
| volatile | 八探针满配（时钟+间隔+语言+来源+待批+hub 牌面+开箱陪跑+笔记本复述） | **~1028**（最大单卡 onboarding ~351） |
| stable | 人设样本 + 冻结块（空记忆） | **~257** |
| stable | 人设样本 + 冻结块（4000 字预算饱和） | **~3320** |
| （参照） | 工具面 ~30 工具 schema（AFR-M3 账本，另一把专尺 `report:atong-toolface`） | ~4947 |

**读法**：volatile 段（`req.systemVolatile`）每轮全价，今天常态在
27～1028tk 之间浮动，天花板被各探针自己的上限（列 3 件/两黄点名/…）钉死；
stable 段（`req.system`）挂 cache_control，饱和态 ~3320tk 轮间命中按 0.1×
计价。**M3 的 ≤500tk 索引卡落在 stable 段**——摊薄后每轮增量 ~50tk 级，
且「重算≠变更」（阿同改索引那轮破一次缓存，之后重新命中）；M4 图书馆员
「常驻段字节不随知识总量长」的承诺从此有尺可量（capstone 断言②直接用本尺）。

**验收**：host 2205 全绿（+6）/ host tsc 零错 / 四门 PASS（旋钮 **114
零新增**，main.ts 3000/3000 零触碰）。

### M2 文件工具 ✅（2026-07-17）

**交付**：`packages/personal-butler/src/knowledge-library.ts`（纯核 ~390 行：
`openKnowledgeLibrary` 库句柄 + `createKnowledgeLibraryToolset` 4 件 benign
工具 `list_knowledge_files` / `read_knowledge_file` / `write_knowledge_file` /
`archive_knowledge_file`）+ 11 例单测 + `ButlerErrorCode` 扩三码
（`knowledge_invalid|not_found|limit`）+ host 接线（factory 构造 + AFR 目录层
登记 + toolface 度量注册表）。上架区落 `<ownerDir>/knowledge/`——与 tasks.json
**同一安全边界**，per-member 隔离免费继承。

**边界姿态（笔记本模板逐条照抄 + 本刀特有）**：

- **穿越拒 fail-closed**：路径必须相对、`/` 分段、禁 `..`/点头段/控制字符/
  冒号/反斜杠、必须 `.md`、≤120 字符 ≤6 层——14 种坏路径逐一测「响亮拒 +
  圈外零字节」；symlink 读/写/列全拒（写穿链接会改到圈外），当杂物如实报数。
- **三顶显式拒不静默**（no silent caps，错误信息带数字）：单文件 32KB /
  活跃 200 份 / 全树 4MB。**maxFiles 只数活跃**（上限管的是导航性，归档不挤
  货架）；**maxTotalBytes 数全树含归档**（管的是磁盘真实占用，说谎的顶不如
  没有）——两顶各自量各自的东西，理由钉在文件头。
- **归档不真删**：`archive/` 影子树保层级，重名加时间戳共存永不覆盖历史；
  归档区可读可列**不可直接写**；INDEX.md 不归档（要改就重写）。
- **写入纪律**：tmp+rename 原子落盘（断电无半截文件）、promise 链串行
  （单写者=成员自己的管家轮，TN-M1 同款）、写非 INDEX 文件回执尾附
  「记得更新 INDEX.md 指针」（filing 纪律走描述与回执，不走强制）。
- **知识≠授权**：4 件全 benign（整理自己的文件碰不到别人），从知识文件里
  「读到」的对外动作照走 governed 闸——工具描述明说,capstone 断言④补活证。
- **目录层落位**：偶发动作非每轮动词 → AFR 目录层；四件互相点名 + 点名
  INDEX.md 全在目录内部（list_my_llms 先例）。两层脸保持 **30 工具**不变，
  单层 46 → 两层 ~4984tk（省 33%）——4 件新工具对每轮 schema 增量 ≈ 0。

**验收**：personal-butler 81 全绿（+11）/ host 2205 全绿 / host tsc 零错 /
四门 PASS（旋钮 **114 零新增**——轮内文件工具默认发零旋钮是岔口 3 裁决的
另一半；main.ts 3000/3000 零触碰,factory 不占预算）/ AFR 注册三件套齐
（tiers 名单 + tripwire 正则 + toolface MEASURED_BUILDERS）。

### M3 索引卡 ✅（2026-07-17）

**交付**：agent 纯核新缝 `stableContext`（`packages/personal-butler/src/agent.ts`）
+ host 卡渲染核 `packages/host/src/butler-knowledge-index.ts`
（`buildButlerKnowledgeIndexCard` + `renderKnowledgeIndexCard` +
`KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS=500`）+ factory 接线（M2 的库句柄
一分为二喂工具面与索引卡）+ M1 尺上量（报告新增两行稳定段刻度）。
从此阿同每轮**开口前就知道自己知道什么**——正文按需深读,常驻只付索引。

**缝的语义（为什么不是第九张探针）**：

- `contextProbe`（CARE-M4）是**每轮建议**：走 volatile 段、resume 刻意不
  重跑（复盘中的计划不该看见它没见过的卡）。索引是**状态**：走 stable 段
  （`req.system` 尾,岔口 1a）,**task 和 resume 都刷新**——先例是冻结块
  （park→批准→重启后 resume,冻结块按当前记忆重组）;状态反映现在,建议
  不穿越复盘。失败姿态同款：provider 抛错 → null → 聊天轮不倒。
- **缓存经济学**：索引只在阿同改写 INDEX.md 时变——不变=字节相同=命中
  0.1×;改一次破一次缓存后重新命中（「重算≠变更」）。每轮现读现渲染,
  新鲜度即文件本身,无额外失效协议。

**≤500tk 门（M1 同一把尺,不是字符数近似）**：

- 渲染核直接 import `estimateTokens` 强制——承诺和门量的是同一个数。
- 超预算**按行贪心截断 + 响亮标记**（no silent caps）：行是索引的语义
  单位,断行=假路径;标记带「前 N/M 行」+指路精简,**标记本身也在预算内**
  （会把预算吹爆的封顶不叫封顶）;保留部分导航比整卡丢弃诚实（写胖一次
  不该全盲）。实测 120 行胖索引 → 截断顶 **~487tk ≤ 500**。
- 无文件/空文件/读失败（symlink 拒）→ **null → prompt 字节不变**（探针
  「无信号=null」同款契约）;not_found 是常态零 warn,真失败 warn 恰一次。
- 指路不指空：卡文案只说人话（「按路径去知识库读」）,不点目录层工具名。

**M1 尺登记（报告永不无声漏量）**：`STABLE_CARD_REGISTRY` 新注册表 +
tripwire 扩展（factory `buildButler*Card(` 调用点 ≡ 注册表值集合,
`stableContext:` 全文件只准出现一次——volatile 侧 `composeContextProbes`
同款纪律）;报告基线新增两行：索引卡样本 ~137tk / 截断顶 ~487tk。

**验收**：personal-butler 84 全绿（+3：稳定段落位/null·throw 字节不变/
resume 重读状态语义）/ host 2215 全绿（+10：门 9 + 报告 1）/ tsc 零错 /
四门 PASS（旋钮 **114 零新增**,main.ts 3000/3000 零触碰）。

### M4 图书馆员 ✅（2026-07-17）

**交付**：纯核 `packages/personal-butler/src/knowledge-librarian.ts`
（`knowledgeLibrarianReviewer` + `parseLibrarianPlan` + `META_PROMOTED_TO`）
+ host 组合 `personal-butler-maintenance.ts`（第五个自门控 reviewer 进
`buildButlerMaintenanceReviewer`,M-RECON 同款姿态）+ main.ts 旋钮
`GOTONG_BUTLER_MEMORY_LIBRARIAN`（岔口 3a 裁决 opt-in,**114→115,本 track
唯一新旋钮**,已登记注册表）。开了它,6h 维护每 tick 把进货区**主题类**
ad-hoc 事实「上架」进 knowledge/ 文件并重写 INDEX.md——每轮必付的冻结块
变小,知识搬进按需付费的书架,M3 索引卡负责导航。

**一次模型调用的合同（reconcile.ts 逐条对齐的纪律）**：

- **自门控零浪费**：可上架候选（活跃 ad-hoc、无 `promotedTo`）< 12 → `{}`
  零 LLM 零盘写;上架即关区间,候选集单调收敛（host 测试第二 tick 实证
  零调用、盘上字节不漂移）。`maxBatch=40` 是**步频不是丢弃**——余量下个
  6h tick 接着来（no silent caps）。
- **写前退后（write-before-shelve）**：正文先落文件,写成了才动记忆——
  崩溃留重影（文件+记忆双在）,永不留失踪。下架 = host 把 CLOSE（validTo）
  与出处（promotedTo）折进**一次** patchMeta:没有「关了却不知去向」的
  中间态,可逆（清 validTo 即回,`GOTONG_BUTLER_MEMORY_GIT` 是再上一层
  undo 网,**生产开图书馆员强烈建议同开**）。
- **fail-soft 全家**：模型坏 JSON/throw → 零操作;库层响亮拒（穿越路径/
  超顶）→ 只跳那条,**它的事实绝不下架**;幻觉 factIds 关不掉任何东西
  （只认递进批的 byId 查表）;纯幻觉 promotion 连文件都不写。
- **INDEX 兜底**：模型整篇重写优先,但**动过的文件不管谁写都必须指得到**
  （机械补指针「图书馆员整理上架」）;零上架 → INDEX 一个字节不动
  （幻觉索引不落盘）。
- **组合位序**：reconcile 之后（上架去重后的现行真相,不搬快要被合并的
  草稿）、link 之前（联想图只连**留在记忆里**的,刚上架的边会悬空）。
- **双写者硬化**：M4 起知识树有两个写者（成员轮常驻句柄 + 6h 临时句柄）,
  M2 的 tmp 名唯一化（时戳+序号后缀）保证并发整篇写永远「后 rename 整篇
  赢」,不可能同 tmp 交错字节;维护侧库句柄用与 factory 同一条
  `ownerDir(root,{user,id})/knowledge` 派生,一棵树两个面。

**显式推迟（等信号,不预造）**：defrag 整文件重组（爆炸半径=整篇重写,等
真实使用信号再定节律与守门）/ prune archive（与 M2「归档不真删」立场
冲突,需要 retention/consent 岔口用户拍板）/ SKILL.md 写端（BF-M8 起
生产侧一直显式推迟,不借道复活）/ index-only 重写（索引变更锚定真上架,
防幻觉;索引失联已有机械兜底盖住）。

**验收**：personal-butler 98 全绿（+14：门槛/收敛过滤/主路径/重复引用/
坏 JSON·throw/穿越拒/幻觉 id/shelve throw/INDEX 三兜底/步频/宽容解析×2）
/ host 2218 全绿（+3：真链上架+可逆+出处/二 tick 收敛/未开字节不变）/
tsc 零错 / 三门 PASS（**旋钮 115 全登记**,main.ts 3000/3000——knob 2 行
+构造 1 行,压 CARE-M4/BF-M8 注释 3 行净零）。
