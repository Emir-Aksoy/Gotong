# 管家记忆 · dreaming 后台 + 默认召回索引 + 自创/Umbrella 技能 + 6h 维护（收口）

> **收口文档（已交付）**。学习 OpenClaw 与 Hermes，把「我们框架之上的管家智能体」的长
> 期记忆补上四块能力，全部落地。本文是事后总结（commit / 落点 / 验收结果 / 显式推迟）；
> 建之前的设计与契约见 [`MEMORY-DREAMING-SKILLS-DESIGN.md`](../MEMORY-DREAMING-SKILLS-DESIGN.md)。
>
> Status: DONE · 2026-06-29/30 · 对应 reference：[[openclaw-hermes-reference]] ·
> 接 [[butler-memory-roadmap]] / [`MEMORY-ADVANCED-FINAL.md`](./MEMORY-ADVANCED-FINAL.md)

---

## 〇、一句话 + 定位

- 这是 **AipeHub 框架之上的「管家智能体」**的记忆增强，**不是框架本身**（[[butler-is-agent-not-framework]]）。
  对比时比的是「我们这个管家的记忆」对「OpenClaw / Hermes 这类智能体的记忆」，不是框架对框架。
- 四件事**几乎全是把已有零件接成新故事**：C/D/E/F/G 长期记忆 + 心跳（Stream D）+
  `MemoryRetriever` seam + `patchMeta` 写缝 + `composeReviewers` 心跳 pass 框架，地基正好够用。
- **零 schema 改**（全住 `MemoryEntry.meta` 自由字段 / 衍生文件）、**core/protocol/identity/
  workflow-runner 零改**、bulk 落 `@aipehub/personal-memory` 叶包、接线在 `examples/personal-butler`、
  `/me` 只读投影在 host，**example-first**（管家 fold 进 host main.ts 仍推迟）。

---

## 一、commit 总账

| MR | 学谁 | commit | 包 |
|---|---|---|---|
| 设计定稿 | — | `c22aa00` | docs |
| **MR1** 默认召回索引（纯 JS 倒排） | Hermes Tier2 FTS5 | `0038658` | personal-memory + host |
| **MR2** dreaming 后台复盘 | OpenClaw dreaming | `8aad30b` | personal-memory + host + web |
| **MR3-M1** 技能自创（聚类 + 检测 + authoring reviewer） | Hermes skills | `6b15ebe` | personal-memory |
| **MR3-M2** Umbrella 合并 + `refine_procedure` 自改工具 | Hermes skills | `c01ff9f` | personal-memory |
| **MR3-M3** master SKILL.md 投影 + 服务接线 | Hermes SKILL.md | `974abf6` | personal-memory + host |
| **MR3-M4** 技能自创+自改+Umbrella demo + README | — | `9caa520` | example |
| **MR4-M1** `cleanOutputsReviewer` 清输出 | Hermes 6h | `16d62c1` | personal-memory |
| **MR4-M2** STATUS.md 投影 + 维护包装 + /me 上次维护 + forgetAll | Hermes 6h | `d6faec2` | host + web |
| **MR4-M3** 6h composed 维护 pass demo | — | `1fac634` | example |
| **MR4-M4** §九 承重门（真文件 handle 一拍维护 → SKILL/STATUS 落盘 + /me 可读 + no-leak） | — | `d5e970a` | host |

测试基线（全量 `pnpm -r test` 绿，零回归）：personal-memory **373** · host **1334 passed | 4 skipped** ·
web **1169** · personal-butler **26**。

---

## 二、为什么做（对照 OpenClaw / Hermes 的四个缺口）

| 维度 | 做之前 | 缺口 | 现在 |
|---|---|---|---|
| 默认召回 | `lexicalRetriever` 只 rank 最近 ≤200 条 | 超窗口的相关旧条目**连被打分的机会都没有** | **MR1** 倒排索引按相关性覆盖整个库 |
| 后台蒸馏 | `consolidate` 超字符限报错逼蒸（≈Hermes） | 缺 OpenClaw 的 **query-diversity 信号 + 升降 sweep + diary** | **MR2** `dreamScore` 三因子门控 + DREAMS.md |
| 技能/程序 | G `form:'procedure'` 只**被动记录** | 缺 Hermes 的**自创 / 自改 / Umbrella 合并** | **MR3** 自创 + `refine_procedure` + umbrella + SKILL.md |
| 运维节律 | 心跳 review（capture 复盘）散件 | 没把「复盘技能/清输出/合并记忆/写状态」组成 **6h 维护节律** | **MR4** `composeReviewers` 当总指挥 + STATUS.md |

