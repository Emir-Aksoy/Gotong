# AipeHub Wire Protocol v1.2

> 同步自英文版 [`docs/PROTOCOL.md`](../PROTOCOL.md) @ 2026-05-17

让远程 agent 通过网络连接到 Hub 的协议。**JSON frame over WebSocket**
（`ws://` 或 `wss://`）。

这套协议**不是**本地 agent 用的 —— 本地 agent 跟 Hub 在同一进程，
直接调 `Participant` 接口。本文档只跟跨进程 / 跨网络的 agent 相关。

## 概览

- **拓扑**：Hub 是 server，agent 是 client。每个 TCP 连接可以
  承载来自同一客户端进程的一个或多个 agent。
- **版本号**：`protocolVersion` 是 SemVer 风格。主版本必须一致。
  AipeHub v0.1 出货协议 `1.0`；v0.4 升 `1.1`（services-over-ws，
  additive）；v0.5 升 `1.2`（per-method ACL + 第三方白名单扩展 +
  审计 transcript，全部 additive —— v1.0 / v1.1 / v1.2 双向互通）。
- **序列化**：JSON over WebSocket text frame。每个 frame 是一个
  自包含 JSON 对象，靠 `type` 字段区分。
- **并发**：一个连接上的 frame 可以任意交错。同一 agent 的 TASK
  投递顺序由 Hub 保持；RESULT 可以按任意顺序回来。

## v1.2 新增

- `ServiceUseDecl.methods?: string[]` —— 可选的**逐声明方法 ACL 收窄**。
  写"我只要 `recall` 和 `list`"，针对 `remember` 的 SERVICE_CALL
  即便 type 级白名单允许，也会回 **`forbidden_method`**。
- **第三方 service type 白名单扩展** —— 插件出货带 `wireMethods` 数组；
  host 启动时调 `registerServiceMethods(type, methods)`，router 就
  可以把非内建 service 类别的 SERVICE_CALL 分发出去。
- 新错误码 `forbidden_method` 加入 SERVICE_RESULT error 枚举（其余
  保持 v1.1 不变）。
- 新 transcript 条目类型 `service_call` —— 每个解析的 SERVICE_CALL
  追加一条审计条目，含 `{from, type, impl, ownerKind, ownerId, method, outcome, durationMs}`。
  **args 故意不记录**。

## v1.1 新增

- `HELLO.services?: ServiceUseDecl[]` —— 可选字段；远端 agent 声明
  本连接想驱动哪些 Hub Services（memory / artifact / datastore）。
  在 HELLO 时绑定，这样管理员审申请时能看到完整 ACL；server 端由
  `ServiceCallRouter` 强制执行。
- `SERVICE_CALL`（client → server）+ `SERVICE_RESULT`（server → client）
  —— 同一 socket 上的 RPC。wire surface 跟 in-process `ServiceCtx` API
  完全对齐，所以 agent 的 `this.services.memory.recall(...)` 在
  in-process 跑还是 WS 跑都是一样的写法。
- 声明里的通配 owner `id: '*'` 和缩写 `id: 'self'` —— v1.1 出货的
  唯一两个 ACL 原语；前缀匹配推到 v1.2 再做。

设计思路、ACL 语义、迁移计划：`docs/services-over-ws-rfc.md`。

## Frame 信封

每个 frame 都是 `{ "type": "<NAME>", ...fields }`。**未知字段被忽略**
（向前兼容）。

## 状态机

```
Client                                    Server
  CONNECTING ──── ws handshake ────►       AWAIT_HELLO
  CONNECTED ───── HELLO ──────────►        validating
  AUTH       ◄─── WELCOME ─────────        READY
                  or
             ◄─── REJECT, close ─────       DEAD
  READY                                    READY
  …正常流量…
  CLOSING ─────── GOODBYE ────────►        CLOSING
        ◄──────── GOODBYE / close          DEAD
  CLOSED                                   DEAD
```

