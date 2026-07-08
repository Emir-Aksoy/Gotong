# memory-upgrade — 同一份记忆,同一把尺子,召回逐里程碑变好(MU capstone)

记忆升级(MU track)的核心论点一句话:

> 管家的记忆**骨架**(file-first + 双时态 + 睡眠期整理)早已赌对;
> 差距在**检索质量**和**可测性**——而「变好了」必须能被同一把尺子证伪。

这个 demo 用**真** MU 代码(一行没重写)在一个人的管家记忆上跑两幕,每幕只改
一个变量、用 MU-M1 的尺子(`scoreRetriever`)量它:

## 两幕

1. **Act 1 — M2 融合重排(改检索器,库不变)**。同一批 case、同一份语料,
   keyword 基线 vs `fusedRetriever`。这些 case 的 recall@5 本来就满,M2 动的是
   **排名**:一条**又老又聚焦**(反复在讲这件事)的事实,被 keyword 埋在几条
   **新而顺带一提**的记录之下;融合的 term-frequency cosine 臂把它提到第 1。
   `direct` 控制项钉住易题,证明融合**不回归**。→ MRR 0.583 → 1.000。

2. **Act 2 — M3 抽取补召回(改库,检索器不变)**。类别 query「饮料」与答案
   「珍珠奶茶」**零共享词**——keyword 和 M2 的本地融合**都**桥不了(这是 bench
   `semantic` 类的诚实天花板)。**真** `atomicFactsReviewer`(6h 维护里的抽取器)
   写下一条自包含桥接事实「用户最爱的饮料是珍珠奶茶」,同一个 query 就命中了。
   为**隔离 M3**,这一幕把检索器**固定在基线**(与 MU-M3 承重门同一手法),
   唯一变的是库里有什么。→ answer-recall 0% → 100%。

## 收尾账本(五项各归其位)

| 里程碑 | 在 demo 里 |
|---|---|
| **M1** 尺子 | 两幕都用 `scoreRetriever` / answer-recall 量,「变好」可证伪 |
| **M2** 融合 | Act 1 把聚焦金标提到第 1(MRR↑) |
| **M3** 抽取 | Act 2 把同义词 recall 从 0 抬到 100%(改库不改检索器) |
| **M4** 外部 | opt-in Mem0 云连接器 + `dataLeavesBox` 披露——记忆可存云端,不改本地召回数 |
| **M5** 快照 | opt-in `GOTONG_BUTLER_MEMORY_GIT`——6h 维护里给记忆树 per-user git commit,best-effort |

M4 / M5 是两个 **opt-in 侧面**,故意**不动召回数**(一个决定记忆存哪、一个给
文件历史),分别在各自里程碑的防腐 / 集成测试里验过。

## 运行

```bash
pnpm demo:memory-upgrade
```

零前置:**无 API key、无 host、无 identity**。自断言,每一项抬升成立才 exit 0。

## 北极星:框架跑了 0 个模型

Act 2 唯一的「模型调用」是**确定性替身**——在真实部署里,它是管家自己的模型,
在 **6h 后台维护**里跑(和 tiered 蒸馏同一趟)。每轮对话的**热路径永远零 LLM**:
捕获是纯抽取,召回是纯检索。这正是 MU track 的不可破边界之一。见
[`docs/zh/MEMORY-UPGRADE.md`](../../docs/zh/MEMORY-UPGRADE.md)。
