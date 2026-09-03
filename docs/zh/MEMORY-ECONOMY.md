# 记忆经济（MEMORY-ECONOMY）—— 一网一账一门一钟

> **状态**：M0 计划落档（2026-09-01）→ M1 立尺待起刀。
> **方向: M**（记忆管理能力；见 [`DIRECTIONS.md`](DIRECTIONS.md) M 路线「记忆经济」行）。
> **一句话**：**不动七个店的盘上真相**，在它们之上加一张可重建的**联想网**、一本按显著性运转的**记忆账**、一道零 LLM 的**新颖门**、一只沿用既有 6h 链的**固化钟**——让记忆**大小常量有界、跨店一次召回、用则存不用则忘**。

---

## 一、为什么

用户命题三条硬要求：**整合现有记忆体系甚至开创** / **控制大小不能无限膨胀** / **合理地存储、整理、调用**。

诊断一句话：**今天的记忆是「一块一块」的，人的记忆是整体的**。具体是三个能指出行号的缺口：

1. **跨店联想不存在**。`recall` 只到 `episodic|semantic|working` 三个 kind（`packages/personal-memory/src/toolset.ts:611`）；知识库接口只有 `list/read/write/archive` **没有检索**（`packages/personal-butler/src/knowledge-library.ts:75`）；任务本、会话窗、长任务档案**根本不在任何召回路径上**。同一件事被写在三个店里，谁也不知道彼此存在。
2. **显著性经济写好了但从没通电**。衰减半衰期（`salience.ts:43`）、强化权重（`salience.ts:46`）、`effectiveSalience`（`salience.ts:89`）、`enforceBudget` 的 `evictExpiredFirst`（`budget.ts:104`）全都在包里——而 `grep -rn 'halfLifeMs\|reinforceWeight\|evictExpiredFirst' packages/host/src` **零命中**：没有一个调用方把开关打开。逐出至今只看重要度与新旧，不看「你到底用没用过它」。
3. **写侧没有门**。每一轮都无条件追加（`capture.ts:32` 只有字数上限没有内容判断），去重只发生在 6h 之后的 `atomicFactsReviewer`（`atomic-facts.ts:62` 阈值 0.8）。同一句话说十遍，盘上就是十条，要等六小时才被合并——而在这六小时里，它们十条都在占召回名额。

**开创的部分**=联想网 + 记忆账（跨店的边、按显著性运转的预算阶梯）。
**整合的部分**=**真相仍归各店**，新层只存**指针与边**，删掉整层不丢一个字节，随时可从各店重建。

---

## 二、侦察实录（2026-09-01，全部一手 file:line）

### 2.1 三个硬事实

| 事实 | 证据 |
| --- | --- |
| 召回面只有三个 kind，知识库无检索 | `personal-memory/src/toolset.ts:611`（`isMemoryKind` 闭集）；`personal-butler/src/knowledge-library.ts:75`（接口四件，无 search） |
| 显著性经济休眠 | `salience.ts:43`（半衰期 30 天）、`:46`（强化权重 0.5）、`:89`（`effectiveSalience` 不传选项就退化成 `importanceOf` 的 1..5）；host 侧三个关键词 grep 零命中 |
| 预算逐出不看使用 | `budget.ts:56`（扫描上限 10 000）、`:59`（保护最近 8 条 episodic）、`:104`（`evictExpiredFirst` 可选、无人传）、`:140`（`enforceBudget`）；唯一调用点在 `host/src/personal-butler-maintenance.ts:124`（8 MiB 常量）经 `tieredReviewer` 传入 |

逐出顺序（`budget.ts`）：`[已过期] → episodic → 临时 semantic → digest → profile`，同档内先低重要度、再旧。**「策展过的档案活得比一次性尾巴久」这条已经是对的**，缺的只是「用过的活得比没用过的久」。

### 2.2 联想与去重的现状

