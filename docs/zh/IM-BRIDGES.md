# IM Bridges — 部署 + 调试 cookbook

> Phase 12 M8 收尾文档。本文是把 6 个 `@aipehub/im-*` bridge 真接到生产
> host 的现场手册。读这篇之前推荐先看：
>
> - `examples/im-bridge-host/` —— 端到端 demo
> - `examples/im-bridge-host/src/router.ts` —— 可复制的 router 胶水
> - 各 bridge 自己的 `packages/im-*/README.md` —— 平台特定坑
>
> Last updated: 2026-05-27

---

## 一、六桥总览

|  Bridge | 协议 / Transport | 入站机制 | 出站机制 | 凭证形态 | 网络要求 |
|---------|-----------------|---------|---------|---------|---------|
| `@aipehub/im-telegram` | Bot API (HTTPS) | `getUpdates` 长轮询 | `sendMessage` | bot token | 出站 HTTPS 到 `api.telegram.org`（可走 proxy） |
| `@aipehub/im-matrix` | Client-Server API | `/sync` 长轮询 (timeout 30s) | `PUT .../send/m.room.message/<txn>` | access_token | 出站 HTTPS 到 homeserver |
| `@aipehub/im-lark` | Open API + Webhook | HTTPS webhook（**入向需要公网**） | `POST .../im/v1/messages` | app_id + app_secret | **入向公网 + 出站 HTTPS** 到 `open.feishu.cn` |
| `@aipehub/im-discord` | Gateway (WSS) | WebSocket gateway 持久连 + heartbeat | `POST /channels/.../messages` | bot token + intents | 出站 WSS + HTTPS 到 `discord.com` |
| `@aipehub/im-slack` | Events API webhook | HTTPS webhook（**入向需要公网**） | `chat.postMessage` (HTTPS) | signing secret + bot token | **入向公网 + 出站 HTTPS** 到 `slack.com` |
| `@aipehub/im-qq` | OneBot v11 forward WS | bridge 主动连 adapter 的 `ws://` | adapter 的 `send_msg` action | adapter access_token | bridge 跟 adapter 都需要本地能跑 |

**三种部署模式**（从最简单到最折腾）：

1. **长轮询 (Telegram, Matrix)** — 最省心。bridge 自己向云端拉，**不需要公网入口**，
   家里 NAT 后面也能跑。代价是延迟 1-5 秒（看 long-poll 配置）。
2. **持久 WebSocket (Discord, QQ)** — 一条长连，秒级延迟。Discord 跟云端连；
   QQ 跟你本地 adapter 连。**也不要公网入口**。
3. **Webhook (Slack, Lark)** — 平台主动 POST 到你给的 URL。**必须公网可达 + TLS**，
   通常配 Caddy / Nginx 反代到 bridge 的 HTTP 端口。延迟最低。

如果你要从一个 0 入向公网的家用机跑：选 Telegram + Matrix + Discord + QQ（4 个），
跳过 Slack + Lark（这两个非要走 webhook 的）。

---

## 二、通用集成 (host 侧)

所有 bridge 共享同一套 router glue 代码。复用模式：

```ts
import { TelegramBridge } from '@aipehub/im-telegram'
import { SlackBridge } from '@aipehub/im-slack'
import { QqBridge } from '@aipehub/im-qq'
// …

import { makeIdentityImBindingResolver } from './im/identity-resolver.js'
import { createImRouter } from './im/router.js'   // 复制自 examples/im-bridge-host/src/router.ts

const resolver = makeIdentityImBindingResolver(identity)
const router = createImRouter({
  hub,
  resolver,
  freeTextDispatch: { strategy: { kind: 'capability', capabilities: ['chat'] } },
  onUnbind: async (platform, platformUserId) => {
    const n = identity.removeImBinding(platform, platformUserId)
    return { removed: n > 0 }
  },
  // ……其他 hook
})

// 同一套 router 接所有 bridge：
const bridges = [
  new TelegramBridge({ token: process.env.TELEGRAM_BOT_TOKEN! }),
  new SlackBridge({
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    botToken: process.env.SLACK_BOT_TOKEN!,
  }),
  new QqBridge({ url: process.env.QQ_ONEBOT_URL ?? 'ws://127.0.0.1:3001/' }),
]

for (const b of bridges) {
  b.onMessage((msg) => router.handle(b, msg))
  await b.start()
}

// 退出时：反向 stop
process.on('SIGINT', async () => {
  for (const b of bridges.slice().reverse()) await b.stop()
  await hub.stop()
  process.exit(0)
})
```

完整可跑示例：`examples/im-bridge-host/`。

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

### 3.3 Lark / Feishu

