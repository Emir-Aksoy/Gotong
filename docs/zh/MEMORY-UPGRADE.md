# 记忆升级 track(MU)—— 把召回质量与可测性追上前沿

> 北极星第 1 层「我的 AI 桌面」的记忆质量抓手。管家的记忆**骨架已经赌对**
> (file-first + 双时态 + 睡眠期整理 + 会员可见可删 = `/me` 同字节),2026 年中
> 的前沿(Letta MemFS / OpenClaw 无隐藏状态 / Zep 双时态)正在朝这里收敛。
> 差距不在骨架,在**检索质量**(多信号/知识图谱)和**可测性**(零 benchmark)。
> 本 track 补这两块,延续 MR1–4 记忆里程碑。
>
> Last updated: 2026-07-08 · **MU track 全完(M0–M5 + capstone)**。M1 立尺 benchmark
> 承重门;M2 融合召回把 MRR 从 0.548 抬到 0.738、已成管家默认 recall,零新旋钮;M3 原子
> 事实抽取把 semantic 类 recall 从 0 抬到 100%、已并进 6h 蒸馏,零新旋钮;M4 外部记忆
> provider = Mem0 托管云连接器 + `dataLeavesBox` 数据离盒披露原语,opt-in 未装字节不变、仍
> 106 旋钮;M5 记忆树 git 快照,6h 维护里 per-user `git commit`、best-effort、缺 git 优雅
> 降级,**opt-in `GOTONG_BUTLER_MEMORY_GIT` = MU track 首个新旋钮 106→107**、未开字节不变;
> **capstone `examples/memory-upgrade`**:真 MU 代码零重写,两幕(M2 重排 MRR 0.583→1.0 + M3
> 补召回 0→100%)用 M1 尺子量出累积升级,`pnpm demo:memory-upgrade` exit 0、零 key。

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
   opt-in 入口。**M5 的 git 快照是本 track 唯一带门槛的项**——它在磁盘上造 `.git`(可能
   嵌在另一个仓库里、或部署方压根不想要),正落「有门槛才 opt-in」这条:故 M5 是 MU
   track **首个也是唯一一个新旋钮**(`GOTONG_BUTLER_MEMORY_GIT`,106→107),未开逐字节不变。

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
          零依赖零网络);把它换成真 embedding provider,同一 fusedRetriever 即获真语义
          桥接。这条缝 M2 已开、host 注入即用;**M4 定夺走连接器目录路径**(见下),真
          embedder 首类 adapter **显式推迟**(缝在,按需落)。
外部缝    连接器目录(builtin-mcp-connectors)—— ✅ M4:Mem0 托管云 MCP 进目录 + 新
          dataLeavesBox 数据离盒披露原语;opt-in 装上给管家 mem0__ 工具(recall 时可取云
          记忆),全走 MCP 不存第二份、凭证 header 占位不入库、接入≠授权。
蒸馏缝    tieredReviewer(6h 维护里的分簇蒸馏)—— M3 **并列**一个 atomicFactsReviewer
          原子事实抽取(单遍法,Mem0 式),经 composeReviewers 串进同一趟维护。
          ✅ M3:抽取「用户最爱的饮料是珍珠奶茶」这类**含类别词+具体词**的自足事实,
          semantic 类 recall 0→100%(不改检索器,改的是库里有什么给检索器找)。
量尺      packages/personal-memory 召回 benchmark(纯 harness,零 key)—— M1 挂
          check:memory-recall(vitest 门,镜像 check:templates)。注意不进
          packages/evals:evals 是「结构合规」检查器(自述 Not a benchmark suite
          for accuracy),尺子该跟检索器同包,retriever 在这里,benchmark 就在这里。
落盘缝    <rootDir>/user/<userId>/ jsonl 树 —— ✅ M5:6h 维护里做周期 git 快照(轻量,
          非每写即 commit,status 无变化即 no-op),per-user `.git` 隔离、缺 git/init 失败
          优雅降级(never throws),opt-in `GOTONG_BUTLER_MEMORY_GIT`。
