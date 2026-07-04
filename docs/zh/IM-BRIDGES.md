# IM Bridges — 部署 + 调试 cookbook

> 本文是把 6 个 `@gotong/im-*` bridge 真接到生产 host 的现场手册。
>
> **2026-06：IM 桥官方化。** 有官方 API 的平台全切官方直连——QQ 走官方 Bot
> webhook（替代第三方 OneBot v11）、Lark 走官方长连接、Slack 走 Socket Mode
> （都替代旧 webhook 入站）。改的理由、OpenClaw / Hermes 对照、QQ「官方 vs 免穿透」
> 取舍见 [`IM-OFFICIAL-REARCH.md`](IM-OFFICIAL-REARCH.md)。
>
> 读这篇之前推荐先看：
>
> - `examples/im-bridge-host/` —— 端到端 demo
> - 各 bridge 自己的 `packages/im-*/README.md` —— 平台特定坑
>
> Last updated: 2026-06-17

---

## 一、六桥总览

|  Bridge | 协议 / Transport | 入站机制 | 出站机制 | 凭证形态 | 网络要求 |
|---------|-----------------|---------|---------|---------|---------|
| `@gotong/im-telegram` | Bot API (HTTPS) | `getUpdates` 长轮询 | `sendMessage` | bot token | 出站 HTTPS 到 `api.telegram.org`（可走 proxy） |
| `@gotong/im-matrix` | Client-Server API | `/sync` 长轮询 (timeout 30s) | `PUT .../send/m.room.message/<txn>` | access_token | 出站 HTTPS 到 homeserver |
| `@gotong/im-lark` | 官方长连接（SDK `WSClient`） | 出站持久 WS（`im.message.receive_v1`） | `POST .../im/v1/messages` | app_id + app_secret | **出站**·免穿透 到 `open.feishu.cn` |
| `@gotong/im-discord` | Gateway (WSS) | WebSocket gateway 持久连 + heartbeat | `POST /channels/.../messages` | bot token + intents | 出站 WSS + HTTPS 到 `discord.com` |
| `@gotong/im-slack` | Socket Mode（WSS） | 出站持久 WS（`xapp-` token） | `chat.postMessage` (HTTPS) | `xapp-` + `xoxb-` 两 token | **出站**·免穿透 到 `slack.com` |
| `@gotong/im-qq` | 官方 Bot API + Webhook | **HTTPS webhook（入向需公网 + TLS）** | 被动回复 REST（带 `msg_id`） | AppID + AppSecret | **入向公网 + 出站 HTTPS** 到 `bots.qq.com` |

**两种部署模式**（按是否需要公网入口分）：

1. **出站长连 / 长轮询 (Telegram, Matrix, Discord, Lark, Slack)** — bridge 主动拨向
   平台云端：Telegram / Matrix 长轮询，Discord / Lark / Slack 持久 WS。**都不需要公网
   入口**，家里 NAT 后面也能跑。这是官方化后的常态——五桥全出站、全免穿透。
2. **入站 Webhook (QQ)** — QQ 官方 Bot API 把 WS 判死、只推入站 webhook，所以**必须
   公网可达 + TLS**，配 Caddy / Nginx 反代到 bridge 的 HTTP 端口。这是 QQ 官方化的代价
   （见 [`IM-OFFICIAL-REARCH.md`](IM-OFFICIAL-REARCH.md) §3.1）。

如果你要从一个 0 入向公网的家用机跑：选 Telegram + Matrix + Discord + Lark + Slack
（5 个，全出站免穿透），跳过 **QQ**（唯一非要走入站 webhook、得上云配反代的）。

---

## 二、通用集成 (host 侧)

生产 host 已经把 IM 接线折进 `startImBridges()`（`packages/host/src/im-bridge.ts`）。
你**不用**自己写 router——按平台填 env，host 启动时逐平台 env-gate 起桥，全挂到同一套
`handleImMessage` 路由上。最省事的接法就是填环境变量：

