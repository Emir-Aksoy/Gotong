# V4 Phase 12 — 协议外通路 (IM bridges + REPL) 收尾

> Phase 12 把 AipeHub 从「浏览器 admin UI + Node SDK」单一入口扩到「人在
> 哪儿，agent 就在哪儿」。6 个 `@aipehub/im-*` bridge 让 Telegram /
> Matrix / 飞书 / Discord / Slack / QQ 用户用熟悉的 IM 客户端跟 hub 对话；
> `aipehub repl` 把 stdin/stdout 当本地 IM bridge，终端里 `:help` `:agents`
> `:dispatch` 跑 free-text 派发。M9-M11（mobile responsive / PWA / 简化 shell）
> 是独立的前端工作，下一个 phase 再做。
>
> Last updated: 2026-05-27

---

## 一、本阶段动了什么

| Milestone | Commit | 关键产物 |
|---|---|---|
| M1 | `b0af21e` | `@aipehub/im-adapter` 基础包（`ImBridge` / `ImUser` / `ImMessage` / `ImCommand` 类型 + `parseImCommand` + `ImBindingResolver`）+ identity migration v=10（`im_bindings` / `im_binding_codes` 表 + 7 个 store API + 2 个新 IdentityError code） |
| M2 | `a09640d` | `@aipehub/im-telegram` —— bot API long-poll (`getUpdates`)，text + attachments dual-write，bot mention strip，anti-loop via `from.id`，`TelegramApiError` |
| M3 | `056d612` | `@aipehub/im-matrix` —— Client-Server `/sync` 长轮询 + `since` 缓存 + room timeline 派发 + `PUT m.room.message` outbound + `MatrixApiError`（含 `retryAfterMs` / `errcode`） |
| M4 | `f254100` | `@aipehub/im-lark` —— verification + 加密 webhook + `tenant_access_token` 2h cache + coalesced refresh + `LarkBridge` 内置 `node:http` listener（默认端口 9090）+ `im.message.receive_v1` 事件 |
| M5 | `19588c8` | `@aipehub/im-discord` —— Gateway WSS (op 10/11 heartbeat + identify + RESUME), MESSAGE_CREATE 派发, `POST /channels/.../messages` outbound, intents bitfield, fatal close code (4004/4014) 不重连 |
| M6 | `6e4e185` | `@aipehub/im-slack` —— Events API webhook (HMAC SHA256, 5-min replay window), `event_id` dedup (512-entry FIFO), `chat.postMessage` outbound, slack-file URI scheme，built-in HTTP server 端口 9091 |
| M7 | `4be4f56` | `@aipehub/im-qq` —— OneBot v11 forward WS + echo-paired action multiplex + risk gate (`AIPE_QQ_BRIDGE_ACK_RISK=true`) + `encodeQqChatId('private:<qq>' \| 'group:<gid>')` + array / string-form message 双兼容 |
| M8 | `9376661` | `examples/im-bridge-host/` 端到端 demo（router + identity-resolver + FakeBridge + 9-step scripted lifecycle）+ `docs/zh/IM-BRIDGES.md` cookbook（六桥对比 + 3 transport 选型 + per-bridge setup + docker-compose 片段 + 调试 / 安全清单） |
| M12 | `355e5cf` | `aipehub repl` 子命令 —— in-memory hub + 默认 `ReplEchoAgent`，`:`-prefix 元命令 (`:help` / `:agents` / `:transcript` / `:dispatch` / `:quit`)，`parse.ts` + `bootstrap.ts` + `loop.ts` + `commands/repl.ts`，readline line-event queue（修 pipe 模式 hang） |
| M13 | (this commit) | 本文 + CLAUDE.md 标 Phase 12 M1-M8+M12 完 |

总改动: 9 commits + docs。+460 个新测试跨 9 个包；workspace 从 2225 → ~2700+。新增源代码 ~19,000 行（含 7 个 bridge + adapter ~7,188 行 src，其余是 tests + example + docs）。

**未做（推到 Phase 13/14 或独立做）**: M9（mobile responsive）/ M10（PWA manifest + Service Worker）/ M11（mobile 简化 shell）—— 三项都是 admin SPA 前端工作，跟 Phase 12 的"非浏览器入口"主题正交，等 IM bridges 真用起来再回来做。

---

## 二、为什么做这阶段

之前 AipeHub 只有两个面向人的入口：

