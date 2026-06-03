# 本 hub 的落地手册 —— 用 agent 编码

> 源:[[raw/sources]] · 上级:[[index]] · 把 [[software-3.0]] /
> [[vibe-coding]] / [[agentic-engineering]] / [[llm-knowledge-base]] 落到
> personal-coding-hub 的真实机制上。

这份笔记是给 **mentor agent** 的操作手册:每条方法论 ↔ 本 hub 的一个具体钩子。

## 方法论 → 机制 对照表

| 方法论 | 本 hub 的钩子 |
|---|---|
| **规范即程序** ([[software-3.0]]) | `AGENTS.md` —— 两个 CLI 共享**同一份字节**(同一 `cwd`);真实里 `CLAUDE.md` symlink 到它。派活前先对齐它的约束。 |
| **小步、可审、带测试** ([[agentic-engineering]]) | mentor **拆活**:起草→claude-code、实现→codex;每步小到一次能审。 |
| **交接 / 短反馈环** ([[agentic-engineering]] + [[llm-knowledge-base]]) | `PROGRESS.md` 是**交接棒**:动手前读、做完追加一行。codex 起步时已能看见 claude-code 刚写的那条。 |
| **原型凭感觉,留存要换挡** ([[vibe-coding]]) | spike 任务可以放松;一旦确认要留,就重做成带测试的小步版本。 |
| **ask-your-wiki** ([[llm-knowledge-base]]) | 接到非琐碎目标 → 先 `obsidian__search` 这个方法论 vault → 按笔记路径引用依据。 |
| **拴绳硬底线** ([[agentic-engineering]]) | `dangerousCommandGate()`:`rm -rf`/`git push`/`sudo`/`curl\|sh` 在 spawn 前挂起等人批。 |

## mentor 的默认循环

1. **读规范**:确认目标符合 `AGENTS.md`。
2. **查方法论**:`obsidian__search` 找相关原则(本 vault),拿不准就跟 `[[链接]]`。
3. **拆 + 派**:小步;起草派 claude-code,实现派 codex;让 `PROGRESS.md` 承载交接。
4. **守底线**:危险动作交给动作闸,不绕过。
5. **沉淀**:有价值的结论可以让编码 agent 写回 vault(新的[[llm-knowledge-base|编译笔记]])。

## 给人类 owner 的话

你是**审阅者 / 架构师 / 把关人**(80/20 迁移里人的新角色)。agent 干大部分活,但
**拴绳、拆活、审 diff、拒大改**是你的。这个 vault 是你和 agent 共享的「方法论事实源」
—— 改这里,就同时改了两个 CLI 的行为方式。

→ 回到:[[index]]。
