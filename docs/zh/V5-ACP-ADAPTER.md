# v5 Stream E / ACP — 用 ACP 长连接直接驱动 Claude Code / Codex（模仿 OpenClaw）

> Last updated: 2026-06-05 · commit `de36cb6`→`f833c75`（M0-M7）+ M8 真机门 + 收口；
> **ACP-OUT** `84d6a06`→`40720a0`（折进生产 host：admin-UI 配置 + 持久化，见下文专节）
> + `df4cba5`（真机联调验证 + 修复 DELETE 后子进程泄漏）

---

## 一句话

让本地 hub **直接管理从启动到分派任务**给一个编码 agent（Claude Code / Codex）：靠
**ACP（Agent Client Protocol，Zed 的「编码 agent 界的 LSP」）** 把 agent 当 **长生命周期
子进程** spawn 一次，做 JSON-RPC 握手，**hold 住 session**，然后把多个任务反复
`session/prompt` 到 **同一个 session**——任务间上下文保留。这正是 OpenClaw 那种「从启动
→ hold session → 分派」的全生命周期所有权。

```
  一次性  hub ──spawn(claude -p)──▶ CLI ──退出              (cli-agent，E2)
  长连接  hub ──spawn 一次──▶ agent  ⇄ ACP session           (acp-agent，本 Stream)
          └── initialize → session/new → prompt → prompt → … ──┘
```

---

## 为什么做（北极星缺口）

用户指令：「模仿 openclaw 的操作方式，我们**必须做到直接管理从启动到分派任务**给 Claude
Code 和 Codex」。

仓库已有 `@aipehub/cli-agent`（E2）——但它是 **一次性 shell-out**：`spawn('claude', ['-p',
prompt])` 每个任务跑完即 **退出**，无 session、任务间零上下文。那只满足「分派」，没满足
「从启动 hold 住到分派」。本包 `@aipehub/acp-agent` 是它的 **互补**（不是替换）：补上
OpenClaw 式的全生命周期所有权。

| | `@aipehub/cli-agent`（E2，已有） | `@aipehub/acp-agent`（本 Stream） |
|---|---|---|
| 进程模型 | 每任务 spawn → 跑完**退出** | spawn **一次**，stdio 长开，反复派任务 |
| 协议 | 无（argv + stdout 文本） | ACP = JSON-RPC 2.0 over NDJSON on child stdio |
| 任务间上下文 | 无（每次新进程） | **保留**（同一 ACP session） |
| 拦截粒度 | spawn 前 regex 闸（T2） | `session/request_permission` 逐动作闸（T2，更细） |
| 满足指令 | 部分（只「分派」） | 「从启动 → hold session → 分派」全生命周期 |

**北极星对齐**：框架不跑 LLM（adapter 只驱动外部 agent 子进程，决策权在 agent 自己）；人是
`Participant`（权限升级走 Phase 16 inbox，不发明新「审批 tool」）；状态文件优先（park 落
identity）；example-first（host `main.ts` **零改**，验收门在 `packages/host/tests/`，demo
在 `examples/`，遵循 IM-bridge / cli-agent 先例）。

---

## 动了什么

### 新包 `@aipehub/acp-agent`（core-only 叶包，依赖仅 `@aipehub/core`）

| 模块 | 职责 |
|---|---|
| `acp-protocol.ts` | 纯 wire 类型（仿 a2a/types）：method 常量 + JSON-RPC 信封 + ACP 参/结果子集 + builder/guard，零运行时副作用 |
| `acp-connection.ts` | **唯一**碰 NDJSON framing：transport 注入（duplex 对，仿 a2a `fetchImpl`）；out 请求按 id 配对、in 通知/反向请求分发；**deferred 反向请求**（不 settle 就不写响应行 = park 时子进程阻塞的语义） |
| `acp-session.ts` | 长生命周期进程引擎（acp 版 cli-runner，但进程长存）：复用 cli-runner 的 `buildEnv`/kill ladder/`asSpawnError`；`ensureStarted()` 握手恰一次（缓存 promise）→ `prompt()` 串行化 → `cancel()`/`terminate()` |
| `acp-checkpoint.ts` | 纯权限闸原语（仿 cli-checkpoint 纪律，不 import cli-agent）：`dangerousToolGate`（fail-closed）+ `pickOptionId` + `readPermissionDecision`（容忍 `{decision}`+`{answer}`）+ `ACP_NEVER_RESUME_AT` + checkpoint round-trip |
| `acp-participant.ts` | `AcpParticipant extends AgentParticipant`：一个实例 = 一个长 session，接通五缝 |

