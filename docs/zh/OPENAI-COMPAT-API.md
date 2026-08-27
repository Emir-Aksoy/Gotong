# OpenAI 兼容入站面（OPENAI track）

> **方向: C+T**（C agent 间协作框架 · T 工具调用能力；方法论层 = **形态兼容**——
> 到对方已经在的地方，用他们已有的形态）
>
> Status: **M0 计划完（2026-08-26）** · M1 待做 · M2 待做 · M3 待做

---

## 一、这一刀要补的是什么

出站早就是 OpenAI 形状了——`packages/llm-openai` 的 provider 名字就叫
`'openai-compatible'`，生产上 MiMo / LongCat / DeepSeek 全走它。**缺的是反过来那一半**：

> 别人的 OpenAI 客户端（SDK、LangChain、Dify、Open WebUI、Cursor、任何一个
> 只会说 `POST /v1/chat/completions` 的东西）**没有一条路能把 Gotong 里的
> agent 当成一个模型来调。**

全仓 grep `/v1/chat/completions` 只有一处命中，而那是一句错误提示
（`local-agent-pool.ts:2256`），不是路由。这条路今天不存在。

补上它，"Gotong 里的一个 agent" 就变成了任何 OpenAI 生态工具眼里的一个
model id——**对方零改动**。这正是形态兼容的判据（EXCH track 同一条）。

---

## 二、四条不可破的边界

### ① 闸零绕过

这是整刀的地板。走这条路进来的调用，**与 `/me` 聊天走的是同一次
`hub.dispatch`、同一个 governed 闸、同一份配额账本**。

具体地说，被拒绝的是这三件事：

- **不接 `tools` / `functions` 参数**。接了就意味着 hub 里的 agent 会返回
  「请你（调用方）去执行这个工具」——那是把执行权交到闸外面。调用方发了
  `tools` → **400 响亮拒**，不静默忽略（静默忽略会让调用方以为工具会被用）。
- **park 不折成 tool_calls**（见 §4 岔口 a）。
- **调用方发的 `system` 消息不生效**。agent 的人设在 hub 里配置，改它要走
  admin 门。让一段 HTTP body 覆盖人设 = 把配置面挪进调用面。

### ② 无状态：以调用方发来的 messages 为准

OpenAI 协议的契约是「你发的 `messages[]` 就是全部上下文」。所以这条路
**不读也不写 hub 侧的 SESS 会话窗**。

理由不是省事，是诚实：偷偷把 hub 侧那 12 条窗混进去，会让同一组 messages
在不同时刻得到不同答案，而调用方无从得知自己少看了什么。

（agent 自己的长期记忆不受影响——那是 agent 是谁的一部分，不是这次对话的上下文。）

### ③ 零新旋钮（116 冻结）

surface 接不接**就是**开关，与 panel / push / exchange 同一姿态。不设 env。

### ④ 内核零改动

新增一个 `packages/web/src/openai-compat-routes.ts` + 一个鸭子 surface；
core / protocol / workflow / identity 一个字节不动。

---

## 三、侦察实录（全 file:line，2026-08-26 核）

| 问题 | 答案 | 出处 |
|---|---|---|
| 出站是不是已经 OpenAI 形状 | 是，provider 名就叫 `openai-compatible` | `packages/llm-openai/src/provider.ts:35` |
| 入站有没有 | **没有**，全仓一处命中且是错误串 | `packages/host/src/local-agent-pool.ts:2256` |
| bearer 能不能直接用 | 能，`aipk_` / `adm_` 早就认 | `packages/web/src/identity-routes.ts:648` |
| 非浏览器面怎么绕开 CSRF 门 | 已有四个先例，都是「自己的 bearer 域」 | `server.ts:872`(A2A) `:901`(设备配对) `:940`(SAML) `:950`(metrics) |
| /me 聊天现在什么形状 | body `{prompt, timeoutMs, stream}`，dispatch payload `{prompt, history?}` | `me-routes.ts:2442-2560` |
| 流式管道现成吗 | 现成，NA-M6b 的 per-call `chatChunkSinks`（register/release） | `me-routes.ts:2526-2545` |
| 成员能看见哪些 agent | `listForMembers()` + E4-M1 grant 门 + BUTLER-CHAT 管家豁免 | `me-routes.ts:1948`、`:2466-2486` |
| park 的结果长什么样 | `{kind:'suspended', taskId, resumeAt, ...}`，人工审批用 `NEVER_RESUME_AT` 哨兵 | `protocol/src/types.ts:205`、`im-bridge.ts:1834` |
| 结果里带 token usage 吗 | **不带**——usage 走 `usageSink` 进账本，不进 TaskResult | `llm/src/agent.ts:170-206` |
| 行数预算余量 | server.ts 2476/2490、me-routes.ts 2947/2960 | `scripts/line-budget-gate.mjs:51-52` |

---

## 四、设计定型

### 4.1 挂载点：顶层 `/v1/*`，CSRF 门之前

```
POST /v1/chat/completions
GET  /v1/models
```