我们守住、且**胜过**对方的两条：双时态正确性（D `validFrom/validTo/supersedes` 时光机，
umbrella 合并 = **可逆 bitemporal-close 封存非删**，胜过 Hermes 的破坏性 archive）；治理
（`/me` forget/export · 敏感写 HITL · no-leak per-user 命名空间，胜过 OpenClaw 的 ungated 自治）。

---

## 三、关键设计决策（落地后回看）

1. **辅模型 = agent 在心跳 pass 里调 LLM，不是 Hub 调**（同 `consolidate` 的 `MemorySummarizer`
   既有姿态）。dreaming 的 `summarize`、umbrella 的 `merge`、技能自创的命名 —— 都是注入的
   `MemorySummarizer`/`ProcedureDrafter` 闭包。**叶包保持 LLM-free**，Hub 仍只调度心跳唤醒。
2. **倒排索引 = 纯 JS，非 SQLite FTS5**。理由：file-first、可移植（零 native 依赖、不撞便携包）、
   复用 `extractTerms` 同一 tokenizer 零漂移。两者都在 `MemoryRetriever` seam 之后随时可换；
   FTS5 / 向量（C-M3 `embeddingRetriever`）留 seam 备选。
3. **倒排索引永不是真相**。host `FileBackedInvertedIndex` 落 `recall-index.json` + watermark
   `{count,maxTs}`；open 时校验漂移 → **从 jsonl 全量重建**。损坏 / 缺失 / 版本不符一律静默重建
   —— jsonl 是唯一真相，索引错了就重建，绝不让召回失败。
4. **query-diversity = distinct 指纹集的 size**，不是命中次数。`queryFingerprint(query)` 复用同一
   tokenizer 做确定指纹；`meta.queryHits` 存有界 distinct 指纹集（FIFO cap）。被越多**不同**问题
   问到 = 越该长期留。写经 `patchMeta`（同 F reinforcer 写缝，shallow-merge 不踩别的 key）。
5. **前缀缓存纪律**：`queryHits` / `effectiveSalience` 等时变 / 用量信号**绝不进 frozen block**
   （`salience.ts` / `relevance.ts` 顶注钉死）。它们只服务 dreaming 打分 / 驱逐 / 召回排序。
   frozen block 的序永远是 entry **集合**的纯函数。
6. **Umbrella 合并的「repoint」免费经 D**：原件 `closedMeta(validTo=now, supersedes→umbrella)`
   封存（可逆）+ E links 指 umbrella；召回 / frozen 的 `activeOnly` 过滤**自动只回 umbrella**，
   无需任何「指针重写」。这就是 Hermes「SQLite repoint」的可逆等价。
7. **skill 存储复用 `form:'procedure'` semantic 条目 + D/E/tiers，不建并行 skill 子系统**；
   SKILL.md / DREAMS.md / STATUS.md 都是**投影**，像 frozen block 一样衍生于 jsonl。
8. **6h 维护 = 一个 `MemoryReviewParticipant` + 各 pass 自门控 + 6h interval**（沿 Stream D #1a
   最轻，不另起 timer / 表）。`statusProjectingReviewer` **包装**整个 composed pass，让 STATUS.md
   看到**合并后**的一行 summary，且返回 inner outcome 不变 → idle `{}` 仍写「无需改动」状态但
   保持 `HEARTBEAT_OK` 抑制（投影从不扰动通知门控）。
9. **自动 Umbrella 合并默认不门控**（封存可逆、不删数据）；运维想让「自动改技能」也人在环，把
   umbrella 合并注册进 `GovernedActionToolset`（同敏感记忆写既有机制，零新设施）即可。本轮默认 opt-in 关。

---

## 四、四块落地（零件 → 落点）

