# @aipehub/im-lark

Phase 12 M4 — third concrete `ImBridge` for AipeHub.

A Lark / Feishu Open Platform Bot bridge implemented against
[`@aipehub/im-adapter`](../im-adapter)'s `ImBridge` interface.
Webhook (Event Subscription) mode; no `@larksuiteoapi/node-sdk`
dependency (just `fetch`); ~600 lines of implementation.

国内（Feishu）和国际（Lark）切换只需要换 `baseUrl`。

## What you get

```ts
import { LarkBridge } from '@aipehub/im-lark'
import { parseImCommand } from '@aipehub/im-adapter'

const bridge = new LarkBridge({
  appId: process.env.LARK_APP_ID!,
  appSecret: process.env.LARK_APP_SECRET!,
  verificationToken: process.env.LARK_VERIFICATION_TOKEN!,
  // baseUrl: 'https://open.larksuite.com',  // 国际版
  // baseUrl is 'https://open.feishu.cn' by default (国内)
  webhookPort: 9090,
  webhookPath: '/lark/webhook',
  onError: (err) => console.error('[lark]', err),
})

bridge.onMessage(async (msg) => {
  const cmd = parseImCommand(msg.text)
  switch (cmd.kind) {
    case 'help':
      await bridge.sendMessage(msg.from, '发 /bind <code> 来连接', {
        chatId: msg.chatId,
      })
      break
    case 'bind':
      // hand off to ImBindingResolver (host wiring)
      break
    case 'free':
      // dispatch to Hub
      break
    // …
  }
})

await bridge.start()
// later
await bridge.stop()
```

## Setup at the Open Platform admin panel

1. 创建应用（cli_xxx）— 拿到 **App ID** + **App Secret**。
2. 在「凭证与基础信息」页找到 **App Secret**。
3. 启用「机器人」能力，在「事件订阅」页：
   - 复制 **Verification Token**（这是 bridge `verificationToken` 配置项）。
   - **不要**配置 Encrypt Key（M4 只支持明文模式）。
   - 「请求网址」填 `https://<你的域名>/lark/webhook`（生产必须 HTTPS — 用反代终止 TLS）。
   - 添加事件 `im.message.receive_v1`。
4. 给机器人加权限：`im:message`（接收）+ `im:message:send_as_bot`（回消息）。
5. 「版本管理与发布」发布到企业内部测试 / 全量。

国际版 Lark 的配置在 [open.larksuite.com](https://open.larksuite.com)，流程一致。

## 为什么 webhook，不是 long-poll？

Lark 没有通用 long-poll API；事件订阅是官方推荐路径。Bridge 自带一个
最小 `node:http` listener:

- 默认 `POST /lark/webhook` → `handleEvent(body)` → 派发监听者
- `GET <任意路径>` → `200 lark-bridge ok` 健康检查
- 验证 token 不匹配 → `401`，触发 onError
- 收 `url_verification` → 自动 echo `challenge`
- 收 Schema 2.0 envelope → 按 `event_type` 路由（M4 只处理 `im.message.receive_v1`）

如果 host 已经有 HTTP 层（`@aipehub/web`），把 `webhookPort: 0` 关闭
内置 listener，再让 host 自己路由 `POST /lark/webhook` 进 `bridge.handleEvent(body)`
即可，零额外端口。

## Surface

| Export                         | Purpose                                                       |
|--------------------------------|---------------------------------------------------------------|
| `LarkBridge`                   | `ImBridge` impl + 内置 webhook listener                       |
| `createLarkClient`             | Fetch 封装，自动管理 `tenant_access_token`                    |
| `LarkApiError`                 | 非 0 code 抛出 — 携带 `code`, `msg`, `status`                 |
| `larkToImMessage`              | 纯映射: `LarkMessageReceiveEvent` → `ImMessage`               |
| `larkExtractAttachments`       | 拉 image / audio / file 出来                                  |
| `larkUri` / `parseLarkUri`     | `lark-image:` / `lark-audio:` / `lark-file:` URI 工具         |
| `stripLarkMentions`            | 剥掉群消息里的 `<at>` 标签                                    |
| `pickLarkReceiveIdType`        | 根据前缀（`oc_`/`ou_`/`on_`）推 `receive_id_type` 值           |

## Token 管理

Lark 用短命的 `tenant_access_token`（约 2 小时 TTL）。`createLarkClient`：

- 第一次业务调用前 `POST /open-apis/auth/v3/tenant_access_token/internal`
  拿 token，缓存
- 在 token 过期前 ~2 分钟（safety margin）主动 refresh
- 并发调用合并到同一个 refresh promise（不 thundering-herd）
- `invalidateToken()` 强制下次调用 refresh（在响应里看到 `99991663` 之类
  token 失效错误时调）

## 附件如何工作

入向 image / audio / file 包装成 `lark-<kind>:<key>` URI；字节**不**
预下载。下游需要时：

```ts
import { parseLarkUri } from '@aipehub/im-lark'

const parsed = parseLarkUri(att.url)!
const endpoint = parsed.kind === 'image' ? 'images' : 'files'
const url = `https://open.feishu.cn/open-apis/im/v1/${endpoint}/${parsed.key}`
const res = await fetch(url, {
  headers: { authorization: `Bearer ${TENANT_TOKEN}` },
})
const bytes = await res.arrayBuffer()
```

## 群里 @机器人 的处理

群消息里机器人会被 `<at user_id="ou_bot">@Bot</at>` 提及。`parseImCommand`
不接受这种前缀，所以 bridge 默认 `stripBotMentions: true` 帮你去掉。如
果要保留原文，关掉这个选项。

## 国内 vs 国际

只换 `baseUrl`，event schema 完全一致：

```ts
// 国内 Feishu — 默认
new LarkBridge({ ..., /* baseUrl: 'https://open.feishu.cn' (default) */ })

// 国际 Lark
new LarkBridge({ ...,
  clientOptions: { baseUrl: 'https://open.larksuite.com' }
})
```

## M4 不做的

- **加密事件** (`encrypt_key` 模式). 业务事件 body 整体 AES 加密，
  bridge 只走明文模式，verification token 比对足以认证。
- **出向附件 / 图片 / 卡片**. `sendMessage` 带 attachments 会触发
  `onError` 但 text 仍发出，跟 Telegram M2 / Matrix M3 一致。
- **交互卡片 / 回调按钮** (`message_action_v1`). 只处理
  `im.message.receive_v1`。
- **TLS 终止**. Bridge listen 明文 HTTP，生产环境必须用反代（nginx /
  traefik / Caddy）终止 TLS — Lark webhook 要求 HTTPS。
- **OAuth/SSO/Marketplace 应用流程**. 假定内部企业应用 + 长期 app
  secret。
- **Schema 1.0 events**. 已废弃；bridge 拒绝。

## 测试

`tests/bridge.test.ts` 主要走 `handleEvent(body)` 直接喂事件，少数
case 起 HTTP listener 验证 wire-up（404/401/200/challenge）。
`FakeLarkClient` 不打网络，sendMessage 验证 `receive_id_type` 自动嗅探。

## Status

- Phase 12 M4 — released（transport only；host integration pending）。
- Next milestones: M5 (Discord), M6 (Slack), M7 (QQ / OneBot v11)。

See `docs/zh/V4-PHASE7-13-PLAN.md` section 七 for the full roadmap.