```

## 五、五项 → 里程碑(一一映射)

| 里程碑 | 对应建议 | 交付 | 状态 |
|---|---|---|---|
| **MU-M0** | —— | 本计划文档 + 侦察(三缝确认) | 计划 |
| **MU-M1** | ② benchmark | `packages/personal-memory` 召回 benchmark(纯 harness + 14 例双语 fixture)+ `pnpm check:memory-recall`,钉住 keyword 基线 recall@5=78.6% / MRR=0.548(棘轮地板只升不降) | **完** |
| **MU-M2** | ① 多信号融合 | `fusedRetriever`(keyword ⊕ 本地 TF cosine,relative-score 融合)+ 本地确定性 embedder + factory 接线成默认;MRR 0.548→0.738(cross-session 0.333→1.0),recall 不变、semantic 仍 0(本地天花板) | **完** |
| **MU-M3** | ④ 实体抽取 | 6h 蒸馏并列 `atomicFactsReviewer`(单遍法,含类别词+具体词的自足事实)+ relevanceScore 去重(跨 pass + pass 内);semantic 类 recall@5 0→100% | **完** |
| **MU-M4** | ⑤ 外部 provider | opt-in Mem0 托管云连接器进目录(官方远程 HTTP + Bearer)+ 新 `dataLeavesBox` 数据离盒披露原语(面板无条件印「记忆离开本机」);凭证 `${MEM0_API_KEY}` 进 header 不入库、全走 MCP 不存第二份、接入≠授权 | **完** |
| **MU-M5** | ③ git 背书 | 6h 维护里记忆树周期 git 快照(**轻量**,用户拍板 A=a):per-user `.git`、status 无变化即 no-op、best-effort never-throws、缺 git 优雅降级;opt-in `GOTONG_BUTLER_MEMORY_GIT`(106→107,MU 唯一新旋钮),审计历史零热路径成本 | **完** |
| **MU-capstone** | —— | `examples/memory-upgrade`:真 MU 代码零重写,两幕用 M1 尺子量累积升级——Act 1 keyword vs fused(MRR 0.583→1.0)、Act 2 真 atomicFactsReviewer 抽取前后(answer-recall 0→100%);self-assert exit 0、零 key | **完** |

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

### MU-M4 —— 外部记忆 provider 连接器(Mem0)+ 数据离盒披露原语

**先查市面(改路线的市场真相)**:动工前核 Mem0 的真实 MCP 面。官方文档给的答案与
**C-M2 抓到的完全同源** —— **现代连接器已整体迁到「托管远程 HTTP + 令牌」**:Mem0 官方
MCP = 托管端点 `https://mcp.mem0.ai/mcp`(`transport: 'http'` + Bearer `MEM0_API_KEY`),
本地 **静态 stdio 版随 OpenMemory 一起退场**。好消息:出站 http MCP + `${TOKEN}` header
管道 C 轮早通(`McpHttpServerSpec.headers` 值支持 `${ENV}` spawn 时展开,文档原例就是
`{ Authorization: 'Bearer ${MCP_PAT}' }`),故 Mem0 是一条**干净可表达**的 http 连接器 spec。

**设计岔口与定夺**:计划 §5 写「Mem0-as-backend 走 retriever 缝」、§4 设计又提「真 embedding
provider 走 Embed 缝」——两条 opt-in 注入缝都是 M2 已建好的入口,但它们是**两种不同的
M4**。定夺走**连接器目录路径**,理由三条:①边界 3 的**「全走 MCP 不存数据」**是最具体的
承重约束,**只有连接器路径**干净满足(embedder-API 路径仍本地存一份,只把文本发出去算
向量;retriever-backend 全量搬盘又要写同步 + 违 file-first);②计划**排序纪律**明写 M4/M5 是
**「较新面」不属 M1→M3 benchmark-lift 链**,故 M4 不必动 M1 分数,是「新 opt-in 能力」而非
「实测抬升」;③连接器路径**整包复用 C-M1 机器**(目录 + 校验 + admin 面板循环),最轻。
**显式推迟**(seam 已开,按需再落):真 embedding provider 走 M2 的 `embed` 缝(host 注入即
获真同义词桥接,首类 adapter 推迟)、外部 provider 当管家**主 MemoryRetriever backend**自动
注入 recall(要写同步 + 全量离盒,和「接入≠授权」张力大,推迟)。