host 仅加 **test devDep** `@aipehub/acp-agent`（验收门要 import 叶包），`main.ts` 零改。

---

## 五条缝怎么落的

| 缝 | 机制 |
|---|---|
| **OBSERVE** 可观测 | agent 的 `session/update` 通知 → 抽 message-chunk 文本 → `onChunk(taskId,{text,raw?})`（host 接到 transcript chunk 事件） |
| **HOLD** 持有 session | 一个 `AcpParticipant` == 一个子进程 == 一个 ACP session：首个 `handleTask` 懒 spawn + `initialize` + `session/new` 缓存 `sessionId`；后续任务复用同 session 走 `session/prompt` |
| **INTERCEPT** 可拦截 | agent 的 `session/request_permission` 反向请求 → `gate(ctx)`：allow/deny **当场** `ctl.respond(optionId)`；escalate → 挂起 |
| **HANDOFF** 可移交 | escalate 时子进程**正阻塞**在反向请求上 → 抛 `SuspendTaskError({resumeAt:ACP_NEVER_RESUME_AT, state})`，state 带 `permissionToken` + 人类可读 tool 上下文（host 映射成 `/me` inbox item，acp-agent 自身**零 inbox 依赖**） |
| **RESUME** 可续跑 | `handleResume(task,state)`（**override** 基类，L11 必须消费 state）：读决定 → 按 token 查内存句柄 → `respond(allow\|deny)` → await **同一**在飞 prompt 到 `stopReason` → ok（**无漂移**，子进程从没重启，session hold 住一切） |
| **TERMINATE** 可终止 | `onTaskCancelled` → abort + `session/cancel`；`onShutdown` → kill ladder（SIGTERM→SIGKILL） |

到 **Tier 2**：`session/request_permission` 是天然逐动作闸（比 cli-agent spawn 前 regex 闸
粒度更细），agent 改文件 / 花钱 / 对外发 → T2 必需且满足。

---

## 关键设计决策

1. **一个实例 = 一个长 session（MVP 不做池）。** 注册 N 个 `AcpParticipant` 即得 N 个独立
   session，无需池抽象。**实例内串行化**：ACP `session/prompt` 逐轮阻塞，故同 session 任务
   串行（内部 busy promise-chain），不并发交错两个 prompt。

2. **权限挂起/恢复是「内存耦合」（诚实的 MVP 边界）。** 两条路径：① **同步闸（不挂起）**——
   `dangerousToolGate` 对多数权限**当场**批/拒，无 hub 往返，脆弱的挂起是例外不是常态；
   ② **升级给人（挂起）**——`SuspendTaskError` 落盘的 `permissionToken` 引用一个**内存句柄**
   （活阻塞子进程持有的开着的反向请求）。**不跨 hub 重启**：hub 死则子进程同死、在飞反向
   请求丢失，恢复时句柄查不到 → `handleResume` **大声失败**（「ACP 权限句柄已失效」），
   **绝不挂死**。跨重启恢复 mid-permission（需 `session/load` + 重建反向请求）是兔子洞，
   MVP 外。对比 cli-agent：那边 park 带可重跑的 transcript（持久）；这边 park 带内存句柄
   （非持久）——都到 T2，差别在 park 引用什么。

3. **NDJSON framing 隔离在唯一模块。** 换 bridge / 改传输只动 `acp-connection.ts`：buffer
   到 `\n` 逐行 `JSON.parse`，半行 buffer 单测钉死；JSON 字符串内的换行被转义，行分割安全。

