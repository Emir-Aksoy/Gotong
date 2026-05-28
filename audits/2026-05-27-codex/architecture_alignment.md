# Architecture Alignment

## 北极星对照

### 1. 框架不跑 LLM

当前状态: 基本保持。

证据:

- `@aipehub/core` 未直接依赖 `@aipehub/llm`、`@aipehub/llm-openai` 或 `@aipehub/llm-anthropic`。
- LLM agent、provider、tool-use loop 主要位于 `packages/llm`, provider 包和 `packages/host/src/local-agent-pool.ts`。
- `Hub.dispatch` 仍只写 task transcript、检查 ancestry gate, 然后交给 scheduler。

风险:

- `WorkflowAssistantAgent` 目前放在 `@aipehub/workflow` 中, 虽未进入 core, 但让 workflow 领域包承担 LLM agent 职责。

判断:

- 未破坏根原则, 但应尽快把 assistant 从 workflow runner 包拆出, 防止"作者ing AI"成为 workflow core 的一部分。

### 2. 人和 agent 是同一个 Participant

当前状态: 保持。

证据:

- `core` 的 `Participant` 抽象仍统一覆盖 agent / human。
- `/api/me/*` 设计上以 v4 user 身份触发 workflow, 而不是把人塞成某个特殊 tool。
- IM bridge / REPL 方向仍是"string in, agent reply out, transcript audit on the side"。

风险:

- product 层越来越多身份、role、org mode、/admin、/me route, 容易让"人"在 UX 上被特殊化。当前是必要产品层复杂度, 不是 core 抽象漂移。

判断:

- 核心抽象未偏离。

### 3. 状态都是磁盘文件

当前状态: 基本保持, 但 SQLite 状态越来越多。

证据:

- workspace `.aipehub/` 仍是主状态目录。
- transcript、agents、sessions、secrets、identity/vault/suspended task 都落本地。
- v4 以后 identity / suspended task / quotas 等进入 SQLite, 但仍是本地文件。

风险:

- 文档需要明确"file-first"不等于"全是 JSONL", SQLite 也是 workspace 文件状态。
- 根 AGENTS 未跟踪会让"复制目录 = 搬走房间"的说明与实际 agent 指南状态不一致。

判断:

- 设计方向保持, 文档和迁移说明需要同步。

## 漂移热区

1. `@aipehub/protocol -> @aipehub/core` 依赖方向。
2. `@aipehub/workflow -> @aipehub/llm` runtime dependency。
3. `packages/web/src/server.ts` 产品路由聚合过多。
4. 当前文档快照落后于真实代码阶段。

## 建议顺序

1. 修 protocol dependency boundary。
2. 更新并提交当前北极星 / 架构文档。
3. 拆 workflow assistant 包。
4. 再做 web/host 文件瘦身。
