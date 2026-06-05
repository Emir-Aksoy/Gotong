# acp-coding-bridge — 让 hub 用 ACP 长连接直接驱动 Claude Code / Codex

> 模仿 **OpenClaw** 的操作方式：hub **直接管理从启动到分派任务**给一个编码
> agent。靠 **ACP（Agent Client Protocol，Zed 的「编码 agent 界的 LSP」）** 把
> agent 当 **长生命周期子进程** spawn 一次，做 JSON-RPC 握手，**hold 住 session**，
> 然后把多个任务反复派到 **同一个 session**——任务间上下文保留。

这是 `examples/coding-agent-bridge`（一次性 shell-out）的 **互补**，不是替换。那个
每个任务 spawn 完即退出、无 session；这个把整条 session 攥在手里，正是「从启动 →
hold session → 分派」的全生命周期所有权。

| | `cli-agent`（一次性） | `acp-agent`（本 example） |
|---|---|---|
| 进程模型 | 每任务 spawn → 跑完**退出** | spawn **一次**，stdio 长开，反复派任务 |
| 协议 | 无（argv + stdout 文本） | ACP = JSON-RPC 2.0 over NDJSON on child stdio |
| 任务间上下文 | 无（每次新进程） | **保留**（同一 ACP session） |
| 拦截粒度 | spawn 前 regex 闸（T2） | `session/request_permission` 逐动作闸（T2，更细） |

```
  一次性  hub ──spawn(claude -p)──▶ CLI ──退出       (cli-agent)
  长连接  hub ──spawn 一次──▶ agent  ⇄ ACP session    (acp-agent，本 example)
          └── initialize → session/new → prompt → prompt → … ──┘
```

## 跑起来

```bash
pnpm demo:acp-coding-bridge
```

不需要任何 API key——demo 真 spawn 一个确定性的 mock ACP server（`src/mock-acp-server.mjs`，
纯 node，说 NDJSON），把五条缝逐个演一遍，并且当场证明「同一个 session 反复派任务」。

## 五条控制缝（演示故事）

| 缝 | 在 demo 里 | 机制 |
|---|---|---|
| **OBSERVE** 可观测 | agent 的 `session/update` 消息块实时打到 stdout | `onChunk(taskId, chunk)`（host 接到 transcript chunk 事件） |
| **HOLD** 持有 session | 第二个任务命中**同一个**已握手的 session（turn 计数器递增） | 一个 `AcpParticipant` == 一个子进程 == 一个 ACP session，懒启动后缓存 |
| **INTERCEPT** 可拦截 | agent 要跑 `rm -rf build` → 闸升级 → 任务挂起 | `session/request_permission` 反向请求 → `gate(ctx)` → escalate |
| **HANDOFF** 可移交 | 挂起态带着工具上下文（host 映射成 inbox item） | `SuspendTaskError({ state })` 带 `permissionToken` + 工具上下文落盘 |
| **RESUME** 可续跑 | 批准 → 答复挂起的权限 → **同一轮**续完，权限前的流式输出原样保留 | `handleResume(task, state)` 答复在飞反向请求（无漂移） |
| **TERMINATE** 可终止 | 卡死的一轮被取消 → ACP cancel + abort 结束它 | `onTaskCancelled` → `session/cancel` + `AbortController`；`onShutdown` 杀子进程 |

第 5 步还演了 **fail-closed**：拒绝 `rm -rf build` → agent 走 refusal、那条破坏性的
`perm:allowed` 工作**从未发生**。

## ACP 速记（设计钉死的子集）

- 传输：JSON-RPC 2.0 over child stdio，**NDJSON**——一行一条消息（**非** LSP
  Content-Length）。framing 隔离在 `@aipehub/acp-agent` 的 `acp-connection.ts`。
- client(hub)→agent：`initialize`（能力协商）→ 可选 `authenticate` → `session/new`
  （返 `sessionId`）→ `session/prompt`（派任务，**阻塞到本轮结束**，返 `stopReason`）→
  `session/cancel`。
- agent→client 通知：`session/update`（流式消息块）——OBSERVE 流。
- agent→client **反向请求**：`session/request_permission`（agent 要跑 tool / 改文件 /
  执行命令，等 hub 批/拒）——INTERCEPT 缝。MVP 对 `fs/*` / `terminal/*` 反向请求用
  JSON-RPC error 拒（推迟）。

## 指到真 agent（非 hermetic）

