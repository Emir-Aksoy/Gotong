# atong-librarian — LIB capstone:知识自治全链路

阿同图书馆员 track(LIB)的收官演示。论点:管好**大量**知识文件靠的不是
更大的上下文,而是「进货区(每轮必付的记忆)→ 上架区(按需付费的文件树)
+ 一张 ≤500tk 的自著索引卡当常驻导航」。

```bash
pnpm demo:atong-librarian   # exit 0 = 全部断言通过;零网络、零 key、零真实 LLM
```

四幕(真件零重写,「模型」全是确定性脚本):

| 幕 | 断言的承诺 | 真件 |
|---|---|---|
| 1 进货→上架 | 文件先落盘才双时态下架(validTo+promotedTo 一次补丁,条目还在盘上=可逆);第二 tick 候选掉下门槛,零模型调用(收敛) | `knowledgeLibrarianReviewer`(M4)+ `MemoryFileHandle`(生产文件后端) |
| 2 百文件树 | 树长 25×(→100+ 文件),策展层级索引不动 ⇒ 常驻卡**逐字节不变**;胖索引病态被 ≤500tk 顶封死(响亮 N/M 标记);正文按需深读 | `buildButlerKnowledgeIndexCard`(M3)+ `estimateTokens`(M1 尺) |
| 3 归档不丢 | archive/ 挪走不真删,前缀照读逐字节同;INDEX.md 不可归档(自断导航响亮拒) | `openKnowledgeLibrary`(M2) |
| 4 知识≠授权 | 真管家靠常驻索引卡导航 → 读出「待办:发预算表」→ 对外发送照样 park 等审批,批准前零发送 | `PersonalButlerAgent` + `stableContext` 缝 + `GovernedActionToolset` |

设计细节与边界:[`docs/zh/ATONG-LIBRARIAN.md`](../../docs/zh/ATONG-LIBRARIAN.md)。
