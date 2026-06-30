# 个人管家记忆 — 五项长期增强 (收口, C/F/E/G/D + Z 全完)

> 用户指令「C/D/E/F/G 都做, 一起做一个计划先」+「定了我就一路做到底不再打断」——
> 一次把 Personal Butler 记忆引擎 `@aipehub/personal-memory` 还缺的五项长期能力做实,
> 再用一个收口里程碑 **Z** 把它们接进 host + example + `/me` 隐私视图。承接
> [`MEMORY-TIERS-FINAL.md`](MEMORY-TIERS-FINAL.md) (③ 多级长期 × ⑤ 重要性) 与
> [`PERSONAL-BUTLER-FINAL.md`](PERSONAL-BUTLER-FINAL.md) (管家骨架)。
>
> 三处用户锁定决策 (均推荐项): **D 双时态 opt-in, 默认关** (overwrite/真删 字节不变) ·
> **收口深度 = 包内原语 + 单测 + example + 一个 Z 收口里程碑接 host** · **顺序 C→F→E→G→D→Z**。
> 开发新阶段**只 commit 本地**, 一里程碑一小 commit。
>
> Last updated: 2026-06-29

---

## 一句话

管家记忆现在不只是**存**事实, 还会:

| 代号 | 能力 | 一句话 |
|---|---|---|
| **C** | 中文混合召回 | `recall` 默认走词法检索, 「奶茶店」能找到「卖奶茶的店」(CJK bigram), 子串匹配漏掉的它命中。 |
| **F** | 衰减 / 强化 | 一条事实有 keep-value: 久不召回的**淡出**, 反复召回的**强化**; 驱逐时先丢淡的。 |
| **E** | 关联建链 | 心跳一拍把相关事实**双向建链** (`meta.links`), recall 一跳展开, 冻结块成可导航小图。 |
| **G** | 程序性记忆 | 记得**怎么做** —— 一条 `form:'procedure'` 的事实带有序 `steps`, 冻结块抽进「会做的事」小节。 |
| **D** | 双时态 | 事实带 `validFrom`/`validTo` 有效区间; 「搬到槟城」**封存**旧的「住吉隆坡」而非覆盖, 历史可查。 |

**零 schema 改**: 五项全部住 `MemoryEntry.meta` 自由字段 (`links`/`recallCount`/
`lastRecalledTs`/`form`/`steps`/`validFrom`/`validTo`/`supersedes`) —— `MemoryEntry`
一个字段不动, 同 ③/⑤ 的 `tier`/`level`/`importance` 纪律。

---

## 二、北极星对齐(全程守住)

- **框架不跑 LLM**。调和 (E/D 的 reconcile) 与蒸馏走注入的 `MemorySummarizer` 回调,
  `reconcile.ts`/`link-pass.ts`/`salience.ts`/`bitemporal.ts`/`procedure.ts` 从不
  `import @aipehub/llm`; 衰减/强化/建链/有效性判定全是**纯函数**。测试用确定性 fake。
- **状态即文件**。五项全是 per-user jsonl 里 entry 的 `meta`。复制目录 = 搬走「大脑」,
  连同它的链、强化计数、时间边。重启透明。
- **不需要向前兼容, 但默认零回归**。每一项都是 **opt-in, 默认字节不变**:
  - C: `lexicalRetriever` 空 query 退化成 importance-then-recency, 与 `handleRetriever` 同。
  - F: `effectiveSalience` 无 `now`/无选项时 **IS** `importanceOf` (整数 1..5) → 驱逐序与 pre-F 同。
  - E: 无 `linkWriter` → 建链 pass 惰性不跑; 冻结块 `showLinks` 默认关。
  - G: `showProcedures` 默认关, 且无 procedure 时字节与关掉相同。
  - D: 无 validity meta → 永远 active; `bitemporal` 默认关 → reconcile 仍 overwrite/真删。
