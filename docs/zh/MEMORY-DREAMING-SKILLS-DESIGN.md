# 管家记忆 · dreaming 后台 + 默认召回索引 + 自创/Umbrella 技能 + 6h 维护

> **设计文档（建之前 / 待定稿）**。学习 OpenClaw 与 Hermes，把管家智能体的长期记忆
> 补上四块能力。本文是计划与契约，定稿后按里程碑实现，一里程碑一本地 commit。
>
> Status: DRAFT · 2026-06-29 · 对应 reference：[[openclaw-hermes-reference]]

---

## 〇、一句话 + 定位

- 这是 **AipeHub 框架之上的「管家智能体」** 的记忆增强，**不是框架本身**。纯框架难
  推广，所以我们造了一个贴合框架的智能体当门面；它的「常驻 + 心跳 + 记忆」节律对齐
  OpenClaw / Hermes。对比时比的是「我们这个管家的记忆」对「OpenClaw / Hermes 这类智
  能体的记忆」，不是框架对框架。
- 四件事**几乎全是把已有零件接成新故事，不是重写**：C/D/E/F/G 长期记忆 + 心跳
  (Stream D) + `MemoryRetriever` seam + `patchMeta` 写缝 + `composeReviewers` 心跳
  pass 框架，地基正好够用。
- **零 schema 改**（全住 `MemoryEntry.meta` 自由字段 / 衍生文件）、**core/protocol/
  identity/workflow-runner 零改**、bulk 落 `@aipehub/personal-memory` 叶包、接线在
  `examples/personal-butler`、`/me` 只读投影在 host，**example-first**（管家 fold 进
  host main.ts 仍推迟）。

---

## 一、背景 — 我们 vs OpenClaw / Hermes（已 web 核准的对比）

| 维度 | 我们现状 | OpenClaw | Hermes | 结论 |
|---|---|---|---|---|
| 系统提示注入 | frozen block 字节稳定前缀 | MEMORY.md + 今/昨日记自动载入 | Tier1 MEMORY.md+USER.md「frozen snapshot at session start」 | **已与 Hermes 独立趋同（核心被验证）** |
| 强制蒸馏 | consolidate byte-cap 超限报错逼蒸馏 | dreaming 后台蒸馏 | 超字符限报错逼当回合合并 | 我们 ≈ Hermes；**dreaming 是 OpenClaw 的后台节律，我们缺** |
| 默认召回 | `lexicalRetriever`：CJK bigram 词法，只 rank 最近 ≤200 | `memory_search` hybrid（配 embedding 时向量+关键词） | Tier2 SQLite **FTS5 全会话历史 ~20ms 确定无 LLM** | **缺口：无持久检索索引，超窗口旧条目选不中** |
| 技能/程序 | G `form:'procedure'` 只**被动记录** | — | **自创技能 + 使用中自改 + Umbrella 合并**（辅模型扫冗余簇并入 master SKILL.md，SQLite 重定向） | **缺口：无自创/自改/合并** |
| 运维节律 | 心跳 review（capture 复盘）+ budget/reconcile/link pass | 心跳 30 分钟扫 HEARTBEAT.md | 心跳 **6h**：复盘技能 / 清输出 / 合并记忆 / 写状态 | **6h 维护节律可学** |
| 双时态正确性 | D `validFrom/validTo/supersedes` 时光机 | Memory Wiki 矛盾+新鲜度 | — | **我们赢**（结构化可逆历史） |
| 治理 | `/me` forget/export · 敏感写 HITL · no-leak per-user 命名空间 | ungated host 自治 | 八个外部 provider | **我们赢**（受治理 + 可审计 + 本地） |

**该补的四块**（= 用户指令）：① dreaming 后台对齐 OpenClaw；② 默认召回检索补上
（纯 JS 倒排）；③ agent 自创 + 使用中自改 + Umbrella 合并学习 Hermes；④ 6h 维护
（复盘技能 / 清输出 / 合并记忆 / 写状态）学习 Hermes。

---

## 二、北极星约束（逐条守，不可破）

1. **框架不跑 LLM**。这些都是**管家这个 agent** 的能力。dreaming / umbrella 用的「辅
   模型」是 **agent 在心跳 pass 里调 LLM**，不是 Hub 调——同 `consolidate` 的
   `MemorySummarizer` 既有姿态。Hub 仍只调度心跳唤醒。
