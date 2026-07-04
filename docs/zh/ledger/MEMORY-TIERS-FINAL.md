# 个人管家记忆 — 多级长期 × 重要性区分 (收口, M1–M5 全完)

> 决策 ③「多级长期记忆架构」× ⑤「重要性区分」, 用户拍板**两者结合** —— 主题分卷
> (topic clusters) × 卷内重要性分级晋升 (digest → profile)。这是把 Personal Butler
> 的记忆从「一摊扁平 episodic + 一份策展 profile」升级成**金字塔**: 按主题分卷, 每卷
> 内按重要性沉淀。作为 `@gotong/personal-memory` 的**加性**能力, 与既有平铺路径并存。
>
> Last updated: 2026-06-29

---

## 一句话

记忆现在分**三层金字塔** × **N 个主题卷**: `episodic` (原始, 未分卷) → 每卷
`digest` (中层, 累积) → 每卷 `profile` (稳定, 一卷一份)。每条事实带 **1–5 重要度**;
晋升时低于闸的被丢弃, 高重要度沉淀进稳定层。成员在 `/me`「管家记得你什么」看得见
一条事实归在**哪个卷**、被评了**多高重要度**。

**零 schema 改**: 卷 id 进 `meta.tier`, 层级进 `meta.level`, 重要度进
`meta.importance` —— `MemoryEntry` 一个字段不动。

---

## 二、北极星对齐(全程守住)

- **框架不跑 LLM**。分卷路由 + 蒸馏是注入的 `MemorySummarizer` 回调 (与 `consolidate`
  同源), `consolidate-tiered.ts` 从不 `import @gotong/llm`。测试用确定性 fake 返
  路由 JSON / profile 文本, 零 key。
- **状态即文件**。卷 / 层 / 重要度全是 per-user jsonl 里 entry 的 `meta`, 复制目录
  = 搬走「分卷大脑」。重启透明。
- **不需要向前兼容, 但默认零回归**。三处默认让既有行为逐字节不变:
  - `importance` 默认 **3** → 排序退化成**纯按新近** → 既有召回/压缩测试不变。
  - `tierConfig` **opt-in** (省略 = 平铺冻结块) → 普通 `MemoryAugmentedAgent` 不变。
  - tiered 与 flat 是**两条互斥策略**, 不叠加: 一个记忆挂一个 reviewer。
- **前缀缓存纪律**。`renderClusteredFrozenBlock` 仍是 entry **集合**的纯字节稳定函数
  (卷按 catalog 定序 / 卷内全序 / 预算按 count+maxChars 确定切分), 同会话稳定 →
  Anthropic/OpenAI 前缀缓存不被打断。

---

## 三、里程碑(M1–M5,逐个 commit)

| M | commit | 内容 |
|---|---|---|
| **M1 ⑤ 重要性地基** | `f32f700` | `importance.ts` — `Importance=1..5`, `META_IMPORTANCE`, `clampImportance`/`importanceOf` (缺省 3), `compareByImportanceThenRecency`; recall/压缩按重要性优先。**默认 3 → 纯新近** = 零回归。 |
| **M2 ③ 分卷模型 + tiered 蒸馏** | `6141973` | `tiers.ts` (词汇: `META_TIER`/`META_LEVEL`/`DEFAULT_TIERS` 画像·项目·人物·承诺·其它 + `tierOf`/`levelOf`/`routeFallback`) + `consolidate-tiered.ts` (`consolidateTiered` 路由 episodic→per-cluster digest, `promoteCluster` 重要性闸 digest→profile, `tieredReviewer` 接 heartbeat); 复用 `distillWithinCap`/`shouldConsolidate`/写前删。 |
| **M3 ③ 冻结块分卷拼 + recall 卷过滤 + review 接线** | `6e774b1` | `renderClusteredFrozenBlock` (按卷分组, 卷内 `compareByImportanceThenRecency`, 预算确定切分) + `MemorySession.tierConfig` + `MemoryAugmentedAgent.tierConfig` 穿线 + `MemoryToolset` recall `tier` 过滤 + 输出行 `kind/tier` 标签; `tieredReviewer` 作为 `reviewer` 接 `MemoryReviewParticipant` 零改。 |
| **M4 /me 视图 + host 接线 + butler 默认分卷** | `b49d528` | host `butler-memory-service` `projectEntry` 投 `tier/level/importance` (经 `tierOf`/`levelOf`/`importanceOf`); web `ButlerMemoryView` +三可选字段 (路由 verbatim echo 自然流通); `PersonalButlerAgent` 构造默认 `tierConfig=DEFAULT_TIERS` (常驻管家开箱即分卷); `/me` SPA 卡片卷/层/重要度徽章 + i18n zh/en。 |
| **M5 e2e + 文档 + 全量测试** | 本提交 | host `personal-butler-tiered-e2e.test.ts` (3 claim 真栈) + 本 FINAL + CLAUDE.md 登记 + `pnpm -r test`。 |

---

## 四、一次 heartbeat tick 的数据流(已落地)

