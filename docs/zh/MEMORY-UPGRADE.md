# 记忆升级 track(MU)—— 把召回质量与可测性追上前沿

> 北极星第 1 层「我的 AI 桌面」的记忆质量抓手。管家的记忆**骨架已经赌对**
> (file-first + 双时态 + 睡眠期整理 + 会员可见可删 = `/me` 同字节),2026 年中
> 的前沿(Letta MemFS / OpenClaw 无隐藏状态 / Zep 双时态)正在朝这里收敛。
> 差距不在骨架,在**检索质量**(多信号/知识图谱)和**可测性**(零 benchmark)。
> 本 track 补这两块,延续 MR1–4 记忆里程碑。
>
> Last updated: 2026-07-08 · M0–M3 完(M1 立尺 benchmark 承重门;M2 融合召回把
> MRR 从 0.548 抬到 0.738、已成管家默认 recall,零新旋钮;M3 原子事实抽取把 semantic
> 类 recall 从 0 抬到 100%、已并进 6h 蒸馏,零新旋钮);M4 外部 provider / M5 git
> 快照 / capstone 待做。

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

1. **框架仍不跑 LLM**。所有 LLM 调用仍只在 **6h 后台维护**里发生;M3 后那一趟维护
   做**两次**模型调用(既有 tieredReviewer 分簇蒸馏 + 新增 atomicFactsReviewer 原子事实
   抽取,`composeReviewers` best-effort 串联),但**都是 6h 背景、每轮热路径仍零 LLM**。
   M2 融合里的 embedding 走**注入/本地确定性**、keyword 是纯函数。捕获(每轮)永远零模型。

2. **字节不变 binds 冻结块 + 有门槛项**(M2 拍板细化)。「不启用=逐字节一致」的硬
   保证锁两处:①**冻结块**永远字节稳定(prompt-cache 前缀契约,融合只骑 recall 路径
   绝不碰它);②**有门槛的项**(M4 真 embedder=网络/key、外部 provider=数据离盒)保持
   **opt-in**,注入才生效。但**零门槛的本地重排**(M2 的 fusedRetriever + 本地确定性
   embedder:无网络/key/依赖/数据移动)按**用户法则「有门槛才可选」+ MR1 先例**(倒排
   索引当年也是直接换成管家默认、没设旋钮)**作为管家默认发**——弱模型用户自动受益,
   无需配置。retriever 原语的**默认仍是 keyword**(直接调用者/既有测试逐字节不变),
   是**管家装配层**显式开融合。**零新 env 旋钮(仍 106)**;embedder 注入缝就是 M4 的
   opt-in 入口。

3. **数据边界**。M4 外部 provider **数据离盒**必须 opt-in + **凭证进 vault** + 面板
   **显式告知「记忆离开本机」**;框架自身绝不存第二份(「全走 MCP 不存数据」同源)。
   接入≠授权:挂上外部记忆能读写 ≠ 替你把私密记忆同步出去,得成员点头。

4. **管家层优先,内核零改动**。全部落在 `packages/personal-memory`(叶子纯核,零
   host/identity 依赖)+ host 装配;**core / workflow / protocol 一行不动**——同 TN。

## 四、设计(每项落哪条既有缝)

```
检索缝    MemoryRetriever.retrieve(query)  —— 只挂 recall 路径,冻结块不可插
          (retriever.ts:30)。M2 的 fusedRetriever、M4 的外部 provider 都从这里注入,
          经 host butler-recall-index 的 fusion 配置换进管家(factory.ts 开 fusion:{})。
          ✅ M2:fusedRetriever(倒排 keyword ⊕ 本地 TF cosine,relative-score 融合)已成
          管家默认。
Embed     Embedder=(texts)=>number[][],注入式 —— M2 默认 localBigramEmbedder(纯 TF,
          零依赖零网络);M4 把它换成真 embedding provider,同一 fusedRetriever 即获
          真语义桥接。
蒸馏缝    tieredReviewer(6h 维护里的分簇蒸馏)—— M3 **并列**一个 atomicFactsReviewer
          原子事实抽取(单遍法,Mem0 式),经 composeReviewers 串进同一趟维护。
          ✅ M3:抽取「用户最爱的饮料是珍珠奶茶」这类**含类别词+具体词**的自足事实,
          semantic 类 recall 0→100%(不改检索器,改的是库里有什么给检索器找)。
量尺      packages/personal-memory 召回 benchmark(纯 harness,零 key)—— M1 挂
          check:memory-recall(vitest 门,镜像 check:templates)。注意不进
          packages/evals:evals 是「结构合规」检查器(自述 Not a benchmark suite
          for accuracy),尺子该跟检索器同包,retriever 在这里,benchmark 就在这里。
落盘缝    <rootDir>/user/<userId>/ jsonl 树 —— M5 在 6h 维护里做周期 git 快照(轻量,
          非每写即 commit),per-user 隔离、缺 git 优雅降级。
```

