# Codex Audit

审计范围: AipeHub 当前工作区 `/Users/emiraksoy/Desktop/AipeHub`

审计目标:

- 判断项目是否偏离初始设计初衷。
- 评估当前代码质量、测试信号和可维护性风险。
- 给出按优先级排序的整改建议。

## 总结

总体没有偏离到"已经不是 AipeHub"的程度。`@aipehub/core` 仍主要承担 Hub / scheduler / transcript / participant 职责, LLM 执行仍在 `@aipehub/llm`、`@aipehub/host` 和 agent 层。

但边界已有几处明显变软:

1. `@aipehub/protocol` 宣称 zero runtime, 但 runtime 依赖 `@aipehub/core`。
2. 架构文档作为真相源已经滞后, 与当前 HEAD / Phase 13 状态不一致。
3. `@aipehub/workflow` 开始承载 AI authoring, 不再只是 workflow schema / runner / validator。
4. Python SDK 的根级测试脚本不能一键复现, 依赖隐式 `PYTHONPATH` 或 editable install。
5. `web/server.ts`、`web/static/admin.js`、`host/main.ts` 等文件持续膨胀, 增加审查成本。

## 文件索引

- `findings.md`: 分级发现和整改建议。
- `architecture_alignment.md`: 与北极星设计的对照。
- `code_quality.md`: 代码质量、测试覆盖和可维护性评估。
- `verification.md`: 已执行验证命令和结果。
- `audit_findings.json`: 机器可读版发现列表。
- `delivery_note.md`: 本次审计交付说明, 收纳原本只在聊天回复里的结果索引。

## 结论优先级

- P1: 先修协议层依赖方向和文档真相源。
- P2: 拆清 workflow runner 与 workflow assistant 边界, 修正 assistant 成功语义。
- P2: 修正 `pnpm test:python` 一键质量门。
- P3: 逐步拆分巨型 web/host 文件。