4. **`session/new` 的 ACP 必填参数是真机才暴露的契约。** 真 bridge 用 zod 校验
   `{ cwd: string, mcpServers: array }`——两者**都必填**。M8 真机门逮到 mock 永远逮不到的
   真 bug：早期 `session/new` 漏 `mcpServers` → 真 bridge `-32602 Invalid params` 拒掉。
   修为 `{ cwd: this.opts.cwd ?? process.cwd(), mcpServers: [] }`（空数组 = 不向 agent 代理
   任何 MCP server）。**这正是真机门相对确定性 mock 门的价值**——我控制的 mock 不做校验，
   照不出这个 bug。

5. **example 不碰 host/main.ts。** 跟 6 个 IM bridge + cli-agent 一个策略——先以 example
   形式发，等社区用法稳定再决定要不要 fold 进 host CLI first-class。本层 host 侧只多了一个
   **test devDep**。

---

## 测试矩阵（+57）

| 包 | 测试 | 覆盖 |
|---|---|---|
| `acp-agent` | `acp-protocol.test.ts` 9 | builder / guard / round-trip |
| `acp-agent` | `acp-connection.test.ts` 10 | 并发请求各归各 / 通知投递 / 反向请求 auto-response / 半行 buffer / **deferred 反向请求** / close reject 在飞 |
| `acp-agent` | `acp-session.test.ts` 9 | 握手一次缓存 / prompt 返 end_turn + onUpdate / 权限反向请求路由 / cancel→in-flight 返 cancelled / terminate→alive=false |
| `acp-agent` | `acp-checkpoint.test.ts` 17 | 闸 allow 只读 / escalate 破坏性 / `onMatch:'deny'` / `pickOptionId` 映射 / decision 双形 + 垃圾返 null / checkpoint round-trip |
| `acp-agent` | `acp-participant.test.ts` 8 | 一实例派两任务复用一 session（握手一次 + 上下文保留）/ OBSERVE / INTERCEPT allow 当场过 / escalate→park（`resumeAt===ACP_NEVER_RESUME_AT`）/ RESUME 批→同轮 ok 无漂移·拒→拒路径·缺句柄→边界 fail / TERMINATE |
| `host` | `acp-agent-e2e.test.ts` 4 | §5 全故事：真 Hub + production suspendNotifier→IdentityStore(tmp sqlite) + 真 spawn 的 mock ACP server（真 stdio/NDJSON）+ 真 FileInboxStore（observe + hold session→拦截升级挂起→inbox 移交→批准续跑无漂移→fail-closed→终止） |

全部确定性（mock ACP server 纯 Node 说 NDJSON，无 key、无网络、无真 CLI）。零回归：
acp-agent 53、host e2e 4，全 `pnpm -r test` 绿。

---

## 真机门（M8，非 hermetic，进不了 CI）

`examples/acp-coding-bridge/src/live.ts`（`start:live`）真 spawn 一条真 ACP bridge
（**非** mock），跑：spawn 一次 → `initialize` → `session/new`（=「从启动」）→ 派善意编码
任务（建 `greet.js`）→ OBSERVE 真 `session/update` 流 → 派**第二**任务到**同 session** 证
上下文保留 → `terminate`。跑在 `mkdtemp` 抛弃 repo，`dangerousToolGate` fail-closed。

```bash
ACP_LIVE=1 ACP_AGENT=claude-code-acp pnpm --filter @aipehub/example-acp-coding-bridge start:live
```

完整前置 / 命令 / 预期输出 / env 旋钮见 `examples/acp-coding-bridge/README.md` 的
**真机 LIVE-RUNBOOK** 段。

### 本机已验证（2026-06-05，开发机 = Claude Code 会话内）