1. **浏览器 admin UI** —— 完整的 ops 控制台，看 transcript / 管 user / 调 quota，
   但「上手成本」是装 host + 部署 SPA + 用浏览器连。
2. **Node SDK / Python SDK** —— 程序员能在脚本里调，但「我要跟 agent 聊天」
   这个最朴素的诉求不是 SDK 该负担的。

对个人模式（Phase 7）尤其尴尬：用户想要的就是「微信 / Telegram 里发一句，
agent 帮我干」。Phase 12 给的范式是 **「IM 客户端 = 远程终端，AipeHub 是
后端」**。每个 bridge 干同一件事：

```
       IM 客户端 (TG / Matrix / 飞书 / Discord / Slack / QQ)
                          ▲
                   text in / text out
                          ▼
       ImBridge (1 of 6, 转协议)
                          ▲
                ImMessage / ImCommand
                          ▼
       Router (examples/im-bridge-host/src/router.ts)
                          ▲
              Hub.dispatch / 渲染 transcript reply
                          ▼
                        Hub
```

约定俗成：

- `/help` / `/bind <code>` / `/agents` / `/workflow <name>` / `/unbind` 是
  IM 通用 meta 命令（M1 的 `parseImCommand` 统一定义）
- 非 meta 即 free-text → 派给 default capability（默认 `chat`）
- transcript 走原路返回，作为 `bridge.sendMessage(chatId, text)`

`aipehub repl`（M12）把同一套 router 模型搬到本地终端。stdin 进来一行 =
一条 IM 消息，`:` 替 `/` 当 meta 前缀（CLI 习惯 vs IM 习惯），其余完全一样。

**心智一致性**才是真价值：6 个 bridge + REPL 共享 same router shape，意味着
新 bridge（钉钉 / WhatsApp / 微信公众号）写起来只是「再翻译一个 IM 协议」，
hub 侧零改动。

---

## 三、关键设计决策

| 决策点 | 选择 | 为什么 |
|---|---|---|
| `ImBridge` 抽象在哪 | 单独包 `@aipehub/im-adapter`，只导出 type + `parseImCommand` | bridge 包之间互不依赖；host 只依赖 adapter 拿 type，**不**强依赖 6 个 bridge 包 |
| 每个 bridge 一个包 vs monorepo `@aipehub/im` | 每平台独立包 | 用户只装他要用的（Telegram bot 不需要 Discord WS lib）；bin binary 不被 6 个 bridge 拖大；测试边界清晰 |
| HTTP client 用 SDK vs 手写 fetch | 手写 fetch + per-bridge `*ApiError` | wrapper lib 平均 80+ method、10-20 transitive deps、`any` 重；我们只调 3-6 个 endpoint；bun --compile binary 要自有 fetch 路径 |
| 长轮询 vs webhook vs WS | 各平台原生支持的选 | Telegram/Matrix 有长轮询（最省心）→ 选；Lark/Slack 只有 webhook → 内置 `node:http` listener；Discord/QQ 只有 WS → 持久连 |
| `node:http` listener 端口冲突 | Lark 默认 9090 / Slack 默认 9091；可设 `webhookPort: 0` 让 host HTTP 层接管 | 默认值方便单 bridge 跑；零端口让生产部署能复用一个 Caddy 反代 |
| webhook signing verify 位置 | bridge 内置（M6 Slack：HMAC SHA256 + 5min replay + constant-time compare） | 一旦签名失败 → 不入派发；host 不需重复校验 |
| QQ 协议风险 | 默认拒绝启动，需 `AIPE_QQ_BRIDGE_ACK_RISK=true` env | OneBot v11 是逆向协议，账号有封禁风险；故意的运维摩擦让 ops 读 docs |
| IM identity 绑 AipeHub user 怎么做 | 6 位数字 code + 短 TTL（默认 10 分钟） | UX：用户在 admin UI 点 "issue code" → 抄到 IM 里发 `/bind <code>` → bridge 自动解析。code 一次性 + rotate-on-reissue，比对话式 captcha 简单 |
| `IdentityError(code='im_binding_code_invalid'\|'_expired')` | 两个 code 分开，bridge 渲染不同提示 | 用户输错 vs code 过期是两种心态；语义化区分有助于 UX |
| `getUserIdByImBinding` 同步 vs 异步 | identity store 同步（throws），adapter `ImBindingResolver` 异步（discriminated result） | identity 用 better-sqlite3 同步天然合适；bridge 跨网络栈用 Promise；example 里的 `makeIdentityImBindingResolver` adapter 翻译 |
| `Task.from` 形态 | `'im:<platform>:<platformUserId>'`，AipeHub userId 走 `task.origin.userId` | transcript 里看着是 `from='im:telegram:123456789'`，可读 + audit 友好；quota gate 看 `origin.userId` |
| Hub.dispatch fallback strategy | router 默认 `{kind: 'capability', capabilities: ['chat']}`，可覆 | "找一个 capability='chat' 的 agent"是最朴素的 chat 语义；用户改 `freeTextDispatch.strategy` 切到 broadcast / explicit |
| Router 单独发包 vs example | 留在 `examples/im-bridge-host/src/router.ts`（~280 行）| 用户大概率要 fork 命令词表；published 包不灵活。等 Phase 13/14 社区使用模式稳定再决定 fold 进 host CLI |
| host main.ts 集成 | **不动** —— 6 bridge + router 不进 host binary | 6 个 bridge 共依赖体积 + 凭证配置都不是 host 责任；example 当模板，用户拷过去 |
| REPL 跟 IM bridge 关系 | 同源 + `:` 替 `/` | "终端 = 本地 IM" 一致心智；CLI 习惯用 `:`（vim / vi 等），IM 用户用 `/`（discord / telegram） |
| REPL `rl.question()` 在 pipe 模式 hang | 换 `line` 事件 queue + EOF flag + waiter resolver | 实测 bug：`rl.question` 非 TTY 模式只 resolve 首次 call；后续 hang。queue 模式 TTY/pipe 都对 |
| `@aipehub/core` 加进 `@aipehub/cli` runtime dep | 加 | 验过 `@aipehub/core` 零 runtime dep（`better-sqlite3` 只是 devDep），不会拖垮 `npx @aipehub/cli` 安装 |