- **前缀缓存纪律 (不可破)**。冻结块顺序仍是纯 `compareByImportanceThenRecency`。
  **F 的时变 keep-value 绝不进冻结块** (`salience.ts` 顶注钉死: 它只服务驱逐/recall,
  从不被 `frozen-block.ts` import)。E 的链尾 / G 的程序小节 / D 的 activeOnly 都是
  (entry 集合[, now]) 的纯字节稳定函数 → 同会话稳定 → 不打断 Anthropic/OpenAI 缓存。

---

## 三、里程碑(逐个本地 commit)

### C — 中文混合召回

| M | commit | 内容 |
|---|---|---|
| C-M1 | `292ed80` | `relevance.ts` — `relevanceScore`/`extractTerms` (CJK bigram + Latin token overlap), 纯打分。 |
| C-M2 | `b1d9fa3` | `lexicalRetriever` 设为 recall **默认**: 不把 `text` 交给后端 (子串会预删非连续 CJK), 拉新近窗口自己按 `relevanceScore` 排; toolset 接入。 |
| C-M3 | `7b717f2` | `embeddingRetriever` + `cosineSimilarity` + `Embedder` 接缝 (向量/chroma-mcp), `examples/` 配方。 |

### F — 衰减 / 强化

| M | commit | 内容 |
|---|---|---|
| F-M1 | `19823d6` | `salience.ts` — `effectiveSalience(entry, now?, opts?)` = importance × ageFactor × reinforceFactor (pin 不衰减); `reinforcedMeta` 纯转换。**无选项 = importanceOf** 零回归。 |
| F-M2 | `1d401bb` | `budget` 驱逐 keep-value 由 `importance` 换 `effectiveSalience` (同级内淡的先驱逐)。 |
| F-M3 | `f19fb4b` | opt-in 召回强化: recall 命中后经注入 `MemoryReinforcer` best-effort bump; 冻结块字节不变 (强化不进冻结块)。 |

### E — 关联建链

| M | commit | 内容 |
|---|---|---|
| E-M1 | `243a58a` | `links.ts` — `linkRelated`/`buildLinkGraph`/`diffLinkUpdates`/`mergeLinks`/`defaultLinkScorer`/`linksOf`/`expandByLinks` 纯函数, 对称闭包。 |
| E-M2 | `2bfc28e` | `link-pass.ts` — `linkPass`/`linkReviewer` 心跳一拍建链, 经注入 `MemoryLinkWriter` 持久 (只写链长的, 收敛态零写)。 |
| E-M3 | `2a98ae2` | recall 一跳 `expandByLinks` 展开 + 冻结块 `showLinks` ` (related: …)` 链尾 (仅 intra-block, 纯字节稳定)。 |

### G — 程序性记忆

| M | commit | 内容 |
|---|---|---|
| G-M1 | `19aa47e` | `procedure.ts` — `form:'procedure'` 第三形态骑在 `semantic` 上 (非新 kind) + `meta.steps` 有序; `remember_procedure` 工具。 |
| G-M2 | `d3ef217` | 冻结块 opt-in `showProcedures`「Things I know how to do」小节 (把程序从事实里抽出, 纯字节稳定)。 |

### D — 双时态

| M | commit | 内容 |
|---|---|---|
| D-M1 | `0cbf539` | `bitemporal.ts` — `validFrom`/`validTo`/`supersedes` + `isActive`/`isClosed`/`isExpired`/`openedMeta`/`closedMeta` + reconcile **opt-in** `bitemporal`+`closeEntry` (UPDATE 封存旧的+开新的, DELETE 关区间)。 |
| D-M2 | `50eb23b` | retriever + 冻结块 `activeOnly`: 只回此刻有效, 封存历史留盘 (无 validity 永远 active → legacy 不受影响)。 |
| D-M3 | `d4a633e` | budget opt-in `evictExpiredFirst`: 过期史料 (`validTo <= now`) 在任何活条目**之前**驱逐 (未来事实不算过期不误驱)。 |