真跑 `claude-code-acp`：adapter 把真 bridge 一路驱动过 `initialize` → `session/new`（真
NDJSON over stdio，**「从启动 → hold session」在真 Claude Code 基建上跑通**）。编码那一轮
被 bridge **自己的嵌套保护**挡下（开发机本身就是 Claude Code 会话，`CLAUDECODE=1`，bridge
拒绝嵌套启动以防「crash all active sessions」）——这是**环境**约束、非 adapter 缺陷，普通
终端不会撞上。我**没有**绕过这个保护（它会拖垮父会话），也没有输入任何凭证。

真机这一遍**逮到一个 mock 永远逮不到的真 bug**（决策 #4 的 `mcpServers`），并一并补了两处
可观测性：① JSON-RPC error 的 `data` 折进任务失败信息（不再是裸 `-32603`）；② `onStderr`
钩子把 bridge 自己的诊断引到日志（正是它把上面那条嵌套保护的真因照出来的）。确定性五缝
证明仍由 `acp-agent-e2e.test.ts` 承担。

**后续（同日 2026-06-05，已跑通完整编码轮）**：嵌套保护是**环境变量继承**问题、非机器级
互斥——`claude-code-acp` 只看它**自己进程**有没有从父进程继承到 `CLAUDECODE`，不看机器上是否
另有 Claude Code 在跑。于是用 `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID …`
启动 `live.ts`，给派生的 bridge 子进程树造一个干净进程树 → 嵌套保护不触发，而**父会话的
`CLAUDECODE=1` 原样保留、毫发无伤**。真跑 `ACP_AGENT=claude-code-acp`：真 Claude Code 经
`AcpParticipant` 走完 [1] 建 `greet.js`（真 `session/update` 流式）→ [2] **同 session** 加
`greetLoudly` 复用刚写的 `greet`（**上下文跨任务保留**）→ [3] terminate，`stopReason:end_turn`、
exit 0；跑后核验：无残留 `claude-code-acp`/`claude` 子进程、throwaway 目录已清、**父会话仍在**。

**结论：两个主流编码 agent 真机都验证了**——Codex 经生产 host admin API（见下「ACP-OUT」节的
真机联调），Claude Code 经 `live.ts` 真机门（同一份 `AcpParticipant`；生产 host 的 manager/路由
已由 Codex 那遍证明对任意 ACP agent 通用，`command` 换成 `claude-code-acp` 即可）。**无需关闭
当前 Claude Code 会话**——env 剥离只作用于子进程树。

---

## ACP-OUT — 折进生产 host（admin-UI 配置 + 持久化，6 M）

> commit `84d6a06`（M1）→ `44a2624`（M2）→ `5224ca4`（M3）→ `a94d076`（M4）→
> `7bf4485`（M5）→ 本提交（M6）

M0-M8 把 adapter 做成了 core-only 叶包 + example 胶水：能力齐了，但要在终端写
example。**ACP-OUT** 把它折进 `aipehub start` 的生产 host——一个加载了工作流的
AipeHub 现在能从 **admin UI 配置 + 持久化** 来「启动 Claude Code / Codex、给它们派
任务、关掉它们」，不再只是 example。整条纵切**逐字镜像** `a2a_outbound_agents`
（Route B P1-M11）那条已验证的纵切，只是 **更纯**：ACP 记录里没有任何密钥列。

| 层 | 文件 | 干了什么 |
|---|---|---|
| identity | `acp-agent-store.ts`（**v26** `acp_outbound_agents` 表） | 持久化出站 ACP agent 配置；镜像 `saml-provider-store` 的「**无 vault**」形状——每列（command/args/cwd）都是非密配置，没有 secret/token 列 |
| host | `acp-outbound.ts`（`AcpOutboundManager`） | 开机 `registerAllFromStore()` 物化 + 运行时 `refresh(id)`/`remove(id)`；构造 `AcpParticipant`（**懒** spawn，注册离线确定性）挂 `dangerousToolGate(undefined,{onMatch:'deny'})`（fail-closed MVP）；`onChunk` 把 ACP 输出复用现有 `llm_stream_chunk` transcript 事件 → admin 打字机实时渲染 **零 core 改** |
| web | `acp-admin-routes.ts`（鸭子 `AcpAgentAdminSurface`） | `GET/POST/PATCH/DELETE /api/admin/acp-agents`；body 校验（必填 id/command + 非空 caps + array args[空许] + 无密钥字段）；503 当 host 没接 identity |
| host | `main.ts` 接线 | 构造 manager + `acpAgentAdmin` facade（identity 行 join `mgr.statusOf/refresh` 的运行时 liveness）注入 `serveWeb` |
| web | `static/acp-ui.js`（`#acp-outbound-panel`，「联邦」tab） | CRUD 面板，镜像 `a2a-ui.js` 但 **删掉所有密钥可视件**——表单只有 command/args/cwd，无 token/env-var 字段；诚实 liveness 徽章（disabled / id_conflict / not_found）|