---

## 四、数据流端到端（以 Telegram 为例）

```
1.  Telegram client 发 "/bind 482917"
       ▼
2.  TelegramBridge.poll() 拉到 update —— `getUpdates?offset=N&timeout=25`
       │
       │ map update → ImMessage {
       │   platform: 'telegram',
       │   chatId: '<chat.id>',
       │   user: { id: '<from.id>', displayName: 'alice' },
       │   text: '/bind 482917',
       │ }
       ▼
3.  bridge.onMessage(msg) 触发 host 注册的 listener
       │
       ▼
4.  router.handle(bridge, msg)
       │  cmd = parseImCommand(msg.text)
       │       → { kind: 'bind', code: '482917' }
       │
       │  resolver.claim({ platform, platformUserId, code, displayName })
       │       │
       │       ▼ identity-resolver.ts adapter:
       │     identity.claimImBindingCode({
       │       code: '482917', platform: 'telegram',
       │       platformUserId: '<from.id>', displayName: 'alice',
       │     })
       │       │
       │       ├─ Throws IdentityError(im_binding_code_expired)?
       │       │   → return { ok: false, reason: 'expired' }
       │       ├─ Throws IdentityError(im_binding_code_invalid)?
       │       │   → return { ok: false, reason: 'invalid' }
       │       └─ ok → row INSERT OR REPLACE 进 im_bindings 表
       │           return { ok: true, userId: 'usr_xxx' }
       │
       │  bridge.sendMessage(msg.chatId, '已绑定 alice@example.com')
       ▼
5.  Telegram client 收到回复


   (...用户后续发 "帮我总结今天的会议记录"...)


6.  TelegramBridge.poll() 拉到 update
       │
       ▼
7.  router.handle:
       │  cmd = parseImCommand("帮我总结今天的会议记录")
       │       → { kind: 'free', text: '帮我总结今天的会议记录' }
       │
       │  userId = await resolver.resolveUserId('telegram', '<from.id>')
       │       → identity.getUserIdByImBinding(...) → 'usr_xxx'
       │
       │  hub.dispatch({
       │    from: 'im:telegram:<from.id>',
       │    strategy: { kind: 'capability', capabilities: ['chat'] },
       │    payload: { text: '帮我总结今天的会议记录' },
       │    origin: { orgId: 'local', userId: 'usr_xxx' },  ← quota 看这个
       │  })
       │
       │  result.kind === 'ok' / 'failed' / 'no_participant' / 'suspended'
       │       │
       │       ▼ summariseResult(result) 抽 .output.text，fallback JSON
       │
       │  bridge.sendMessage(msg.chatId, summary)
       ▼
8.  Telegram client 收到 agent 回复
```