- **链接只增不剪**：`links.ts:34`（`META_LINKS`）、`:37`（每条最多 5 个）、`:154`（`buildLinkGraph`）、`:219`（`expandByLinks`）。6h 链接 pass 写进 `meta.links`，但**没有任何一处会因为对端消失而剪掉死链**。
- **强化合同已在**：`toolset.ts:69`（`MemoryReinforcer`）、`:100`（`reinforce?` 可选注入，抛错被吞不连累召回）；host 侧 `personal-butler-writers.ts:29` 已 import `reinforcedMeta`。**管道通着，语义没开**（记的是次数与时间戳，没人拿它排序或逐出）。
- **梦境评分**：`dreaming.ts:147`（`dreamScore`）——现成的「查询命中多样性」信号，M3 排序可直接读。
- **写侧无门**：`capture.ts:32`；去重在 6h 后的 `atomic-facts.ts:54`（回看窗 10 000）、`:62`（重合阈值 0.8）。
- **先摘要后遗忘**：`consolidate-tiered.ts:67`（digest 硬顶 1 200 字）、`:69`（攒够 4 篇才提升）、`:71`（低于重要度 2 的 digest 直接丢弃不折叠）——**阶梯②压缩的执法点本来就在**。
- **双时态与遗忘投影**：翻篇（`closedMeta`）与「忘掉一条必须同时清投影」的四例二值门，见 [`MEMORY-WRITE-EVAL.md`](MEMORY-WRITE-EVAL.md) §2.4。**降温用翻篇不用硬删**，这条有现成执法面。

### 2.3 七个店，每个都已经有自己的常量天花板

| 店 | 盘上真相 | 天花板 |
| --- | --- | --- |
| 语义/情节/工作记忆 | `semantic.jsonl` 等 | 8 MiB / 成员（`host/src/personal-butler-maintenance.ts:124`） |
| 知识库 md 树 | `knowledge/*.md` | 200 文件 / 32 KiB 每文件 / 4 MiB 全树 / 6 层深（`knowledge-library.ts:47`）；归档进 `archive/`（`:34`）**不真删** |
| 任务笔记本 | `tasks.json` | 20 条 open / 20 步 / 标题 120 字（`task-notebook.ts:79`） |
| 会话窗 | `<userId>.json` | 60 分钟静默即开新场 / 12 轮 / 单轮 2000 字（`session-window.ts:54,56,58`） |
| 长任务档案 | `dossier.json` + `journal.jsonl` | `LONGRUN_LIMITS`（`longrun-dossier.ts:209`）；日志尾部只读 1 MiB（`:220`）；最多 200 段 |
| 冷区（归档/离场） | `archive/`、离场会话窗 | `retention.json` 三键 30–3650 天（`host/src/space-retention.ts:45,50,52`）=**全仓唯一的删除执法点** |
| 冻结块（进模型的那份） | 渲染产物 | 4000 字（`frozen-block.ts:90`） |

**这张表就是「大小有界」论证的地基**：每个店的真相都已被常量框住，新层若只存指针与边，总量必然还是常量级。

### 2.4 6h 固化链：不改中间，两头各加一步零 LLM

`buildButlerMaintenanceReviewer`（`host/src/personal-butler-maintenance.ts:276`）今天的组成，逐字为准：

```
statusProjectingReviewer(:279)
  └─ composeReviewers(
       tieredReviewer({ summarize, budgetBytes })      :288  ← 8 MiB 字节封顶在这里进入(:295)
       atomicFactsReviewer({ summarize })              :297  ← 刻意排在 tiered 之后(去重能看到新鲜的 cluster profile)
       butlerReconcileMaintenanceReviewer(...)         :302  opt-in，不开=没有任何事实会被翻篇
       butlerKnowledgeLibrarianMaintenanceReviewer(...) :308  opt-in，上架
       butlerLinkMaintenanceReviewer()                 :312  opt-in，最后，不开=不写 links(冻结块字节稳定)
     )
```

