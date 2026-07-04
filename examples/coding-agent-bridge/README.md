# coding-agent-bridge — 让 hub 驱动一个自托管编码 agent CLI

> Stream E E2 的 §7 P0 交付物。AGENT-ADAPTER-CONTRACT 的「**出站 shell-out**」那一
> 极：本地 hub 把一个外部编码 agent CLI（Claude Code / Codex / OpenCode / Aider /
> Goose）当成一个 `Participant` 来 **驱动**——派一个 task 进去，CLI 的 stdout 当 task
> 输出回来——并且全程带齐五条控制缝。

这是 `gotong connect <agent>`（**入站**：CLI 当 MCP client 反过来调 hub）的镜像。
两个方向合起来满足契约的「双向连通 + 可快速接管」验收门。

```
  入站  CLI ──MCP──▶ hub        (gotong connect, 已有)
  出站  hub ──spawn─▶ CLI        (本 example，CliParticipant)
```

## 跑起来

```bash
pnpm demo:coding-agent-bridge
```

不需要任何 API key——demo 打一个确定性的 mock CLI（`src/mock-cli.mjs`，纯 node，读
prompt 回显），把五条缝逐个演一遍。输出会标出每一步。

## 五条控制缝（演示故事）

| 缝 | 在 demo 里 | 机制 |
|---|---|---|
| **OBSERVE** 可观测 | CLI 的 `step:` / `result:` 行实时打到 stdout | `onChunk(taskId, chunk)` 回调（host 接到 transcript chunk 事件） |
| **INTERCEPT** 可拦截 | 一个人「接管」→ 下一轮前任务挂起 | `TakeoverController.requestTakeover(taskId)`，轮间检查 |
| **HANDOFF** 可移交 | 挂起态带着完整上下文交给复核人 | `SuspendTaskError({ state })` 把 turn 记录随挂起一起落盘 |
| **RESUME** 可续跑 | 复核人改 prompt + 批准 → 从挂起处续跑，turn 0 的成果原样保留 | `onResume(task, state)` 读决定续 loop（无漂移） |
| **TERMINATE** 可终止 | 卡死的 CLI 被取消 → 子进程被杀 | `onTaskCancelled(taskId)` → `AbortController` → SIGTERM→SIGKILL |

第 5 步还演了 **T2 动作闸**：一个带 `rm -rf` / `git push --force` 的 prompt 在 CLI
**还没 spawn 之前**就挂起等人批；拒绝 → 任务 fail-closed，CLI 从未跑过。

## 指到真 CLI

把 `command` / `args` 换成 `src/presets.ts` 里的一条预设，去掉 mock 即可。控制面
完全一样。

| 预设 | 命令 | prompt 传入 | API key |
|---|---|---|---|
| `claude-code` | `claude -p {prompt}` | arg | `ANTHROPIC_API_KEY` |
| `codex` | `codex exec {prompt}` | arg | `OPENAI_API_KEY` |
| `opencode` | `opencode run {prompt}` | arg | 各自配置 |
| `aider` | `aider --message {prompt} --yes` | arg | 各自配置 |
| `goose` | `goose run -t {prompt}` | arg | 各自配置 |

```ts
import { CliParticipant, dangerousCommandGate, TakeoverController } from '@gotong/cli-agent'
import { CLI_PRESETS } from './presets.js'

const p = CLI_PRESETS['claude-code']
const coder = new CliParticipant({
  id: 'claude-code',
  capabilities: ['code'],
  command: p.command,
  args: p.args,           // 含 '{prompt}' 占位，arg 模式下替换
  promptVia: p.promptVia, // 'arg' | 'stdin'
  cwd: '/path/to/repo',   // agent 操作的仓库
  env: { [p.apiKeyEnv!]: process.env[p.apiKeyEnv!] },
  timeoutMs: 120_000,     // 卡死的 CLI 会被杀，任务 failed
  onChunk: (taskId, c) => hub.appendTranscriptChunk(taskId, c.text), // 观测缝
  gate: dangerousCommandGate(), // T2：危险命令先挂起等人批
  takeover: new TakeoverController(), // 接管缝
})
hub.register(coder)
```

`promptVia: 'arg'` 把 prompt 替进 `{prompt}` 占位（`claude -p "<prompt>"`）；
`'stdin'` 把 prompt 管进 CLI 的标准输入（适合从 stdin 读任务的 CLI）。

## 安全须知

- **动作闸是默认推荐、不是默认开**。`dangerousCommandGate()` 用一组保守的危险模式
  （`rm -rf` / `git push` / `git reset --hard` / `npm publish` / `sudo` / `curl|sh` /
  `drop table` / `kubectl delete`）。命中 → 挂起等人批；批准前 CLI 绝不 spawn。给会
  改文件 / 花钱 / 对外发的真 agent，**务必挂一个闸**（契约里这类副作用面要钉到 T2）。
- **prompt 注入**：CLI 拿到的 prompt 来自派发它的 task。如果 task 的 origin 不可信
  （比如跨组织 A2A、IM 桥），先在 hub 边界把它的副作用面钉到 T2（动作闸 + 受限 `cwd`
  + 最小 `env`），别让一个外部消息直接驱动一个能 `rm -rf` 的 agent。
- **凭证**：CLI 自己的 API key 走 `env` 显式注入，别继承整个 `process.env`。

## 验收门

`packages/host/tests/cli-agent-e2e.test.ts` 是这个 adapter 的验收测试：真 Hub +
production-shaped suspendNotifier→identity + 真 FileInboxStore，照 §5 故事跑一遍
（observe→接管挂起→inbox 移交→改 prompt 续跑且无漂移→终止），外加一条 fail-closed
动作闸用例。这就是契约 §5 说的「照这个故事写一个确定性 E2E 测试就是该 adapter 的
验收门」。

## 相关

- `packages/cli-agent/` — `CliParticipant` + `cli-runner` + 检查点原语（core-only 叶包）
- `docs/zh/AGENT-ADAPTER-CONTRACT.md` — 双向 + 可快速接管的契约本体
- `docs/zh/QUICK-CONNECT.md` — 入站方向（`gotong connect <agent>`）