**为什么是顶层不是 `/api/v1`**：OpenAI 客户端的 `base_url` 惯例就是
`<host>/v1`，SDK 自己会拼 `/chat/completions`。挂在 `/api/v1` 会逼每个调用方
写一个非标准 base_url——而"对方零改动"正是这一刀存在的理由。

**为什么在 CSRF 门之前**：与 metrics / A2A 同一档——OpenAI SDK 不是浏览器，
不发 Origin，也没有 ambient cookie 可供一次 CSRF 去花。**bearer 就是授权**。
这个论证必须写在挂载处（server.ts），不能折进 routes 文件——挂载处的注释
就是那道门的说明书（SHELL-M1 / HANDS-M3b 同规）。

### 4.2 鉴权：复用既有 `aipk_` bearer

`Authorization: Bearer aipk_...` → `resolveV4Auth`（`identity-routes.ts:629`）。
OpenAI SDK 天生就发这个头，调用方什么都不用改。

**不新开签发口**：成员自助拿 key 的路 SHELL-M1 已经建好（设备配对二维码），
owner 签发的路一直都在。

无 bearer / 坏 bearer → `401` + OpenAI 的标准错误信封：

```json
{"error":{"message":"...","type":"invalid_request_error","code":"invalid_api_key"}}
```

### 4.3 `model` 就是 agent id

`GET /v1/models` 列这个成员**看得见的** agent——直接继承 E4-M1 的 viewer grant
门与 BUTLER-CHAT 的管家行豁免，**不新开披露面**：

```json
{"object":"list","data":[{"id":"assistant","object":"model","owned_by":"gotong"}]}
```

未知 / 无权的 model → `404` `model_not_found`（两者同一个回答，不做探测面）。

### 4.4 `messages[]` → dispatch payload

| OpenAI | 映射 | 说明 |
|---|---|---|
| 最后一条 `role:'user'` | `payload.prompt` | 不是 user 结尾、或空 → 400 |
| 它之前的 user/assistant | `payload.history` | 与 SESS 窗同一渲染形状（下面两条规则） |
| `role:'system'` | **忽略** | 边界③——人设在 hub 里 |
| `role:'developer'` | **忽略** | 同上。它是 `system` 的新名字，漏认一个就等于开了后门 |
| `role:'tool'` / `function` | **400** | 边界①——我们不接外部工具循环 |
| `content` 是数组 | 全是 `{type:'text'}` 才收，**否则 400** | 图片/音频块是另一个数据面（§6），静默丢掉等于撒谎 |

`history` 的两条规则**逐字抄自** `session-window.ts` 的 `render()`，不是另写一份：

1. **同角色连续项合并**（`\n\n` 连接）——严格轮替的 provider 见了两条背靠背
   的 assistant 会当场拒。
2. **丢掉结尾的 user 项**——当前那句由 `LlmAgent.buildRequest` 紧接着追加，
   不丢就是两条背靠背的 user。

### 4.5 park 语义 —— 岔口 a（用户拍板）

**park 时返回 `200` + 一条正常的 assistant 消息，`finish_reason:'stop'`**，
正文说明这件事挂起了、去哪儿批。

三条为什么：

- **为什么不是 HTTP 错误（选项 b）**：调用方是个 SDK，非 2xx 会被它当传输故障
  重试。而 park **不是故障**——它是一次成功的、正确的、需要人点头的对话轮。
  用错误码表达它，会把"等你确认"变成"服务坏了"。
- **为什么不是 `tool_calls`（选项 c）**：调用方看到 tool_call 就会去执行它，
  而那正是闸刚刚挡下来的那个动作。**这是把闸交给调用方**，撞边界①。
- **为什么语义不算撒谎**：那确实是助手说的话。助手说「这件事我得先问你一声」
  是一句真话，不是一个伪装成回复的错误。

**正文里放什么**（顺序承重）：

1. **永远**先指网页「我的 → 收件箱」——那条路一定在。
2. 尽力带上**那件事的标题**（`inbox.listPending(userId)` 里 `itemId === taskId`
   的那条，取 `title` 否则 `prompt`，清洗后截 80 码点）。让人知道要去批的是哪件。
3. **取不到就退回通用措辞，绝不编一个标题。** 待批项由 suspend notifier 写：
   它先写 `suspended_tasks` 后写待批项，而 dispatch 的 promise 在前一步就
   resolve 了——存在一个竞态窗，查不到就是查不到。inbox surface 没接也一样。

**M1 不报 IM 短码，这是刻意的。** 短码是 `imShortId()` —— 一个 **HMAC 内容指纹**，
钥匙在 host 侧 `<space>/runtime/im-shortcode.key`，而 web 拿到的 `InboxItemView`
里根本没有这个字段（它只带 `{itemId, kind, prompt, title?, options?, editField?,
createdAt, handoffNote?}`）。要报它就得新开一条 host surface 把指纹递过来——
那是 M3 的活，不折进 M1。**在它到位之前，一个字也不提 `/approve`**：指一条
可能不存在的路，比说「去网页批」更坏（HANDS-M3b `linkBaseUrl` 判例）。