### MR1 · 默认召回索引（`0038658`）
- 叶包 `inverted-index.ts`：`InvertedIndex`（`add`/`remove`/`query`/`serialize`/`load`，term 经
  `extractTerms` 切 CJK bigram / Latin token）+ `invertedIndexRetriever`（`MemoryRetriever` 实现：
  `index.query` 出**全店候选**不限最近窗口 → handle 取回 → D `activeOnly` 透传 → `relevanceScore`
  精排 → slice k；空 query 退化 importance-then-recency 同 `lexicalRetriever`）。
- host `butler-recall-index.ts`：`FileBackedInvertedIndex` 落 `recall-index.json` + watermark 校验
  + 全量重建兜底。

### MR2 · dreaming 后台复盘（`8aad30b`）
- 叶包 `dreaming.ts`：`dreamScore(entry,now) = effectiveSalience × recall-frequency × query-diversity`
  三因子纯函数；`dreamingReviewer`（`composeReviewers` 兼容：promoteGate 升进 curated semantic /
  pruneGate + staleMs 清陈旧 / 产 diary summary `dreamed: promoted N, pruned M`）；`queryFingerprint` /
  `queryHitMeta` / `queryHitsOf` + `MemoryQueryHitWriter`；`MemoryToolset` 新 `queryHit` 选项，recall
  路径同时 bump `recallCount`(F) 与 `queryHits`。
- host `personal-butler-dreams.ts`：DREAMS.md append-only 日记（`openButlerDreamDiary`，
  `readLatest()` 解析最后一个 marker）；`/me` 加只读「上次复盘」。

### MR3 · 自创 + 自改 + Umbrella（`6b15ebe`/`c01ff9f`/`974abf6`/`9caa520`）
- 叶包 `skills.ts`：`detectProcedureCandidates`（episodic 找重复多步模式）+ authoring reviewer
  + `umbrellaReviewer`（聚类 active procedure 两两相似 → 冗余簇 → 辅模型 `merge` 成 master umbrella
  → 原件 D 封存 + E 回链）+ `activeProcedures` / `isUmbrella`。`procedure.ts`：`refine_procedure`
  自改工具（`patchMeta` 不铸新 id，frozen 不挪位）。
- host `personal-butler-skills.ts`：`projectButlerSkills` + `openButlerSkillFile` + `skillFileReviewer`
  把 active umbrella procedures 投影成 SKILL.md（返回 `{}` 不声称工作，组合在 umbrellaReviewer 之后）。

### MR4 · 6h 维护心跳（`16d62c1`/`d6faec2`/`1fac634`/`d5e970a`）
- 叶包 `clean-outputs.ts`：`cleanOutputs` / `cleanOutputsReviewer`（按 age prune 陈旧 `working` kind；
  `staleMs:0` 无视年龄全清；与 `budgetReviewer` 互斥 —— age-housekeeping vs byte-pressure-backstop）。
- host `personal-butler-status.ts`：STATUS.md 覆盖式快照（`openButlerStatusFile` + marker）+
  `statusProjectingReviewer({statusFile, inner})` 包装整个 composed pass 写 STATUS.md。
- 维护节律 = `statusProjectingReviewer({ inner: composeReviewers(umbrellaReviewer①复盘技能,
  cleanOutputsReviewer②清输出, dreamingReviewer③合并记忆, skillFileReviewer→SKILL.md) })` ④写状态。
- `butler-memory-service.ts`：`/me`「管家记得你什么」`read` 浮现 `lastStatus`（+ MR1/2/3 衍生），
  `forgetAll` 一并清 recall-index.json / DREAMS.md / SKILL.md / STATUS.md（被遗忘权 / §八）。

---

## 五、跨 MR 的统一落点（per-user 目录）

```
<rootDir>/user/<userId>/
├─ episodic.jsonl     真相 (capture)
├─ semantic.jsonl     真相 (consolidate/profile/procedure/umbrella)
├─ recall-index.json  MR1 衍生, 可从 jsonl 重建
├─ DREAMS.md          MR2 复盘日记 (append 历史)
├─ SKILL.md           MR3 umbrella 投影 (active 技能, 衍生)
└─ STATUS.md          MR4 最新维护状态 (覆盖)
```