`aipehub repl` 走完全一样的链路，只是 step 1+8 换成 stdin / stdout，step 2-7
不变（除了 router 用 `:` 解析 meta 命令而不是 `/`）。

---

## 五、被覆盖的测试

| 包 | 文件 | 测试数 | 主要场景 |
|---|---|---|---|
| `@aipehub/im-adapter` | `command-parser.test.ts` | 15 | `/help` / `/bind <code>` / `/unbind` / `/agents` / `/workflow <name> args` / free-text；多语言空白容错；trailing-newline；非 `/` 前缀 → free |
| `@aipehub/identity` | `im-bindings.test.ts` | 27 | 7 store API CRUD + 错误 code (invalid/expired)；code rotate-on-reissue；INSERT OR REPLACE 行为；ON DELETE CASCADE；sweep 过期 code；listImBindings filter；index sanity |
| `@aipehub/im-telegram` | 3 files | 31 | bridge start/stop 幂等 / poll offset cursor / sendMessage formdata / 错误重试 / TelegramApiError；client fetch wrapper；message mapper 含 attachment + mention strip + anti-loop |
| `@aipehub/im-matrix` | 3 files | 49 | sync long-poll + since 缓存 / autoJoin invite / event_id dedup ring / cold-start backlog skip / retry-after honour / MatrixApiError retryAfterMs；fetch + Bearer；message mapper m.room.message + edit/reply |
| `@aipehub/im-lark` | 3 files | 69 | verification challenge + 加密 webhook decrypt / tenant_access_token coalesced refresh / 2h cache / im.message.receive_v1 / receipt fallback / 内置 http listener；client；message mapper 含 attachment file_key |
| `@aipehub/im-discord` | 3 files | 60 | gateway state machine (HELLO/IDENTIFY/READY/HEARTBEAT/RECONNECT/INVALID_SESSION) / zombie detection / 4004/4014 不重连 / exponential reconnect / intent bitfield；client；message mapper 含 mention strip (`<@!id>` legacy) |
| `@aipehub/im-slack` | 3 files | 85 | HMAC SHA256 verify + 5min replay window + constant-time / event_id dedup 512 FIFO / file_share 4 layers anti-loop / built-in http server；client xoxb auth；message mapper 含 `slack-file:` URI + Slack mention strip |
| `@aipehub/im-qq` | 3 files | 80 | risk gate env + 默认拒启 / echo-paired action multiplex / 12-byte correlation id / connecting/open/closed state dedup / disposed on stop / private/group chatId 编码；client；message mapper array+string-form 双兼容 + 3-layer anti-loop |
| `@aipehub/cli` | `repl-parse.test.ts` | 26 | noop / help / quit / agents / transcript (clamp [1,200] + default 5 + floor) / dispatch (full + alias `:d` `:send`) / free / unknown verb；`:`-prefix；case-insensitive |
| `@aipehub/cli` | `repl-loop.test.ts` | 18 | `:quit` reason+turns / EOF / `:help` render / `:agents` list / 自由文本→default cap / `:dispatch tester` 显式 / no-participant / `:transcript` last N / 空行 noop / agent throw 不挂掉 / AbortError 退出 / `ReplEchoAgent` defaults；4 个 `createReplHub` test |
| **总计** | | **+460 tests** | workspace 2225 → ~2700+ |

`pnpm demo:im-bridge-host` 跑通：9 步 scripted lifecycle (help / bind-before-binding /
bind-success / agents / free-chat / workflow / unknown / unbind / bind-prompt-again)，
全 in-memory，无网络。

`printf ':help\n:agents\nhello world\n:transcript 4\n:quit\n' | node packages/cli/bin/aipehub.js repl --no-banner`
跑通：banner 抑制 / help block / agents 列出 chat / dispatch + echo reply /
transcript 4 entries / bye!。

---

## 六、运维须知

### 6.1 IM bridges

**通用约定**：

- 每个 bridge 是独立包：`pnpm add @aipehub/im-<platform>`。
- host 不强依赖 bridge —— 用户复制 `examples/im-bridge-host/src/router.ts` +
  `identity-resolver.ts` 进自己的 host main.ts 即可。
- bridge 出错 → 不挂主进程（每个 bridge 顶层 try/catch + onError 回调）。
  router 顶层 catch 把派发失败渲染回 IM 客户端，单条 bad message 不拉垮 polling loop。