## 五、五项 → 里程碑(一一映射)

| 里程碑 | 对应建议 | 交付 | 状态 |
|---|---|---|---|
| **MU-M0** | —— | 本计划文档 + 侦察(三缝确认) | 计划 |
| **MU-M1** | ② benchmark | `packages/personal-memory` 召回 benchmark(纯 harness + 14 例双语 fixture)+ `pnpm check:memory-recall`,钉住 keyword 基线 recall@5=78.6% / MRR=0.548(棘轮地板只升不降) | **完** |
| **MU-M2** | ① 多信号融合 | `fusedRetriever`(keyword ⊕ 本地 TF cosine,relative-score 融合)+ 本地确定性 embedder + factory 接线成默认;MRR 0.548→0.738(cross-session 0.333→1.0),recall 不变、semantic 仍 0(本地天花板) | **完** |
| **MU-M3** | ④ 实体抽取 | 6h 蒸馏并列 `atomicFactsReviewer`(单遍法,含类别词+具体词的自足事实)+ relevanceScore 去重(跨 pass + pass 内);semantic 类 recall@5 0→100% | **完** |
| **MU-M4** | ⑤ 外部 provider | opt-in Mem0-as-backend 走 retriever 缝 + MCP + 连接器目录;凭证 vault + 离盒告知(Zep 按需再加) | 计划 |
| **MU-M5** | ③ git 背书 | 6h 维护里记忆树周期 git 快照(**轻量**,用户拍板 A=a);审计历史零热路径成本 | 计划 |
| **MU-capstone** | —— | `examples/memory-upgrade`:同组事实纯 keyword vs 融合+抽取,recall@k 明显变好;self-assert exit 0 + 文档收尾 | 计划 |

**排序纪律**:benchmark(M1)**先做**——「先量后改」,M2/M3 每步拿 M1 分数证伪抬升;
强协同项(M1→M2→M3)在前,较新面(M4 外部、M5 git)在后,capstone 收口。

## 六、里程碑记录

### MU-M1 —— 召回 benchmark 承重门(先量后改的尺子)

**为什么先做**:排序纪律「先量后改」。M2/M3/M4 都声称「召回变好」,但没有尺子 =
无法证伪。M1 先把尺子立起来,后面每步拿同一把尺量抬升。

**落哪**:**不进 `packages/evals`** —— 侦察时读了它,自述 "Not a benchmark suite
for accuracy, we measure structural compliance",它只查工作流/prompt 的结构合规。
尺子该跟被测对象同包:检索器(`invertedIndexRetriever` 等)在 `packages/personal-memory`,
benchmark 就在这里,能直接复用真实检索器、零跨包耦合。

**交付**:
- **`src/benchmark.ts`** —— 纯 harness,零 LLM 零 key:`scoreRetriever(make, cases, k)`
  对每例「用 corpus 建检索器 → 跑 query → 对金标算 recall@k + 倒数排名」,聚合出
  `recall@k / MRR / 命中率 / 逐类`。关键设计:入参是**检索器工厂**(corpus→retriever),
  M2 拿同一批 case 跑融合检索器,抬升当场可证。`formatBenchResult` 出逐类中文记分卡。