**交付(纯 web 常量 + 面板 + 防腐测试,内核零改动)**:
- **`builtin-mcp-connectors.ts`**:新 `memory` 分类 + **`mem0-memory`** 连接器(http 托管、
  `Authorization: 'Bearer ${MEM0_API_KEY}'`、逐字核过官方端点不硬编造)。
- **`dataLeavesBox` 披露原语**(边界 3 mandate「面板显式告知」的一等公民):`BuiltinMcpConnector`
  新布尔字段 = 「用它你的内容离开本机发往第三方云」。面板对 `true` 的卡**无条件**印醒目
  「数据离开本机」行(`t.mcpDirLeavesBox` 双语 + 自带红框样式),**披露是绑在 flag 上的结构
  保证,不靠每条 caveat 自觉**。**诚实覆盖**:凡把用户数据搬去云的都标 —— `mem0-memory`(记忆)
  **+ `notion-notes` + `todoist-tasks`**(C-M1 的云 SaaS,顺手补标,免得「Notion 无警示」被
  误读成「不离盒」);本地进程(chroma / filesystem / obsidian 本地 REST)不标。
- 目录路由/一键装/admin 面板**零改动**:catalog 路由整条 `BUILTIN_MCP_CONNECTORS` 序列化
  (新字段自动过线到前端),面板 `admin-src/mcp.js` 通用循环渲染,新卡 + 披露自动出。

**三条边界守住**:①**全走 MCP 框架不存第二份**——Mem0 云持有记忆,Gotong 不存副本
(搬走 `.gotong/` 无 Mem0 数据尾巴);②**凭证纪律**——`${MEM0_API_KEY}` 只作 header 占位、
spawn 时对 host 环境(vault 背书)展开,明文绝不进目录 / `mcp-servers.json` / UI 表单;
③**接入≠授权**——装上连接器 = 管家「能」读写云记忆,真把私密内容同步出去仍是管家的
governed 动作、得成员点头(「发现≠信任」在记忆域的延伸)。**opt-in 未装 = 逐字节不变**
(目录多一张浏览卡,零运行时行为);**`MEM0_API_KEY` 是用户连接器凭证不是 `GOTONG_*`
旋钮,仍 106**。

**防腐测试硬化(会红的门)**:`EXPECTED_IDS` 加 `mem0-memory`(增删即 diff);凭证占位检查
**transport 无关化**——从只查 `spec.env` 扩到同时查 `headers`(mem0 的 `Bearer ${MEM0_API_KEY}`
是 header 里的嵌入占位,`env`-only 的旧断言会漏);`dataLeavesBox` 标记集 `['notion-notes',
'todoist-tasks','mem0-memory']` 钉死(honest-coverage 增删即红);mem0 连接器专项断言
(http + 端点 URL + `Bearer ${MEM0_API_KEY}` header);catalog 路由断言 `dataLeavesBox` 过线到
前端(边界 3 披露 round-trip)。

**验收**:web 1321 单测全绿(connector 防腐 + mcp-route catalog 扩例)/typecheck 干净;
`build:assets` 重打 admin bundle + 重嵌 static-assets(解码核对 `mcpDirLeavesBox` 双语 +
memory 类标签已进包);四门 PASS(`check:guards`:**旋钮仍 106**、line-budget 三热文件不动)。
内核(core/workflow/protocol)零改动、host 零改动(纯 web 层)。顺手补 C-M1 的 i18n 缺漏:
`mcpDirCat` 补 `tasks` 中英标签(此前落回原始英文串)。

### MU-M5 —— 记忆树 git 快照(给 file-first 记忆免费的历史 / 时光机 / 审计)

**为什么(Letta MemFS 的洞见)**:前沿正把 agent 记忆投影成 **git-backed 文件**(Letta
MemFS)——git 给**免费的历史**:时光旅行、审计、从一次坏蒸馏里恢复,全在一棵你本来就能
读的盘上。Gotong 的管家记忆**已经是** file-first jsonl(`<root>/user/<id>/`),M5 只要在周期
维护里裹一层 `git commit`,历史就有了,且**零热路径成本**。