> 到了 M3 也不构成新披露：`resolveByShortId` 只在**调用者自己的** listPending
> 范围内匹配，而调用者就是这条 bearer 的主人。把他自己那件事的短码给他，
> 正是 `/inbox` 每天在做的事。

### 4.6 流式：SSE，但内容 delta 只在结果定稿后发

`stream:true` → `text/event-stream`，OpenAI 的 `data: {...}` 帧 + `data: [DONE]`。

**这里有一个必须诚实处理的东西**：带工具的 agent 会重放多轮，**只有最后一轮
的文本是回复**。`/me` 的 SPA 能接受预览不准，因为它拿到 result 行会**整体替换**；
而 OpenAI 的 SSE 语义是「delta 累加 = 最终答案」，**没有"整体替换"这个动作**。
把中间轮的文本当 delta 发出去，累加起来就不等于最终答案——那是撒谎。

所以 M2 的形状是：**SSE 连接立即建立并保持**（客户端不会超时），但**内容 delta
只在最终结果确定后发出**。代价是首 token 延迟没有改善，收益是 delta 累加永远
等于最终答案。这一条如实写进文档，不含糊成"支持流式"。

**M1 对 `stream:true` 一律 400，不静默降级成非流式。** 一个要了流的客户端
拿到一坨完整 body，会以为自己在流；宁可让它当场知道这儿还没有流。

真 token 流要等 host 侧能标出轮次边界（或标出「这个 agent 没有工具」），
列进 §6 显式推迟。

### 4.7 参数：拒绝那些"忽略了就等于撒谎"的，忽略那些"忽略了只是没调到参"的

| 参数 | 怎么办 | 为什么 |
|---|---|---|
| `tools` / `functions` / `tool_choice` | **400** | 边界①，执行权 |
| `n` > 1 | **400** | 返回 1 个 choice 却说好了 n 个 = 撒谎 |
| `logprobs` / `logit_bias` | **400** | 要的是我们结构上给不出的东西 |
| `temperature` `top_p` `max_tokens` `stop` `seed` | **忽略**，文档写明 | 边界③——那些是 **agent 主人**配的，一个调用方不该能改别人 agent 的行为方式。`payload` 里连键都不出现。拒了则会挡掉几乎所有客户端（它们默认就发这些） |
| `usage` 回什么 | **整个字段缺席** | TaskResult 不带 token 数；报 0 会被读成"这次调用免费"。真账在 `/me` 用量面板 |

### 4.8 归属与限流

`origin: {orgId:'local', userId}`（同 `/me` chat）⇒ 配额按人记账。

限流走既有 `loginLimiter`，**桶名 `openai-compat:<userId>`**——按人一个桶，
超了 `429` + `retry-after: 60`。刻意**不**复用 `checkMeRateLimit`：那条会顺手
写一行审计，而一个 SDK 循环打端点写满审计表，等于把一条正常用法变成噪音源。

---

## 五、里程碑

| | 内容 | 验收 |
|---|---|---|
| **M1** ✅ | 非流式 `POST /v1/chat/completions` + `GET /v1/models` + 鉴权 + 参数校验 + **park 语义（岔口 a）** | **真 `openai@6` SDK**（未改一字节）打通问答/列模型/park 不抛/越权 404；`tools`、`n>1`、`stream:true`、多模态块一律 400 |
| **M2** | SSE 流式（§4.6 形状） | 真 SDK `stream=True` 收到 delta + `[DONE]`；delta 累加 === 非流式的答案（逐字节） |
| **M3** | 文档 + capstone + 收口 | `examples/` 一个零 key 的确定性 demo；四门 PASS |

---

## 六、显式不做

- **embeddings / images / audio 端点**——那是另外三个数据面，各自有各自的授权与
  披露问题，没需求不预造。
- **入站 function calling**（边界①）。
- **真 token 流**（§4.6；等 host 标轮次边界）。
- **`/v1/completions`（legacy）**——OpenAI 自己都在退役它。
- **多 agent 一次调用**（`model: "a,b"` 之类）——那是编排，编排面是工作流。
- **匿名 / 无 bearer 访问**——一个开着的 LLM 端点是别人的免费额度。

---

## 七、诚实边界（写给用它的人）

1. **不是一个模型，是一个 agent。** 同一组 messages 两次调用可能不同——agent
   有记忆、有工具、可能去搜索。它比一个模型"活"，也因此比一个模型不确定。
2. **可能返回"这件事我得先问你一声"。** 那不是错误，是治理闸。程序化调用方
   要准备好处理这种回复（判据：正文里出现审批指引，且这次对话没有产生副作用）。
3. **没有 `usage` 字段。** 真账在 hub 的用量账本里。
4. **`system` 消息不生效**，`temperature` 一类参数被忽略（§4.7）。
5. **无状态**——历史以你发的 `messages` 为准（§边界②）。

