# AipeHub v3.3 全量代码审计 — 2026-05-18

> 触发：用户决定"不发 Docker，先把测试和审计补齐"，对整个 monorepo 做安全 + 正确性审计。
>
> 范围：23 个 TypeScript 包 + 1 个 Python SDK + 22 个 example + workflow/Dockerfile/scripts，总计约 60 K LOC。
>
> 方法：5 个并行 Agent 分包扫描，主线程深读核心 5 个文件（`web/server.ts`、`host/main.ts`、`core/secrets.ts`、`transport-ws/server.ts`、`transport-ws/session.ts`），最后聚合去重。
>
> 总计：**4 CRITICAL + 22 HIGH + 26 MEDIUM + 29 LOW = 81 项**。

---

## 总评

架构基线稳。`assertSafeOwnerId` + `sanitisePath` + `resolveOwnerPath` 把文件类服务的路径穿越堵得严实；`better-sqlite3` 全程参数化；`workflow/predicate.ts` 是自建 AST，不走 JS `eval()`；admin/worker token 是 256-bit URL-safe hex + sha256 哈希 + `constantTimeEqualString` 校验；AES-256-GCM 带认证标签，主密钥从 env 或 0600 文件读；HTTP 服务全套 CSP / X-Frame-Options DENY / HttpOnly+SameSite=Strict 启用，admin/worker 注册路径有 per-IP 限流，Origin+Host 头反 CSRF。

**主要风险集中在三条边界**：

1. **WebSocket 升级零硬化** —— `new WebSocketServer({ host, port })` 没有 Origin 校验、path 匹配、subprotocol 协商、`maxPayload` 限制、连接总数上限。任意浏览器从 `http://evil.example` 都能连进本机 4000 端口，且单帧最大 100 MiB。
2. **客户端 TLS 没有可配置钩子** —— sdk-node 和 python-sdk 都把 `wss://` 当默认信任系统 CA，没暴露 `ca` / `servername` / `rejectUnauthorized` 接口；用户在内部 CA 场景下只能 `NODE_TLS_REJECT_UNAUTHORIZED=0` 全局关验证。同时 `apiKey` 在 `ws://` URL 下静默走明文，没有告警。
3. **本机文件信任假设** —— `secrets.enc.json` 用默认 umask（通常 0644）写出，仅 `runtime/secret.key` 是 0600；workspace 根目录没有 `lstat` 检测符号链接，也不验证文件属主。多用户主机下同机攻击面比设计文档承诺的"备份无用"模型大。

下面按严重度排列。每条带文件:行号和修复建议。

---

## CRITICAL（4）

### C1. WebSocket 升级零硬化
**文件**：`packages/transport-ws/src/server.ts:136`

`new WebSocketServer({ host, port })` 是全部升级配置，缺：
- `verifyClient` / Origin 校验 → CSWSH 攻击面
- `path` 匹配（任意路径都接）
- `handleProtocols`（未协商子协议）
- `maxPayload`（默认 100 MiB，单帧就能 OOM）
- 最大连接数（`sessions: Set<Session>` 无上限）

**修复**：扩 `WebSocketTransportOptions`：
```ts
allowedOrigins?: string[] | ((o: string) => boolean)
path?: string                    // 默认 "/ws"
maxPayload?: number              // 默认 256 KiB
maxConnections?: number          // 默认 1024
```
透传到 `WebSocketServer({ host, port, verifyClient, path, maxPayload, handleProtocols })`，并在连接计数达上限时 503 拒绝。

### C2. sdk-node 的 `wss://` 没有 TLS 配置钩子
**文件**：`packages/sdk-node/src/session.ts:254`

`new WebSocket(this.opts.url)` 没有第二参，无法传 `ca` / `servername` / `checkServerIdentity` / `rejectUnauthorized`。内部 CA 用户只能 fork 或 `NODE_TLS_REJECT_UNAUTHORIZED=0` 全局关验证（影响整个 Node 进程，远更危险）。

