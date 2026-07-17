# Audits

按时间归档的外部审计快照。每份审计是某个 agent / 人在某个 HEAD 下对当前
工作区做的一次只读评估, 不是当前真相 — 真相在代码和
[`docs/zh/PROGRESS-LEDGER.md`](../docs/zh/PROGRESS-LEDGER.md) 的进展账本
里。审计的价值在于"当时怎么看的", 用于后续回顾整改路径。

> 快照内容一律**逐字保留**(包括当时对已不存在文件的引用) —— 改写审计
> 记录就毁掉了它唯一的价值。

## 索引

| 日期 | 审计方 | HEAD | 链接 |
|---|---|---|---|
| 2026-05-31 | Codex | a495d11 | [2026-05-31-codex-goal-audit/](2026-05-31-codex-goal-audit/) |
| 2026-05-27 | Codex | 823c49a (Phase 13 M1) | [2026-05-27-codex/](2026-05-27-codex/) |

## 约定

- 每份审计放一个独立子目录, 命名 `YYYY-MM-DD-<auditor>/`。
- 子目录里至少有 `README.md` 总结 + `findings.md` 分级建议。
- 审计**只读**, 不修改源码。整改动作在主线 commit 里完成, 不回填到审计目录。
- 整改完成后, 可在 audit 子目录的 `README.md` 末尾加一节"后续 follow-up"
  指向具体 commit / PR, 让审计结论可以追到落地点。