```bash
# 1. 在 https://open.feishu.cn 建一个 "企业自建应用"
# 2. 应用功能 → 机器人 → 启用
# 3. 事件订阅 → 把 Request URL 填成 https://your.host/lark/webhook
#    Verification Token 留着，bridge 用它做请求验签
# 4. 加事件：im.message.receive_v1
# 5. 权限管理 → 添加：
#    - im:message       (收发消息)
#    - im:message:send_as_bot
#    - im:resource      (附件下载, 可选)
# 6. 在 "凭证与基础信息" 抄 App ID + App Secret

export LARK_APP_ID=cli_a1b2c3d4
export LARK_APP_SECRET=...
export LARK_VERIFICATION_TOKEN=...
node host.js
```

bridge 默认监听 `0.0.0.0:9090/lark/webhook`。需要反代到公网：

```caddy
# /etc/caddy/Caddyfile (snippet)
your.host {
  handle /lark/webhook {
    reverse_proxy 127.0.0.1:9090
  }
  # …其他路由
}
```

**坑**：
- Lark 走的是 **请求加密 v2**（AES + base64）；bridge 已经处理，但
  Feishu 后台的 "加密策略" 必须设成 `不加密`（明文 + verification token），
  否则要在 bridge 配 `encryptKey`。
- token 是 `app_access_token` 自动续，bridge 内部缓存 2h；首次出消息会
  有 ~50ms 多走一次拿 token 的开销。

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

### 3.5 Slack

```bash
# 1. 在 https://api.slack.com/apps 建 App
# 2. Event Subscriptions → 启用，Request URL 填 https://your.host/slack/webhook
#    Slack 会发 url_verification 测试，bridge 自动回 challenge。
# 3. Subscribe to bot events: message.channels, message.im, message.groups
# 4. OAuth & Permissions → Bot Token Scopes:
#    - chat:write
#    - im:history, channels:history, groups:history
#    - files:read (可选)
# 5. Install to Workspace → 拿 Bot User OAuth Token (xoxb-...)
# 6. Basic Information → Signing Secret 抄一份

export SLACK_SIGNING_SECRET=...
export SLACK_BOT_TOKEN=xoxb-...
node host.js
```

bridge 默认监听 `0.0.0.0:9091/slack/webhook`。需要反代到公网：

```caddy
your.host {
  handle /slack/webhook {
    reverse_proxy 127.0.0.1:9091
  }
}
```

**坑**：
- raw body 必须保留 —— Slack 用 HMAC SHA256 对 `v0:${ts}:${rawBody}` 签名。
  如果用 Express 把它当 `bodyParser.json()` 处理掉，签名会永远验不过。
  bridge 自带 HTTP server 已正确处理。
- xoxb-token 是长期 token，不像 Lark 要刷新 —— 但泄露了就完蛋。务必装环境变量，
  别 commit。
- bridge 内部 `event_id` dedup 走 512 entry FIFO；正常 retry 都能去重，
  极端高 QPS 下小心。

### 3.6 QQ (OneBot v11)

> ⚠️ **风险提示**：OneBot v11 不是腾讯官方 API，是社区逆向出来的协议。
> Tencent 反复封号。请用小号 / 测试号，不要主号。详见 `packages/im-qq/README.md`。

```bash
# 1. 装 OneBot adapter (推荐 NapCat)
#    下载: https://github.com/NapNeko/NapCatQQ/releases
#    跑 NapCat → 扫码登 QQ → WebUI 配 Network → 加 WebSocket Server
#      监听: ws://127.0.0.1:3001/
#      access_token: napcat-token-xxx (建议带)
#      message_format: array (不是默认的 string)
#
# 2. 启 bridge:
export AIPE_QQ_BRIDGE_ACK_RISK=true     # 必须，否则 bridge 拒绝启动
export ONEBOT_TOKEN=napcat-token-xxx
node host.js
```

NapCat 当然也能 docker 化：

```yaml
# docker-compose.napcat.yml (snippet — 跑 NapCat adapter)
services:
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    restart: unless-stopped
    ports:
      - "127.0.0.1:3001:3001"   # OneBot WS (bridge 连这里)
      - "127.0.0.1:6099:6099"   # WebUI (首次扫码登录)
    volumes:
      - ./napcat-data:/app/.config/QQ
      - ./napcat-config:/app/napcat/config
    environment:
      ACCOUNT: "你的QQ号"
      WEBUI_PORT: "6099"
```

跑起来后 `http://127.0.0.1:6099` 扫码登录 QQ，在 WebUI 里加 WebSocket Server 配置。

**坑**：
- 没 export `AIPE_QQ_BRIDGE_ACK_RISK=true` → bridge 构造时直接 throw（这是
  设计：让你 fail-fast 而不是上线后才发现）。
- `message_format: array` 必须配 —— 默认 string 模式下，bridge 收到的是 CQ-string
  (`[CQ:image,file=xxx]`)，attachment 提取受限。