**修复**：`ConnectOptions` 增加 `tls?: import('tls').ConnectionOptions`，透传到 `new WebSocket(url, { ...tlsOpts })`。README 写明默认信任系统 CA，并强调"不要用 `NODE_TLS_REJECT_UNAUTHORIZED=0`，请 `tls: { ca: fs.readFileSync(...) }`"。

### C3. python-sdk 的 `wss://` 也没有 SSLContext 入口 + `ws://` 明文 apiKey 不告警
**文件**：`python-sdk/src/aipehub/session.py:201`

`async with websockets.connect(self._url) as ws:` 没办法传自定义 `ssl.SSLContext`。同时 `api_key` 在 `ws://` URL 下静默走明文。

**修复**：增加 `ssl: ssl.SSLContext | None = None` 参数透传给 `websockets.connect(..., ssl=ssl_ctx)`；当 `url.startswith("ws://")` 且 `api_key is not None` 时打 `logging.warning("plaintext auth — use wss://")`。

### C4. `secrets.enc.json` 全局可读
**文件**：`packages/core/src/space.ts:97`、`:493-494`

`writeJsonAtomic(this.paths.secrets, file)` 走进程 umask（Linux/macOS 通常 0644）。文件头注释说"备份没用因为密钥分离"，但 `secrets.enc.json` 和 `runtime/secret.key` 同机同用户，**本机攻击者一次本地读就拿全套**。

**修复**：每次 `writeSecretsFile` 后 `await chmod(this.paths.secrets, 0o600)`；`admins.json` / `agents.json` / `workers.json`（含 token hash）同样处理；`Space.init` 把 `<root>` 整目录 chmod 0o700。

---

## HIGH（22）

### H1. workflow resolver 原型污染
**文件**：`packages/workflow/src/resolver.ts:57-62`

```ts
for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
  out[k] = resolveRefs(v, ctx)
}
```
`JSON.parse('{"__proto__":{"x":1}}')` 产生的合法 own-property 经此赋值会触发原型 setter。`triggerPayload`（resolver.ts:142）来自 `Task.payload`，受 agent 控制。

**修复**：`out = Object.create(null)`；跳过键名 `__proto__` / `constructor` / `prototype`。

### H2. SQLite KV 写入绕过配额
**文件**：`packages/service-datastore-sqlite/src/handle.ts:90-105`

`makeSqlHandle.writeGuard()` 强制 `maxBytes`，但 `makeKvHandle.set` 直接 `prep.set(key, value)` 没过 guard。

**修复**：提取 `writeGuard` 为共享 helper，`kv.set` 和 `sql.exec` 都走它。

### H3. MCP server admin token 经 stderr 泄漏
**文件**：`packages/mcp-server/src/hub-client.ts:99-127`、`packages/mcp-server/src/main.ts:142`

`headers.authorization = \`Bearer ${this.opts.adminToken}\``；某些 undici 版本的 TypeError stack 含 init 对象，catch 直接 `err.stack ?? err.message` 写 stderr — Claude Desktop/Cursor 日志会捕获。

**修复**：`err.stack?.replaceAll(token, '***')`；`HubClient.unwrap` 显式 assert 错误串不含 `Bearer `。

### H4. MCP `dispatch_task` 入参无上限
**文件**：`packages/mcp-server/src/tools.ts:77-82, 83-104`

`payload: z.unknown()` + `title: z.string()` 无 `.max()`。LLM 长循环可能 dispatch MB 级 payload 写进 transcript JSONL 并广播全网。

**修复**：`title: z.string().max(2000)`，预检 `JSON.stringify(input.payload).length < 256 * 1024`。

### H5. OpenAI retry 模糊匹配导致取消时双倍计费
**文件**：`packages/llm-openai/src/provider.ts:198, 219-249`

`isTransientError` 用 `/aborted/i` 匹配 `err.message`。用户自带 `AbortController` 触发的取消若 message 是 "aborted by user"，会被误判成瞬时错误 retry。

**修复**：收紧成 `/socket aborted|connection aborted|request aborted/i`，或直接查 `signal?.aborted`。