三条要点：①**模型调用全在这条 6h 链上，热路径零 LLM**；②梦境 / 技能 reviewer **不在这个 builder 里**（host 只在 docblock 里提过它们）；③这条链的顺序有注释写死的理由，M2–M4 **一个环节都不动它**，只在**链头**加一步「算压力」、**链尾**加一步「刷索引与显著性」，两步都是纯函数零模型。

### 2.5 可照抄的现成件

- **尺子**：`benchmark.ts` 的 `scoreRetriever`/`formatBenchResult` + `memory-recall-bench.test.ts` 的地板棘轮（头注：「Never lower a floor to make it pass」）+ 写侧 `write-benchmark.ts` 的「判分器先被判过」。
- **检索**：`fusedRetriever`（关键词覆盖 ⊕ 本地 TF 余弦）、`localBigramEmbedder`、`invertedIndexRetriever`——**种子怎么找已经解决**，M2 要做的是种子之后的扩散。
- **分层**：`@gotong/personal-butler` 是**唯一同时看得见七个店**的包（依赖 core / llm / personal-memory / services-sdk）——索引、统一 recall、跨店尺子都住这里；host 只接线；core 零触碰；kernel-deps 门天然绿。

---

## 三、设计：一网一账一门一钟

### 3.1 联想网（派生、可重建、只存指针与边）

一个节点 = `{ 店, 指针 id, 表面文本(≤200 字), 时间, validFrom/validTo, 显著性, 边[] }`。

指针形状按店固定：`MemoryEntry.id` / 知识库相对路径 / `tn-<n>` / 会话窗轮次下标 / `taskId#seg`。

四类边，**前三类全部零 LLM**：

| 边 | 怎么来 | 例 |
| --- | --- | --- |
| 出处边 | 读既有 meta | semantic 事实 ← 它被抽出的 episodic；知识库文件 ← `META_PROMOTED_TO`（`knowledge-librarian.ts:46`）；档案事实 ← 写它的那一段 |
| 共现边 | 同一轮 / 同一任务 / 同一文件里同时出现 | 同一轮里说的两件事 |
| 时序边 | 双时态与新颖门 | `supersedes` 翻篇链；复述新条 → 旧条 |
| 语义边 | **逐字读**既有 6h 链接 pass 写的 `meta.links` | 不新增一次模型调用 |

**红线**：网里没有任何一个字节是孤本。删掉整个索引文件，各店真相一字不少，下一个 6h tick 自动重建。

### 3.2 记忆账（把休眠的显著性经济通上电）

**总额**=把已有的各店天花板折成一本**每成员热区预算**（8 MiB 记忆 + 4 MiB 知识树 + 笔记本/会话窗/档案的既有上限），**零新旋钮**——所有数字要么是既有常量，要么是既有策略文件 `retention.json`。

**显著性通电**：把 `DEFAULT_SALIENCE_HALF_LIFE_MS`（30 天）与 `DEFAULT_REINFORCE_WEIGHT`（0.5）真的喂给 `enforceBudget` 与召回排序——**用得多的自然浮上来，久不用的自然沉下去**，两个数字都是包里早就写好的。

**压力**=热区字节 / 预算。四级阶梯按压力逐级开：

| 级 | 动作 | 执法点 |
| --- | --- | --- |
| ① 合并去重 | 新颖门 + 0.8 阈值把复述折成强化 | 见 3.3，零 LLM |
| ② 压缩 | 分层蒸馏 / 图书馆员上架 | 既有 `tieredReviewer` / librarian，**不新建** |
| ③ 降温 | 最低显著性的事实**双时态翻篇**（不硬删）；文件走 `archive()`（不删）；剪掉死链；带滞回 | 既有 `closedMeta` / `KnowledgeLibrary.archive` |
| ④ 遗忘 | 只走 STOR 保留期阶梯（`retention.json`，且**有备份才动剪刀**） | `host/src/space-retention.ts`，全仓唯一 |

**两条红线**：**LLM 永不决定删除**；**删除执法点恰好一个**（新层一行 `unlink` 都不写）。