**用户拍板 A=a(轻量)**:五项里的「③ git 背书」有两条路——(a) 轻量:周期快照;(b) 重:
每写即 commit / 完整 MemFS 工具面。用户选 **a**。M5 就是最小可用的轻量版:一次 6h tick 一次
commit,且**仅当真有变化**(`git status --porcelain` 空 → no-op),捕获热路径永不碰 git。

**三条让它安全的属性**:
- **非每写即 commit**。一次 6h 维护 tick 顶多一次 commit,`status` 无变化直接 no-op。审计
  热路径零 git 调用。
- **per-user 仓库**(`<memberDir>/.git`)。搬走一个成员的目录 = 带走它自己的历史(「搬走
  目录 = 搬走房间」);一个成员的仓库锁/损坏**永不**波及另一个——和维护 sweep 本就有的
  隔离同源。
- **best-effort,永不抛**。没有 `git` 二进制(ENOENT)、init 失败、锁冲突——任何故障都
  记 warn 后吞掉,返回 `'skipped'`。快照是审计便利,**绝不能**打断一次维护 tick 或改动
  jsonl 真相。加固:commit 带 `-c commit.gpgsign=false`——自动化后台 commit 绝不触发 gpg
  (全局开签名会调 gpg、可能卡在 passphrase 提示 → 挂住 sweep;拿人的密钥签 bot commit
  本也不对)。

**opt-in(`GOTONG_BUTLER_MEMORY_GIT`)**:默认关,免得部署方的记忆目录**无声变成 git 仓库**
(它们可能已嵌在另一个仓库里,或运维压根不想要)。**未开时逐字节不变**——无 `.git`、无 git
进程;框架在这里也不跑 LLM,快照纯 git。这是 MU track **唯一带门槛的项**,故也是**唯一
新旋钮**(106→107,合边界 2 的「有门槛才 opt-in」)。

**交付(host 装配层,内核零改动)**:
- **`butler-memory-git.ts`**(新):`snapshotMemoryTree({dir, logger, now?, git?})` 状态机——
  `hasOwnGitDir`(直接 fs stat `<dir>/.git`,symlink-proof、不花 git 调用)→ 没有则 `git init`
  + 写 `.gitignore`(`*.tmp`/`*.lock` 写临时件从不入库)→ `git add -A` → `status --porcelain`
  空则 `'nothing'` → 否则带 bot 身份 commit → `'committed'`。可注入 `GitRunner`(测试无需真
  git)+ `now`(commit 讯息 ISO 确定性)。非零退出是**结果**(code 存进 `GitResult`)不是抛;
  只有 spawn 失败(git 缺失)rejects,被外层 catch 收成干净 skip。
- **`personal-butler-maintenance.ts`**:`ButlerMaintenanceSweeperOptions` 加 `gitSnapshot?`
  + `git?`;`maintainOne` 蒸馏完(**无论本 tick 是否 consolidate**)按 `gitSnapshot` 调
  `snapshotMemoryTree`——把此刻盘上的东西 commit 下来。
- **`main.ts`**:解析 `GOTONG_BUTLER_MEMORY_GIT`(仅 `butlerMaintenanceOn` 时有意义,复用同
  一 truthy 集)→ 传 `gitSnapshot`。装配层 +6 行,line-budget main.ts 显式抬 2990→2996。

**测得(会红的门)**:
- `tests/butler-memory-git.test.ts`(+10):注入 `GitRunner` 单测钉状态机 + 「永不抛,诚实
  出码」契约——no-repo→init-then-commit、`.git` 已存跳过 init 不重写 `.gitignore`、clean→
  `'nothing'`、init/add/commit 非零 → `'skipped'`、git 缺失(ENOENT throw)→ `'skipped'`、
  commit 讯息 + bot 身份 + gpgsign-off 从注入 `now` 确定;真 git 集成(有 git 才跑)证产出
  的仓库真会 commit / 未变即 no-op / 再变再 commit / `.tmp` 被 gitignore。