5 秒内没发 HELLO 的连接会被 server 关掉。

## Frame 列表

### `HELLO` —— client → server（第一帧）

声明本连接承载的所有 agent。

```ts
{
  type: "HELLO",
  protocolVersion: "1.1",                      // "1.0" 仍接受
  client: { name: string, version: string },  // 用于日志 / 调试
  agents: Array<{
    id: ParticipantId,                         // 必须在 hub 内唯一
    capabilities: string[],
  }>,
  apiKey?: string,                             // v0.1 是可选的
  // v1.1+ —— 声明本连接可以通过 SERVICE_CALL 调用哪些 Hub Services。
  // 每个条目是 `{type, impl, owner: {kind, id}, config?}`。
  // `owner.id` 接受字面量 `'self'`（仅限 agent，server 端替换为
  // 调用 agent 的 id）和 `'*'`（匹配该 kind 下任何具体 id）。
  // 同一个 (type, impl) 多条目在 ACL 时取并集。见
  // docs/services-over-ws-rfc.md §3 + §4。
  services?: Array<{
    type: "memory" | "artifact" | "datastore" | string,
    impl: string,                              // 比如 "file" / "sqlite"
    owner: {
      kind: "agent" | "workflow-run" | "shared",
      id: string                               // 具体 id | "self" | "*"
    },
    config?: unknown                           // 插件定义；首次 attach 时校验
  }>
}
```

### `WELCOME` —— server → client

HELLO 通过后发。两边都进入 `READY`。

```ts
{
  type: "WELCOME",
  sessionId: string,
  protocolVersion: "1.0",
  serverTime: number,                          // ms since epoch
  heartbeatIntervalMs: number                  // 一般 30000
}
```

### `REJECT` —— server → client，跟着关闭

```ts
{
  type: "REJECT",
  code: "auth_failed"        // apiKey 被拒，或 verifier 返回 { ok: false }
      | "forbidden_agent"    // apiKey 有效但无权注册某个声明的 id（v0.4+）
      | "duplicate_id"       // 某个声明的 id 已在 hub registry
      | "protocol_mismatch"  // HELLO.protocolVersion 的主版本不一致
      | "bad_hello"          // HELLO 格式错（比如 agents 数组为空）
      | "internal_error",
  message: string
}
```

**`forbidden_agent`**（在协议 1.0 的小修订引入，AipeHub v0.4）：
server 的 `authenticate` 钩子返回了 `{ ok: true, allowedAgents: [...] }`，
但 `HELLO.agents` 里至少有一个 id 不在那个白名单里。
用它把一个 API key 绑死到一组固定的 agent 身份 —— 这样泄漏的 key
也无法假冒部署里的任何其他 agent。客户端应把未知 code 当作通用
鉴权 / 配置失败处理，并把 `message` 透传给运维。

### `TASK` —— server → client

```ts
{
  type: "TASK",
  recipient: ParticipantId,   // 本连接的哪个 agent
  task: {                      // core Task 形状
    id, from, strategy, payload, title?, deadlineMs?, createdAt
  }
}
```

### `RESULT` —— client → server

```ts
{
  type: "RESULT",
  result: {
    kind: "ok" | "failed" | "cancelled" | "no_participant",
    taskId, by, ts,
    ...kind 特有字段
  }
}
```

迟到的 result（CANCEL 之后或断连之后）会被 Hub 静默丢弃。

### `SERVICE_CALL` —— client → server（v1.1+）

调用一个 Hub Service handle 上的一个方法。Hub 把请求对照该连接的
`HELLO.services` ACL，对一个 `(type, impl, owner)` 三元组首次引用
时**惰性 attach** 底层 service handle，然后分发调用。

