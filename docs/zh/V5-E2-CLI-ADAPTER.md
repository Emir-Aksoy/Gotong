# v5 Stream E / E2 — 出站 CLI shell-out adapter（hub 驱动编码 agent）

> Last updated: 2026-06-03 · commit `e5ebd51`→`57fe00d`（E2-M1/M2/M3）+ 本提交（M4 文档）

---

## 一句话

让本地 hub **驱动**一个自托管的编码 agent CLI（Claude Code / Codex / OpenCode /
Aider / Goose…）当成一个 `Participant`：派一个 task 进去，CLI 的 stdout 当 task 输出
回来，全程带齐 AGENT-ADAPTER-CONTRACT 的五条控制缝。这是 `aipehub connect <agent>`
（**入站**：CLI 当 MCP client 反过来调 hub）的镜像；两个方向合起来才满足契约的
「**双向连通 + 可快速接管**」验收门。

```
  入站  CLI ──MCP──▶ hub      (aipehub connect, 已有)
  出站  hub ──spawn─▶ CLI      (本 Stream，CliParticipant)
```

---

## 为什么做（北极星缺口）

Stream E 是把 AipeHub 从「能自洽运转」推到「装得下真实工作」的五条交付缺口，按杠杆
排序。E2 是用户点名的那一条：

- 现状只有 **入站** 方向（`aipehub connect` 把外部 agent 接成 hub 的 MCP client）。
  契约要求 adapter **双向**——hub 也得能反过来 **驱动** 一个外部 agent。最高频、生态
  最大的那类外部 agent 就是 **CLI 编码 agent**（Claude Code/Codex/Aider…），它们都
  长一个样：`命令 + prompt 进，stdout 出，exit code 表成败`。
- 真要把一个会 **改文件 / 花钱 / 对外发** 的 agent 接进来，光「能跑」不够——必须
  **可观测、可拦截、可移交、可续跑、可终止**（契约的五缝），否则就是放一个黑盒在生产
  里裸跑。所以本 Stream 的核心不是「spawn 一个进程」，而是「让这个进程在五缝控制面
  下跑」。

---

## 动了什么

### 新包 `@aipehub/cli-agent`（第 31 包，core-only 叶包）

跟 `@aipehub/inbox` / `@aipehub/a2a` 同源——可复用的 participant 住在只依赖 core 的
叶包里，example 导入叶包而不是 host（`@aipehub/host` 一被 import 就会跑起来）。

| 文件 | 职责 |
|---|---|
| `cli-runner.ts` | 进程引擎。`runCliCommand(opts)`：spawn + stdin 灌 + stdout/stderr 流式 `onChunk` + abort（SIGTERM→2s→SIGKILL）+ timeout + ENOENT→「命令未找到」。**纯通用**：只收最终 argv，prompt 怎么摆是 participant 的事。 |
| `cli-checkpoint.ts` | 检查点纯原语（无 IO）。`CliCheckpointState`（带版本号 + turn + 转录）、`TakeoverController`（接管开关）、`dangerousCommandGate()`（危险命令模式匹配）、`readReviewDecision`/`readCheckpointState`（容错读复核决定，兼容 `{decision}` 与 inbox 的 `{answer}` 两种形状）、`CLI_NEVER_RESUME_AT` 哨兵。 |
| `cli-participant.ts` | `CliParticipant extends AgentParticipant`。一个有界的 **turn 循环**：checkpoint → spawn → 记录 → 续跑。默认 `maxTurns:1`（无闸无接管）就是单发；抬高 + 给 `next`/`gate`/`takeover` 才进多轮带检查点。 |

### `examples/coding-agent-bridge/`（§7 P0 模板）

| 文件 | 职责 |
|---|---|
| `presets.ts` | `CLI_PRESETS`：claude-code / codex / opencode / aider / goose 各自的 `命令 + args + promptVia + apiKeyEnv`。一张表覆盖 §6.1 整类。 |
| `mock-cli.mjs` | 确定性 mock CLI（纯 node，读 prompt 回显），让 demo 无 key 可跑。 |
| `index.ts` | 五缝逐个演（`pnpm demo:coding-agent-bridge`）。 |
| `README.md` | 预设表 + 指到真 CLI 的代码 + 安全须知。 |

