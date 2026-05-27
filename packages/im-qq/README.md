# @aipehub/im-qq

Phase 12 M7 — sixth concrete `ImBridge` for AipeHub.

**EXPERIMENTAL.** QQ bot bridge over the third-party
[OneBot v11](https://github.com/botuniverse/onebot-11) protocol
(forward WebSocket transport). No SDK dep (`fetch` + globalThis
WebSocket).

> ⚠️ **风险提示 / Risk warning**
>
> 1. **OneBot v11 不是腾讯官方 API**。它是社区维护的 bot 协议规范，由 NapCat /
>    go-cqhttp / Lagrange / Mirai-onebot 等第三方实现暴露给 bot 作者。
>    这些实现都是逆向 QQ 客户端协议得来的。
> 2. **腾讯对个人 QQ 号自动化的态度反复无常**。曾经多次封禁主流 adapter
>    的运行账号；社区里频繁有 "号没了" 的案例。
> 3. **本 bridge 只是一个 OneBot v11 客户端**。所有 QQ 侧的风险归属于 adapter
>    层和你登的 QQ 账号 — bridge 本身不直接碰 QQ 协议。
> 4. 因此，bridge **默认拒绝启动**。必须设置 `AIPE_QQ_BRIDGE_ACK_RISK=true`
>    环境变量明确确认你理解风险。**不要拿主号试**，建议小号 / 测试号。
>
> 出问题（账号被封 / 数据丢失 / adapter 行为异常）请自负。

## What you get

```ts
import { QqBridge } from '@aipehub/im-qq'
import { parseImCommand } from '@aipehub/im-adapter'

const bridge = new QqBridge({
  url: 'ws://127.0.0.1:3001/',               // 你的 OneBot adapter 监听地址
  accessToken: process.env.ONEBOT_TOKEN!,    // adapter 配的 access_token
  onError: (err) => console.error('[qq]', err),
})

bridge.onMessage(async (msg) => {
  const cmd = parseImCommand(msg.text)
  switch (cmd.kind) {
    case 'help':
      await bridge.sendMessage(msg.from, '发 /bind <code> 来连接', {
        chatId: msg.chatId, // 'private:<qq>' 或 'group:<群号>'
      })
      break
    case 'bind':
      // hand off to ImBindingResolver
      break
    case 'free':
      // dispatch to Hub
      break
    // …
  }
})

// 启动前必须 export AIPE_QQ_BRIDGE_ACK_RISK=true
await bridge.start()
// later
await bridge.stop()
```

## 安装 OneBot adapter（推荐 NapCat）

bridge 自己不登录 QQ — 你需要一个本地跑的 OneBot v11 adapter 拿 QQ
登录态。当前主流选择：

| Adapter | 实现语言 | 状态 (2026-05) | 备注 |
|---------|---------|---------------|------|
| **NapCat** | C++ / NodeJS hook | 活跃 | 当前最活跃的实现，注入 QQNT 客户端 |
| **Lagrange.Core** | C# | 活跃 | 纯逆向协议；无需 QQ 客户端 |
| go-cqhttp | Go | 已 archived | 不再维护，老项目沿用 |
| Mirai + mirai-api-http | Kotlin/Java | 半活跃 | 旧但稳，OneBot 模式通过适配器 |

**NapCat 快速启动**（推荐）：

```bash
# 1. 下载 https://github.com/NapNeko/NapCatQQ/releases
# 2. 启动 NapCat — 第一次会要求登 QQ
# 3. 在 NapCat WebUI 配置 → Network → 加一条 "WebSocket Server"
#    监听 ws://127.0.0.1:3001/，可选 access_token
# 4. 配 message_format: "array"（不是默认的 "string"）
```

`message_format: 'array'` 让 adapter 直接发结构化的 message segments
(`[{type:'text',data:{text:...}}, {type:'image',data:{url:...}}]`)。
bridge 也兼容默认的 CQ-string form，但 attachment 提取会受限。

## 为什么 forward WebSocket，不是 HTTP / reverse WS？

OneBot v11 规范定义了三种 transport：

| 模式 | bridge 行为 | 何时选 |
|------|-----------|--------|
| **Forward WS** | bridge 主动连 adapter 的 `ws://host:port/` | **默认 — 简单可靠，没有第二个 listener** |
| Reverse WS | adapter 主动连 bridge 暴露的 ws endpoint | bridge 在 NAT 后面但 adapter 有公网出口 |
| HTTP POST + webhook | bridge POST → adapter；adapter POST → bridge | 跨语言桥接、需要 HTTP 中间件介入时 |

M7 只实现 forward WS — 涵盖 95% 的部署场景，最少的运维面。

## 入向事件路由

OneBot v11 push 4 类 event：

| `post_type` | 处理 |
|-------------|------|
| `message` | 走 `oneBotToImMessage` mapper → 派发监听者 |
| `meta_event` (lifecycle/heartbeat) | 抓 `self_id` 缓存；不派发 |
| `notice` (group_increase / friend_add / …) | 静默忽略 |
| `request` (friend_request / group_invite) | 静默忽略 |

每个 message event 的 anti-loop 防线：

1. `user_id === self_id` → 跳（绝大多数 adapter 把自己发的消息也 echo 回来）
2. `user_id === options.selfId` → 跳（显式 selfId 的情况）
3. `user_id` 非数字 → 跳

## chatId 编码

QQ 的 `group_id` 和 `user_id` 都是纯数字 — `ImMessage.chatId` 直接存数字
会跨 namespace 撞车。bridge 用带类型标签的形式：

- `private:<user_id>` — 私聊 QQ 号
- `group:<group_id>` — 群

`sendMessage(to, text, { chatId })` 解析回 `message_type` 给 `send_msg`
action 调用。Bridge 不替你猜上下文 — 一般直接转 `ImMessage.chatId` 就行。

## Surface

| Export                       | Purpose                                                       |
|------------------------------|---------------------------------------------------------------|
| `QqBridge`                   | `ImBridge` impl + risk gate + reconnect orchestration         |
| `QQ_RISK_ACK_ENV`            | 字符串常量 `'AIPE_QQ_BRIDGE_ACK_RISK'`                        |
| `createOneBotClient`         | Forward-WS client，echo 配对 + 超时                           |
| `OneBotApiError`             | retcode ≠ 0 抛出 — 带 `action`, `retcode`, `detail`           |
| `oneBotToImMessage`          | 纯映射: OneBot message event → `ImMessage`                    |
| `qqSegmentsToText`           | array form → 平文本                                           |
| `qqExtractAttachments`       | image / record (audio/silk) / file 抽取                       |
| `stripQqBotMentions`         | 剥 `[CQ:at,qq=<self>]` 和 array-form `at` segment             |
| `encodeQqChatId` / `parseQqChatId` | private/group chatId 编解码                             |
| `buildQqTextMessage`         | 包成单一 text segment（outbound 用）                          |

## Node 版本兼容

bridge 调用的是 `globalThis.WebSocket`：

- Node **22+**：内置，零依赖跑得起。
- Node **20.x**：没有内置 WebSocket — 装 `ws` 然后传入：
  ```ts
  import { WebSocket } from 'ws'
  new QqBridge({ url, webSocketImpl: WebSocket as unknown as WebSocketCtor })
  ```

## 附件如何工作

OneBot v11 array form 的 `image` / `record` / `file` segment 都带 `url`
字段，公开 CDN（类似 Discord，不像 Slack 的 auth-gated）。bridge 直接
pass-through 进 `ImAttachment.url`：

```ts
{
  kind: 'image',
  url: 'https://gchat.qpic.cn/.../pic.jpg',  // QQ CDN, 公开访问
  mime: null,                                 // OneBot 不带 MIME
  filename: 'pic.jpg',
}
```

`record` 用 `audio/silk` 因为 QQ 语音是 SILK 编码（不是 opus 也不是
mp3），下游消费者要明确这一点。M7 不解 CQ-string form 的 `[CQ:image,...]`
里的 url —— 强烈建议把 adapter 切到 `message_format: 'array'`。

## M7 不做的

- **OAuth / 登录流**. adapter 自己处理 QQ 登录；bridge 拿 `ws://`
  endpoint。
- **出向 attachment / image / record**. `sendMessage` 带 attachments
  会触发 `onError` 但 text 仍发出，跟 M2/M3/M4/M5/M6 一致。
- **Reverse WS / HTTP POST transport**. Forward WS 涵盖大部分场景。
- **CQ-string form attachment 解析**. 建议切 `message_format: 'array'`。
- **Sharding / multi-account**. 一个 bridge 实例 = 一个 QQ 登录。
- **Bot 频道 / 公众号**. 那是另一套 OAuth API（QQ官方 bot 平台），
  不在 OneBot v11 范围内。

## 测试

`tests/message.test.ts` 纯函数 (mapper + chatId 编解码 + mention strip
+ attachment 抽取，38 tests)；`tests/client.test.ts` Forward-WS
(FakeWebSocket 端到端：connect / echo 配对 / 超时 / disposed /
multiplex / 错误退化，18 tests)；`tests/bridge.test.ts` 用
`FakeOneBotClient` 走端到端：risk gate、lifecycle、reconnect 指数
backoff、event 派发、anti-loop、notice/request 跳过、sendMessage
shape（24 tests）。

```bash
AIPE_QQ_BRIDGE_ACK_RISK=true pnpm --filter @aipehub/im-qq test
# (测试用 __acknowledgeRiskInTest 旁路，不用 env)
pnpm --filter @aipehub/im-qq test
```

## Status

- Phase 12 M7 — released (experimental; transport only; host
  integration pending)。
- Next milestone: M8 (docs + docker-compose for the 6 IM bridges)。

See `docs/zh/V4-PHASE7-13-PLAN.md` section 七 for the full roadmap.