```
成员对话 N 轮
   │ 每轮 turn-end (M2 capture, 无 LLM)
   ▼
episodic 原始记忆 (per-user jsonl)
   │
   │ 心跳一拍 → MemoryReviewParticipant.reviewer = tieredReviewer(...)
   ▼
consolidateTiered                         ← 决策 ③ 路由 + ⑤ 打分
   │  ① pull episodic (留 keepRecent 条不动)
   │  ② 一次 summarize() 调用: 路由整批 → cluster JSON
   │       {"clusters":{"persona":{"digest":"...","importance":5}, ...}}
   │     失败/坏 JSON/抛错 → routeFallback (确定性关键词路由) + routedByFallback 旗标
   │  ③ 每卷写一条 digest (meta.tier + meta.level='digest' + meta.importance)
   │  ④ 写完才 forget 折叠掉的 episodic (crash → 重复不丢)
   ▼
per-cluster digest (中层)
   │
   │ 同一拍, 对每个卷:
   ▼
promoteCluster(tier)                       ← 决策 ⑤ 重要性闸
   │  digest 数 ≥ promoteAfterDigests 才促
   │  importance < minImportance 的 digest → 丢弃 (不折叠)
   │  其余 (+ 旧卷 profile) → distillWithinCap → 一份稳定 profile
   │     (meta.tier + meta.level='profile' + meta.profile=true + meta.importance)
   │  全 trivial 且无旧 profile → 只清 trivial digest, 不合成空 profile
   ▼
per-cluster profile (稳定层, 一卷一份)
   │
   ├─→ /me 隐私视图: HostButlerMemoryService.read/export
   │      projectEntry → { tier, level, importance } → SPA 卡片徽章
   │
   └─→ 下一个 fresh session: MemoryAugmentedAgent.buildRequest
          MemorySession.ensureFrozenBlock → renderClusteredFrozenBlock
          # Long-term memory — <label>
          ## 画像        (catalog 定序)
            [id] (p5) 主人对花生严重过敏。   ← 重要度优先于新近
            [id] (p2) 主人平时爱喝美式咖啡。
          ## 项目
            [id] (p3) 在做一个奶茶店创业项目。
          → 前置进 system prompt (前缀缓存稳定)
```

---

## 五、验收门结果(`personal-butler-tiered-e2e`, 3 claim 全过)

真栈: 真 `Hub` + 真 `PersonalButlerAgent` (默认 `DEFAULT_TIERS`) + 真 `openButlerMemory`
per-user + 真 `tieredReviewer` (心跳job) + 真 `HostButlerMemoryService` (/me 视图);
LLM 是确定性 provider (无 key), 既应答 turn 又当 curator 路由/蒸馏, 并记录 system prompt。

1. **tiered 路由经心跳 + /me 显示卷与重要度** — 活管家捕获三主题 turn → `tieredReviewer`
   把 episodic 折成 per-cluster digest (persona p5 / projects p3 / misc p1) → `/me`
   `export` 每条带 `tier`+`level:'digest'`+`importance`。端到端 ③×⑤, 无单测垫片。
2. **一拍内重要性晋升 + 丢弃 trivial** — 同一心跳拍 (`promoteAfterDigests:1`): persona
   (p5 ≥ 闸) → `level:'profile'` 稳定层; misc (p1 < 闸, 无旧 profile) → digest 被丢弃,
   不合成空 profile → `/me` 视图无 misc 任何层。
3. **fresh session 消费分卷+重要性冻结块** — 全新管家实例 (同 per-user 记忆) 送给模型的
   system prompt: `## 画像`/`## 项目` 按 catalog 定序; 同卷内 p5 事实排在更新的 p2 之前
   (**重要度压过新近**, 活冻结块里); 管家自身 prompt 仍跟在前置块之后。

---

## 六、测试矩阵(全过, 零回归)