- **`tests/fixtures/recall-cases.ts`** —— 14 例双语 LongMemEval/LoCoMo 风格 fixture,
  时间戳全常量(无 `Date.now`,分数逐字节稳定),五类各压一种失败模式:
  `direct`(词法直命中,钉 recall@5=MRR=1 防融合改动误伤易题)、`cross-session`
  (金标**又老又聚焦**——反复提 query 词,新干扰只顺带提一次;keyword 覆盖度是粗二值
  → 平票落到 recency → 聚焦金标被埋到第 4 名,recall@5 仍 1 = **纯排名空间**留给 M2 的
  TF cosine 臂)、`temporal`(旧事实被 supersede,`activeOnly` 必须剔除,金标=当前事实)、
  `multi-hop`(两条金标)、**`semantic`**(query 与金标**零共享词**:「饮料」vs「珍珠奶茶」、
  "electric vehicle" vs "Tesla Model 3",且放**够多含 query 词的诱饵**把 top-k 占满 → 金标
  被挤出 → keyword 与字符 embedder 都 recall 0,只有 M3/M4 能救)。
- **`tests/memory-recall-bench.test.ts`** —— 承重门,跑**生产默认检索器**
  (`invertedIndexRetriever` + `activeOnly`,与管家 factory 接线一致),锁地板。

**测得的 keyword 基线(k=5)**:

```
recall@5=78.6%  MRR=0.548  命中率=78.6%
  · direct         recall@5=100%   MRR=1.000  (3 例)
  · cross-session  recall@5=100%   MRR=0.333  (4 例) ← 聚焦金标被 recency 埋到第 4,纯排名空间
  · temporal       recall@5=100%   MRR=1.000  (2 例) ← activeOnly 剔除旧事实生效
  · multi-hop      recall@5=100%   MRR=0.667  (2 例)
  · semantic       recall@5=0.0%   MRR=0.000  (3 例) ← 真同义词,keyword 天生做不到
```

**这把尺子诚实在哪**:`semantic` 类 **recall 恒 0 是设计出来的**,不是 bug —— 字符
重叠信号(连 M2 本地 embedder 都算)**无法桥接真同义词**。这正是后续里程碑各自要吃
的空间:**M2**(多信号融合)吃 `cross-session` 的 **MRR**(term-frequency cosine 这个不同
偏置的信号把聚焦金标从第 4 名提到第 1;recall@5 不变——本地信号扩不了召回,只重排);
**M3**(蒸馏出「饮料=珍珠奶茶」这类含类别词+具体词的桥接事实)让 `semantic` 类 query 命中
蒸馏出的原子事实;**M4**(真 embedding provider)不靠蒸馏直接跨语义。测试**显式断言
`semantic.recallAtK === 0`**,把缺口钉成实测事实而非脚注。

**棘轮方向**(镜像 line-budget-gate,反号):line-budget 锁天花板只降;准确率锁**地板
只升**。地板常量 `{recallAtK:0.785, mrr:0.547, hitRate:0.785}`,M2/M3/M4 每步必须跑同
fixture 并**抬高**这些常量来证明抬升;退化即红。**绝不为过门下调地板**。MRR 地板故意压
得低(cross-session keyword MRR 只有 0.333),正是留给 M2 的排名空间。

**验收**:personal-memory typecheck 干净 / 380 单测全绿(+4)/ build 干净;四门 PASS
(`check:guards`:kernel-deps 6 不变式、env-registry **106 旋钮不变**、line-budget
main.ts 2990/2990 不动)+ 新 `pnpm check:memory-recall` 绿。零新 env 旋钮、内核零改动
(benchmark 是 personal-memory 叶子内纯函数,只 import services-sdk 类型 + `./retriever`
类型)。

### MU-M2 —— 多信号融合召回(把对的事实排到最前)

**缺口**:默认召回只有**一个信号**——query-coverage(`relevanceScore`,每个词二值)。
凡包含 query 词的候选**全并列在顶**,平票落到 importance-then-recency → 一个**真正
在讲**这件事的旧事实,排名输给一句**顺带提一嘴**的新记录。recall@k 没事(都在页里),
但**模型第一眼看到的顺序错了**。对弱模型,「第一条就是对的」才是关键。

**做法**:**relative-score 融合**两条互补臂——
- **keyword 臂**:`relevanceScore` over 倒排全库候选(覆盖度,够到旧事实)。
- **semantic 臂**:cosine over 注入 `Embedder`。默认是零依赖 `localBigramEmbedder`
  (批内构词表的 L2 归一化 TF 向量,连续、聚焦感知的**词法**信号,打破 keyword 臂的
  平票);M4 注入真 provider,**同一 retriever** 即获真同义词桥接。