- adapter 选型：当前最活跃是 NapCat 和 Lagrange.Core。go-cqhttp 已停维护，
  Mirai 半活跃但走 onebot 模式需要 mirai-api-http 桥接。
- 单 bridge 实例 = 单 QQ 登录。多账号要起多个进程。

---

## 四、Docker compose 示例（IM 子栈）

主 `docker-compose.yml` 已经包含 host 进程。如果要把 QQ adapter 一起部署，
新建 `docker-compose.im.yml`：

```yaml
# docker-compose.im.yml — 跑在主 host 旁边的 IM 相关服务
# 用法: docker compose -f docker-compose.yml -f docker-compose.im.yml up -d

services:
  # NapCat adapter for QQ bridge —— 详见 §3.6
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: aipehub-napcat
    restart: unless-stopped
    ports:
      - "127.0.0.1:3001:3001"
      - "127.0.0.1:6099:6099"
    volumes:
      - ./napcat-data:/app/.config/QQ
      - ./napcat-config:/app/napcat/config
    environment:
      ACCOUNT: "${QQ_ACCOUNT:?需要在 .env 设 QQ_ACCOUNT}"
      WEBUI_PORT: "6099"

  # Caddy 反代 —— 如果要跑 Slack / Lark webhook
  caddy:
    image: caddy:2
    container_name: aipehub-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy-data:/data
      - ./caddy-config:/config
    depends_on:
      - aipehub
```

主 host 在 `docker-compose.yml` 里跑 `aipehub-host` 容器；这里加 Caddy + NapCat。

Caddy 配置：

```caddy
# caddy/Caddyfile
your.host {
  encode gzip

  handle /slack/webhook* {
    reverse_proxy aipehub:9091
  }
  handle /lark/webhook* {
    reverse_proxy aipehub:9090
  }
  handle {
    reverse_proxy aipehub:3000
  }
}
```

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
   tail -50 .aipehub/transcript.jsonl | grep '"kind":"task"'
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
| QQ | `OneBotApiError(action, retcode, detail)` | retcode 100 = bad param；wording 中文 |

bridge 的 `onError(err)` 回调是关键诊断点 —— 集成时务必接上。

### 5.4 "bot 自己的消息又回来了"

bridge 的 anti-loop 都做了 3-4 层防线，但仍可能在以下情况漏：

- bot 是发出方但 `from.id` 是 user 而不是 bot（比如 Slack 的某些 system event）—
  检查 `bot_id` 字段，或在 router 加白名单。
- 多个 bot 实例都连同一个 IM 账号 — 不要这么干，按 §3.6 单实例原则。

---

## 六、安全清单

部署任何 bridge 前过一遍：

- [ ] 所有 token / secret 走 env 变量或 vault，**不要** commit 到代码或 `.env`。
- [ ] webhook bridge (Slack/Lark) 必须 HTTPS。Caddy 自动 ACME 推荐。
- [ ] Slack signing secret 验签开着（bridge 默认）；不要把验签关掉。
- [ ] Lark verification token 配着（bridge 默认要求）。
- [ ] QQ bridge 的 `AIPE_QQ_BRIDGE_ACK_RISK=true` 是显式确认 —— 设这条意味着
      你接受 QQ 账号被封的风险。
- [ ] Matrix access_token 用专用 bot 账号，不要用你的主账号 token。
- [ ] 不要把 bot 加到不该听的 channel/group — bridge 看到所有它能看到的消息。
- [ ] 路由器外发消息时不要 echo 回 IM 用户输入的敏感 token / code — router 里
      默认不会，但如果 fork 改 helpText 之类的小心。
- [ ] 启用 hub 的 `quota` 限制，防 IM 用户疯狂派发把 LLM 额度打爆。

---

## 七、Roadmap

|  Phase 12 milestone | 状态 |
|--------------------|------|
| M1 — `@aipehub/im-adapter` + IM bindings | ✓ |
| M2 — `@aipehub/im-telegram` | ✓ |
| M3 — `@aipehub/im-matrix` | ✓ |
| M4 — `@aipehub/im-lark` | ✓ |
| M5 — `@aipehub/im-discord` | ✓ |
| M6 — `@aipehub/im-slack` | ✓ |
| M7 — `@aipehub/im-qq` | ✓ |
| **M8 — 本文 + `examples/im-bridge-host/`** | **✓ (本 milestone)** |
| M9-M11 — PWA + mobile shell | next |
| M12 — `@aipehub/cli` REPL | next |
| M13 — Phase 12 release notes | next |

host main.ts 还**没有**默认装 IM bridge —— 现状是用户复制 example 当模板。
等社区使用模式稳定（哪些 hook 真的有人 fork、哪些只是装饰），再决定要不要
fold 进 host CLI 当 first-class config 选项。
