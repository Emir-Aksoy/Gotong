# HITL 术语表（Human-in-the-Loop / 人在回路）

> 本文件是 AipeHub 项目内 HITL 相关术语的**唯一权威定义**。代码注释、
> prompt、文档、commit message 全部用这里定的写法，不要再混用 "HUMAN-
> IN-THE-LOOP"、"人在回路"、"用户介入" 等多种说法。

## 1. 项目内标准写法

| 场景 | 标准写法 | 不要这样写 |
| --- | --- | --- |
| 代码注释、文件名、类名前缀 | `HITL` | `HUMAN-IN-THE-LOOP`、`human_in_the_loop` |
| 中文文档首次出现 | `HITL（Human-in-the-Loop，人在回路）` | 后续可只用 `HITL` |
| 中文文档后续出现 | `HITL` 或 `人在回路`（择一，全文一致） | 同段内混用两种 |
| 英文文档 | `Human-in-the-Loop (HITL)` 首次，后续 `HITL` | 全大写 `HUMAN-IN-THE-LOOP` |
| 用户可见 UI 文案 | `需要你确认 / 需要补充信息` 等具体动作描述 | "HITL"（用户不需要知道这个缩写） |

## 2. 四种 HITL 模式

参考 LangChain / Permit.io 的业界共识，AipeHub 把 HITL 场景分成四类。
**新加 HITL 行为时，先确认它属于哪一类**，并在代码注释里点名：

### 2.1 `approve` — 审批模式

- **形态**：agent 已经产出一份完整结果，把它交给一个有最终决定权的真
  人；人选择「通过」或「打回去（带具体改动建议）」。
- **典型场景**：法律文书、对外发声、不可逆操作前的人审。
- **本项目实例**：
  - `industry-consultation-flow.yaml` 的 `human-review` step
    （capability=`consultant-review`）—— 资深顾问审 AI 草稿。
- **关键约束**：approve 模式**不强制超时**。`Hub.dispatch` 会一直挂
  着直到真人完成，因为审批是显式职责，不该被超时绕过。

### 2.2 `interrupt` — 中断模式

- **形态**：流程跑到某一步**强制停下**，等人显式 resume；常用于"危险
  操作前的最后一道闸"。
- **典型场景**：删数据库、改生产配置、调用付费 API 前的硬刹车。
- **本项目实例**：暂无。**未来如果加，命名前缀用 `interrupt-`**。

### 2.3 `edit` — 修改模式

- **形态**：agent 产出后，真人**直接改**结果再交给下一步（不是给反馈
  让 agent 重做，而是亲自动手）。
- **典型场景**：营销文案 / 设计稿的最后一公里编辑。
- **本项目实例**：暂无。**未来如果加，命名前缀用 `edit-`**。

### 2.4 `collect` — 信息收集模式

- **形态**：agent 发现**自己不知道**继续往下走需要的关键信息，主动停
  下来反问真人，拿到答案后继续。
- **典型场景**：初次访谈、关键事实模糊、红旗信号需要确认。
- **本项目实例**：
  - `personal-growth-agent.ts` 的 `<NEED_INPUT>` marker（仅访谈师步骤
    启用，硬约束 1 轮、≤3 个问题）。
- **关键约束**：collect 模式必须有**轮数预算**。无限循环 = 死锁。当
  前实现是硬 1 轮上限，必要时由 agent 把剩余问题挪到正文里让用户下次
  跑 v2 时回答。

## 3. Marker 命名规范

LLM 输出里用 `<...>` XML-style marker 触发 HITL 时，命名遵循：

```
<HITL_{MODE}>{json}</HITL_{MODE}>
```

其中 `{MODE}` ∈ `{APPROVE, INTERRUPT, EDIT, COLLECT}`。

### 3.1 历史兼容（已落地的 marker）

| 老 marker | 模式 | 状态 |
| --- | --- | --- |
| `<NEED_INPUT>` | collect | **保留**。改名要同步改 prompt / 解析器 / 单测三处，收益有限；新加 marker 才按 3 节规范命名。 |

新加的 marker（比如 P1-4 Replanning）按规范来：`<REPLAN>` 不属于
HITL（是 agent ↔ agent 协调），不走这套命名。**HITL marker 才用
`HITL_*` 前缀**。

## 4. 触发记录与可观测

任何 HITL 触发都需要：

- **日志**：用 `log.info` 级别记录 `mode`（approve/collect/...）、
  `taskId`、`agentId`、`askingParticipant`。
- **task metadata**：在结果 task 的 metadata 里写 `hitlTriggered: true,
  hitlMode: '<mode>'`，方便 admin UI 上做"哪些任务走了 HITL"的统计。
  *（待 P1-5 eval harness 一起落地）*

## 5. 何时**不**用 HITL

防止滥用：

- **可以用 evaluator 解决的，不要用 HITL**。真人很贵，AI evaluator 几
  分钱一次。先用 `evaluator-optimizer` 模式跑两轮 AI 自评，质量不够
  再考虑加 HITL。本项目 `industry-consultation` 的 P0-2 改造即是这条
  原则的体现 —— 在 `human-review` 前先加一道 AI evaluator。
- **流程内每个 step 都加 HITL = 反模式**。HITL 应该集中在「不可逆 +
  高 blast radius + 合规敏感 + 低置信」四象限的交点上，参考 Permit.io
  的判定矩阵。

## 6. 参考资料

- LangChain HITL: https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/
- Permit.io HITL Patterns: https://www.permit.io/blog/human-in-the-loop-for-ai-agents
- Anthropic "Building Effective Agents":
  https://www.anthropic.com/research/building-effective-agents