2. **file-first**。`*.jsonl` 永远是**唯一真相**；倒排索引 / `DREAMS.md` / `SKILL.md` /
   `STATUS.md` 全是**可重建的衍生物**，落在同一 per-user 目录里，**copy 目录 = 带走大脑
   + 索引 + 日记 + 技能 + 状态**。任何衍生物损坏 / 缺失都从 jsonl 静默重建。
3. **有界 + 门控，反无界自治**（明确区别于 OpenClaw 的 ungated host 自治）。技能自创 =
   有界工具 / 心跳 pass（非每 turn 无界循环）；破坏性合并 = **可逆 bitemporal-close**
   （封存非删，胜过 Hermes archive）；敏感动作仍走 `/me` 收件箱（既有 governed 闸不动）。
4. **前缀缓存纪律**。时变 / 用量信号（`effectiveSalience`、新增 `queryHits`）**绝不进
   frozen block**——frozen block 的序必须是 entry **集合**的纯函数（`salience.ts` 顶注、
   `relevance.ts` 顶注都已钉死这条）。这些信号只服务 dreaming 打分 / 驱逐 / 召回排序。
5. **治理 / no-leak / 被遗忘权不变**。新衍生文件都进 `<rootDir>/user/<userId>/` per-user
   命名空间（`openButlerMemory` 唯一 seam）；`/me`「管家记得你什么」视图能读 / 能删，
   `forgetAll` 一并清衍生文件。
6. **example-first**。bulk 落叶包（纯 + 可单测）+ `examples/personal-butler` 接线；fold
   进 host main.ts 推迟。
7. **core/protocol/identity/workflow-runner 零改**。

---

## 三、四个里程碑总览（依赖图 + 落点）

```
   MR1 召回索引 ──────────────┐ (umbrella/召回都吃它的"全店相关"能力)
   (纯 JS 倒排, 补检索)       │
                             ▼
   MR2 dreaming ─────────────┤ (queryHits 信号 + 三门控提升 + 清陈旧 + DREAMS.md)
   (对齐 OpenClaw)            │
                             ▼
   MR3 自创 + Umbrella ───────┤ (procedure 自创/自改 + 冗余簇合并 + SKILL.md)
   (学习 Hermes)             │
                             ▼
   MR4 6h 维护心跳 ───────────┘ (composeReviewers 总指挥: 复盘/清输出/合并/写状态)
   (学习 Hermes, 当指挥)
```

| MR | 学谁 | 新零件（纯件） | 复用零件 | 落点包 | schema 改 |
|---|---|---|---|---|---|
| MR1 | Hermes Tier2 | `InvertedIndex` + `invertedIndexRetriever` | `extractTerms` / `relevanceScore` / `MemoryRetriever` seam | personal-memory + host | 无 |
| MR2 | OpenClaw dreaming | `dreaming` reviewer + `dreamScore` + `queryHits` | `consolidate`/`promoteCluster`/`enforceBudget`/`effectiveSalience`/`recallCountOf`/`patchMeta` | personal-memory + host | 无（`meta.queryHits`） |
| MR3 | Hermes skills | `detectProcedureCandidates` + `umbrellaReviewer` + 聚类 | `isProcedure`/`stepsOf`/`closedMeta`(D)/`META_LINKS`(E)/tiers 聚类/`extractTerms` | personal-memory + host | 无（`form:'procedure'`） |
| MR4 | Hermes 6h | `cleanOutputsReviewer` + 维护组装 helper | `composeReviewers`/`MemoryReviewParticipant`/`HeartbeatScheduler`/`budgetReviewer` | personal-memory + example + host | 无 |

---

## 四、MR1 · 默认召回索引（纯 JS 倒排）

### 4.1 缺口的真实形状

`lexicalRetriever`（当前默认）从 handle 拉**最近 `wideK`（cap 200）** 条，再用
`relevanceScore` 在内存里 rank。两个问题：

- **覆盖面**（更要命）：超过最近 200 条的**相关旧条目永远进不了候选**——它们连被打分
  的机会都没有。一个常驻管家攒久了，「半年前那家奶茶店叫什么」可能就在窗口外。
- **成本**：每次召回 O(n) 全读 + 全打分。

「默认召回检索需要补上」的实质 = **让召回按相关性覆盖整个库，而不只是最近一屏**。

### 4.2 设计

**叶包：纯算法 + retriever（零 I/O、零 LLM、可单测）**

`packages/personal-memory/src/inverted-index.ts`：