```ts
{
  type: "SERVICE_CALL",
  callId: string,                              // 客户端选；SERVICE_RESULT 回显
  from: ParticipantId,                         // 本连接的哪个 agent 在调
  service: {
    type: "memory" | "artifact" | "datastore" | string,
    impl: string,
    owner: { kind: "agent" | "workflow-run" | "shared", id: string }
  },
  method: string,                              // 见下方白名单
  args: unknown[]                              // 位置参数，由插件方法决定形状
}
```

**方法白名单**（server 端硬编码；不在表内的方法回 `unknown_method`）：

| Service type | 允许的方法 |
|---|---|
| `memory` | `recall`, `remember`, `list`, `forget`, `clear` |
| `artifact` | `write`, `read`, `list`, `exists`, `remove` |
| `datastore` | `kv.get`, `kv.set`, `kv.del`, `kv.keys`, `sql.exec`, `sql.query` |

第三方 service type 在 v1.1 范围外；这张表在 v1.2 做可扩展（RFC §5.3）。

### `SERVICE_RESULT` —— server → client（v1.1+）

对一个 SERVICE_CALL 的回复。按 `ok` 区分。

```ts
{
  type: "SERVICE_RESULT",
  callId: string,                              // 回显 SERVICE_CALL.callId
  ok: true,
  value: unknown                               // 方法返回值，JSON 序列化
}
// — 或 —
{
  type: "SERVICE_RESULT",
  callId: string,
  ok: false,
  error: {
    code:
      | "forbidden_service"   // (type, impl) 不在 HELLO.services 里
      | "forbidden_owner"     // owner 不匹配任何声明的 pattern
      | "forbidden_method"    // 方法不在 decl.methods 的收窄里（v1.2）
      | "attach_failed"       // 惰性 attach 时 plugin.attach 抛了
      | "service_error"       // 方法抛了（校验、配额、IO）
      | "unknown_method"      // 方法不在白名单上
      | "bad_args"            // call.args 格式错
      | "unknown_agent"       // call.from 不在本连接拥有的 agent 里
      | "session_not_ready"   // 在 WELCOME 之前 / teardown 之后到达
      | "unknown_service"     // (type, impl) 在 host 端没有插件
      | "internal_error",
    message: string,
    context?: unknown                          // 自由（回显 args / 插件 hint）
  }
}
```

连接掉时 pending 的 SERVICE_CALL 由 SDK 以 `session_not_ready` 失败
（v1.1 不保留 in-flight RPC 状态，跟 TASK frame 在 disconnect 那节
的态度一致）。

### `CANCEL` —— server → client

之前发过的某个 TASK 被取消了（通常是 broadcast race 输了）。
如果停活成本低，agent 应该停下来。**不需要回复**。

```ts
{
  type: "CANCEL",
  recipient: ParticipantId,
  taskId: TaskId,
  reason: string
}
```

### `MESSAGE` —— server → client

本连接订阅的某个参与者收到一条 channel 消息。

```ts
{
  type: "MESSAGE",
  recipient: ParticipantId,
  msg: { id, channel, from, body, ts }
}
```

### `PUBLISH` —— client → server

```ts
{
  type: "PUBLISH",
  from: ParticipantId,        // 必须是本连接拥有的 agent
  channel: ChannelId,
  body: unknown
}
```

### `SUBSCRIBE` / `UNSUBSCRIBE` —— client → server

```ts
{ type: "SUBSCRIBE",   participantId: ParticipantId, channel: ChannelId }
{ type: "UNSUBSCRIBE", participantId: ParticipantId, channel: ChannelId }
```

### `PING` / `PONG` —— 双向

```ts
{ type: "PING", ts: number }
{ type: "PONG", ts: number }   // 回显 PING 的 ts（算 RTT）
```

### `GOODBYE` —— 双向

优雅关闭。接收方回自己的 GOODBYE，然后关底层 socket。

```ts
{ type: "GOODBYE", reason?: string }
```

### `ERROR` —— server → client（非致命）

server 处理不了的 frame，但连接保留。

