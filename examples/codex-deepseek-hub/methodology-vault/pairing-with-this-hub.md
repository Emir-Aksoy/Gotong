# 本 hub 的落地手册 —— Codex × DeepSeek TUI

> 源:[[index]] · 把 [[pairing-model]] / [[routing-by-situation]] 落到
> codex-deepseek-hub 的真实机制上。

这份笔记是给 **mentor agent** 的操作手册:每条方法论 ↔ 本 hub 的一个具体钩子。

## 方法论 → 机制 对照表

| 方法论 | 本 hub 的钩子 |
|---|---|
| **规范是共享事实源** | `AGENTS.md` —— 两个 coder 共享**同一份字节**(同一 `cwd`)。派活前先对齐它的约束。 |
| **配对分工** ([[pairing-model]]) | mentor **拆活**:设计/审查→`deepseek-tui`(主理)、实现→`codex`(快手);每步小到一次能审。 |
| **按情况路由** ([[routing-by-situation]]) | `planRoute(goal, policy)`:任务分析 × 用户安排,合并出派谁;不在岗的绝不派。 |
| **交接 / 短反馈环** | `PROGRESS.md` 是**交接棒**:动手前读、做完追加一行。`codex` 起步时已能看见 `deepseek-tui` 刚写的方案那条。 |
| **拴绳硬底线** | `dangerousCommandGate()`:`rm -rf` / `git push` / `sudo` / `curl\|sh` 在 spawn 前挂起等人批,绝不绕过。 |

## mentor 的默认循环

1. **读规范**:确认目标符合 `AGENTS.md`。
2. **查方法论**:`obsidian__search` 找相关原则(本 vault),拿不准就跟 `[[链接]]`。
3. **分析 + 结合安排 + 派**:看清任务(只审查 / 琐碎 / 需设计),结合名册谁在岗,
   按 [[pairing-model]] 三种配法选一种;让 `PROGRESS.md` 承载交接。
4. **守底线**:危险动作交给动作闸,不绕过。
5. **沉淀**:有价值的方案/结论可以让 coder 写回 vault(新的编译笔记)。

## 为什么共享 cwd 是关键

两个 coder 跑在**同一个工作目录**。这不是巧合 —— 它是配对的物理基础:

- `deepseek-tui` 写下的方案、改的文件,`codex` **当场就能看见**(同一棵文件树)。
- 交接不靠消息传递,靠**磁盘状态**:方案落 `PROGRESS.md` / 代码落工作树,
  下一只手直接读。
- 复制这个目录 = 搬走整个配对的上下文(Gotong「状态是文件」北极星)。

## 给人类 owner 的话

你是**审阅者 / 把关人**:agent 干大部分活,但**拴绳、拆活、审 diff、拒大改、
批危险动作**是你的。这个 vault 是你和两个 coder 共享的「方法论事实源」——
改这里,就同时改了配对的行为方式。

→ 回到:[[index]]。