**新节点保护期**：把 `DEFAULT_PROTECT_RECENT_EPISODIC = 8`（`budget.ts:59`）的思路推广到所有店——刚写下的东西不参与降温，否则「刚说的话立刻被判定为不重要」。

### 3.3 新颖门（写侧，零 LLM）

capture 的那一刻，拿新文本与**同店最近若干条**算重合（复用 `relevanceScore`，阈值与 `DEFAULT_FACT_DEDUP_THRESHOLD` 同源）：

- **近重复** ⇒ 强化既有节点（`recallCount+1`）+ 写一条时序边，**不产生新字节**；
- **否则** ⇒ 照常追加。

**它只判「像不像」，永远不判「对不对」**——判对错要模型、要上下文、会误删，那是 6h 链上 reconcile 的活。今天要等 6 小时才合并的复述，从此在写下的那一刻就被折叠。

### 3.4 固化钟（沿用既有 6h 链，两头各一步）

- **链头**（模型调用之前）：纯函数算一次压力，写进账。
- **链中**：`tiered → atomicFacts → reconcile? → librarian? → links?` **一个字不动**（§2.4）。
- **链尾**：刷索引与显著性——重扫 meta 补边、按钟衰减、剪掉指向已不存在对象的死链。

两头都是纯函数、零模型、可注入时钟；**不开新的定时器**。

### 3.5 调用：一次 `recall` 走遍七个店

```
种子   fusedRetriever 命中 + 上下文种子(open 任务 / 活跃档案 / 会话窗词)
  ↓
扩散   2 跳（每跳衰减 × 边类型权重 × 显著性；多路径求和）
  ↓
配额   每店各自名额（一个店再热也挤不掉别的店）
  ↓
记忆单 有预算的一页：现行事实 / 相关文件指针 / 相关任务 / 相关往事 / (仅在冲突时)已翻篇事实
```

记忆单每行**带日期、带出处店名**，落在 **volatile 尾段**——冻结块作为稳定前缀**逐字节不变**（缓存前缀纪律）。被召回的节点经既有 `MemoryReinforcer` 合同就地强化：**调用本身就是投票**。

---

## 四、大小有界：构造性论证

| 层 | 上界从哪来 | 会不会随轮数线性长 |
| --- | --- | --- |
| 七个店的真相 | §2.3 每个店各自的既有常量 | 否（各自封顶） |
| 联想网节点数 | ≤ 七个店活跃条目之和 | 否（跟着上一行走） |
| 每节点边数 | 常量上限（沿用 `DEFAULT_LINK_TOP_K = 5` 的姿态） | 否 |
| 记忆单字节 | 常量预算 | 否 |
| 热区总量 | 预算常量 + 四级阶梯 | 否 |
| 冷区（归档/翻篇） | `retention.json` 策略（30–3650 天） | **是，但有界且归 STOR 管** |

**结论**：热区**常量有界**，冷区**策略有界**，**没有一层随对话轮数线性增长**。这不是「我们会注意控制」，是每一层都指得出它的天花板常量。

---

## 五、尺子（先立尺后动刀，全部零 key）

**① 跨店整合尺**（M1 的全部产出）
合成一个成员空间，七个店都种上料，**固定钟零 `Date.now()`**；用例的黄金答案**跨 ≥2 个店**，另配单店对照组；按 `single-store` / `cross-store` 两类报 recall@k 与 MRR；地板棘轮**只升不降**。**基线=在同一批用例上跑今天的三 kind `recall`（用适配器包一层），数字必须是量出来的，不许估。**
判分器自己先被判过：oracle 记忆单必须满分，空记忆单必须零分。

**② 大小不变量**
一万轮合成对话推进后：热区字节 ≤ 预算、节点数 ≤ 上限、① 的分数不下降。
另一条：两条同等重要的事实，**被召回五次的那条**在两个月衰减后仍在，**从没被召回过的那条**已经凉下去。