```bash
# 填哪个平台的 env，就起哪个桥（独立 gate；全不填 = IM 关闭，零行为变化）
export GOTONG_TELEGRAM_BOT_TOKEN=123456:AAE...        # Telegram（出站免穿透）
export GOTONG_LARK_APP_ID=cli_a1b2c3d4                # Lark（出站长连接）
export GOTONG_LARK_APP_SECRET=...
export GOTONG_SLACK_APP_TOKEN=xapp-...                # Slack（Socket Mode）
export GOTONG_SLACK_BOT_TOKEN=xoxb-...
export GOTONG_QQ_BOT_APPID=102000000                  # QQ（官方 webhook，需反代 + 公网）
export GOTONG_QQ_BOT_SECRET=...
gotong start
```

> `startImBridges` 当前 env-gate **Telegram / Lark / Slack / QQ** 4 个平台。
> Discord / Matrix 桥仍走 `examples/im-bridge-host/` 的示例 router（折进 host 是独立
> 小步，见 [`IM-OFFICIAL-REARCH.md`](IM-OFFICIAL-REARCH.md) §六）。

行为约定（`startImBridges`）：

- **逐平台独立**：某平台 env 齐才构造它的桥，全 push 进同一个 `bridges` 数组。
- **best-effort 起桥**：一个平台凭证坏只 log + skip，不阻断其他平台、不阻断 host 启动
  （镜像 A2A / ACP 出站 manager）。
- **零行为变化**：全没设 → 返回 `undefined`，现有部署逐字节不受影响。

要完全自定义 router（改 help 文案 / 加 `/agents` / `/workflow` hook），复制
`examples/im-bridge-host/src/router.ts` 自己接——所有桥只依赖 `ImBridge` 契约，一套
router 接全部。

---

## 三、各 bridge 启动 cookbook

### 3.1 Telegram

```bash
# 1. 跟 @BotFather DM /newbot —— 拿 bot token
# 2. 在 @BotFather 给 bot 启用 inline mode（可选）
# 3. 给 bot 关掉 Privacy Mode（如果要在群里读消息）：
#    /setprivacy → Disable

export TELEGRAM_BOT_TOKEN=123456:AAEhBP...
node host.js
```

`TelegramBridge` 默认走长轮询 (`pollIntervalMs: 1500`)。公网入口完全不需要。

**坑**：
- Bot 在群里默认 privacy mode = enabled，只看到 `@yourbot` 提的消息；
  解除前测试用 DM。
- `getUpdates` 是 long-poll 不是 webhook —— 跟 Telegram 的 webhook 模式互斥，
  一个 bot 同时启 webhook 会让 long-poll 拿不到消息。

### 3.2 Matrix

```bash
# 1. 在 element-web / nheko 登录（建议建个专用账号当 bot）
# 2. 在客户端 Settings → Help & About 拿 access_token
# 3. 让 bot 账号 join 要监听的 room
export MATRIX_HOMESERVER=https://matrix.org
export MATRIX_ACCESS_TOKEN=syt_...
node host.js
```

**坑**：
- access_token 比 bot token 危险得多 —— 它是完整账号控制权。建议建专用 bot 账号。
- bridge 用 `/sync` 长轮询；不主动 join room，需要用户先邀请 bot 加入。
- 第一次 `/sync` 返回的 since token 必须缓存，不然每次重启都会重放历史。
  bridge 内部已经处理。

**Q: 想自己搭 Matrix homeserver？** 可以用官方 Synapse / Dendrite，docker-compose
片段：

```yaml
# docker-compose.matrix.yml (snippet)
services:
  synapse:
    image: matrixdotorg/synapse:latest
    restart: unless-stopped
    environment:
      SYNAPSE_SERVER_NAME: matrix.example.com
      SYNAPSE_REPORT_STATS: "no"
    volumes:
      - ./synapse-data:/data
    ports:
      - "8008:8008"   # client-server API
```

