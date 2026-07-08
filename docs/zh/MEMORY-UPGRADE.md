# 记忆升级 track(MU)—— 把召回质量与可测性追上前沿

> 北极星第 1 层「我的 AI 桌面」的记忆质量抓手。管家的记忆**骨架已经赌对**
> (file-first + 双时态 + 睡眠期整理 + 会员可见可删 = `/me` 同字节),2026 年中
> 的前沿(Letta MemFS / OpenClaw 无隐藏状态 / Zep 双时态)正在朝这里收敛。
> 差距不在骨架,在**检索质量**(多信号/知识图谱)和**可测性**(零 benchmark)。
> 本 track 补这两块,延续 MR1–4 记忆里程碑。
>
> Last updated: 2026-07-08 · 计划中(M0 本文档;M1 benchmark / M2 融合召回 /
> M3 实体抽取 / M4 外部 provider / M5 git 快照 / capstone 待做)。

---

## 一、为什么(缺口)

管家的记忆引擎([`packages/personal-memory`](../../packages/personal-memory/src))能力已很全:
冻结块、episodic/semantic 分层、6h 分簇蒸馏、双时态、关联链、衰减强化、
dreaming、程序技能。但两处短板在退:

1. **检索质量**——默认召回是**倒排索引的词法扫描**
   ([`inverted-index.ts`](../../packages/personal-memory/src/inverted-index.ts) +
   [中文感知 relevanceScore](../../packages/personal-memory/src/relevance.ts))。
   那个可插的 embedding 检索缝([`embedding-retriever.ts`](../../packages/personal-memory/src/embedding-retriever.ts))
   基本没在生产启用,也没有真正的实体图(只有扁平 semantic + 简单 links)。
   **对弱模型用户这点最疼**:模型越弱,越靠检索把对的事实喂到嘴边。

2. **零 benchmark**——LongMemEval / LoCoMo / BEAM 已是行业通用尺,Gotong 记忆
   一个都没测过。有 [`packages/evals`](../../packages/evals) 却没挂记忆召回门,
   意味着任何「记忆变好了」的说法都无法证伪。

## 二、市场真相(先查市面,2026-07 核)

- **Mem0**(最广,5.1 万星):**单遍抽取**(agent 生成的事实与用户陈述**同权**)
  + **多信号检索**(语义+关键词+实体并行融合成统一分);自报 LongMemEval 94.4 /
  LoCoMo 92.5,~6900 token/查询(全上下文要 ~26k)。
- **Zep / Graphiti**(arxiv 2501.13956):**双时态知识图谱**,事实带有效期窗口 +
  出处 + 本体;独立评测 LongMemEval 领先 15–18.5 个点、延迟 -90%。
- **Letta(MemGPT 后继)**:正迁往 **MemFS** —— 记忆投影成 **git-backed 文件**,
  用 **bash/computer-use 工具**操作,废掉 `core_memory_replace` 专用 API;
  睡眠期整理挪客户端。理由:透明、可组合、git 给历史、灵活。
- **OpenClaw**(2026.3.31):**Task Brain** SQLite 统一任务台账;记忆 = markdown +
  SQLite,**provenance-rich recall**(每条记忆带出处),官方「模型只记住写进盘的,
  没有隐藏状态」。
- **Hermes Agent**(Nous,v0.2.0):agent 自策展 + 周期 nudge,**可插 8 个外部记忆
  provider**(Mem0/Supermemory/ByteRover…)—— 内核薄 + 记忆交给插件生态。

**收敛洞见**:前沿的**骨架**(file-first、双时态、睡眠期整理、无隐藏状态、隐私
可控)正是 Gotong 已有的;它们领先的是**检索**(多信号/图谱)与**可测**(benchmark
纪律)。所以本 track 不重做骨架 —— 只把召回质量与可测性追上,并把差异化(**框架
不跑 LLM** + 会员同字节隐私)守住。

## 三、四条不可破边界(与宪章一致)

1. **框架仍不跑 LLM**。整条链唯一的 LLM 调用仍是 **6h 蒸馏**(M3 是升级它,不新增
   热路径 LLM);M2 融合里的 embedding 走**注入/本地确定性**、keyword 与实体是纯
   函数。捕获(每轮)永远零模型。

2. **opt-in 默认字节不变**。新检索器/新抽取器/外部 provider 全是**可选注入或可选
   连接器**;不启用 = 与今天逐字节一致。尽量**零新 env 旋钮**(仍 106);确需登记
   的走 GUARD 注册表。