- `tests/butler-maintenance-sweep-e2e.test.ts`(+1):**wiring 门**——默认(`gitSnapshot` 未设)
  即便传了 git runner 也**一次不调**(opt-in 就是 opt-in);`gitSnapshot:true` 时成员的记忆
  dir(`<root>/user/alice`)确经注入 runner 快照。

**验收**:host **1930** 单测全绿(+11)/typecheck 干净;四门 PASS(`check:guards`:kernel-deps
6 不变式、env-registry **107 旋钮**[+`GOTONG_BUTLER_MEMORY_GIT`]、line-budget main.ts
2996/2996)。内核(core/workflow/protocol)零改动——纯 host 装配 + 一个新叶子模块。

### MU-capstone —— `examples/memory-upgrade`(同一份记忆,同一把尺子,召回逐里程碑变好)

**论点**:MU track 的头号可证伪主张是「管家召回变好了」。capstone 端到端证它——**组合真
MU 导出代码(一行没重写)**,在一个人(小美/Mira)的管家记忆上跑两幕,每幕**只改一个变量**、
用 MU-M1 立的那把尺子量它。这是「先量后改」纪律的收口演示:不是散文说变好,是尺子读出变好。

**两幕(各隔离一个里程碑,实验卫生)**:
- **Act 1 — M2 融合重排(改检索器,库不变)**。同一批 `RecallCase`、同一份语料,`scoreRetriever`
  分别量 keyword 基线(`invertedIndexRetriever`)与 `fusedRetriever`。这些 case 的 recall@5 本就
  满,M2 动的是**排名**:`cross-session` 类的**又老又聚焦**金标(反复讲这件事)被 keyword 埋在
  **新而顺带一提**的记录下,融合的 TF-cosine 臂把它提到第 1。`direct` 控制项钉住易题证不回归。
  **实测 MRR 0.583 → 1.000**(cross-session 0.375 → 1.000),recall@5 两者皆满(融合只重排)。
- **Act 2 — M3 抽取补召回(改库,检索器不变)**。类别 query「饮料」与答案「珍珠奶茶」零共享词
  ——keyword 和 M2 本地融合**都**桥不了(bench `semantic` 类的诚实天花板)。**真**
  `atomicFactsReviewer`(注入确定性 summarizer = 6h 模型的替身)写下自包含桥接事实,同一 query
  就命中。**为隔离 M3,这一幕把检索器固定在基线**(与 MU-M3 承重门同一手法),唯一变量是库里
  有什么。**实测 answer-recall 0% → 100%**,抽取的两条事实都带 `atomicFact` 出处标记。

**收尾账本(五项各归其位)**:demo 末尾把 M4(opt-in Mem0 云连接器 + `dataLeavesBox`,记忆可存
云端**不改本地召回数**)与 M5(opt-in `GOTONG_BUTLER_MEMORY_GIT`,记忆树 git 历史**不改召回数**)
摆成两个 opt-in 侧面,并指回各自的防腐/集成测试——诚实说明它们**故意不动尺子读数**(一个决定记忆
存哪、一个给文件历史),避免「capstone 没量 M4/M5」被误读成遗漏。

**北极星回声**:全程**框架跑了 0 个模型**。Act 2 唯一的「模型调用」是确定性替身,真实部署里它是
管家自己的模型、在 6h 后台维护里跑;每轮对话热路径永远零 LLM(捕获纯抽取、召回纯检索)。

**排错记(诚实留痕)**:初版 Act 2 的 `answerRecall` 用了 `fusedRetriever`,`electric vehicle→Tesla`
过了但 `饮料→珍珠奶茶` 掉出 top-5 → 只有 50%。根因:融合的本地 embedder 是 **bigram TF**,而所有
诱饵都含 query 词「饮料」(coverage 全平),更长的桥接事实那条 `饮料` bigram 的 TF 权重被稀释 →
cosine 反而低于短诱饵 → 被挤出。这是融合的**正确**行为,但**混淆了 Act 2 要隔离的 M3**。修正 = 把
Act 2 的检索器固定在基线 keyword(正是 MU-M3 承重门的手法:改库不改检索器,金标靠 coverage-tie
的 recency 排第 1)。教训:**每幕只改一个变量**;要量 M3 就别让 M2 的重排掺进来当混淆项。