详细配置参考 [Synapse 官方文档](https://element-hq.github.io/synapse/latest/setup/installation.html)。

### 3.3 Lark / Feishu（官方长连接，免穿透）

```bash
# 1. 在 https://open.feishu.cn 建一个 "企业自建应用" → 拿 App ID + App Secret
# 2. 应用功能 → 机器人 → 启用
# 3. 事件订阅 → 传输方式选「长连接」（不是「发送至开发者服务器」）
#    —— 长连接由 bot 主动外拨，无需公网回调、无需 HTTPS、无需 Verification Token / Encrypt Key
# 4. 加事件：im.message.receive_v1
# 5. 权限管理 → 添加：im:message（收）+ im:message:send_as_bot（回）+ im:resource（附件，可选）
# 6. 版本管理与发布 → 发布

export GOTONG_LARK_APP_ID=cli_a1b2c3d4
export GOTONG_LARK_APP_SECRET=...
gotong start
```

bridge 用官方 `@larksuiteoapi/node-sdk` 的 `WSClient` 拨出一条持久 WS 收事件，出站发
消息仍走 REST（`tenant_access_token` 自动续，缓存 ~2h）。**不需要反代 / 公网 / TLS**
——跟 Telegram / Discord 一类。国际版只换 `baseUrl`（`open.larksuite.com`）。

**坑**：
- 务必选「长连接」而不是「发送至开发者服务器」——后者才是旧的 webhook 入站模式，
  本桥已不用。
- **卡片按钮回调事件长连接不投递**（那只走 HTTPS 回调）。纯文本聊天不受影响；要卡片
  按钮得另起 webhook 旁路（超出本桥范围）。

### 3.4 Discord

```bash
# 1. 在 https://discord.com/developers 建 Application
# 2. Bot 标签 → Add Bot → 拿 token
# 3. Privileged Gateway Intents 打开 MESSAGE CONTENT INTENT
#    （2022 年起需要这个 intent 才能读到 message.content）
# 4. OAuth2 → URL Generator → 勾 bot + applications.commands → 拿邀请 URL → 让管理员
#    把 bot 加进你的 server
export DISCORD_BOT_TOKEN=MTEz...
node host.js
```

bridge 连 `wss://gateway.discord.gg` 持久 WebSocket。

**坑**：
- intents 不全 → bridge 收到 message event 但 `content` 字段是空字符串。
  排查：先在 dev portal 确认 MESSAGE CONTENT INTENT 是 enabled。
- bridge 内部走 op 10 → identify → op 11 ack → 进 ready 流程；如果停在
  "connecting" 超过 30 秒，多半 token 错。日志里看 op 9 (invalid session)。
- shard 0 / 0 单实例 = 一个 bot；超过 2500 guild 才需要 sharding，本 bridge 不支持。

### 3.5 Slack（Socket Mode，免穿透）

```bash
# 1. 在 https://api.slack.com/apps 建 App（From scratch）
# 2. Socket Mode → Enable Socket Mode → 引导创建 App-Level Token（connections:write 作用域）
#    → 拿 xapp-... → 填 GOTONG_SLACK_APP_TOKEN
# 3. Event Subscriptions → 开启 → Subscribe to bot events:
#    message.channels, message.groups, message.im, message.mpim
#    （Socket Mode 下不需要 Request URL —— 事件从 socket 推下来）
# 4. OAuth & Permissions → Bot Token Scopes:
#    chat:write, app_mentions:read, channels:history, groups:history, im:history, mpim:history,
#    files:read（可选）
# 5. Install to Workspace → 拿 Bot User OAuth Token (xoxb-...) → 填 GOTONG_SLACK_BOT_TOKEN
# 6. 重新邀请 bot 进 channel：/invite @你的Bot

export GOTONG_SLACK_APP_TOKEN=xapp-...    # 开 Socket Mode 连接（入站）
export GOTONG_SLACK_BOT_TOKEN=xoxb-...    # chat.postMessage（出站）
gotong start
```

bridge 用 `xapp-` token 调 `apps.connections.open` 拿 WSS URL 再拨出，事件经 socket
推下来——**没有 Request URL、没有 TLS、没有 HMAC signing secret**，免穿透。

**坑**：
- 两个 token 别混：`xapp-`（app-level，开连接）vs `xoxb-`（bot，发消息）。
- `apps.connections.open` 返 `invalid_auth` / `not_allowed_token_type` 等 = app token
  配错，`start()` loud fail 不重试；限流 / 5xx / 网络按退避重连。
- `xoxb-` 是长期 token，泄露就完蛋；务必走环境变量别 commit。
- bridge 内部 `event_id` dedup 走 512-entry FIFO；正常 retry 都能去重。

### 3.6 QQ（官方 Bot API + Webhook，需公网 + 反代）

> QQ 是唯一**不免穿透**的桥：官方 Bot API 把 WebSocket 判死、只推**入站 webhook**，
> 所以要跑在云主机上、前面挂反代终止 TLS。它替代了旧的第三方 OneBot v11 实现（那个
> 驱动个人号、有封号风险）。详见 `packages/im-qq/README.md` +
> [`IM-OFFICIAL-REARCH.md`](IM-OFFICIAL-REARCH.md)。

```bash
# 1. 在 https://q.qq.com 注册 bot → 拿 AppID + AppSecret（ClientSecret）
#    旧 Token 在 webhook + v2 路径不用，桥不收它。
# 2. 配置 bot 的「回调地址」为你的公网 HTTPS 端点，如 https://bot.example.com/qq/webhook
#    保存时 QQ 发一次性回调校验（op:13），桥用 AppSecret 派生的 Ed25519 密钥自动应答。
# 3. 启 host（桥自起本地 HTTP 监听，反代转发到它）：
export GOTONG_QQ_BOT_APPID=102000000
export GOTONG_QQ_BOT_SECRET=...
export GOTONG_QQ_WEBHOOK_PORT=9092          # 可选，默认 9092；反代转发到这个端口
export GOTONG_QQ_WEBHOOK_PATH=/qq/webhook   # 可选，默认 /qq/webhook
gotong start
```

反代终止 TLS（nginx 示例），两个 `X-Signature-*` header 必须原样到达桥：

```nginx
location /qq/webhook {
    proxy_pass http://127.0.0.1:9092/qq/webhook;
    proxy_set_header X-Signature-Ed25519   $http_x_signature_ed25519;
    proxy_set_header X-Signature-Timestamp $http_x_signature_timestamp;
}
```

**坑**：
- **不免穿透**：QQ 必须有公网域名 + TLS + 反代，跑云主机（GO-LIVE 的 T2/T3），家用
  NAT 后面收不到官方 webhook。
- **群 / C2C 仅被动回复**：只能在用户消息时间窗内带 `msg_id` 回复；**主动推送
  2025-04 已停**——agent 主动 push（心跳 / 告警）到 QQ 群不可用，`sendMessage` 到一个
  没收过消息的会话会诚实失败。
- 富媒体（图片 / 文件 / 语音）MVP 未做，`sendMessage` 带 attachments 触发 `onError`
  但 text 仍发。

---

## 四、Docker compose 示例（QQ 反代子栈）

官方化后只有 **QQ** 还需要公网入口（其余五桥全出站免穿透，不需要反代）。如果你部署
QQ，给主 `docker-compose.yml` 旁边加一个 Caddy 终止 TLS、把 `/qq/webhook` 反代到 host：

```yaml
# docker-compose.im.yml — QQ 官方 webhook 的反向代理
# 用法: docker compose -f docker-compose.yml -f docker-compose.im.yml up -d

services:
  caddy:
    image: caddy:2
    container_name: gotong-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy-data:/data
      - ./caddy-config:/config
    depends_on:
      - gotong
```

Caddy 配置（自动 ACME 签发证书 + 转发 QQ webhook；T3 直连 IP 顺带反代 web）：

```caddy
# caddy/Caddyfile
your.host {
  encode gzip

  handle /qq/webhook* {
    reverse_proxy gotong:9092
  }
  handle {
    reverse_proxy gotong:3000   # T3 直连 IP 的 web/PWA；纯 T2 + QQ 可省
  }
}
```

> Lark / Slack **不再需要** Caddy——官方化后它俩走出站长连接 / Socket Mode，免穿透。
> 旧版这里的 NapCat adapter 子栈已随 OneBot 实现一并删除。

---

## 五、调试 cookbook

### 5.1 "/bind 没响应 / 提示无效"

1. 查 host 日志：bridge 收到消息了吗？
   ```
   [im-router/info] bind ok platform=telegram user=...
   ```
   没有 → bridge 的 `onMessage` 没起来。看 bridge.start() 是否成功。
2. 看 binding code 是否过期。默认 TTL 10 分钟。`identity.issueImBindingCode`
   返回值里的 `expiresAt`。
3. 数据库里看：
   ```sql
   SELECT * FROM im_binding_codes WHERE code = '748775';
   SELECT * FROM im_bindings WHERE platform = 'telegram' ORDER BY created_at DESC LIMIT 5;
   ```

### 5.2 "agent 收不到消息"

1. router 是否真的派发了？看 hub transcript：
   ```sql
   -- 假设 host 用文件 transcript：
   tail -50 .gotong/transcript.jsonl | grep '"kind":"task"'
   ```
2. agent 是否真的注册成功？
   ```ts
   console.log(hub.listParticipants())
   ```
3. capability 匹配错了？free-text 用的是 `freeTextDispatch.strategy.capabilities`
   —— 必须有 agent advertise 同名 capability。

### 5.3 "出向 sendMessage 失败"

各 bridge 错误形态：

| Bridge | 错误类 | 看哪里 |
|--------|-------|--------|
| Telegram | `TelegramApiError(code, description)` | description 一般人话 |
| Matrix | `MatrixApiError(status, errcode, error)` | `M_FORBIDDEN` = bot 没在 room；`M_LIMIT_EXCEEDED` = 限速 |
| Lark | `LarkApiError(code, msg)` | code 见 [Lark error code 列表](https://open.feishu.cn/document/server-docs/getting-started/server-error-codes) |
| Discord | `DiscordApiError(code, message)` | code 50001 = missing access |
| Slack | `SlackApiError(code, error)` | `not_in_channel` = bot 没在 channel |
| QQ | `QqApiError(status, code, detail)` | 官方 Bot API 错误；发到没收过消息的会话 → 被动回复无 `msg_id` 诚实失败 |

bridge 的 `onError(err)` 回调是关键诊断点 —— 集成时务必接上。

> QQ 专属：群 / C2C **只能被动回复**（官方主动推送 2025-04 已停）。所以「sendMessage
> 失败」在 QQ 上常常不是 bug，而是你想主动 push 一个没有先发过消息的会话——这条路
> 官方关了。

### 5.4 "bot 自己的消息又回来了"

bridge 的 anti-loop 都做了 3-4 层防线，但仍可能在以下情况漏：

- bot 是发出方但 `from.id` 是 user 而不是 bot（比如 Slack 的某些 system event）—
  检查 `bot_id` 字段，或在 router 加白名单。
- 多个 bot 实例都连同一个 IM 账号 — 不要这么干，按 §3.6 单实例原则。

---

## 六、安全清单

部署任何 bridge 前过一遍：

- [ ] 所有 token / secret 走 env 变量或 vault，**不要** commit 到代码或 `.env`。
- [ ] QQ webhook 必须 HTTPS + 反代（Caddy 自动 ACME 推荐）；两个 `X-Signature-*`
      header 必须原样到达桥（op:0 事件签名靠它验）。其余五桥出站免穿透，无入站面。
- [ ] Slack 两个 token 别混且别 commit：`xapp-`（开连接）/ `xoxb-`（发消息）。
- [ ] Lark 选「长连接」而非「发送至开发者服务器」——后者是旧 webhook 入站，会暴露面。
- [ ] Matrix access_token 用专用 bot 账号，不要用你的主账号 token。
- [ ] 不要把 bot 加到不该听的 channel/group — bridge 看到所有它能看到的消息。
- [ ] 路由器外发消息时不要 echo 回 IM 用户输入的敏感 token / code — router 里
      默认不会，但如果 fork 改 helpText 之类的小心。
- [ ] 启用 hub 的 `quota` 限制，防 IM 用户疯狂派发把 LLM 额度打爆。

---

## 七、Roadmap

|  Phase 12 milestone | 状态 |
|--------------------|------|
| M1 — `@gotong/im-adapter` + IM bindings | ✓ |
| M2 — `@gotong/im-telegram` | ✓ |
| M3 — `@gotong/im-matrix` | ✓ |
| M4 — `@gotong/im-lark` | ✓ |
| M5 — `@gotong/im-discord` | ✓ |
| M6 — `@gotong/im-slack` | ✓ |
| M7 — `@gotong/im-qq` | ✓ |
| **M8 — 本文 + `examples/im-bridge-host/`** | **✓ (本 milestone)** |
| M9-M11 — PWA + mobile shell | next |
| M12 — `@gotong/cli` REPL | next |
| M13 — Phase 12 release notes | next |

**更新（2026-06）**：host 现在通过 `startImBridges()` env-gate 了 Telegram / Lark /
Slack / QQ 4 个桥（见 §二）——填 env 即用，不再需要复制 example。Discord / Matrix 仍走
example router，折进 host env 闸是独立小步。官方化的理由与各桥 transport 决策见
[`IM-OFFICIAL-REARCH.md`](IM-OFFICIAL-REARCH.md)。