### H6. `secret.key` chmod 竞态 + 静默吞错
**文件**：`packages/core/src/secrets.ts:128-131`

```ts
await writeFile(keyPath, fresh.toString('hex') + '\n', 'utf8')
await chmod(keyPath, 0o600).catch(() => { /* best-effort */ })
```
`writeFile` 默认 0644，到 `chmod` 之间有微秒级窗口；exFAT 等不支持 chmod 的 FS 上密钥永远 0644 用户毫不知情。

**修复**：`writeFile(keyPath, ..., { mode: 0o600 })` 原子建文件；catch 改 `logger.warn`，让操作员看见。

### H7. workspace 根无符号链接 / 属主检查
**文件**：`packages/core/src/space.ts:109-117, 134-141`

`Space.init` 直接 `mkdirSync(root, { recursive: true })`，没 `lstat` 防符号链接、没 `fstat.uid === geteuid()`。共享主机上攻击者预创 `/tmp/.aipehub/runtime/secret.key` 指向受害者文件，等受害者 init 就覆盖。

**修复**：`Space.init` / `Space.open` 对 root 和 `runtime/` 下每个文件 `lstat`，符号链接或异属主则拒绝。`secret.key` 首次创建用 `open(... O_NOFOLLOW | O_CREAT | O_EXCL)`。

### H8. `callId` 用 `Math.random()`
**文件**：`packages/sdk-node/src/service-client.ts:322`、`python-sdk/src/aipehub/services.py:418`