**凭证形态对比**：

| Bridge | 凭证 | 长度 | 旋转策略 |
|---|---|---|---|
| Telegram | `bot token`（含 bot id 数字 prefix） | 长生命 | BotFather 手动 revoke |
| Matrix | `access_token`（Bearer） | 长生命 | `/_matrix/client/v3/logout` revoke |
| Lark | `app_id` + `app_secret` | 长生命；运行时换 `tenant_access_token`（~2h） | Lark 控制台 rotate secret |
| Discord | `bot token` | 长生命 | Developer Portal reset |
| Slack | `signing secret` + `xoxb-` bot token | 长生命 | App 管理面 rotate |
| QQ | adapter `access_token`（可选） | 看 adapter | NapCat / go-cqhttp 管理 |

**所有凭证都该走 vault**（Phase 5 加密存储），不在 process.env 裸跑生产。
Example 里为简单走 env，迁移 cookbook 在 `docs/zh/IM-BRIDGES.md` 第七节。

### 6.2 webhook 部署（Lark / Slack）

入向需要公网。三种选择：

1. **Caddy / Nginx 反代** —— 推荐。Caddy 自动签 TLS，配 ~5 行：
   ```
   bot.example.com {
     reverse_proxy /lark/webhook localhost:9090
     reverse_proxy /slack/events localhost:9091
   }
   ```
2. **`webhookPort: 0`** —— bridge 不开自己的 listener，host HTTP 层（@aipehub/web）
   挂载路由后转给 bridge 的 `handleWebhook(req, res)`。生产复用一个 TLS 入口。
3. **Cloudflare Tunnel / ngrok** —— dev 阶段最快。

不推荐裸开 80/443 —— ops 视角少一层防护。

### 6.3 QQ bridge 风险

- 必须 `AIPE_QQ_BRIDGE_ACK_RISK=true` env 才启动（否则 `QqBridgeRiskNotAck` 错）
- 需要本地跑 OneBot adapter（NapCat 推荐，go-cqhttp / Lagrange / Mirai-onebot 都可）
- adapter 协议是逆向得来的，**Tencent 没承认**。账号有封禁风险，主号慎用。
- 建议小号 / 群机器人专号
- adapter ↔ bridge 之间 access_token 走 `?access_token=` query string
  （NapCat 接受 Authorization header，但 go-cqhttp 旧版只看 query）

### 6.4 SQLite 表

`im_bindings` —— migration v=10（跟 `vault` / `usage_counters` / `suspended_tasks` 同库）：

```
platform          TEXT NOT NULL
platform_user_id  TEXT NOT NULL
user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
display_name      TEXT
created_at        INTEGER NOT NULL
PRIMARY KEY (platform, platform_user_id)
```
索引: `idx_im_bindings_user(user_id)`。

`im_binding_codes`：

```
code         TEXT PRIMARY KEY     (6 位数字默认；测试可注入)
user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
expires_at   INTEGER NOT NULL     (Unix ms)
created_at   INTEGER NOT NULL
```
索引: `idx_im_binding_codes_user(user_id)`, `idx_im_binding_codes_expires(expires_at)`。

运维查询：
```sql
-- 当前活 binding
SELECT platform, platform_user_id, user_id, display_name,
       datetime(created_at/1000, 'unixepoch') AS bound_at
FROM im_bindings ORDER BY created_at DESC LIMIT 20;

-- 待消费的 code
SELECT code, user_id,
       datetime(expires_at/1000, 'unixepoch') AS expires
FROM im_binding_codes WHERE expires_at > strftime('%s','now')*1000;

-- 清过期 code（host 可周期调 sweepExpiredImBindingCodes）
DELETE FROM im_binding_codes WHERE expires_at < strftime('%s','now')*1000;
```

### 6.5 transcript

IM 派发跟 SDK 派发对 transcript 完全一致：

- `task` entry：`from='im:<platform>:<platformUserId>'`，origin.userId 是 AipeHub userId
- `task_result` entry：跟 SDK 一样的 kind union（ok/failed/suspended/no_participant）

`/me` SPA（Phase 5 加的）能看到自己的 transcript，**包括 IM 派发的**，
"我在 Telegram 里问了啥"在 admin UI 留痕。

### 6.6 aipehub repl

CLI 子命令：