全部进 per-user 命名空间（`openButlerMemory` 唯一 seam）→ no-leak 不破；被遗忘权：`/me`
`forgetAll` 一并清这四个衍生文件。**copy 目录 = 带走大脑 + 索引 + 日记 + 技能 + 状态**；
任何衍生物损坏 / 缺失都从 jsonl 静默重建。

---

## 六、测试矩阵 + 验收结果

| 层 | 内容 | 结果 |
|---|---|---|
| 叶包单测 | 倒排索引(add/remove/query/serialize 往返+重建幂等) · `dreamScore` 三因子 · `queryHits` 去重+cap+不进 frozen · `detectProcedureCandidates` · 聚类相似度 · `cleanOutputsReviewer` | personal-memory **373** 绿 |
| example 确定性 demo | `examples/personal-butler` `[4f]`MR1 / `[4g]`MR2 / `[4h]`MR3 / `[5]`MR4：mock provider + `DemoMemory`(patchMeta) 跑 dreaming + umbrella + 6h composed pass，断言 promote/prune/合并/SKILL/STATUS，改坏即红 | personal-butler **26** 绿 |
| **host E2E 承重门** | `personal-butler-maintenance-e2e.test.ts`（MR4-M4 `d5e970a`）：真 `MemoryFileHandle` 一拍 6h 维护 → ① SKILL.md 落唯一 umbrella ② STATUS.md 落合并 summary ③ `HostButlerMemoryService.read` 浮现 lastStatus + dreaming promote 进画像 ④ **no-leak**：另一成员树空、无衍生文件 | host **1334 passed \| 4 skipped** 绿 |
| 全量 | `pnpm -r test` | **零回归**（exit 0，34 包全绿，仅 live-gate / provider-key 测试 skipped） |

**承重门的价值**：叶包 reviewer 与 host 投影各自已单测；E2E 按生产接线把它们组合 + 包装
（`statusProjectingReviewer({ inner: composeReviewers(...) })`）在一个**真文件后端** handle 上跑一拍，
钉死「四件事一拍跑完 + 四个衍生文件真落盘 + `/me` 真读得到 + 别的成员真看不到」—— 这是 example
的内存 `DemoMemory` 与隔离单测都覆盖不到的、生产形态的端到端正确性。查询多样性经**真 recall 工具
+ 文件后端 `patchMeta`** 驱动，正是 host 接线方式。全程确定性无 key（辅模型是结构化 mock，叶保持 LLM-free）。

---

## 七、北极星合规自查

- [x] **框架不跑 LLM**：辅模型 pass = agent 调 LLM（同 consolidate）；Hub 只调度心跳。
- [x] **file-first**：jsonl 唯一真相；4 个衍生文件都可重建、都在 per-user 目录、copy 即搬走。
- [x] **有界 + 门控**：自创 = 有界工具 / 心跳 pass；合并封存可逆；敏感写既有闸不动。
- [x] **前缀缓存**：`queryHits` / salience 时变信号绝不进 frozen block。
- [x] **治理 / no-leak / 被遗忘权**：衍生文件进 per-user 命名空间 + `/me` 可读可删可导出。
- [x] **example-first**：bulk 叶包 + example 接线；fold 进 host 推迟。
- [x] **core/protocol/identity/runner 零改；zero schema 改**。

---

## 八、显式推迟

- **SQLite FTS5 / 向量 retriever**：本轮纯 JS 倒排；FTS5 / `embeddingRetriever`（C-M3）留 seam 备选。
- **跨 hub 技能共享 / 技能模板导出**：B 模板系统（决策 #4 带引用不带内容）可承接，本轮不做。
- **无界自治 tool-loop**：明确**不做**（北极星）。
- **矛盾检测**（OpenClaw Memory Wiki）当独立 pass：D 双时态已覆盖部分「新鲜度 / 取代」，
  显式矛盾检测留后。
- **fold 进 host main.ts 一等公民**：example-first，`/me` 隐私视图已读同一子树。
- **dreaming / umbrella 接 governed 审批闸**：默认 opt-in 关（封存可逆），机制已就位。