### Z — 收口接线 (host + example + /me)

| M | commit | 内容 |
|---|---|---|
| **Z-M1** | `173162e` | **真生产缝**: `MemoryHandle.patchMeta?(id, patch)` (services-sdk) + `MemoryFileHandle` 实现 (read-filter-rewrite, 只重写命中行, 坏行逐字保留, 跨并发 remember 串行化)。三注入写手在文件后端**之前无处落地** —— 这一刀补上。 |
| **Z-M2** | `94b5a49` | host `butlerMemoryWriters(handle)` → `{closeEntry, reinforcer, linkWriter}` 三写手全接 `patchMeta`: `closedMeta`/`reinforcedMeta`/`{[META_LINKS]:links}` 经同一 in-place patch。缺 `patchMeta` 的后端 loud throw。 |
| **Z-M3** | `1c43c7c` | `/me`「管家记得你什么」隐私视图投影 8 个可选长期字段 (`links`/`recallCount`/`lastRecalled`/`form`/`steps`/`validFrom`/`validTo`/`active`); `projectEntry(e, now)` 经记忆引擎同一套 accessor 读, 全字段守卫 (普通条目投影字节不变); web 路由 verbatim echo; app.js chip + 程序 steps 列表 + i18n zh/en parity (无 emoji)。 |
| **Z-M4** | `e570465` | example `personal-butler` 接成完整故事: `DemoMemory.patchMeta` (替换数组槽, 让三写手在 demo 里成真) + 管家默认 recall=`lexicalRetriever(activeOnly)` + 新增 `[4]` 段 `composeReviewers(reconcileReviewer bitemporal+closeEntry, linkReviewer linkWriter)` 一拍 + `budgetReviewer(evictExpiredFirst+salience)` 一拍, 逐项 C/F/E/G/D 确定性自断言。 |
| **Z-M5** | 本提交 | 本 FINAL + CLAUDE.md 文档地图 & 进展登记 + MEMORY.md 指针 + `pnpm -r test` 全量回归。 |

---

## 四、注入写手缝(Z 的核心)

C/F/E/G/D 的**纯计算**早在包里, 但其中三项要**改已存在 entry 的 meta** —— 封存
(D)、强化 (F)、建链 (E) —— 而 `MemoryHandle` 此前**没有 meta-only 更新**:
reconcile 的 "update" 是 remember+forget, 会铸新 id/ts 把冻结块挪位。Z 补上这一缝:

```
纯计算 (leaf, 无 LLM)                    注入写手 (host 接 patchMeta)
─────────────────────                   ──────────────────────────────
closedMeta(meta, validTo)      ──→  closeEntry(entry, validTo)   D 封存时间边
reinforcedMeta(entry, now)     ──→  reinforcer(entry, now)       F 强化 keep-value
{ [META_LINKS]: links }        ──→  linkWriter(updates[])        E 双向建链
                                          │
                                          ▼
                          MemoryHandle.patchMeta(id, patch)   ← Z-M1 唯一落地点
                          (shallow-merge, 保 id/kind/text/ts)
                                          │
                ┌─────────────────────────┴─────────────────────────┐
         FileMemoryHandle (生产)                      DemoMemory (example)
         read-filter-rewrite, 只重写命中行            替换数组槽 (truer to rewrite)
```

**为什么是 shallow-MERGE 而非 REPLACE**: `linkWriter` 只拿到 `{id, links}`, REPLACE
会抹掉同 entry 的 `validTo`/`importance` 等其它 meta。MERGE 让三个写手各管各的 meta
键互不干扰 (D-M3 budget 驱逐 example 里, linkWriter 给已封存的 KL 加 `links` 不动
其 `validTo`, 正是靠 merge)。**为什么 patch 是普通数据而非闭包**: RPC-friendly,
跨进程可传, 与 interface 一致 (镜像 `forget` 的形状)。