```
aipehub repl [options]
  --prompt=<str>   覆盖 prompt（默认 `> `）
  --from=<id>      覆盖 Task.from（默认 `repl-user`，测试用）
  --no-banner      关闭启动 banner
  --help / -h
```

环境：

- in-memory hub（`Hub.inMemory()`），进程退出全清
- 默认装 `ReplEchoAgent`（capability=`chat`），用户 `--no-banner` 跑测试时 echo
- SIGINT (Ctrl-C) → AbortController → 优雅退出 + transcript flush
- pipe 模式自动检测（`process.stdout.isTTY`）—— `printf '...' | aipehub repl`
  跑测试不会 hang，不打 prompt

未来 M13/14 可以加 `--connect=<ws-url>` 让 REPL 连远程 hub（替代 in-memory），
现阶段只做本地。

---

## 七、未做（留给后续 Phase）

### 7.1 Phase 12 推迟

- **M9 Mobile responsive audit** —— admin SPA 在手机上排版没做过审计。
  现状：能用，但 `/me` 页用 desktop 布局，密码框小、表格滚动。
  做法：审计 `packages/web/static/` 的 CSS，加 mobile breakpoint。1-2 天。
- **M10 PWA manifest + Service Worker** —— "添加到主屏幕"体验。
  manifest.json + 简单 SW 缓存 SPA assets。半天。
- **M11 Mobile 简化 shell** —— 移动端默认走 `/m` 简化视图（chat + agents 选单），
  避免 admin SPA 的全功能 UI。1-2 天。

三项独立工作，跟 Phase 12 IM/REPL 主题正交。等 IM bridges 真用起来再回来做。

### 7.2 跟 bridge 设计相关

- **新增 bridge**：钉钉 / 企业微信 / WhatsApp / Signal / Line / Viber。每个 ~3-5 天，复用 router。
- **bridge 健康度上报**：每个 bridge 启动后注册一个 "im-status" capability，
  router 派给它的 task 返当前 polling delay / WS RTT / webhook 最近延迟。admin UI 可见。
- **`ImBridge.sendStream(chunk)` for streaming**：Phase 8 加了 LLM streaming，
  但 IM bridge 现在只能 batch send（agent 完成后一次性发）。Telegram 支持 edit_message，
  可以做 streaming 效果；其他平台原生不支持需 batch fallback。
- **Bridge group permissions**：当前 IM bridge 没有"哪个 chat / channel 能跑 workflow"
  的 ACL；任何 bind 过的 user 在任何 chat 都能 dispatch。生产组织需要 channel allow-list。

### 7.3 跟 REPL 相关

- **`aipehub repl --connect=<ws-url>`** —— 远程 hub REPL。
  现在只能跑 in-memory，等于"本地 sandbox"；生产想要的是"连我那台生产 hub 跑 :agents"
- **`:bind <code>` in REPL** —— 现在 REPL 没有 user binding，task.from 写死 `repl-user`。
  远程模式做之后顺手加。
- **`:upload <path>`** —— Phase 9 多模态进了 admin UI 上传，但 CLI 没有。
  REPL 加个 `:upload pic.png` 然后下条消息引用 `[1]` 是合理的演进。

### 7.4 文档 / 治理

- **`docs/zh/IM-PROTOCOL-MATRIX.md`** —— 6 bridge 之间的能力对比矩阵
  （reactions / threads / edits / typing-indicators / read-receipts），方便选型。
- **Per-bridge metrics export** —— 每个 bridge 暴露 prometheus metrics
  （poll latency / msg in/out / error count）。Phase 5 host 有 metrics infra，可挂上。

---

## 八、Phase 13 入口

下一步：**AI 辅助 workflow 编辑器** —— 自然语言 → YAML。

现在 workflow 是手写 YAML，新用户上手成本高（agents 数组 / steps DAG / 上下文变量
要看 docs 才会）。Phase 13 加：

1. admin SPA 加 "workflow assistant" tab —— 用户描述需求（"我要一个每周一早 10 点
   爬 5 个新闻源、用 DeepSeek 总结、发到 Telegram 群"），LLM 出 YAML
2. workflow runner 加 `dryRun` 模式 —— 编辑器实时验证生成的 YAML
3. `templates/community/` 升级：现在是手写示例，未来是 assistant 训练数据来源

也可以转 M9-M11 mobile / PWA 三件套，等 IM bridges 实战反馈到位再走 Phase 13。
看用户优先级。