```
class InvertedIndex {
  // term(由 extractTerms 产出: CJK bigram / Latin token) → Set<entryId>
  add(id: string, text: string): void      // extractTerms(text) → 各 term 的 postings 加 id
  remove(id: string): void                 // 从所有 postings 删 id
  query(text: string): string[]            // extractTerms(query) → 候选 id(命中任一 term 的并集)
  serialize(): InvertedIndexSnapshot       // { version, postings, ids }  (host 落盘用)
  static load(snap): InvertedIndex
}
```

- **复用 `extractTerms`**（relevance.ts）当唯一 tokenizer → 索引的切词与召回打分**同一套**，
  零漂移（索引召回什么、`relevanceScore` 怎么排，用的是同一个词表）。
- `query` 只做**候选粗筛**（命中任一 query term 的 id 并集），**精排仍交 `relevanceScore`**。

`invertedIndexRetriever(handle, index, opts?)`（新 `MemoryRetriever` 实现）：

```
retrieve(q):
  if !q.text → 退回 importance-then-recency(同 lexicalRetriever 空 query 分支)
  candidateIds = index.query(q.text)            // 全店候选, 不限最近窗口 ← 补上覆盖面
  entries = await handle 按 id 取 candidateIds   // 经 recall/list 拉回再按 id 取
  filterActive(entries, opts)                   // D activeOnly 透传
  rank by relevanceScore(q.text, e.text), tie→compareByImportanceThenRecency
  slice k
```

> 取 entries 的方式：handle 当前接口（recall/list）无「按 id 批量取」。MVP 用一次
> `handle.list({limit: 上限})` 拉回全量后按 candidateIds 过滤——**仍 O(n) 读但只在
> 索引命中后做一次**，且候选已收窄到相关集；或在 host 持久层维护 `id→entry` 映射随
> 索引一起持久化（4.3）。叶包 retriever 只依赖 `MemoryHandle`，按 id 取的策略由实现
> 选，契约不变。**实现期定**：先走「list 一次 + 按 id 过滤」最简，量大再上 id→entry。

**host 侧：持久化 + 新鲜度（叶包保持零 I/O）**

`packages/host/src/butler-recall-index.ts` —— `FileBackedInvertedIndex`：

- 落 `<rootDir>/user/<userId>/recall-index.json` = `{ snapshot, watermark:{count,maxTs} }`。
- **open 时校验**：读当前库的 `{count, maxTs}`（一次廉价 `list`）vs 索引 watermark。漂移
  → **从 jsonl 全量重建**（jsonl=真相，索引可丢可重建）。一致 → 直接 load。
- **增量维护**：host 中介的写（capture / consolidate / reconcile / forget / `/me` forget）
  顺手 `index.add/remove` + bump watermark + 落盘。
- **工具驱动的写**（toolset `remember`/`forget`/`refine_procedure`）：toolset 暴露可选
  `onWrite(id, kind, op)` 钩子；host 接它 → 同样 add/remove。**兜底**：即便钩子漏了，
  下次 open 的 watermark 校验会触发重建——**索引永不是真相，错了就重建**。
- 损坏 / 缺失 / 版本不符 → 静默全量重建（best-effort，绝不让召回失败）。

**决策（已定）**：机制 = **纯 JS 倒排**，非 SQLite FTS5。理由：file-first、可移植（零
native 依赖、不撞便携包）、复用 tokenizer。两者都在 `MemoryRetriever` seam 之后，**随时
可换**；SQLite FTS5 / 向量（C-M3 `embeddingRetriever`）留作 seam 备选。

### 4.3 数据流

```
recall("奶茶店", k=6)
  └─ invertedIndexRetriever.retrieve
        ├─ index.query("奶茶店") → extractTerms → {奶茶,茶店} → postings 并集 = [m12,m87,m203,…]  (全店, 含窗口外 m203)
        ├─ handle 取这些 id → filterActive(D)
        └─ relevanceScore 精排 → top-6
  jsonl 写 ──(host 中介/toolset onWrite)──▶ index.add/remove + watermark + 落 recall-index.json
  open ──▶ watermark 校验 ──drift?──▶ 从 jsonl 全量重建
```

### 4.4 测试

- 索引召回 **⊇** lexicalRetriever 召回，且**能找回超 wideK 窗口的相关旧条目**（核心增量）。
- 重建幂等：同 jsonl → 同 postings（确定）。
- 增删同步：remember/forget 后 query 反映变化。
- watermark 漂移触发重建；损坏 index 静默重建；版本不符重建。
- 空 query 退化 = importance-then-recency（与 lexicalRetriever 一致）。