### 验收门 `packages/host/tests/cli-agent-e2e.test.ts`

照契约 §5 故事跑：真 Hub（InMemoryStorage）+ production-shaped suspendNotifier→真
IdentityStore + 真 FileInboxStore，驱动 `CliParticipant` 跑过 node `-e` mock CLI。

---

## 五条缝怎么落的

| 缝 | 机制 | 关键正确性点 |
|---|---|---|
| **OBSERVE** 可观测 | `onChunk(taskId, chunk)` 鸭子回调，host 接到 transcript chunk 事件 | 叶包不碰 host——回调签名带 `taskId` 让 host 归因（镜像 usageSink/suspendNotifier） |
| **INTERCEPT** 可拦截 | `TakeoverController.requestTakeover(taskId)`，每轮 spawn 前查 | 协作式（cooperative）——不是硬杀，是「下一轮前停下来」，turn 边界干净 |
| **HANDOFF** 可移交 | `SuspendTaskError({ resumeAt: NEVER_RESUME_AT, state })` 把 turn 转录随挂起落盘 | `NEVER_RESUME_AT` → 30s resume sweep **永远取不到**，只有人驱动的 resume 能续 |
| **RESUME** 可续跑 | `onResume(task, state)` 读复核决定续 loop | **无漂移**：carried state 原样带回，turn 0 的成果不重跑；复核人可改 prompt 操舵 |
| **TERMINATE** 可终止 | `onTaskCancelled(taskId)` → `AbortController.abort()` → SIGTERM→SIGKILL | hub 把 task cancel 路由到 `onTaskCancelled`（hub.ts），同一条缝 |

外加 **T2 动作闸**（`dangerousCommandGate`）：危险命令（`rm -rf` / `git push` /
`git reset --hard` / `npm publish` / `sudo` / `curl|sh` / `drop table` / `kubectl
delete`）在 **CLI 还没 spawn 之前** 就挂起等人批；拒绝 → 任务 fail-closed，CLI 从未
跑过。这就是契约说的「会改文件/花钱/对外发的副作用面钉到 T2」。

### 验收门的故事（§5）

```
派发 benign refactor
  → 流式输出 (OBSERVE)
  → 人接管 → turn 1 挂起 (INTERCEPT), 落盘 NEVER_RESUME_AT, sweep 取不到
  → 写 inbox item + delegate alice→bob (HANDOFF)
  → bob 改 prompt "apply only the safe edits" + 批准
  → resumeTask(carried state + decision) (RESUME)
     · turns=2, turn 1 跑了改后的指令
     · turn 0 "refactor the auth module" 原样保留 ← 无漂移
  ───
派发 destructive "rm -rf build/ && git push --force"
  → spawn 前挂在 action_gate (零 chunk 流出)
  → 拒绝 → failed, CLI 从未跑 (fail-closed)
  ───
派发一个会卡 10s 的 task
  → onTaskCancelled → 子进程被杀 → failed (TERMINATE)
```

---

## 关键设计决策

1. **runner 只收最终 argv**。M1 一度让 runner 自己填 `{prompt}`，会和 participant 的
   stdin/arg 处理双重替换打架。砍掉——runner 通用，prompt 摆哪儿（arg 占位 vs 管进
   stdin）完全是 `CliParticipant` 的事（`promptVia`）。

2. **默认就是单发**。`maxTurns:1` + 无 gate/takeover 时，行为跟最朴素的「spawn 一次拿
   stdout」完全一样。检查点机器是 **opt-in**，不给不付费。