默认全关 → 无写手 = pass 惰性 = 字节不变。三写手在 host (`butlerMemoryWriters`) 与
example (内联 ~3 行) 各接一次, 同一 `patchMeta` 缝。

---

## 五、一次 heartbeat tick 的数据流(example [4] 已落地)

```
成员对话 N 轮 → 每轮 turn-end capture → episodic 原始 (per-user jsonl)
                                              │
                              心跳一拍 (Stream D, 无新表/timer)
                                              ▼
                     MemoryReviewParticipant.review()  (minEpisodic 闸)
                                              │ composeReviewers 顺序跑, 各自 self-gate
              ┌───────────────────────────────┼───────────────────────────────┐
              ▼                                ▼                                ▼
   reconcileReviewer (E/D)          linkReviewer (E)               budgetReviewer (F/D)
   summarize→ops; bitemporal:       buildLinkGraph→diff;           evictExpiredFirst:
   UPDATE 写新事实+openedMeta,       linkWriter 写链长的            过期史料先驱逐;
   closeEntry 封存旧的(留史)         (收敛态零写)                   salience: 淡的先丢
              │                                │                                │
              └────────────── 全经 patchMeta in-place 落 per-user jsonl ─────────┘
                                              │
                       落盘后两条**独立**读路径 (互不喂给对方):
              ┌───────────────────────────────┴───────────────────────────────┐
              ▼                                                                ▼
   on-demand `recall` 工具                                 会话起一次性冻结块 (MemorySession)
   C lexical + D activeOnly                                D activeOnly + E 链尾 + G 程序小节
   (按需翻细节/历史, 每轮可变)                              (前缀缓存, 管家默认三项全开 = 审计 Fix B)
              └───────────────────────────────┬───────────────────────────────┘
                                              ▼
                          /me「管家记得你什么」隐私视图 (Z-M3 投影 8 字段)
```

> **读路径分两条, 别混。** `recall` 是**按需工具** (模型每轮自己决定查不查, 结果随
> query 变); 冻结块是**会话起算一次**的策展画像 (`MemorySession` 记住字节, 整个会话
> 不动 = 前缀缓存契约)。两者都从同一份 per-user jsonl 读, 但 recall **不喂给**冻结块。
> D 的 `activeOnly` 两条都做 (recall retriever + 冻结块各自过滤); E 链尾 / G 程序小节
> 只在冻结块。**审计 Fix B** 之前 `MemorySession` 没把 D/E/G 透传进冻结块 (只有 example
> 直接调 `renderFrozenBlock` 才演示得出来), 现已透传, 且 `PersonalButlerAgent` 默认
> 三项全开 —— 每项对不带相应 meta 的事实**字节不变**, 故新管家的块不变、长寿管家的块更干净。

example `[4]` 六项自断言全确定性、无 key、改坏即红:

```
[4a] C 子串漏「卖奶茶的店」, 词法命中 ✓
[4b] D activeOnly 只回「槟城」, 关掉仍翻出「吉隆坡」史料 ✓
[4c] E 项目↔供货商双向建链 + D 吉隆坡封存(supersedes)、槟城现行 ✓
[4d] F 供货商回想 2 次 keep-value 3.00→5.38 ✓
[4d'] D-M3 过期「吉隆坡」史料先驱逐, 在岗低优先级事实反而留 ✓
[4e] G 冻结块把「怎么给加班费定金额」连步骤抽进「会做的事」小节 ✓
```

---

## 六、测试矩阵