---

## 五、MR2 · dreaming 后台蒸馏（对齐 OpenClaw）

### 5.1 缺口

有 `consolidate`（episodic→semantic）/ `consolidateTiered` / `effectiveSalience`(F) /
`importanceOf`(⑤) / `recallCountOf`(F)，但缺 OpenClaw dreaming 的三样：① **query-diversity
信号**（被多少**不同**查询命中过）② 「打分 → **三门控**提升 + 清陈旧」的统一 sweep
③ **dream diary**（人可复盘）。

### 5.2 设计

**① `meta.queryHits` —— query-diversity 信号**

- 召回命中一条时，记录该 query 的**指纹**：`fingerprint(query) = djb2_short(extractTerms(query).sort().slice(0,N).join('|'))`（确定、无 LLM、复用同一 tokenizer）。
- `meta.queryHits` 存**有界 distinct 指纹集**（cap 如 16，FIFO）。**多样性 = 集合 size**
  （被越多不同问题问到 = 越该长期留）。
- 写经 `patchMeta`（同 F reinforcer 的写缝）。新增 `queryHitWriter(entry, fingerprint)`
  返回 `{ queryHits: 去重并 cap 后的新集 }` delta（同 `reinforcedMeta` 的 delta 纪律，
  shallow-merge 不踩别的 key）。召回路径同时 bump `recallCount`(F) 与 `queryHits`。
- **时变 / 用量信号 → 绝不进 frozen block**（同 salience 纪律，写进顶注钉死）。

**② `dreaming.ts` reviewer（`composeReviewers` 兼容）**

```
dreamScore(entry, now) =                       // 纯函数, OpenClaw 三门
    importance/salience  (effectiveSalience)    // score 门
  × recall-frequency     (recallCountOf)        // 召回频率门
  × query-diversity      (queryHits size)       // query 多样性门

dreamingReviewer(ctx):
  收 ctx.episodic 短期候选
  打分 dreamScore
  提升: score ≥ promoteGate 的 → 提升进 curated semantic   (复用 consolidate/promoteCluster: dreaming 决定"哪些值得", consolidate 做蒸馏写入)
  清陈旧: score ≤ pruneGate 且久未召回/无多样性 → 驱逐       (复用 enforceBudget / D isExpired 排最前)
  产 diary: ReviewOutcome.summary + 结构化 { promoted:[…], pruned:[…], firedAt }
```

**③ dream diary**

- host 把结构化结果 append 到 `<rootDir>/user/<userId>/DREAMS.md`（人可读历史）。
- `/me`「管家记得你什么」加只读「上次复盘：提升 X 条 / 封存 Y 条」。

**对齐 OpenClaw 逐点**：promotion gates（score + recall frequency + query diversity）=
`dreamScore` 三因子；DREAMS.md = diary；stale removal = 清陈旧。

### 5.3 测试

- 三因子门控确定性：高分提升 / 低分丢弃 / 边界。
- `queryHits` 不进 frozen block（字节不变断言）。
- diary 产出结构正确。
- 幂等：收敛态（无新候选）零写 → `HEARTBEAT_OK`。

---

## 六、MR3 · agent 自创 + Umbrella 合并技能（学习 Hermes）

### 6.1 缺口

G `form:'procedure'` 只**被动记录**（`remember_procedure` 工具）。缺 Hermes 的三样：
**自创**（观察重复多步 → 写成技能）、**自改**（使用中增补）、**Umbrella 合并**（辅模型
扫冗余簇 → 并入 master SKILL.md + 重定向）。

### 6.2 设计（复用 D/E/tiers/procedures，零新 schema）

**自创**
- ① 工具：保留 `remember_procedure`（LLM 显式写）。
- ② 自动检测 `detectProcedureCandidates(episodic)`（纯件）：在 episodic 找**重复多步模式**
  （同一组动作序列出现 ≥N 次）→ 提议候选。检测在**心跳辅模型 pass**（有界，非每 turn）：
  LLM 把候选序列**命名 + 规整成 `steps`** 写成 procedure 条目。

**自改**
- `refine_procedure` 工具（或 umbrella pass 顺手精修）：对已存 procedure 增补 / 修订 steps
  → `patchMeta`（不铸新 id，frozen 不挪位）。