```ts
{
  type: "ERROR",
  code: string,             // 比如 "unknown_recipient", "forbidden_publish"
  message: string,
  context?: unknown
}
```

## 心跳

`WELCOME` 之后：

- **server** 每 `heartbeatIntervalMs` 发一次 `PING`。
- **client** 必须在 `0.5 * heartbeatIntervalMs` 内回 `PONG`。
- **连续两次** PING 没回，server 关闭连接。
- client 也可以随时发 PING；server 回 PONG。

## 重连与断连语义

连接掉时，Hub 侧的清理是：

1. **注销**本连接承载的每个参与者 → transcript 里写
   `participant_left` 条目。
2. **失败 in-flight 任务**：路由到这些参与者的任务回成
   `TaskResult { kind: 'failed', error: 'remote_disconnect' }`。
3. **忘掉 session id** —— 重连开启新 session。

v0.1 **不保留**跨重连的 in-flight 任务。客户端 SDK 应该用同样的
`agents` 数组重新发 HELLO；Hub 把它们重新注册（这样后续的
capability / explicit 派单还能继续工作）。

未来的协议修订**可能**会加 `RESUME` frame，用之前的 `sessionId`
从持久化日志里恢复 in-flight 状态。v0.1 范围外。

## 安全（v0.1 最低）

- TLS 是传输层的活 —— 生产用 `wss://`。
- HELLO 里的 `apiKey` 字段；server 配一个验证回调（或字面白名单）。
  验证失败 server 回 REJECT，`code: "auth_failed"`。
- v0.1 **没有**每任务授权。registry 里的任何 agent 都能被任何
  dispatch 触达。
- v0.4 会用 per-agent identity token 替换 `apiKey`，并加入 per-participant ACL。

## 错误码速查

| Code | Where | 含义 |
|---|---|---|
| `auth_failed` | REJECT | apiKey 验证失败 |
| `duplicate_id` | REJECT | HELLO 里的某个 agent id 已注册 |
| `protocol_mismatch` | REJECT | 主版本不一致 |
| `bad_hello` | REJECT | HELLO 格式错或缺必填字段（含 v1.1 的 `services` 声明错） |
| `internal_error` | REJECT / ERROR / SERVICE_RESULT | server 端 bug |
| `unknown_recipient` | ERROR | RESULT / PUBLISH / SUBSCRIBE 用的 agent 不属于本连接 |
| `forbidden_publish` | ERROR | PUBLISH 里的 `from` 不是本连接拥有的某个 agent |
| `unknown_task` | ERROR | RESULT 针对一个 Hub 没在悬挂的任务 |
| `forbidden_service` | SERVICE_RESULT (v1.1) | SERVICE_CALL 的 `(type, impl)` 不在 HELLO.services |
| `forbidden_owner` | SERVICE_RESULT (v1.1) | SERVICE_CALL owner 不匹配任何声明的 pattern |
| `forbidden_method` | SERVICE_RESULT (v1.2) | 方法不在匹配 decl 的 `methods` 收窄里（per-decl ACL） |
| `unknown_method` | SERVICE_RESULT (v1.1) | 方法不在该 type 的白名单上 |
| `attach_failed` | SERVICE_RESULT (v1.1) | 惰性 attach 时插件的 `attach` 抛了 |
| `service_error` | SERVICE_RESULT (v1.1) | handle 方法抛了（校验 / 配额 / IO） |
| `bad_args` | SERVICE_RESULT (v1.1) | SERVICE_CALL.args 不是数组 |
| `unknown_agent` | SERVICE_RESULT (v1.1) | SERVICE_CALL.from 不属于本连接 |
| `session_not_ready` | SERVICE_RESULT (v1.1) | 调用在 WELCOME 之前或 teardown 之后 |
| `unknown_service` | SERVICE_RESULT (v1.1) | `(type, impl)` 在 host 端没注册插件 |