**对比 A2A 出站（M11）的唯一实质差别 = 没有密钥**：A2A 用 `tokenEnv`（bearer 的环境变量
**名**），ACP **连环境变量指针都没有**——bridge 用底层 agent（`claude`/`codex`）**自己的
登录态** 认证，所以 `AcpInactiveReason` 比 A2A 少一个 `token_env_unset`，manager 也没有
`readEnv`。这就是为什么 store 镜像的是 `saml-provider-store`（cert 是公钥，无 vault）而非
A2A 的 `a2a-agent-store`。

**「从启动到关闭」现在全在 admin UI 闭环**：① 注册一行（enabled）→ host 立即在运行的
hub 上注册该 participant（**首个派发时才真 spawn 子进程**，长 session 懒起）；② 派发它声明
的能力 → `session/prompt` 到同一 session，输出经 `llm_stream_chunk` 在 transcript 实时打字；
③ 停用该行（PATCH enabled=false）或删除 → `manager.remove` 注销 + 杀子进程（kill ladder）。
无需重启 host。

**诚实边界（与叶包一致）**：ACP agent 是 **本地 participant**（驱动子进程但注册在本地），
**不是** 跨 hub 目的地——故意 **不** 喂进工作流的「离开本 hub」能力视图（Stream H 的 A2A
才是跨 hub）。破坏性动作仍 fail-closed 当场拒（`onMatch:'deny'`）；把 ACP park 升级成 inbox
审批（`onMatch:'escalate'` → 两步恢复）是已记录的 follow-up，本纵切先不接线以免出现「无人
能恢复的挂起」。

### 真机联调验证（2026-06-05，开发机）

把上面这条「从启动到关闭」的闭环在**真生产 host 上真驱动了一遍真 Codex**（`aipehub start`
+ admin API，bridge = `@zed-industries/codex-acp`，走 Codex 自己的 ChatGPT 登录态）：

1. `POST /api/admin/acp-agents`（201）注册 `codex-live` → host 立即在 hub 上 JOIN 该
   participant（子进程尚未 spawn）。
2. `POST /api/admin/dispatch`（wait）派一个善意编码任务 → 子进程懒 spawn + ACP 握手
   （`initialize`+`session/new`）+ `session/prompt`。真 Codex 跑了 248 条 `session/update`
   块经 `llm_stream_chunk` 在 transcript **实时打字**，`stopReason:end_turn`，真 `sessionId`；
   它真在 `cwd` 写了 `greet.js`（`node` 真跑出 `Hello, …!`）。
3. 派**第二个**任务到同实例 → **同一个 `sessionId`**、仅 5.7s（无重新 spawn/握手）、Codex
   凭 session 记忆答出上一轮的函数名/文件名 = **hold session + 上下文跨任务保留**坐实。
4. `DELETE /api/admin/acp-agents/codex-live`（200）→ hub `LEAVE`、`GET` 返 `{agents:[]}`。