**验收**:`pnpm demo:memory-upgrade` **exit 0**(两幕每项抬升自断言,任一不成立即 exit 1);
example typecheck 干净;零前置(无 key/host/identity)。纯新增 example 包,内核 + host + web 零改动。

## 七、相关文档

| 想知道什么 | 读哪 |
|---|---|
| MU 全链路一个确定性脚本(M1 尺子量 M2 重排 + M3 补召回,零 key) | [../../examples/memory-upgrade](../../examples/memory-upgrade) · `pnpm demo:memory-upgrade` |
| 管家记忆机制现状(冻结块/捕获/6h 蒸馏/召回) | [ledger/MEMORY-TIERS-FINAL.md](ledger/MEMORY-TIERS-FINAL.md) · [ledger/MEMORY-ADVANCED-FINAL.md](ledger/MEMORY-ADVANCED-FINAL.md) |
| dreaming / 技能自创 / 6h 维护 | [ledger/MEMORY-DREAMING-SKILLS-FINAL.md](ledger/MEMORY-DREAMING-SKILLS-FINAL.md) |
| 语义召回缝(本地 embed / chroma-mcp,注入式) | [../../examples/butler-vector-recall](../../examples/butler-vector-recall) · [KB-CONNECTORS.md](KB-CONNECTORS.md) |
| 连接器目录纪律(M4 参照:全走 MCP 不存数据 / 凭证 vault / 接入≠授权) | [REAL-LIFE-CONNECTORS.md](REAL-LIFE-CONNECTORS.md) |
| 承重门体例(M1 参照) | [CONVENTIONS.md](CONVENTIONS.md) |

## 八、后续扩展:多模式记忆(M-EMB 系列)