```ts
const callId = `c${this.callCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
```
今天不是安全边界（本地 Map 匹配），但 SERVICE_RESULT 跨 session 多路复用一旦上线就成漏洞。Python fork 后 PRNG 同种子也可能 callId 碰撞。

**修复**：TS 用 `randomBytes(6).toString('hex')`，Py 用 `secrets.token_hex(6)`。

### H9. python-sdk fire-and-forget `asyncio.create_task` 可被 GC
**文件**：`python-sdk/src/aipehub/session.py:117`

`asyncio.create_task(ws.send(json.dumps(frame)))` 返回的 Task 未存引用；3.11+ 仅持弱引用，内存压力下可能被 GC 掉，导致 SERVICE_CALL 静默丢帧，30s 后 `session_not_ready` 超时。

**修复**：Session 上挂 `set[asyncio.Task]`，task 加进去 + done-callback 移除。

### H10. apiKey 在 `ws://` 走明文且不告警
**文件**：`packages/sdk-node/src/session.ts:266`、`packages/cli/src/commands/ping.ts:46`

```ts
...(this.opts.apiKey !== undefined ? { apiKey: this.opts.apiKey } : {})
```
SDK 不论 URL scheme 都把 apiKey 塞 HELLO JSON。CLI template 默认 `ws://127.0.0.1:4000`，配合 `AIPE_KEY` env 用户可能在远程 dev tunnel 上明文飞 key。

**修复**：`connect()` 检测 `apiKey` 已设 + `url.startsWith('ws:')` 且非 loopback 时 `console.warn` 或拒绝（除非 `--allow-plaintext-auth`）。Python 端同步。

### H11. `REJECT` 错误消息原样回抛
**文件**：`packages/sdk-node/src/session.ts:330`

`new Error(\`hub rejected: ${frame.code}: ${frame.message}\`)`。若服务端 REJECT 含用户自己的 apiKey（例如 "apiKey 'sk-...' not recognised"），错误进 Sentry/日志。

**修复**：扫 `sk-[A-Za-z0-9]+` / `Bearer …` / 30+ 字符 base64 模式做 redact，或干脆只走 `logger.debug`。

### H12. `decodeFrame` 先解析完整 JSON 再检尺寸
**文件**：`packages/protocol/src/codec.ts:13-16`

`JSON.parse(text)` 无条件执行，100 MB 帧在内存里翻倍才查 envelope。配合 C1 直接 OOM。

**修复**：`decodeFrame` 入口先 `if (text.length > 1_048_576) return { ok: false, reason: 'too_large' }`，`DecodeResult.reason` union 加 `'too_large'`。

### H13. `AIPE_PROTOCOL_STRICT` 未文档化 + 热路径每帧读 env
**文件**：`packages/transport-ws/src/session.ts:155`

每个入站消息都 `process.env.AIPE_PROTOCOL_STRICT === '1'`。`grep -r AIPE_PROTOCOL_STRICT docs/` 零命中。

**修复**：构造时一次性 capture，写进 `docs/PROTOCOL.md` 操作指南 + `docs/SIDECAR.md` 错误图册。

### H14. `validateFrame` 只检 envelope 不进 task/result/msg
**文件**：`packages/protocol/src/codec.ts:97-103`

strict 模式 TASK 只查 `task` 是对象，不检 `task.id` / `from` / `strategy` / `payload` / `createdAt`。`{ type: 'TASK', recipient: 'a', task: {} }` 通过 strict，到下游 SDK 才崩。

**修复**：strict 模式至少递一层，校 task/result/msg 的必填子字段。或在 codec.ts:60 docstring 写明 strict 只校 envelope。

### H15. 未知 frame type 通过 strict 模式
**文件**：`packages/protocol/src/codec.ts:155-161`

strict `default:` 返 null，`{"type":"FROM_THE_FUTURE"}` 通过。这是文档化的前向兼容策略，但操作员调试新 SDK 时没法 assert "陌生 type 应该报错"。

**修复**：分两档 — `AIPE_PROTOCOL_STRICT=1`（当前）+ `AIPE_PROTOCOL_STRICT=closed`（拒绝未知 discriminator）。

### H16. core/tests 创建临时目录从不清理
**文件**：`packages/core/tests/secrets.test.ts:83,92,121,141,159,170`、`packages/core/tests/contributions.test.ts:465`

7 个 `mkdtempSync(join(tmpdir(), 'aipehub-...-'))` 没有 `afterEach` rm。CI runner 上残留加密 secrets 文件 + master key — 共享 CI 上最坏的残留类型。

**修复**：每个 `it` 体 `try { ... } finally { rmSync(dir, { recursive: true, force: true }) }`，或 hoist 到 `beforeEach`/`afterEach`。

### H17. `packages/web/src/server.ts` 测试覆盖率最低
**文件**：`packages/web/src/server.ts`（2276 LOC）vs `packages/web/tests/*`（4 文件，1209 LOC）

src:test ratio 2.17 — 全 monorepo 最差。dispatch、leaderboard、workflow control、services-admin 端点零 unit test，只靠 host 集成测试间接覆盖。CSRF / `AIPE_ALLOWED_HOSTS` / `AIPE_COOKIE_SECURE` 关键分支没有专门测试。

**修复**：补写路径级 unit test，重点是 CSRF / allowed-hosts / cookie security flag。

### H18. web server 错误信息泄漏给客户端（**手工发现**）
**文件**：`packages/web/src/server.ts:344`

```ts
res.end(`server error: ${err.message}`)
```
500 错误直接把内部 `err.message` 写响应体。可能含路径、SQL 片段、栈追踪线索。

**修复**：客户端只返 `'internal server error'` + 关联 requestId，详细信息走 `this.logger.error({ requestId, err })`。

### H19. `RateLimiter.hits` Map 永不清理（**手工发现**）
**文件**：`packages/web/src/server.ts:411 附近 RateLimiter`

`hits: Map<string, number[]>` 持续增长，攻击者轮换 IP 即可 OOM。

**修复**：每 N 次操作或定时器 sweep，移除窗口外的所有 IP。

### H20. admin token URL 经 stdout 写进系统日志（**手工发现**）
**文件**：`packages/host/src/main.ts:462-474`

`console.log(...)` 打印 admin token URL — systemd journal / docker logs / pm2 logs 全部抓到。任何能读这些日志的人都能拿 admin。

**修复**：写到 `<root>/.aipehub/runtime/admin-link.txt`（0600），stdout 只打 "admin link saved to ..."。

### H21. cookie-sid 路径未限流（**手工发现**）
**文件**：`packages/web/src/server.ts:1738-1754` (`findAdminFromRequest`)

Bearer auth 走限流，但 cookie 路径没限。攻击者可用大量 cookie sid 尝试触发磁盘 lookup 做磨损式攻击。

**修复**：cookie 路径同样过限流器（按 sid 前缀 + IP）。

### H22. HELLO.agents 数组长度无上限（**手工发现**）
**文件**：`packages/transport-ws/src/session.ts`（HELLO 处理）

恶意 client 可在 HELLO 发 10000 个 agent 声明，Hub 会全部接受并占用 registry 内存。

**修复**：HELLO 处理时 enforce `agents.length <= 256`（或可配置上限），超过则 REJECT `bad_hello`。

---

## MEDIUM（26）

### M1. SQLite prepared-statement 缓存无上限
`packages/service-datastore-sqlite/src/handle.ts:45,114-120` — `stmtCache: Map<string, SqliteStmt>` 没 LRU。Agent 发独特 SQL 字符串可耗尽内存。**修复**：LRU 200 entries。

### M2. `restore()` / `hardDelete()` 不校验 `ref.id`
`packages/service-{memory,artifact,datastore-sqlite}-file/src/plugin.ts` — `ref.id` 是 string 但从未 validate；构造 `ref.id = '../../../tmp/sensitive'` 可让 `rm({recursive:true})` 出 sandbox。**修复**：入口断言 `/^[0-9a-f]{16}$/`。

### M3. 表达式解析器无递归深度限制
`packages/workflow/src/predicate.ts:249-256` — `((((...))))` 1 万层栈溢出。schema 加载时触发。**修复**：predicate 字符串 ≤ 4 KiB；解析器跟踪深度上限 128。

### M4. `walkPath` 允许遍历 `__proto__` / `constructor` / `prototype`
`packages/workflow/src/resolver.ts:150-166` — 只读，但是 reconnaissance gadget。`$x.__proto__.constructor.name` 能拿到 "Object"。**修复**：denylist。

### M5. SQLite 错误消息含绝对路径
`packages/service-datastore-sqlite/src/handle.ts:62-67,138-141` — `\`...maxBytes=${opts.dbPath}...\`` 直接到 RPC 客户端泄主机布局。**修复**：path 进 logger，对外返通用消息。

### M6. workflow halt-failure 错误原样回抛
`packages/workflow/src/runner.ts:274` — `state.error` 包含 `record.error` 里下游栈追踪 / 路径。**修复**：scrub。

### M7. MCP admin token 通过 CLI flag 泄漏 ps
`packages/mcp-server/src/main.ts:56-60` — `--token <BEARER>` 写 help 文档，`ps auxww` 能看到。**修复**：help 加 "prefer `AIPE_ADMIN_TOKEN=…`" 警告。

### M8. MCP server 用户控制错误串原样回 LLM
`packages/mcp-server/src/tools.ts:119-120` — `throw new Error(\`Dispatch failed: ${r.error}\`)`。恶意 remote agent 可在错误里塞 prompt-injection 标记。**修复**：`JSON.stringify(r.error)` 中和。

### M9. LLM 输出未经清洗回喂另一 agent
`packages/llm/src/agent.ts:118-149` — writer → reviewer pipeline，前者文本直接拼后者 prompt。可被 `[INST]` 标记注入。**修复**：`sanitisePromptText: boolean` 可选项。

### M10. Anthropic vs OpenAI provider retry 不对称
`packages/llm-anthropic/src/provider.ts:64-66` vs `packages/llm-openai/src/provider.ts:122-126` — Anthropic SDK 默认 2 次重试，OpenAI 默认 0。5 步 workflow 单次瞬时故障可变 3 倍计费。**修复**：显式 `maxRetries: opts.maxRetries ?? 0`。

### M11. OpenAI 响应文本无尺寸上限
`packages/llm-openai/src/provider.ts:170-186` — 兼容供应商（DeepSeek/vLLM/Ollama）若忽略 `max_tokens` 返几 MB 文本会进 transcript。**修复**：`out.text.slice(0, 256 * 1024)` + `stopReason='max_tokens'`。

### M12. `HubClientError.body` 保留原始解析体
`packages/mcp-server/src/hub-client.ts:31-33` — 若 Hub 返调试字段（如 `token_seen`）会留在 error 上传到 stderr。**修复**：构造时 scrub。

### M13. `AIPE_SECRET_KEY` 直接 hex-decode 无 KDF
`packages/core/src/secrets.ts:107-117` — 用户口令 padding 成 hex 也通过，没有 PBKDF2/scrypt 拉伸。**修复**：增加 `AIPE_SECRET_PASSPHRASE` 走 scrypt(N=2^17,r=8,p=1)。

### M14. admins/workers token 验证 O(n) 短路
`packages/core/src/space.ts:259-266,373-381` — 每条 `constantTimeEqualString` 常时，但循环短路可探测位置。**修复**：indexed by `tokenHash` Map。

### M15. python-sdk `str(err)` 可能泄漏路径 / API key
`python-sdk/src/aipehub/session.py:286-293`、`packages/sdk-node/src/session.ts:367` — `httpx.HTTPStatusError("401 from https://api.example.com/v1/?api_key=sk-...")` 整串进 transcript。**修复**：regex scrub `(api[_-]?key|token|secret)=...` / `Bearer\s+\S+`。

### M16. CLI `ping ws://...` apiKey 默认无警告
`packages/cli/src/commands/ping.ts:46` — `ws://` + `--api-key` 静默明文。**修复**：拒绝或要 `--allow-plaintext-auth`。

### M17. corrupt master key 错误含路径
`packages/core/src/secrets.ts:118-126` — `\`master key at '${keyPath}'...\`` 泄主机布局。**修复**：tag stable code，UI 渲染通用消息。

### M18. `parseDigits` 静默降级
`packages/sdk-node/src/session.ts:585-593` — 返 0 时，v1.2 method ACL 检查被跳过。攻击者控 WELCOME 发 `protocolVersion: ""` 即可。**修复**：返 [0,0] 且原串非空时 warn。

### M19. heartbeat 文档 / 代码漂移
`packages/transport-ws/src/session.ts:540-552`、`docs/PROTOCOL.md:285` — 文档说"客户端 0.5×interval 内 PONG"，代码不强制；实际最少 60s 才检出死连接。**修复**：服务端加严，或改文档。

### M20. WS send 忽略 backpressure
`packages/transport-ws/src/session.ts:556-562` — `this.ws.send(...)` 不查 `bufferedAmount`。慢消费者使 RSS 爬升直到 OOM。**修复**：BACKPRESSURE_LIMIT 检查 + drop frames 或 terminate。

### M21. duplicate HELLO 不致命
`packages/transport-ws/src/session.ts:225-227` — READY 状态再收 HELLO 发 ERROR 但保持连接。文档说 HELLO 只一次。**修复**：`sendReject('bad_hello'); this.terminate()`。

### M22. SERVICE_CALL strict 校验漏 owner.kind/id/method 形状
`packages/protocol/src/codec.ts:135-144` — `{ kind: 99, id: ['nested'] }` 通过 strict。**修复**：扩展检查。

### M23. 57 个测试文件用 `setTimeout` 同步
具体见 `packages/transport-ws/tests/gating.test.ts:106-195`、`packages/host/tests/services-audit.test.ts:104-221` 等。M5 本机过得了，CI 冷启动 runner 上易 flake。**修复**：改 event-based（`once('ready')` / `vi.waitFor`）。

### M24. sleep-then-assert 微 delay
`packages/web/tests/auth.test.ts:130`、`packages/service-artifact-file/tests/plugin.test.ts:78`、`packages/service-memory-file/tests/handle.test.ts:51,78` — 5-20ms `setTimeout` 后 assert，CI 负载下易 flake。**修复**：deterministic await。

### M25. Dockerfile 非 slim 基础镜像
`Dockerfile:14,62` — `node:20-bookworm`（非 slim）带 ~150 MB 工具链，运行时 stage 又跑 `pnpm install --frozen-lockfile --prod` 重新触发 `better-sqlite3` 编译需求。**修复**：tracked — 改 `pnpm deploy --prod` 或 distroless 终态。

### M26. Dockerfile HEALTHCHECK 用 `/healthz` 而非 `/readyz`
`Dockerfile:97` — 容器可能"healthy"但 workflow resume 还在路上。生产 compose 是对的（`docker-compose.prod.yml:115` 用 `/readyz`）。**修复**：镜像层 healthcheck 改 `/readyz` + `start_period=30s`。

---

## LOW（29）

精简列出，每条一行：

- **L1**: `service-memory-file/handle.ts:101` 接受调用者 `entry.id` 不验形状。
- **L2**: `service-memory-file/id.ts:27` `Math.random()` 生成 id 后缀。
- **L3**: `service-datastore-sqlite/config.ts:69` name regex 允许纯点 stem。
- **L4**: `service-artifact-file/paths.ts:96-105` 用 `resolve()` 不是 `realpath()`，符号链接已经存在时穿越生效。
- **L5**: `workflow/run-store.ts:135` 用 `console.error` 不是结构化 logger。
- **L6**: `services-sdk/loader.ts:182-189` 异步工厂可能未捕获。
- **L7**: `web-demo/src/index.ts:42` 默认 `gating: 'open'` + 3000 端口 README 没强调 loopback 限定。
- **L8**: `examples/remote-agent/src/host.ts:18` 显式传 `host: '127.0.0.1'` 做防御深度。
- **L9**: `llm-openai/provider.ts:252` 退避 jitter 用 `Math.random()` — 标注不要假定密码学性质。
- **L10**: `llm-anthropic/provider.ts:131-142` `raw` 无条件回 — 加 `includeRaw: boolean` 默认 false。
- **L11**: `examples/industry-consultation-deepseek/src/index.ts:556` 提示串含 `sk-...` 字面占位。
- **L12**: `mcp-server/tools.ts:60` description 字面词与 enum 重复，加 integration test 防漂移。
- **L13**: `core/secrets.ts:84-90` `decipher.setAuthTag` 在 try 块外。
- **L14**: `sdk-node/session.ts:519-527` send 错误只 stderr，应缓存到下一次调用 surface。
- **L15**: `cli/commands/new-agent.ts:35` `access()` ENOENT 与 EACCES 不区分。
- **L16**: `python-sdk/session.py:349` `_is_open` 在 attr 不可读时假定 True — 未来 websockets 升级可能踩坑。
- **L17**: `core/space.ts:888` `uniqueTmpSuffix` 3 字节熵偏少。
- **L18**: `sdk-node/service-client.ts:144` `ServiceCallError.code` 从服务端 frame 取，未类型校验。
- **L19**: `python-sdk/services.py:215` `CustomServiceHandle.call(method, *args)` 不校 `method` 类型。
- **L20**: `docs/PROTOCOL.md:93` 例子 `protocolVersion: "1.0"` 与实际 "1.2" 漂移。
- **L21**: `docs/PROTOCOL.md:299` "Out of scope for v0.1" 已经 v1.2 仍存在。
- **L22**: `docs/PROTOCOL.md:170` "v1.1 only" 表注脚现已支持 — 应删。
- **L23**: `docs/PROTOCOL.md:280-287` heartbeat 描述与 `MAX_MISSED_PINGS=2` 实现轻微漂移。
- **L24**: `transport-ws/tests/handshake.test.ts` 缺 "AWAIT_HELLO 收非 HELLO frame" 测试。
- **L25**: `transport-ws/session.ts:185` CLOSING 状态下静默 drop frame，应加 debug log。
- **L26**: 24 个 `.toBeDefined()` 断言无后续字段检查 — 收紧成 `.toBeInstanceOf(...)`。
- **L27**: `core/tests/priority-scheduler.test.ts:139` 用 `Date.now() - 1000` 做"过期 deadline"测试 — 应注入 clock。
- **L28**: `Dockerfile:73` 运行时 stage `pnpm install --prod` 未禁 lifecycle script — 切 `pnpm fetch` + `pnpm deploy` 隔离 resolve 与 execute。
- **L29**: `packages/web/scripts/build-static-assets.mjs` 递归读 static dir 无文件大小上限 + 不防符号链接。

---

## API 一致性漂移（sdk-node ↔ python-sdk）

不算安全 bug，但违反"in-process 平滑迁移 remote"承诺：

1. **默认 backoff**：TS 1000ms / Py 500ms — 选一个。
2. **connect timeout**：TS 有 `connectTimeoutMs`，Py 没暴露。
3. **datastore 命名**：`services.datastore.cases`（TS）/ `services.datastore["cases"]`（Py）。
4. **Error 类型**：TS `ServiceCallError extends Error` / Py `extends RuntimeError`。
5. **federation**：`TeamBridgeAgent` TS-only；Py 应该有 NotImplementedError stub。

---

## 优秀实践（保留）

- 0 个 `0.0.0.0` 绑定，全 loopback。
- LLM 包零 `console.*` — key 不会经本地日志泄。
- WS 测试统一 `{ port: 0 }` 用临时端口。
- 生产 compose `read_only: true` + `cap_drop: ALL` + `no-new-privileges`。
- `.dockerignore` 正确排除 `.aipehub*` / `*.pem` / `*.key` / `.env*`。
- 没有快照测试 — 不会有 snapshot rot。
- LLM 实时测试统一 `describe.skipIf(!process.env.X_API_KEY)`。
- Python conftest 也用 `port=0`。

---

## 推荐优先级与修复路线

下面分三批，每批可在独立 PR 中完成，互不阻塞：

### Batch 1 — Security-critical（合并前必做）
- **C1** WS 升级硬化（server.ts:136） + **H12** decodeFrame 尺寸前置 + **H22** HELLO.agents 上限 — 一起改，同一文件链路。
- **C4** secrets.enc.json 0o600 + **H6** secret.key 原子 mode + **H7** workspace 符号链接检查 — 一组。
- **H20** admin URL 不走 stdout — 单点修复，立即收益最大。
- **H18** + **H21** web server 错误泄漏 + cookie 未限流 — 一组。
- **C2** + **C3** SDK TLS 钩子 + **H10** apiKey 明文告警 — sdk-node 和 python-sdk 镜像修。

### Batch 2 — Correctness & robustness
- **H1** + **H2** + **H17** + **M1**-**M6** workflow + sqlite quota + 测试覆盖。
- **H3**-**H5** MCP / LLM 边界（token redact + payload 上限 + retry 收紧）。
- **H8** + **H9** + **H11** + **M15** SDK 杂项（callId / Python GC / REJECT msg / err scrub）。
- **H19** RateLimiter 内存增长 sweep。
- **M19** + **M20** + **M21** transport-ws backpressure + duplicate HELLO + heartbeat 文档对齐。

### Batch 3 — Quality & docs
- **H13** + **H14** + **H15** + **M22** protocol strict 模式深化 + 文档化 `AIPE_PROTOCOL_STRICT`。
- **H16** core/tests 临时目录清理。
- **M23** + **M24** 测试 flake 治理（sleep → event-based）。
- **M25** + **M26** Dockerfile slim + healthcheck `/readyz`。
- 全部 LOW + API drift。

---

## 备注

- 没发现路径穿越实战可利用案例（`assertSafeOwnerId` + `sanitisePath` 守得稳）。
- 没发现 SQL 注入（全程参数化）。
- 没发现 eval/Function 注入（workflow predicate 是自建 AST）。
- 没发现明文存储 API key / 私钥。
- 没发现 hardcoded credential。
- Docker 镜像无 secret 烘焙、非特权用户、运行时不需要 root。
- 生产 compose `read_only` + `cap_drop` 配置有水准。

**最高单点收益修复**：Batch 1 全部 + H20 + H18。下一步是这批的 PR 计划。