**③ 既有两把尺不许退**：`check:memory-recall`、`check:memory-write` 全程保持绿。

**④ 止损线**：**若 M1 量出来的余量很小（跨店召回本来就没差多少），就停在 M1 并如实说**——尺子本身已经是产出，不为完备而完备。

**⑤ 逐出尺与降温尺**（M3b / M3c，同住 `check:memory-eviction`）
同一把 `scoreEviction`、两份夹具、两个被测件：M3b 换的是 `enforceBudget` 的选项，M3c 换的是**执法之前多跑一趟降温**。两条纪律：预算 = 该留的那些的字节和（完美策略恰好一条不多一条不少 ⇒ 1.0 是绝对满分，不是「比另一个高一点」）；**每一刀的基线是上一刀收口之后的生产配置**，否则量到的是上一刀的功劳。
已知局限，写在用例里：`pin-never-cools` 那条**量不到**降温的钉住守卫——显著性排序自己就把钉住的挡在了最冷序末尾，拆掉守卫这条尺照样满分。守卫是极端压力下的第二层，只有单元测试够得着（变异 N6-A 只在那边变红）。

---

## 六、边界与复用

**四条不可破**：①热路径零 LLM（压力/扩散/门全是纯函数，模型只在 6h 链上）；②冻结块与未开功能**字节不变**；③数据不离盒（不引入任何外部记忆服务）；④内核零改动（全落 personal-memory / personal-butler / host，core·workflow·protocol 一行不动）。

**旋钮 114 冻结**：所有上限要么是代码常量，要么进既有 `retention.json` 策略文件。

| 复用 | 新建 | 退役 |
| --- | --- | --- |
| `fusedRetriever` / `relevanceScore` / `localBigramEmbedder`；`enforceBudget` 及其 `evictExpiredFirst`；`effectiveSalience` / `reinforcedMeta` / `MemoryReinforcer`；`meta.links`；`closedMeta` 双时态；`KnowledgeLibrary.archive`；`benchmark.ts` 尺子形状；6h 链本体 | 联想网索引（派生文件）；跨店统一 `recall` 与记忆单渲染；记忆账压力纯函数；新颖门；跨店整合尺 | 无（不删任何既有件） |

**诚实局限**：效果幅度**不预先承诺**（这正是 M1 先立尺 + ④ 止损线的理由）；语义边的质量受 6h 模型影响；扩散权重是常量不是学出来的。

**显式不做**：embedder（用户门，已拍板搁置）；按模型档位调参（用户否过）；第二个删除执法点；**让 LLM 改写既有记忆**。

---

## 七、里程碑