> 用户战略问「引入更前沿的技术,比如多种模式结合的记忆,是否可行,深度研判」。研判结论:
> 前沿的**混合记忆**(向量 ⊕ 图 ⊕ 情节;HippoRAG 图谱多跳 / Zep 双时态 KG / A-MEM
> Zettelkasten / Mem0 抽取)约 **80% 已在骨架里**——`fusedRetriever` 已是多信号融合、
> `links.ts` 已是 A-MEM 式图(但**休眠**:无生产 reviewer 写 link)、双时态已落。真差距只在
> **两处**:(a) 融合的**语义臂**默认是本地词法 embedder,桥不了真同义词;(b) 图 / 程序模式
> **建了没接线**(正是我在自审里揪出的「build-but-don't-wire」病)。故路线图 **M-EMB1→M-EMB3**
> 逐个补,每步都必须**移动 benchmark 尺子**才算数——不移动数字的模式就不接。

### M-EMB1 —— 真 embedder 接进 `fusion.embed` 缝(opt-in,未配=字节不变)✅

**缝早在,线没连**:`fusedRetriever` 的语义臂取一个 `Embedder`(`(texts)=>Promise<number[][]>`),
默认是零依赖本地词法 embedder;MU-M4 设计了 `fusion:{ embed }` 注入点但**从没接过真 embedder**
(工厂一直传 `fusion:{}`)。M-EMB1 把这条线连上:

- **`packages/host/src/butler-embedder.ts`**(新):`httpEmbedder(config)` 走 **OpenAI 兼容
  `/v1/embeddings`**——**一份代码**覆盖本地端点(Ollama / LM Studio / vLLM,无 key、数据不离盒)
  与远程 API(OpenAI / Jina / DeepInfra,Bearer key、数据离盒);**零新依赖**(原生 fetch,同 LLM
  provider 的选择);按响应 `index` 排序保证向量与输入对齐;**fail-soft**——任何 HTTP / 超时 /
  形状错都**抛**,`fusedRetriever` 的 try/catch 兜住→语义臂塌成纯关键词排序,**配错只降召回质量,
  绝不断召回**。`butlerEmbedderFromEnv()` 纯函数读 env,**未配返回 undefined**⇒工厂保持
  `fusion:{}`(逐字节等同今天)。
- **接线**:`personal-butler-factory.ts` 的 `ButlerFactoryDeps` 加 `embedder?: Embedder`,
  `openButlerRecallIndex({ fusion: deps.embedder ? { embed } : {} })`;`main.ts` 从
  `butlerEmbedderFromEnv()` 构造、**远程时 boot 日志披露离盒**(`dataLeavesBox`,面板徽章的
  env-config 版),压相邻注释净零守 **main.ts 3000/3000**。
- **三旋钮**(109→112,均登记):`GOTONG_BUTLER_EMBEDDER_URL`(端点)/ `_MODEL`(模型名)/
  `_KEY`(远程 Bearer,本地免)。两者齐备才启用。

**四条边界全守**:①热路径零 LLM(embedder 是向量查表非推理路径模型,纯检索器消费它排序);
②opt-in 未配字节不变;③数据离盒 opt-in(远程 URL 才离盒,boot 披露 + `dataLeavesBox` 标);
④内核零改动(personal-memory 叶子不碰,新件在 host 装配层)。

**诚实的尺子刻度**(实测,不是散文):M-EMB1 填的是**干净同义词**格,不是既有 gate 的**诱饵硬用例**格。

| 案型 | 本地 embedder | 真语义 embedder |
|---|---|---|
| **干净同义词**(gold 是同义词、干扰项语义无关) | recall 0.000 | **recall 1.000** ✅ |
| **gate 硬 semantic**(6 个含查询词的诱饵) | 0.000 | **仍 0.000** |

`packages/personal-memory/tests/semantic-lift.test.ts` 用**同一把尺子**(`scoreRetriever`)证:
注入真语义 embedder,`饮料→珍珠奶茶`/`宠物→金毛`/`electric vehicle→Tesla`(零字符重叠)全被桥接、
召回 0→1;而 gate 那三条带 6 个「饮料」诱饵的硬用例**光靠 embedder 抬不动**(诱饵霸占 top-5)——
**那是 MU-M3 原子事实的活,不是 embedder 单独能解**。故**不碰** `memory-recall-bench` 的
`semantic===0` 断言(它测默认本地路径,断言正确),只新增一格 embedder 专属刻度。这条边界诚实地
划清了 M-EMB1 的抬升**从哪开始、到哪为止**。

**验收**:host `butler-embedder.test.ts` 11 例(OpenAI wire / index 对齐 / fail-soft 抛 / env
opt-in / 离盒披露)+ personal-memory `semantic-lift.test.ts` 3 例(干净 0→1 + 硬用例边界)全绿;
host **2069** / personal-memory **410** 全绿,四门 PASS(main.ts 3000/3000,旋钮 112,kernel-deps
不破)。真语义 embedder 的独立演示见 [`examples/butler-vector-recall`](../../examples/butler-vector-recall)
(`embeddingRetriever` + chroma-mcp 两条真 embedder 路径)。

### M-GRAPH —— 图模式接线:联想 link 从「建了没接线」到全链路活(opt-in)✅

M-EMB1 之后本要做 **M-EMB2**(把 `fusedRetriever` 泛化成可插 N 路加权信号的融合核)。开工前先实测一
把:**它是投机泛化**——没有第三个**打分**信号在等这条缝(图模式是**召回池扩展**、不是打分臂;时新 /
重要性早已是排序里的因子),照「build-but-don't-wire」纪律**不接不需要的缝**。转而实测揪出**真缺口=图
模式**:问「妈妈住哪」→ A「我妈妈是玛丽」被查询命中、答案 B「玛丽在槟城买了房子」与查询零词重叠,
**keyword 和 embedder 都够不到 B**(它俩各把每条事实**孤立**地对查询打分),只有顺着 A↔B 的联想边走一跳
才够得到。用户拍板**做图模式**。

侦察发现图件**全建好了、只差接线**(`links.ts` 的 `buildLinkGraph`/`expandByLinks` + `link-pass.ts` 的
`linkReviewer` 写侧缝 + `personal-butler-writers.ts` 的 patchMeta link writer + `toolset.ts` 的 `expandK`/
`linkLookup` 读侧扩展 —— 教科书级 build-but-don't-wire),M-GRAPH 就是把三段接上:

- **写侧**:6h 维护 `buildButlerMaintenanceReviewer` 的 `composeReviewers` 末尾组进 `linkReviewer`(**排最后**
  才连上本 tick 刚抽出的原子事实),writer 走既有 patchMeta 缝。**opt-in 且防御**:handle 无 patchMeta 就跳过
  (绝不因接线 bug 拖垮同 tick 已跑完的蒸馏),`diffLinkUpdates` 只写增长过的 link(收敛后零写)。
- **读侧**:`FileBackedInvertedIndex` 加 `lookupByIds`(复用已 fresh 的全店索引按 id 取邻居,零额外 IO、无
  `list` 500 上限),graph 模式开时工厂把它作 `memoryLinkLookup` 传进 `MemoryToolset` —— recall 顺 link 扩一跳。
- **旋钮**:`GOTONG_BUTLER_MEMORY_LINKS`(112→113,opt-in,默认关)。**一个旋钮管两侧**:开=维护写 link + 召回
  扩一跳;关=一条 link 不写、recall 不扩,**逐字节不变**。且冻结块 `frozenShowLinks` 是**独立** opt(默认关),
  故即使写了 link,**冻结块也字节不变**(link 只在按需 recall 面起效,不动缓存前缀)。

**诚实的尺子刻度**(实测,非散文):端到端 proof `graph-recall.test.ts` 4 例——① 真 `linkReviewer` 从零发现
A↔B(shared 玛丽,linked:2)、距扰项零链接;② **读侧缺口**:融合召回(keyword + 本地 embedder,即 M-EMB1
生产默认)返回 A 但**够不到 B**;③ **读侧解出**:写了 link 后**同一查询**顺 `↪` 扩出 B(带真地址「槟城」);
④ **关时字节不变**:link 在但无 `linkLookup` ⇒ recall 不扩。这些**实体桥接多跳用例刻意不进主 gate**
(`RECALL_CASES`)——它们对无扩展的生产默认本就失败,进 gate 会拉低召回地板;单独 proof 隔离证明,与 M-EMB1
`semantic-lift` 同款纪律。

**四条边界**:① 热路径零 LLM(选边 / 扩展全是纯函数 jaccard + 一跳查表,写 link 在 6h 后台);② opt-in 未配
字节不变(冻结块尤其);③ 数据不离盒(link 是本地 meta,不外呼);④ 内核零改动(`links.ts`/`link-pass.ts` 是
personal-memory 叶子既有件,host 只加装配缝 + `lookupByIds`)。

**验收**:personal-memory `graph-recall.test.ts` 4 例 + host `butler-recall-index` lookupByIds 3 例 + host
`butler-maintenance-links.test.ts` 2 例(links:true 写 A↔B / 默认零写)全绿;personal-memory **414** / host
**2074** 全绿,四门 PASS(main.ts 3000/3000,旋钮 **113**,kernel-deps 不破 —— `lookupByIds` 是能力非旋钮)。

### M-EMB2(N 路融合泛化)—— 超越/不做

实测判定为**投机泛化**:没有第三个**打分**信号在等这条缝,图模式走**池扩展**(M-GRAPH 已按池扩展形状接线,
非打分臂),照纪律不预造。若将来真出现第三个内容感知打分信号(如密集向量 + 稀疏 + 图分三路加权),再按当时
形状重启,不预造。

### M-EMB3 —— 激活休眠模式(逐个补,每步先立尺子)

| 里程碑 | 交付 | 验收门 | 状态 |
|---|---|---|---|
| **M-GRAPH** | 激活 `links.ts` 联想图(见上) | `graph-recall` 实体桥接 0→1 + 关时字节不变 | ✅ 完 |
| **M-EMB3-next** | 逐个**激活剩余休眠模式**(程序记忆自动化 / dreaming umbrella…):每个模式**先补一条它独有能解的 benchmark 失败用例**,再接线——**写不出失败用例=不接** | 每激活一个模式,尺子上多一格它专属的、之前红的刻度变绿 | 计划 |

**显式推迟**(尺子没显缺口前不预造):HippoRAG Personalized PageRank 多跳、Zep 双时态 KG、独立
情节缓冲、多模态记忆——这些是更远的前沿,等 benchmark 真读出它们能填的缺口再上,不预造。