| 包 / 层 | 关键测试 | 数 |
|---|---|---|
| `personal-memory` | relevance / salience / links / link-pass / procedure / bitemporal / budget / reconcile 全套纯函数 + reviewer | 101 |
| `service-memory-file` | `patchMeta (Z-M1)` 8 测 (merge 保 id/ts/kind/text · 只重写命中行含坏行存活 · 跨并发 remember 串行) | 73 |
| `host` (butler) | `personal-butler-writers (Z-M2)` 4 测 (真文件后端: closeEntry/reinforcer/linkWriter 落地 + 缺 patchMeta throw) + `butler-memory-service (Z-M3)` 长期字段投影 | +12 |
| `web` | `me-butler-memory-routes` (Z-M3 投影 verbatim echo) | 8 |
| `examples/personal-butler` | `[4]` C/F/E/G/D 自断言 (tsx, throw-on-mismatch — examples 无 vitest) | demo exit 0 |

全量 `pnpm -r test` 绿, 零回归。

---

## 七、显式推迟

- **管家 fold 进 host main.ts 一等公民** —— 仍 example 运行时接线 (`/me` 隐私视图服务
  已接线读同一子树)。承 `PERSONAL-BUTLER-FINAL.md` 推迟项。
- **向量 / 图记忆当默认** —— C-M3 给了 `embeddingRetriever`/`Embedder` 接缝, 但默认
  仍是 `lexicalRetriever` (无外部依赖)。chroma-mcp 走 example, 非框架内置。
- **D 的「我以前住哪」时间旅行查询路径** —— 封存历史已留盘 (`activeOnly` 只是默认过滤),
  但还没有一个「翻历史」的成员入口 / 工具。
- **E 链的可视化 (导航小图 UI)** —— `/me` 现以 id 列表呈现链, 未画图。
- **F 衰减/强化默认开** —— 仍 opt-in (host 给 `salience` 选项才生效), 默认零回归。

---

## 八、记忆怎么随规模增长(诚实边界)

> 审计 Fix F 收口: `semantic` 记忆**会无界增长**, 把三道闸的分工讲清, 别让人以为冻结块
> 自己会兜住。

冻结块**不是**增长的约束 —— 它只拉 `frozenK`(默认 100)条、再按 `maxChars`(默认 4000)
软截断, 留下的标一句「(N lower-priority … omitted)」。**被截的尾巴没丢**, 留在盘上,
模型按需用 `recall` 工具够得着。真正管「规模」的是另外两件:

| 维度 | 谁兜住 | 怎么兜 |
|---|---|---|
| **盘上累积** | `budgetReviewer` (F/D 驱逐) | 心跳一拍按 `effectiveSalience` 淡的先驱逐 + `evictExpiredFirst` 过期史料最先走 → 盘上有上限, 不是无限堆。 |
| **召回规模** | 可插拔 `embeddingRetriever` (C-M3 接缝) | 默认 `lexicalRetriever` 是 O(n) 全扫 (无外部依赖, 个人 hub 量级够用); 库大了换向量后端 (chroma-mcp), `recall` 不再线性。 |
| **常驻 prompt** | `frozenK` / `maxChars` 天花板 | 冻结块永远是个**小而字节稳定**的前缀, 无论盘上多大 —— 这是前缀缓存契约, 故意不随库长。 |

所以三句话: **驱逐管盘、embeddings 管召回、frozenK 管常驻块**。冻结块溢出是**有声**的
(omitted 提示), 不是静默截断; 尾部事实始终经 `recall` 可达。

**仍未做** (本轮不在范围, 诚实列出): `budgetReviewer` 默认仍 opt-in (host 不给 `salience`
选项就不驱逐 → 纯靠手动 `forget`); embeddings 默认仍是 lexical; append-only `episodic`
没有保留窗 (蒸馏成 `semantic` 后旧 episodic 不自动清, 同 `PERSONAL-BUTLER-FINAL.md` 推迟项)。

详见 [`MEMORY-TIERS-FINAL.md`](MEMORY-TIERS-FINAL.md) · [`PERSONAL-BUTLER-FINAL.md`](PERSONAL-BUTLER-FINAL.md) · [`PERSONAL-BUTLER-DESIGN.md`](PERSONAL-BUTLER-DESIGN.md)。