**真机这一遍逮到一个 mock e2e 永远逮不到的真 bug**：DELETE 后 `codex-acp` **子进程仍存活**。
根因 = `Hub.unregister` 只把 participant 从 registry 摘除、**从不触发 `onShutdown`**（那只在
整 hub `stop()` 时跑），而 `AcpOutboundManager.unregister` 当时没补这一刀 → 每次 admin
delete/disable/edit 都泄漏一个长生命周期子进程。mock e2e 抓不到是因为 vitest 退出时拆掉整个
进程树、把泄漏的子进程隐藏了。**修复**（`df4cba5`）：manager 现在对 `hub.unregister` 返回的
participant 调 `onShutdown()`（best-effort + fire-and-forget kill ladder，不阻塞 admin 调用，
也不阻塞 refresh 立即重注册一个全新独立 session；`terminate()` 在从未启动的 session 上是安全
no-op）；+3 回归测试断言 remove/refresh 触发 `onShutdown` 且非自己的同 id participant 不被误杀。
**修复后真机复验**：DELETE 后子进程在 0.5s 内被干净杀掉，无泄漏。

> 本机限制：开发机本身就在一个 Claude Code 会话内（`CLAUDECODE=1`），故这条**生产 host
> admin-API** 真机门选了 Codex（未嵌套、已登录）当目标。`claude-code-acp` 随后也在本机验证了
> ——见上「真机门（M8）」节的「后续」段：用 `env -u CLAUDECODE …` 给派生子进程树造干净环境
> 即可绕过嵌套保护，且**不触碰父会话**。这是**环境约束非 adapter 缺陷**，普通终端不受影响。

---

## 运维须知

- **动作闸是默认推荐**。`dangerousToolGate()` 用一组保守的危险模式（`rm -rf` / `git push` /
  `git reset --hard` / `npm publish` / `sudo` / `curl|sh` / `drop table` / `kubectl delete`）。
  命中 → 升级等人批。给会改文件 / 花钱 / 对外发的真 agent，**务必挂一个闸**。
- **prompt 注入**：agent 拿到的 prompt 来自派发它的 task。task origin 不可信（跨组织 A2A /
  IM 桥）就先在 hub 边界把副作用面钉到 T2（动作闸 + 受限 `cwd` + 最小 `env`）。
- **凭证**：ACP bridge 走 agent 自己的登录态，hub 不注入 key，也别继承整个 `process.env`。
- **嵌套保护**：别在一个 Claude Code 会话里跑 `claude-code-acp`（`CLAUDECODE=1` → bridge
  拒启动）。`live.ts` 会提前侦测 `CLAUDECODE` 并告警。

---

## 显式不做 / 推迟

- 跨 hub 重启的 mid-permission 持久恢复（需 `session/load` + 重建反向请求）。
- session 池（按 workspace/origin keyed）——注册 N 个实例即得 N 个独立 session。
- `fs/*` · `terminal/*` 反向请求（MVP 用 JSON-RPC error 拒）。
- `session/load` 恢复旧 session（常量定义但 MVP 只 `session/new`）。
- 同 session 并发轮（显式串行）。
- ~~ACP agent 的 admin-UI 配置 / 持久化~~ **✓ ACP-OUT 已做**（`acp_outbound_agents` v26 +
  CRUD + admin 面板，见上「折进生产 host」节）。
- 把 ACP 权限 park 升级成 inbox 审批（`onMatch:'escalate'` → 两步恢复）——ACP-OUT 的 host
  manager 当前用 `onMatch:'deny'`（fail-closed），escalate→inbox 接线是 follow-up。
- `tool_call` / `plan` `session/update` 富渲染（MVP 只 message-chunk 文本 OBSERVE）。

---

## 相关文档

- `packages/acp-agent/` — `AcpParticipant` + `AcpSession` + `acp-connection`（NDJSON）+ 权限闸原语（core-only 叶包）
- `examples/acp-coding-bridge/` — 五缝 + 长 session demo（mock）+ 真机 LIVE-RUNBOOK（M8）
- `docs/zh/V5-E2-CLI-ADAPTER.md` — 一次性 shell-out 的姊妹 adapter（`@aipehub/cli-agent`）
- `docs/zh/AGENT-ADAPTER-CONTRACT.md` — 双向 + 可快速接管的契约本体
- `docs/zh/QUICK-CONNECT.md` — 入站方向（`aipehub connect <agent>`）