**Umbrella 合并 `umbrellaReviewer`**
```
聚类: active procedure 两两相似 (extractTerms/relevanceScore, 复用同一 tokenizer 零漂移)
      → 相似度 ≥ 阈值的冗余簇
合并: 辅模型 (MemorySummarizer 类 LLM 调用) 把一簇 micro-procedure → 一个 master umbrella procedure (合并 steps + 命名)
重定向 (= Hermes "SQLite repoint"):
   原件 D closedMeta(validTo=now, supersedes→umbrella id)  ← 封存非删, 可逆 (胜过 Hermes archive)
   原件 E links 指 umbrella
   umbrella 现行
```

**召回 / frozen 自动只回 umbrella —— "repoint" 免费经 D**：原件 closed → `activeOnly`
retriever（MR1 倒排 + D 过滤）自动 drop；frozen procedures 小节（G-M2，B 修
`frozenShowProcedures` + activeOnly）也只显 active → 显示 umbrella。无需任何「指针重写」。

**master SKILL.md**：host 把 active umbrella procedures 投影成
`<rootDir>/user/<userId>/SKILL.md`（人可读，镜像 DREAMS.md）。**衍生视图非真相**——真相是
jsonl 里的 procedure 条目；SKILL.md 像 frozen block 一样是投影。字面映射 Hermes 的
master SKILL.md，但单一真相守住。

### 6.3 治理姿态（反无界自治）

- 自创 = 有界工具 / 心跳 pass（非每 turn 无界 tool-loop）。
- 合并 / 封存 = 心跳辅模型 pass；封存 **可逆**（bitemporal close）。
- **决策点（默认不门控，留 opt-in）**：自动 Umbrella 合并因封存可逆、不删数据，默认
  **不**走 `/me` 收件箱审批；若运维想让「自动改技能」也人在环，可把 umbrella 合并注册进
  `GovernedActionToolset`（同敏感记忆写既有机制，零新设施）。本轮默认 opt-in 关。

**决策（我默认，可改）**：skill 存储 = 复用 `form:'procedure'` semantic 条目 + D/E/tiers，
**不建并行 skill 子系统**；SKILL.md 是投影。

### 6.4 测试

- 重复模式 → 自创 procedure。
- umbrella 合并：原件封存（validTo + supersedes）/ umbrella active / 原件 links 指 umbrella。
- 召回只回 umbrella（activeOnly 生效）。
- SKILL.md 投影只含 active umbrella。
- 幂等：收敛态（无冗余簇）零合并。

---

## 七、MR4 · 6h 维护心跳（学习 Hermes，当总指挥）

### 7.1 缺口

有 `HeartbeatScheduler/Participant`（Stream D）+ `MemoryReviewParticipant` +
`composeReviewers`，但没把「复盘技能 / 清输出 / 合并记忆 / 写状态」组成一个 6h 维护节律。

### 7.2 设计

一个**维护 reviewer agent**（`MemoryReviewParticipant`），心跳 broker 以 **6h** cadence
fire（`intervalMs` 可配，默认对齐 Hermes 6h）：

```
reviewer = composeReviewers(
  umbrellaReviewer,      // ① 复盘技能 (MR3)
  cleanOutputsReviewer,  // ② 清输出: prune 陈旧 working kind + budget 驱逐(F effectiveSalience)
  dreamingReviewer,      // ③ 合并记忆 (MR2) + 既有 tiered/reconcile
  reconcileReviewer, linkReviewer, budgetReviewer,
)
// 各 pass 自门控 (policy.minEpisodic 设低, 让非 episodic pass 不被饿死 —— review.ts 注释已说)
```

**Hermes 四件逐一对上**：
1. **复盘技能** → `umbrellaReviewer`（MR3）。
2. **清输出** → `cleanOutputsReviewer`：prune 陈旧 `working` kind（scratch / 工具输出）+
   budget 驱逐。注：管家默认不挂 `working`（`personal-butler-memory` 注释——in-flight 状态
   在 suspend 上不在记忆），故 cleanOutputs 主要是 budget；若启用 working 则一并 prune。
3. **合并记忆** → `dreamingReviewer`（MR2）+ 既有 tiered / reconcile。
4. **写状态** → host 把本拍 composed `ReviewOutcome.summary` 落
   `<rootDir>/user/<userId>/STATUS.md`（覆盖 = 最新一拍状态）+ DREAMS.md（append = 历史）；
   `/me` 可读。