| # | 内容 | 量级 | 状态 |
| --- | --- | --- | --- |
| M0 | 计划落档（本文） | 半天 | ✅ 2026-09-01 |
| M1 | **尺子**：跨店整合 bench + `check:memory-integration` 门；量出基线，按 ④ 止损线判断 | 1 天 | ✅ 2026-09-02 `0af9f10`——基线 recall@5=27.8% / **cross-store 16.7%**，三例平地板零分 ⇒ **止损线不触发**；变异四发全中；大小不变量推迟到 M3（记忆账存在之后才有东西可量，M1 先用节点数/确定性上下界顶着） |
| M2a | **联想网纯核**（`personal-memory/src/assoc-net.ts`，零 I/O 零模型） | 1 天 | ✅ 2026-09-02 `628b2e4`——四类边 semantic/origin/cooccur/temporal；大小界写成断言（界在**总数**不在单点度数）；扩散三承诺各配会红用例；变异六发全中（N-D/N-F 首轮没红，查出是夹具空洞，修强后按预测变红） |
| M2b | **跨店单一 `recall`**（`personal-butler/src/memory-net.ts`，只读/不发新 id/零模型） | 1 天 | ✅ 2026-09-02 `001cdab`——同尺同夹具只换被测件：recall@5 **27.8% → 100%**、MRR 0.500 → 0.833、**cross-store 16.7% → 100%**；途中撞到两个真缺陷（`SEED_FLOOR` 独苗返空、记忆单一行不止一行）；变异五发，**N2-B 首轮没红**（配额在 k=5 时不咬人 ⇒ 空洞地真），改 k=8 + 阳性对照后变红 |
| M2c | **记忆单接进管家提示词**（骑 CARE-M4 `contextProbe` 易变尾巴，冻结块逐字不动） | 半天 | ✅ 2026-09-02 `4d71d79`——静默契约（没问题/没网/召不到/渲染空/抛错 ⇒ `null` ⇒ 提示词逐字节不变）；网的供给方带 60s TTL + 并发合流，记忆面骑索引既有 watermark 不开第二条枚举路径；**生产只接得到四个面**（会话窗住 `im-bridge-wiring.ts`），故 `MemorySpace` 四个非记忆店改可选——缺席比编造诚实；不加旋钮（114 冻结）；变异九发全中 |
| M3a | **记忆账纯核**（压力 + 四级阶梯 + 滞回，零 I/O 零模型零删除） | 半天 | ✅ 2026-09-02 `9f21699`——阈值 0.6/0.75/0.9/1.0 是代码常量不是旋钮；滞回 0.05 **只护降级**；途中推翻自己的算术：`max(总和比, 单面最大)` 里总和比**永远赢不了**（加权平均恒 ≤ 最大值），连当初写它的理由一并作废；变异六发，N4-F 首轮没红（「单调不减」对「取最低开的级」是空洞的），修强后命中 |
| M3b | **显著性通电** + 逐出尺 `check:memory-eviction` | 1 天 | ✅ 2026-09-02 `98895ec`——**该留的留住 0% → 100%**、该逐的逐掉 33.3% → 100%；两个常量本来就在包里，M3b 之前无人传下来（host grep 零命中，本次核实仍为 0）；夹具造成「只有用没用过分得开」且该留的更旧，逼基线必然指错；变异五发，**N5-D 没红**——host 接了 `evictExpiredFirst` 却没门量它，补用例后命中 |
| M3c | ③ 降温：最低显著性的**散装事实**翻篇（不硬删）+ 剪死链 | 半天 | ✅ 2026-09-02 `<pending>`——**该逐的逐掉 25.0% → 100.0%**、该留的留住 89.1% → 100.0%（基线是**M3b 通电后的今天**，不是「什么都不开」，否则量到的是上一刀的功劳）；只翻 `levelRank === 1` 那层，借用逐出那处的判断不另写一份——翻 digest/profile 会把最受保护的送进过期带即队列最前面，**倒置分层保护**；四道守卫（钉住/已翻篇/未来事实/保护期）各配用例；变异十发全中；顺带查出 `pin-never-cools` 那条尺子**量不到**钉住守卫（显著性排序已经挡在前面），如实改写用例说明 |
| M3d | ③ 降温·知识库那一面：文件归档（缓解货架数，**不减字节**）+ 冷度信号 | 半天 | |
| M4 | 新颖门（写侧零 LLM 折叠） | 1 天 | |
| M5 | capstone `examples/atong-memory-economy`：万轮不膨胀 / 跨店召回 / 用则存不用则忘 | 1 天 | |

一个里程碑一个 commit，每刀配变异测试，数字一律量出来的。

> **M2b 之后这把尺子的现状（2026-09-02 如实记）**：recall 这根轴在这份 6 例 23 节点的夹具上**已经到顶（100%）**。到顶的尺子不再量得出东西——M3/M4 想在召回上证明自己，得先把夹具加厚，而不是看着那行 1.0 自我感觉良好。MRR（0.833）还没到顶，排名仍有量的余地；且抬召回是有排名代价的，`weight-trend` 的首位命中从 1.000 退到 0.500，这一例确实退了。

**岔口已拍板**（2026-09-01，用户原话「好的，按这个设计开始开工」）：走「落档 → M1 立尺 → 逐个里程碑」这条，不先做小刀试水。