把 `command` / `args` 换成 `src/presets.ts` 里的一条预设、去掉 mock 即可。控制面完全
一样。**这些 bridge 用各自 agent 自己的登录态认证，hub 不注入任何 API key。**

| 预设 | 命令 | 认证 |
|---|---|---|
| `claude-code-acp` | `npx @zed-industries/claude-code-acp` | Claude Code 自己的登录（先跑一次 `claude` 登录） |
| `codex-acp` | `codex-acp` | Codex CLI 自己的登录（先跑一次 `codex` 登录） |

```ts
import { AcpParticipant, dangerousToolGate } from '@aipehub/acp-agent'
import { ACP_PRESETS } from './presets.js'

const p = ACP_PRESETS['claude-code-acp']
const coder = new AcpParticipant({
  id: 'claude-code',
  capabilities: ['code'],
  command: p.command,
  args: p.args,
  cwd: '/path/to/repo',          // agent 操作的仓库
  onChunk: (taskId, c) => hub.appendTranscriptChunk(taskId, c.text ?? ''), // 观测缝
  gate: dangerousToolGate(),     // T2：危险工具升级等人批；常见情形当场放/拒
})
hub.register(coder)
// 第一个任务懒启动 session（spawn + initialize + session/new），后续任务复用它
```

> ACP bridge 还年轻，包名 / 二进制名 / 命令形状会变——用前先核对 bridge 自己的 README。
> 预设是「这是个 config 不是 per-agent code」的示范，不是当前 flag 的权威。

真机联调脚本见 `start:live`（M8 交付，非 hermetic，进不了 CI）。马来西亚网络从国际 CDN
拉 `npx @zed-industries/claude-code-acp` 偶发 SSL 解密失败，按全局约定带 `--retry` /
用 brew curl（见根 `CLAUDE.md`）。

## 持久化边界（诚实的 MVP 边界）

权限升级是 **内存耦合** 的：挂起时子进程**正阻塞**在那个反向请求上，`SuspendTaskError`
落盘的 `permissionToken` 引用的是一个**内存句柄**。

- **同步闸（不挂起）**：`dangerousToolGate` 对多数权限**当场**批/拒，无 hub 往返——
  脆弱的挂起是例外，不是常态。
- **不跨 hub 重启**：hub 死则子进程同死、在飞反向请求丢失。恢复时句柄查不到 →
  `handleResume` **大声失败**（「ACP 权限句柄已失效，session 已丢，请重新派发」），
  **绝不挂死**。跨重启恢复 mid-permission（需 `session/load` + 重建反向请求）是兔子洞，
  MVP 外。

对比 cli-agent：那边 park 带可重跑的 transcript（持久，新进程重跑）；这边 park 带内存
句柄（非持久，活阻塞子进程即资源）——都到 T2，差别在 park 引用什么。

## 安全须知

- **动作闸是默认推荐**。`dangerousToolGate()` 用一组保守的危险模式（`rm -rf` / `git
  push` / `git reset --hard` / `npm publish` / `sudo` / `curl|sh` / `drop table` /
  `kubectl delete`）。命中 → 升级等人批。给会改文件 / 花钱 / 对外发的真 agent，**务必挂
  一个闸**（契约里这类副作用面要钉到 T2）。
- **prompt 注入**：agent 拿到的 prompt 来自派发它的 task。task origin 不可信（跨组织
  A2A / IM 桥）就先在 hub 边界把副作用面钉到 T2（动作闸 + 受限 `cwd` + 最小 `env`）。
- **凭证**：ACP bridge 走 agent 自己的登录态，hub 不注入 key，也别继承整个 `process.env`。

## 验收门

`packages/host/tests/acp-agent-e2e.test.ts` 是这个 adapter 的验收测试：真 Hub +
production-shaped suspendNotifier→identity + 真 FileInboxStore + 真 spawn 的 mock ACP
server（真 stdio / NDJSON），照五条缝跑一遍（observe + hold session→拦截升级挂起→inbox
移交→批准续跑且无漂移→fail-closed→终止）。这就是契约 §5 的确定性 E2E 验收门。

## 相关

- `packages/acp-agent/` — `AcpParticipant` + `AcpSession` + `acp-connection`（NDJSON）+ 权限闸原语（core-only 叶包）
- `examples/coding-agent-bridge/` — 一次性 shell-out 的姊妹 example（`CliParticipant`）
- `docs/zh/AGENT-ADAPTER-CONTRACT.md` — 双向 + 可快速接管的契约本体
- `docs/zh/QUICK-CONNECT.md` — 入站方向（`aipehub connect <agent>`）