3. **数据边界**。M4 外部 provider **数据离盒**必须 opt-in + **凭证进 vault** + 面板
   **显式告知「记忆离开本机」**;框架自身绝不存第二份(「全走 MCP 不存数据」同源)。
   接入≠授权:挂上外部记忆能读写 ≠ 替你把私密记忆同步出去,得成员点头。

4. **管家层优先,内核零改动**。全部落在 `packages/personal-memory`(叶子纯核,零
   host/identity 依赖)+ host 装配;**core / workflow / protocol 一行不动**——同 TN。

## 四、设计(每项落哪条既有缝)

```
检索缝    MemoryRetriever.retrieve(query)  —— 只挂 recall 路径,冻结块不可插
          (retriever.ts:30)。M2 的 fusedRetriever、M4 的外部 provider 都从这里注入,
          经 host factory 的 memoryRetriever 换进管家(factory.ts:369)。
Embed     embeddingRetriever({ embed: Embedder })  —— Embedder=(texts)=>number[][],
          注入式;M2 默认本地确定性 embed,可换 provider。
蒸馏缝    tieredReviewer(6h 维护里那次唯一 LLM 调用)—— M3 升级/并列成原子事实抽取。
量尺      packages/evals + scripts/*.mjs 承重门(镜像 check:first-result)—— M1 挂
          check:memory-recall,确定性 mock provider,零 key。
落盘缝    <rootDir>/user/<userId>/ jsonl 树 —— M5 在 6h 维护里做周期 git 快照(轻量,
          非每写即 commit),per-user 隔离、缺 git 优雅降级。
```

## 五、五项 → 里程碑(一一映射)

| 里程碑 | 对应建议 | 交付 | 状态 |
|---|---|---|---|
| **MU-M0** | —— | 本计划文档 + 侦察(三缝确认) | 计划 |
| **MU-M1** | ② benchmark | `packages/evals` 记忆召回小集 + `pnpm check:memory-recall`,钉住今天 keyword 基线分 | 计划 |
| **MU-M2** | ① 多信号融合 | `fusedRetriever`(keyword ⊕ semantic ⊕ 词法实体,RRF 融合)+ factory 接线;M1 分数抬升 | 计划 |
| **MU-M3** | ④ 实体抽取 | 6h 蒸馏升级原子事实抽取(单遍法,agent=用户同权)+ 去重 reconcile;M1 分数再抬 | 计划 |
| **MU-M4** | ⑤ 外部 provider | opt-in Mem0-as-backend 走 retriever 缝 + MCP + 连接器目录;凭证 vault + 离盒告知(Zep 按需再加) | 计划 |
| **MU-M5** | ③ git 背书 | 6h 维护里记忆树周期 git 快照(**轻量**,用户拍板 A=a);审计历史零热路径成本 | 计划 |
| **MU-capstone** | —— | `examples/memory-upgrade`:同组事实纯 keyword vs 融合+抽取,recall@k 明显变好;self-assert exit 0 + 文档收尾 | 计划 |

**排序纪律**:benchmark(M1)**先做**——「先量后改」,M2/M3 每步拿 M1 分数证伪抬升;
强协同项(M1→M2→M3)在前,较新面(M4 外部、M5 git)在后,capstone 收口。

## 六、里程碑记录

(逐里程碑收口时填。)

## 七、相关文档

| 想知道什么 | 读哪 |
|---|---|
| 管家记忆机制现状(冻结块/捕获/6h 蒸馏/召回) | [ledger/MEMORY-TIERS-FINAL.md](ledger/MEMORY-TIERS-FINAL.md) · [ledger/MEMORY-ADVANCED-FINAL.md](ledger/MEMORY-ADVANCED-FINAL.md) |
| dreaming / 技能自创 / 6h 维护 | [ledger/MEMORY-DREAMING-SKILLS-FINAL.md](ledger/MEMORY-DREAMING-SKILLS-FINAL.md) |
| 语义召回缝(本地 embed / chroma-mcp,注入式) | [../../examples/butler-vector-recall](../../examples/butler-vector-recall) · [KB-CONNECTORS.md](KB-CONNECTORS.md) |
| 连接器目录纪律(M4 参照:全走 MCP 不存数据 / 凭证 vault / 接入≠授权) | [REAL-LIFE-CONNECTORS.md](REAL-LIFE-CONNECTORS.md) |
| 承重门体例(M1 参照) | [CONVENTIONS.md](CONVENTIONS.md) |