3. **挂起态自描述 + fail-closed**。park 一律 `NEVER_RESUME_AT`（只有人能唤醒）；状态
   随 `SuspendTaskError.state` 带走；`readReviewDecision` 同时认 `{decision}`（CLI 自己
   的复核）和 `{answer}`（Phase 16 inbox 的约定），所以同一个 participant 既能挂在 CLI
   自有复核流，也能挂在 `/me` inbox 面板。action_gate 没拿到明确 `approved:true` 就抛
   错——**默认拒**。

4. **resume-state 约定踩坑**：`hub.resumeTask(agentId, task, state)` 的 `state` 是
   **resume 调用方传什么就是什么**，不是自动回填挂起时的 state。所以验收门里 host 胶水
   显式传 `{...carriedState, decision}`——carried state 必须由调用方带回，这也正是
   「无漂移」能在 CLI-task 层证出来的原因（workflow 派发 CLI capability 时，Phase 15 的
   修订钉绑会自动继承，本层不重复造）。

5. **example 不碰 host/main.ts**。跟 6 个 IM bridge 一个策略——先以 example 形式发，等
   社区用法稳定再决定要不要 fold 进 host CLI first-class。本层 host 侧只多了一个 **test
   devDep**（验收门要 import 叶包），main.ts 零改。

---

## 测试矩阵（+36）

| 包 | 测试 | 覆盖 |
|---|---|---|
| `cli-agent` | `cli-runner.test.ts` 11 | spawn / stdin / 流式 / abort / timeout / ENOENT |
| `cli-agent` | `cli-participant.test.ts` 9 | 单发 / gate park / takeover park+resume / 多轮 next + maxTurns 封顶 |
| `cli-agent` | `cli-checkpoint.test.ts` 13 | gate spawn 前挂 / 批准跑 / 拒绝 fail-closed / readReviewDecision / dangerousCommandGate 单元 |
| `host` | `cli-agent-e2e.test.ts` 3 | §5 全故事（observe→takeover→inbox handoff→resume 无漂移）+ 动作闸 fail-closed + terminate |

全部确定性（`process.execPath -e` 当 mock CLI，无 key 无网络）。零回归：cli-agent 33、
host 641、全 `pnpm -r test` 绿。

---

## 运维须知

- **动作闸是默认推荐、不是默认开**。给会改文件/花钱/对外发的真 agent **务必挂一个**
  （`gate: dangerousCommandGate()`），否则副作用面没钉到 T2。
- **prompt 注入**：CLI 拿到的 prompt 来自派发它的 task。task origin 不可信时（跨组织
  A2A、IM 桥），先在 hub 边界钉副作用面（动作闸 + 受限 `cwd` + 最小 `env`），别让外部
  消息直接驱动一个能 `rm -rf` 的 agent。
- **凭证**：CLI 自己的 API key 走 `env` 显式注入，别继承整个 `process.env`（`env` 里
  value 给 `undefined` 会删掉那个 key）。
- **超时**：`timeoutMs` 必给——卡死的 CLI 会被杀、任务 failed，免得一个 task 永久占着。

---

## 显式不做 / 推迟

- **不替每个 CLI 逐个手写 adapter**——`CLI_PRESETS` 参数化模板覆盖整类。
- **不追自主 agent（Devin/Manus）的 agent 内部 mid-run 接管**——只在 hub 边界钉副作用面。
- **host CLI first-class 配置**（admin UI 里配出站 CLI agent + 持久化）——先 example 形式
  发，社区用法稳定再 fold（同 IM bridge 策略）。
- **真 CLI 的 wire 级互操作测试**（真打 `claude`/`codex`）——验收门用 mock CLI 保确定性
  可进 CI；真 CLI 冒烟留给 live gate（参照 Route B P1-M13 的 live.yml 模式）。

---

## 相关文档

- `docs/zh/AGENT-ADAPTER-CONTRACT.md` — 双向 + 可快速接管的契约本体（§7 P0 已标 done）
- `docs/zh/QUICK-CONNECT.md` — 入站方向（`aipehub connect <agent>`）
- `examples/coding-agent-bridge/README.md` — 预设表 + 指到真 CLI + 安全须知