**cadence**：复用 heartbeat per-agent `intervalMs`；6h = 维护 agent 的 interval。**推荐一个
agent + 各 pass 自门控 + 6h interval**，最轻（不另起 timer / 表，沿 Stream D #1a）。

### 7.3 测试

- 一拍跑完四件（composed summary 含各 pass 报告）。
- STATUS.md 产出（最新覆盖）+ DREAMS.md append（历史）。
- 幂等：收敛态 → `HEARTBEAT_OK`（心跳静默）。
- cleanOutputs prune 陈旧 working。

---

## 八、跨 MR 的统一落点（per-user 目录）

```
<rootDir>/user/<userId>/
├─ episodic.jsonl     真相 (capture)
├─ semantic.jsonl     真相 (consolidate/profile/procedure/umbrella)
├─ recall-index.json  MR1 衍生, 可从 jsonl 重建
├─ DREAMS.md          MR2 复盘日记 (append 历史)
├─ SKILL.md           MR3 umbrella 投影 (active 技能, 衍生)
└─ STATUS.md          MR4 最新维护状态 (覆盖)
```

全部进 per-user 命名空间 → no-leak 不破；被遗忘权：`/me` `forgetAll` 一并清这些衍生文件
（host `butler-memory-service` 扩一步删衍生物）。

---

## 九、测试矩阵 + 验收门

| 层 | 内容 |
|---|---|
| 叶包单测 | 倒排索引(add/remove/query/serialize 往返) · `dreamScore` 三因子 · `queryHits` 去重+cap+不进 frozen · `detectProcedureCandidates` · 聚类相似度 · `cleanOutputsReviewer` |
| example 确定性 demo | 扩 `examples/personal-butler`: mock provider + `DemoMemory`(已含 patchMeta) 跑一遍 dreaming + umbrella + 6h composed pass, 断言 promote/prune/合并/SKILL/STATUS, 改坏即红 |
| host E2E 承重门 | 真 Hub + 真 IdentityStore + 真 FileInboxStore + 真 file handle: 一拍 6h 维护跑通四件 + 衍生文件落盘 + `/me` 可读 + no-leak(另一 user 看不到) |
| 全量 | `pnpm -r test` 零回归 |

---

## 十、北极星合规自查

- [x] 框架不跑 LLM：辅模型 pass = agent 调 LLM（同 consolidate）；Hub 只调度心跳。
- [x] file-first：jsonl 唯一真相；4 个衍生文件都可重建、都在 per-user 目录、copy 即搬走。
- [x] 有界 + 门控：自创 = 有界工具 / 心跳 pass；合并封存可逆；敏感写既有闸不动。
- [x] 前缀缓存：`queryHits` / salience 时变信号绝不进 frozen block。
- [x] 治理 / no-leak / 被遗忘权：衍生文件进 per-user 命名空间 + `/me` 可读可删。
- [x] example-first：bulk 叶包 + example 接线；fold 进 host 推迟。
- [x] core/protocol/identity/runner 零改；zero schema 改。

---

## 十一、显式推迟

- **SQLite FTS5 / 向量 retriever**：本轮纯 JS 倒排；FTS5 / `embeddingRetriever` 留 seam 备选。
- **跨 hub 技能共享 / 技能模板导出**：B 模板系统（决策 #4 带引用不带内容）可承接，本轮不做。
- **无界自治 tool-loop**：明确**不做**（北极星）。
- **矛盾检测**（OpenClaw Memory Wiki）当独立 pass：D 双时态已覆盖部分「新鲜度 / 取代」，
  显式矛盾检测留后。
- **fold 进 host main.ts 一等公民**：example-first，`/me` 隐私视图已读同一子树。
- **dreaming / umbrella 接 governed 审批闸**：默认 opt-in 关（封存可逆），机制已就位。

---

## 十二、里程碑顺序 + commit 计划

```
MR1 召回索引  → 本地 commit + 叶包/索引测试
MR2 dreaming  → 本地 commit + dreaming/queryHits 测试
MR3 自创/Umbrella → 本地 commit + skills/umbrella 测试
MR4 6h 维护    → 本地 commit + 维护/example/E2E 测试
收尾          → 本文转 FINAL + CLAUDE.md 登记 + 全量回归
```

一里程碑一本地 commit，串行做到底，**只本地不 push**。每个 MR 先开发后测试再 commit。
```
```