| 包 | 套件 | 关注 |
|---|---|---|
| personal-memory | `importance.test.ts` | 1–5 打分 + 缺省 3 + 重要性优先排序 |
| personal-memory | `consolidate-tiered.test.ts` (8) | 路由/折叠/keep-recent + fallback (坏JSON/抛错) + 重要性闸晋升/丢弃/不合成空 + tieredReviewer 一拍 consolidate+promote |
| personal-memory | `clustered-frozen-block.test.ts` (6) | 空标记 / catalog 定序 / 卷内重要性序 / 未分卷→其它无伪段 / 纯函数输入序无关 / 紧预算切分+省略note |
| personal-memory | `toolset.test.ts` (+1) | recall `tier` 过滤 + `kind/tier` 标签 |
| personal-memory | `agent.test.ts` (+1) | `tierConfig` 设了 → 冻结块分卷 (## 画像/## 项目 catalog 序) |
| personal-memory | `review.test.ts` (+1) | `tieredReviewer` 作为 reviewer 接线 |
| host | `butler-memory-service.test.ts` (+1) | `projectEntry` 投 tier/level/importance; 平铺事实无标签, importance 缺省 3 |
| host | `personal-butler-tiered-e2e.test.ts` (3) | 见 §五 |
| web | `me-butler-memory-routes.test.ts` (+1) | 分卷投影过 HTTP 路由 (verbatim echo) |

基线: personal-memory **101** / personal-butler **26** / host butler **21+3** / web me-butler **8**, 全量 `pnpm -r test` 绿。

---

## 七、包 / 文件清单

```
packages/personal-memory/src/
├── importance.ts           ⑤ — Importance/打分/compareByImportanceThenRecency (M1)
├── tiers.ts                ③ — META_TIER/META_LEVEL/DEFAULT_TIERS/tierOf/routeFallback (M2)
├── consolidate-tiered.ts   ③×⑤ — consolidateTiered / promoteCluster / tieredReviewer (M2)
├── frozen-block.ts         + renderClusteredFrozenBlock (M3, flat renderFrozenBlock 不变)
├── session.ts              + tierConfig → 选 clustered/flat 拼装 (M3)
├── agent.ts                + tierConfig 穿线 (M3)
├── toolset.ts              + recall tier 过滤 + kind/tier 标签 (M3)
└── index.ts                + 导出上述

packages/host/src/
└── butler-memory-service.ts  projectEntry 投 tier/level/importance (M4)

packages/host/tests/
└── personal-butler-tiered-e2e.test.ts  3-claim 承重门 (M5)

packages/web/src/me-routes.ts             ButlerMemoryView +tier?/level?/importance? (M4)
packages/web/static/app.js                memTierLabel/memLevelLabel + renderMemCard 徽章 (M4)
packages/web/static/app-core.js           +8 i18n key (zh/en parity) (M4)

packages/personal-butler/src/agent.ts     构造默认 tierConfig=DEFAULT_TIERS (M4)
```

---

## 八、关键设计决策

1. **零 schema** — 卷/层/重要度全进 `meta` (`tier`/`level`/`importance`), 不动
   `MemoryEntry`。同 `meta.profile` 先例, 加性、可逆、不迁移。
2. **三级金字塔, 不是两级** — `episodic`(原始) → `digest`(中层, 累积) → `profile`
   (稳定, 一卷一份)。中层让「最近这阵子这个主题」可读, 又不立刻挤进稳定层。
3. **重要度缺省 3 = 纯新近** — 不打分的库 (含所有既有库) 排序与 M1 前逐字节相同。
   这是「零回归」的支点, 不是巧合。
4. **opt-in 分卷** — `tierConfig` 串 `MemorySession`→`MemoryAugmentedAgent`; 省略 =
   平铺。常驻 `PersonalButlerAgent` 默认 `DEFAULT_TIERS` (开箱即分卷), 普通记忆 agent
   不变。
5. **晋升是重要性闸, 不是搬运** — `promoteCluster`: digest `< minImportance` **丢弃**
   (不折叠进 profile); 全 trivial 且无旧 profile → **不合成空 profile** (省得稳定层被
   垃圾占位)。
6. **防漂移路由** — 路由 LLM 失败/坏 JSON/抛错 → 确定性 `routeFallback` (无 LLM 关键词
   路由) + `routedByFallback` 旗标, 整批永不丢。
7. **写前删** — 所有 digest 写完才 forget episodic; profile 写完才 forget digest。
   crash → 重复 (下一拍幂等吸收), 永不留空档。
8. **/me 投影同源** — `projectEntry` 用与冻结块**同一组** accessor (`tierOf`/`levelOf`/
   `importanceOf`), 故面板显示的卷/层/重要度 = 管家真正归档的那一份, 一棵树一个真相。

---

## 九、显式推迟

- **向量 / 图记忆当默认** — 仍是关键词 fallback + LLM 路由; 可换 `MemoryRetriever`
  后端已在 (M4 旧), 但默认不是向量。
- **per-卷自定义闸** — `minImportance`/`promoteAfterDigests` 目前是 reviewer 级一刀切,
  不是 per-卷。
- **卷 catalog 的 admin/`/me` 编辑 UI** — `DEFAULT_TIERS` 是代码常量; 成员改不了卷的
  定义 (画像/项目/人物/承诺/其它)。
- **跨卷重要性预算** — 冻结块预算按**在场卷数**均分 + 余量结转; 不做「全局按重要度抢
  预算跨卷重排」(那会打破 catalog 定序 → 伤前缀缓存)。
- **fold 进 host main.ts 一等公民** — 同 Personal Butler 收口, 管家 agent 仍 example
  运行时接线; `/me` 隐私视图服务 (含分卷投影) 已接线读同一子树。

---

## 关联文档

- [`docs/zh/ledger/PERSONAL-BUTLER-FINAL.md`](./PERSONAL-BUTLER-FINAL.md) — 常驻管家 M1–M6 收口
  (记忆 + 治理 tool-loop + 被遗忘权); 本文是其记忆层的纵深升级。
- [`docs/zh/PERSONAL-BUTLER-DESIGN.md`](../PERSONAL-BUTLER-DESIGN.md) — 建之前的设计。
- [`docs/zh/ledger/V5-D-FINAL.md`](./V5-D-FINAL.md) — 心跳 / 主动自治 (Stream D); `tieredReviewer`
  接的就是这套心跳。