**为什么不是 RRF**:RRF 融合的是**排名位次**,适合分数尺度不可比的臂(BM25 vs cosine)。
但我们 keyword 臂**平票成堆**(覆盖度粗),RRF 里「平票 vs 反序臂」相互抵消成一锅粥
(位次 (1,3)(2,2)(3,1) 之和全相等)。relative-score 融合(每臂 min-max 归一后加权和)让
**不区分的臂(全平→零区间)自动退场**、由能区分的臂裁决——正是我们要的平票打破
(Weaviate 的 `relativeScoreFusion` 同理同选)。

**边界守住**:只骑 recall 缝(冻结块字节不变);默认路径零 LLM 零网络(本地 embedder
纯数学);**fail-soft**——注入的 embedder 抛错/返回坏形状,降级到纯 keyword 排名绝不
中断本轮(镜像 `embeddingRetriever`);本地 embedder 下,零共享词候选 cosine 0 且覆盖 0 →
被丢 → **recall 与 keyword 逐条一致(融合只重排)**,只有真 embedder 才扩召回到同义词——
这就是本地天花板,M3/M4 抬。

**接线**(拍板:**作为管家默认发,零新旋钮**——见边界 2 细化):leaf `fusedRetriever`
+ `localBigramEmbedder`;host `butler-recall-index.ts` 的 `FileBackedInvertedIndex` 加可选
`fusion` 配置(**给了才开融合,不给=keyword 逐字节不变**——直接调用者/既有 10 个
recall-index 测试全不受影响),`openButlerRecallIndex({ fusion })` 透传;**管家 factory**
开 `fusion: {}`(本地默认 embedder)。embedder 注入缝 = M4 的 opt-in 入口。

**测得抬升(同 M1 fixture,k=5)**:

```
keyword 基线  recall@5=78.6%  MRR=0.548   (cross-session MRR 0.333)
fused 生产    recall@5=78.6%  MRR=0.738   (cross-session MRR 1.000)  ← 4 个聚焦金标全提到第 1
```

recall 不变(本地信号扩不了召回)、MRR **+0.19**、semantic 类仍 0(诚实天花板)。**抬升是
测试不是散文**:门里显式断言 `fused.mrr > keyword.mrr`(严格)+ `fused.recall ≥
keyword.recall`(不倒退)+ `cross-session` 类 MRR 严格变大;semantic 类对**keyword 与
fused 都**断言 recall===0(字符信号桥不了同义词,钉成实测)。另有注入 toy 同义词
embedder 的单测证明 **M4 缝**能桥接(饮料↔奶茶映同轴 → 金标浮现)。

**验收**:personal-memory 393 单测全绿(+13:6 fusion + 6 embedder + 1 门)/typecheck/build
干净;host 1919 全绿(factory + recall-index 改动零 ripple)/typecheck/build 干净;四门
PASS(`check:guards`:**旋钮仍 106**、line-budget main.ts 2990/2990 不动——融合落在非预算
文件)+ `check:memory-recall` 锁 fused 地板 {recall@5≥0.785, MRR≥0.737}。内核零改动。

### MU-M3 —— 原子事实抽取(把检索器够不到的同义词,蒸馏成够得到的事实)

**缺口**:M1 的 `semantic` 类 **recall 恒 0**,M2 也抬不动——keyword 与本地字符
embedder(哪怕融合)**都桥不了真同义词**:query 「饮料」和答案 「珍珠奶茶」**零共享字**,
没有任何词法/字符信号能把它俩连起来。这不是检索器不够聪明,是**库里根本没有一条同时
带「饮料」和「珍珠奶茶」的记忆**。

**做法(Mem0 式单遍抽取,改的是「库里有什么」不是「检索器多聪明」)**:6h 维护里
**并列**一个 `atomicFactsReviewer`,从最近 episodic 抽出**自足事实**——每条**同时带类别词
和具体值**:「用户最爱的饮料是珍珠奶茶」而不是「珍珠奶茶」。这样类别 query 「饮料」直接
命中这条桥接事实,答案(珍珠奶茶)就在事实文本里被顺带召回。这正是 Mem0 的洞见:抽成
**能独立召回**的原子事实。

**关键设计**:
- **6h 背景、每轮零 LLM**。抽取是个 `MemoryReviewer`,复用注入的 `MemorySummarizer` 缝
  (叶子永不 import LLM,跟 `consolidate`/`tieredReviewer` 同姿态)。M3 后那趟维护做**两次**
  模型调用(分簇蒸馏 + 事实抽取,`composeReviewers` best-effort 串联),**但都是背景**——
  热路径捕获仍纯抽取零模型(边界 1 细化:2 次调用都在 6h 里)。
- **自足形状是 benchmark 检查的属性**。prompt 强制「类别词+具体值」——坏例子「珍珠奶茶」
  (缺类别,单独召回不知在讲什么)被规则明令排除。这个形状就是后续类别 query 的重叠面。
- **去重不花第二次模型调用**。新事实用 `relevanceScore`(词法覆盖度≥0.8)对**已存 semantic**
  查重(稳定事实不每 6h 重写一遍)+ 对**本 pass 已接受的**查重(模型吐重复行也只落一条);
  写入打 `meta.atomicFact` 出处标记(OpenClaw「召回知道记忆从哪来」)。
- **agent 说的与用户说的同权**(Mem0 单遍法:transcript 是源,谁说的都抽)。
- **安静**:episodic 不够 trigger(默认 4)、或模型抽不出东西 → 返回 idle 不打扰 heartbeat;
  parseFacts 纯函数剥项目符号/编号、丢空行与超 200 字的段落、封顶每 pass 12 条防跑飞。

**接线**:leaf `atomicFactsReviewer`;host `personal-butler-maintenance.ts` 的
`buildButlerMaintenanceReviewer` 内层从 `tieredReviewer({...})` 改成
`composeReviewers(tieredReviewer({...}), atomicFactsReviewer({ summarize }))`——同一趟 6h
维护、同一个注入 summarizer。**零新旋钮、零 host 装配层行数**(改的是既有 reviewer 组合)。

**测得抬升(蒸馏承重门,确定性无 LLM)**:

```
semantic 类 recall@5:  0%  →  100%   (饮料→珍珠奶茶 / 宠物→大黄 / electric vehicle→Tesla)
```

`tests/memory-consolidation.test.ts` 端到端量这个抬升:同一批 synonym query **蒸馏前
recall 0**(只有 raw episodic + 类别词诱饵,query 够不到具体答案),跑一次
`atomicFactsReviewer`(固定 summarizer,零 LLM)写入 3 条桥接事实后,**同批 query recall 1**。
这是纯检索 bench 的诚实补充——**M3 不改检索器**(bench 的 keyword/fused 地板一字不动),
改的是**库里有什么给检索器找**。

**验收**:personal-memory 400 单测全绿(+7:6 atomic-facts + 1 蒸馏门)/typecheck/build
干净;host 1919 全绿(6h 维护 composeReviewers 改动,11 个 maintenance/consolidate e2e 测试
全过)/typecheck 干净;四门 PASS(`check:guards`:**旋钮仍 106**、line-budget 三热文件不动)+
`check:memory-recall` 现同时跑 bench 地板 + 蒸馏抬升门。内核(core/workflow/protocol)零改动。

## 七、相关文档

| 想知道什么 | 读哪 |
|---|---|
| 管家记忆机制现状(冻结块/捕获/6h 蒸馏/召回) | [ledger/MEMORY-TIERS-FINAL.md](ledger/MEMORY-TIERS-FINAL.md) · [ledger/MEMORY-ADVANCED-FINAL.md](ledger/MEMORY-ADVANCED-FINAL.md) |
| dreaming / 技能自创 / 6h 维护 | [ledger/MEMORY-DREAMING-SKILLS-FINAL.md](ledger/MEMORY-DREAMING-SKILLS-FINAL.md) |
| 语义召回缝(本地 embed / chroma-mcp,注入式) | [../../examples/butler-vector-recall](../../examples/butler-vector-recall) · [KB-CONNECTORS.md](KB-CONNECTORS.md) |
| 连接器目录纪律(M4 参照:全走 MCP 不存数据 / 凭证 vault / 接入≠授权) | [REAL-LIFE-CONNECTORS.md](REAL-LIFE-CONNECTORS.md) |
| 承重门体例(M1 参照) | [CONVENTIONS.md](CONVENTIONS.md) |
