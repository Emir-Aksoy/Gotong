# v4 Phase 8 收尾 — LLM streaming 全链路

> Status: **完成**. 8 个 commit, LLM 调用从"一次返回完整结果"切到
> "增量 chunk 流" 全链路落地, 破坏性删 `LlmProvider.complete`.
>
> Last updated: 2026-05-26
>
> 本文是 Phase 8 的 release-notes / hand-off. 读完应该能:
>   - 知道 Phase 8 加了什么 + 删了什么(破坏性变更)
>   - 知道每个 milestone 在代码 / docs 里的入口
>   - 把 Phase 9 (多模态 content blocks) 接续起来
>
> GitHub 状态: Phase 8 全部 commit **未 push** (操作员指令 "github
> 额度超了"), 本地 `main` 分支领先 origin 68 commits (60 Phase 7 + 8 本期).
> 后续解禁后一次 push, 无需 squash — 每个 commit 都是有意义的小步.

---

## 一、commit 时序

按写入顺序, 共 8 个 commit:

| # | sha | 内容 |
|---|---|---|
| 1 | `029c21b` | feat(llm): stream-first LlmProvider interface (Phase 8 M1) |
| 2 | `ac611f9` | feat(llm-anthropic): native SSE streaming (Phase 8 M2) |
| 3 | `048c3a0` | feat(llm-openai,llm): native OpenAI-compat streaming (Phase 8 M3) |
| 4 | `1aec86f` | test(llm): mock chunks option for raw stream control (Phase 8 M4) |
| 5 | `6da223c` | feat(llm): LlmAgent stream consumer + onStreamChunk hook (Phase 8 M5) |
| 6 | `280c1cd` | feat(core,host): LLM stream chunks land in transcript (Phase 8 M6) |
| 7 | `7b6450c` | feat(web): live LLM stream in admin UI (Phase 8 M7) |
| 8 | `11a6325` | refactor(llm,llm-anthropic,llm-openai,host): drop LlmProvider.complete (Phase 8 M8) |

代码量(累加, 2d405f8..HEAD): **32 files changed, +2837 / -532**.

---

## 二、Phase 8 解决了什么 (按 milestone)

### M1 — `LlmProvider.stream` 接口设计 (RFC + types)

`LlmStreamChunk` 判别联合 + `LlmProvider.stream(req, signal?): AsyncIterable<LlmStreamChunk>`
落地为 first-class entry point. Chunk 类型:

```ts
type LlmStreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolUse: LlmToolUseBlock }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'end'; stopReason?: LlmStopReason }
  | { type: 'error'; error: { code: string; message: string } }
```

`drainStream(stream): Promise<LlmResponse>` helper 把流折成完整 response,
让 provider 的 `complete()` (在 M1 还未删) 可以委托给 stream 路径走单一
真相. 防御了 multi-usage、缺失 terminal end、provider bug 等几种边缘场景.

`MockLlmProvider` 加 native chunked 实现; Anthropic + OpenAI 此时只通过
一次性 `completeAsStream()` 转换 shim 满足接口 (M2/M3 替换为真 SSE).

`complete()` 暂留, 打 `@deprecated` 标记 — M8 删.

测试增量: 17 个 (stream-mock.test.ts), 覆盖 chunk 顺序、空回复契约、
textChunkCount 切分、throwError 同步抛、scripted tool_use chunks、drainStream
拼接 + first-usage-wins + error-chunk mapping + provider-bug fallback + 与
complete() round-trip 对等性.

### M2 — Anthropic provider 原生 SSE 流

`AnthropicProvider.stream()` 直接消费 SDK `messages.create({stream:true})`
的事件迭代器, 替换 M1 的 transition shim.

SSE event 翻译表:

| Anthropic event | 翻译 |
|---|---|
| `message_start` | capture initial usage |
| `content_block_start` | open text or tool_use block |
| `content_block_delta` (`text_delta`) | emit text chunk |
| `content_block_delta` (`input_json_delta`) | buffer tool args JSON |
| `content_block_stop` (tool_use) | parse args JSON + emit tool_use chunk; malformed → error chunk + early return |
| `message_delta` | capture stop_reason + final output_tokens |
| `message_stop` | emit terminal usage + end chunk |

`buildBody()` 拆出, 让 `complete()` / `stream()` 共用 (snake_case tool /
opus 思考模型 temperature drop). `complete()` 仍走非 stream endpoint 保留
raw escape hatch — M8 一起删.

错误模型:
- SDK 同步 throw (auth / rate / transport) 透传给 LlmAgent 的 onAuthFailure
- 流中 malformed tool args → soft-fail error chunk, 不 throw
- AbortSignal 透传给 messages.create options

测试增量: 9 个 (provider.test.ts), 覆盖纯文本序列、空 text_delta 过滤、
prompt-cache usage 透传、多片 input_json_delta 累积、malformed JSON 错误路径、
空 input tool_use、SDK 同步抛、`body.stream=true` + tools 报文形状、
AbortSignal 转发.

### M3 — OpenAI-compat provider 原生流

`OpenAIProvider.stream()` 消费 `chat.completions.create({stream:true,
stream_options:{include_usage:true}})`. 同一份代码服务 DeepSeek / Qwen
DashScope / Moonshot / Zhipu / Ollama / vLLM (全部 OpenAI-compat).

翻译表:

| OpenAI chunk | 翻译 |
|---|---|
| `delta.content` (string) | text chunk (空字符串过滤) |
| `delta.tool_calls[]` (by index) | 跨 chunk 累积, JSON 解析后按 index 顺序在 finish_reason 时一次性 emit |
| `finish_reason` | stopReason + terminal end chunk |
| `usage` (独立或随 finish_reason) | usage chunk, 在 tool_use 与 end 之间 emit |

边缘场景:
- **DeepSeek-style** `usage + finish_reason 同 chunk`: usage 提取从
  `empty-choices` 分支搬出来, 两种顺序都工作
- Malformed tool args JSON → error chunk + 早退 (匹配 Anthropic 语义)
- AbortSignal 透传给 SDK

`buildBody()` 共享给 `complete()`. **streaming 故意不继承 complete() 的
retry loop** — 字节已经在 stream 后没法安全重放, 由 LlmAgent 把 transient
error 转 failed TaskResult.

两 provider 都 native 后, M1 的 `completeAsStream()` shim 在 `@aipehub/llm`
types + index 中无 caller, 顺手删.

测试增量: 10 个 (provider.test.ts), 覆盖纯文本顺序、finish_reason+usage
同 chunk (DeepSeek)、空 content 过滤、单 tool args 累积、多 tool index
排序、malformed JSON、max_tokens 映射、SDK 同步抛、报文形状 +
stream_options、AbortSignal 转发.

### M4 — Mock provider chunks 选项

`MockProviderOptions.chunks` 接受 `LlmStreamChunk[]` (每调一次都用) 或
`LlmStreamChunk[][]` (per-call 矩阵, 指针递进, 耗尽落回 reply). 覆盖
reply / script / textChunkCount / stopReason 对 stream 的影响.

设计动机: M5/M6/M7 测试要对 stream 做精细控制 (中途 error chunk、混合
text + tool_use、缺失 terminal end、特定字节边界) — reply/script 抽象
表达不出来, chunks 是 escape hatch.

`throwError` 优先级最高 (在 generator 构造前就同步抛) — auth-failure
测试语义不变.

> 关于路线图里说"migrate 76 tests": 实际不需要批量重写. 现有 mock-based
> 测试本来就跑 stream() 内部 (`complete()` 只是 `drainStream(stream(req))`),
> 没有改测试路径的必要. chunks 选项只是新解锁了"要更细控制的测试".

测试增量: 5 个 (stream-mock.test.ts), 覆盖固定 list 跨 call、per-call
矩阵指针 + fallback、drainStream 透传 error chunk、throwError 优先级、
缺失 terminal end (provider-bug simulation).

### M5 — LlmAgent stream consumer + `onStreamChunk` hook

`LlmAgent` 改吃 `provider.stream()` 替代 `provider.complete()`:
中央调用包装 `completeWithAuthHook` 改名 `streamWithAuthHook`, 直接驱
chunk iterator.

新 `LlmAgentOptions.onStreamChunk(chunk)` hook 在 provider 每 yield 一个
chunk 时调一次, **在累计到 LlmResponse 之前**. M6 (workflow runner →
transcript) + M7 (web SSE → admin UI) 都挂这个 hook. **best-effort 语义**:
hook 抛错被捕获并 log, 不打断 stream — 把 chunk emission 当 load-bearing
会破坏 SDK-only 用法和测试.

Auth-failure 双路径:
- `provider.stream(req)` 同步 throw (SDK 在连接前发现 bad auth)
- 迭代中 throw (服务器中途 401)

两路径都触发同一个 `onAuthFailure` hook + 原样 rethrow 原 error. 通过
factored-out `runAuthFailureHook()` 保证两路径永不 drift.

聚合语义匹配 `drainStream` — 返回的 `LlmResponse` 与 `provider.complete()`
旧产物逐字节一致, 下游测试/agent 行为零变化.

Transition fallback (M8 删):
- `legacyCompleteAsStream()` 把 complete-only provider 包成一个 single-pass
  stream. 覆盖 fake test providers 和未升级 SDK 消费者.
- Provider neither stream 也 neither complete → 清晰错误, 不 silent no-op.

测试增量: 8 个 (agent-stream-chunk.test.ts), 覆盖 chunk 顺序 + task 透传、
per-chunk await 串行化、hook-throw 隔离、多轮 tool-use loop 的 chunk emit、
原始 chunks{} 选项端到端观察性、legacy-provider fallback、空 provider 清晰
失败、可选不设.

旧的 7 个 onAuthFailure + 4 个 tool-use loop 测试无须改动, 走 legacy
fallback 仍通过 (仅刷新了 comment).

### M6 — Workflow runner stream chunks → transcript

`TranscriptEntry` 加新 variant `kind: 'llm_stream_chunk'`, 负载是
`{ taskId, agentId, chunk: unknown }`. 每个 LlmAgent yield 的 chunk 都
写一条 transcript.

接线两处:
- **`packages/core/src/types.ts`**: discriminated variant 加入 TranscriptEntry.
  `chunk` 类型故意是 `unknown` — 把 `@aipehub/llm` 拉进 `@aipehub/core`
  作硬依赖会反转现有依赖方向. Shape contract 在 `LlmStreamChunk`,
  host translator + web SSE forwarder 都按这个 honor.
- **`packages/host/src/local-agent-pool.ts`**: spawn 时把
  `LlmAgentOptions.onStreamChunk` (M5) 接到
  `hub.transcript.append({ kind: 'llm_stream_chunk', taskId, agentId, chunk })`.
  best-effort: transcript append 失败 log 但 stream 继续, 让 agent 仍能拿到
  最终 response.

`host/src/main.ts` describe() 每 chunk 打一行
`LLMCHUNK <agent> task=<id> kind=<chunkType>` 摘要. 完整 payload 留在
transcript 文件 + 通过 SSE 流给 admin.

Web 自动 forward 给 SSE clients: `web/server.ts` 里 `hub.onEvent()` 已经
广播每个 TranscriptEntry kind 走现有 SSE bridge. **M6 不需要碰 web/server.ts**;
admin UI 的 llm_stream_chunk 订阅 留 M7 做.

测试增量: 5 个 (host/tests/llm-stream-chunk-transcript.test.ts), 覆盖
chunks per call 逐条落盘、text concat 还原 final response、`hub.onEvent`
实时看到 chunks (SSE 上游契约)、error chunks 原样透传、多轮 tool-use loop
每轮都 emit chunks.

### M7 — Web SSE 透传 + admin UI 实时渲染

Admin UI 订阅 `llm_stream_chunk` SSE events, 每个 task 卡片实时显示
agent 输出.

**app-core.js** (兼修一个老 SSE bug):
- 服务端 `event: <kind>` 发命名事件, 客户端原来只听 `'message'` 默认通道
  → 所有命名事件之前都 silent, UI 之前只靠 `applyEvent` 对 `task` /
  `task_result` 触发 `/api/state` 全量刷新而活下来. 现在 `connectStream`
  按 kind 注册 handler, 包含 `llm_stream_chunk`. 新增 kind 加到
  `core/types.ts` 后这里也加.

**admin.js** state.liveStreams:
- `Map<taskId, accumulator>` 存 in-flight chunks
- 故意 NOT push 进 `state.transcript`: 单个 task 可能 emit 30+ chunks,
  撑爆 transcript list + stall `renderAll`
- `handleStreamChunk` 把 text 片段 / tool_use 计数 / end / error 折进
  per-task accumulator
- `applyEvent('task_result')` 清空对应 liveStreams 项, 让指示器在最终
  答案落地的瞬间消失
- `renderTasks` 在每张卡里插 `renderLiveStreamIndicator(taskId)`:
  active 状态: 闪烁点 + agent id + tool-use 计数 + 截断的 text 预览;
  done 状态: 折叠成 checkmark

**styles.css**: 50 行 CSS, active vs done 状态 / 等宽预览 / 渐变背景 /
动画点.

Web SSE 上游不变: `hub.onEvent()` 在 `server.ts` 已经原样透传每个
TranscriptEntry kind 走现有 `/api/stream` broadcast loop (M6 端到端验过).

**无新增单测** — 视觉指示器在浏览器侧, chunk-event 投递路径已经被 M6
host 测 + M5 agent 测覆盖.

### M8 — 删 LlmProvider.complete + 全量验证

LLM streaming 进 first-class — `provider.stream(req): AsyncIterable<LlmStreamChunk>`
是唯一的 LLM 调用面. 旧的 `complete()` 折叠 `LlmResponse` 从所有 provider、
所有 test fake、所有 caller 删干净.

为什么现在删: M1-M7 已经把 streaming 全链路接通 (provider → LlmAgent →
transcript → SSE → admin UI). 留 `complete()` 只是把 provider 的 contract
surface 翻倍, 让 caller 隐式 fallback 到非流路径. 我们 pre-1.0 没向前兼容
压力, 现在删比留 deprecation shim 便宜.

具体改了什么:
- `LlmProvider.complete()` 从 interface + 三个 provider (Mock, Anthropic,
  OpenAI) 删除. 翻译规则 (`buildBody()`) 现在只在 stream 路径
- `LlmAgent.streamWithAuthHook` 不再带 `legacyCompleteAsStream` fallback —
  唯一支持的 provider 形状是 `{ name, stream }`
- OpenAI provider 删 `maxRetries` / `retryBackoffMs` 选项 + per-attempt
  retry loop. Streaming 字节后没法安全重放; 调用方要自己的 retry harness,
  用仍导出的 `isTransientError` 分类器包 `provider.stream(req)` 直接重试
- `host/agents/personal-growth-agent.ts` memory-compaction 改走
  `drainStream(this.provider.stream({...}))`. 两个 host test fixture +
  两个 example agent 同步改
- Anthropic + OpenAI provider 测试重写: 加 `synthesizeAnthropicStream` /
  `synthesizeOpenAIStream` helper 把"非流响应"形状翻成 SSE 事件序列,
  让现有"翻译这条消息"断言仍然自然可读, 所有 `provider.complete(req)`
  call site 替换为 `drainStream(provider.stream(req))`
- README + ARCHITECTURE.md (en/zh) 更新, feature matrix 里 LLM streaming
  标 ✅ shipped (v3.8 / Phase 8)

**stream-only contract notes** (代码内已注释, 这里说给运维 / SDK 用户):
- **`raw` (LlmResponse 的 provider escape hatch) 删了** — stream 契约
  没地方塞. 想要 vendor raw fields 的 caller 自己 wrap provider
- **Anthropic `message_stop` 总会 emit 至少一个 zero-token usage chunk**,
  哪怕上游没有 usage 数据. 旧 `complete()` 在这种情况下 `.usage` 是
  undefined; drainStream 现在保留这个 chunk (在意的 caller 可以 call site
  跳过 zero usage)
- **OpenAI tool_calls 里 malformed JSON args** 旧路径会 coerce 到
  `{_raw: '<original>'}`; stream 路径 emit error chunk + 停, drainStream
  暴露为 `stopReason: 'error'`, message 卷进 `.text`. 专门 stream 测试已覆盖

**验证**: `pnpm -r build` 19 包 clean; `pnpm -r test` 全 workspace 绿,
零失败.

---

## 三、新增 + 修改的关键资产

### 新接口 / 类型

```ts
// packages/llm/src/types.ts
export interface LlmProvider {
  readonly name: string
  stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamChunk>
}

export type LlmStreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolUse: LlmToolUseBlock }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'end'; stopReason?: LlmStopReason }
  | { type: 'error'; error: { code: string; message: string } }

export function drainStream(
  stream: AsyncIterable<LlmStreamChunk>,
): Promise<LlmResponse>
```

### 删除的 API surface

```ts
// 全部删
LlmProvider.complete(req): Promise<LlmResponse>
LlmResponse.raw                                  // 没地方塞了
OpenAIProviderOptions.maxRetries                 // streaming 不重放
OpenAIProviderOptions.retryBackoffMs             // 同上
LlmAgent.completeWithAuthHook                    // 改名 streamWithAuthHook
LlmAgent.legacyCompleteAsStream                  // M8 一并删
completeAsStream() helper                        // M3 删
extractToolUses() (openai)                       // 跟着 complete 走
defaultBackoff / sleep (openai)                  // 跟着 retry loop 走
AnthropicMessageLike / AnthropicContentBlock     // 跟着 complete 走
OpenAIChatCompletionLike                         // 跟着 complete 走
```

### 新 TranscriptEntry variant

```ts
// packages/core/src/types.ts
{
  kind: 'llm_stream_chunk'
  taskId: string
  agentId: string
  chunk: unknown    // 形状契约见 LlmStreamChunk
}
```

### 新 LlmAgent option

```ts
interface LlmAgentOptions {
  // ... 已有
  onStreamChunk?(chunk: LlmStreamChunk): void | Promise<void>
}
```

### 新 MockProviderOptions

```ts
chunks?: LlmStreamChunk[] | LlmStreamChunk[][]
```

### 新 SSE event 通道

```
event: llm_stream_chunk
data:  { "kind":"llm_stream_chunk", "taskId":"...", "agentId":"...", "chunk":{...} }
```

(顺手修了一个老 SSE bug: 客户端之前没听任何命名事件, 只靠 task /
task_result 路径触发全量刷新.)

---

## 四、测试统计

| 阶段 | 包数 | tests | failures |
|---|---|---|---|
| Phase 7 结束 | 19 | 1958 | 0 |
| Phase 8 M1 | 19 | +17 | 0 |
| Phase 8 M2 | 19 | +9 | 0 |
| Phase 8 M3 | 19 | +10 | 0 |
| Phase 8 M4 | 19 | +5 | 0 |
| Phase 8 M5 | 19 | +8 | 0 |
| Phase 8 M6 | 19 | +5 | 0 |
| Phase 8 M7 | 19 | 0 (UI) | 0 |
| Phase 8 M8 | 19 | -N (legacy 删了几个) | 0 |

净结果: 全 workspace 绿, 零失败. M1-M6 累加 +54 tests, M8 删了 5 个
legacy fallback 测试 + 2 个 raw-only 测试 + 4 个 retry-loop 测试.

跳过 (无变化): `llm-anthropic` / `llm-openai` 各 1 个真凭据集成测试.

---

## 五、Phase 8 没做的事

下面这些在 Phase 8 路线里被推到 Phase 9+:
- 多模态 content blocks (Phase 9 — `LlmMessage.content` 加 image_blob /
  file_ref / audio)
- Agent → 子 agent 派发 (Phase 10 — 让 LlmAgent 能通过 tool-use 调
  capability)
- Long-running agent suspend/resume (Phase 11)
- 协议外通路 IM bridges + PWA + REPL (Phase 12)
- AI 辅助 workflow 编辑器 (Phase 13)

详见 `docs/zh/ledger/V4-PHASE7-13-PLAN.md`.

Phase 7 RFC 段末尾的 3 个 open 问题里, 与 streaming 相关的:
- **个人模式默认 system prompt + 自由对话框** — Phase 7 RFC 里写"建议
  和 streaming 一起做". 实际 M7 admin UI 只做了 task 卡片实时输出指示,
  自由对话框留到 Phase 13 (AI 辅助 workflow 编辑器) 一起做 — 自由对话
  本质上是 UI 形态的 workflow, 拆开做两遍 UX 代价大.

---

## 六、给 Phase 9 的交接

**Phase 9 主题**: 多模态 content blocks (image / audio / file 进 first-class
`LlmMessage.content`).

**预备工作**:
- `CLAUDE.md` § "现在在哪段" 更新 Phase 8 状态为完成, Phase 9 设为"下一步"
- `docs/zh/ledger/V4-PHASE7-13-PLAN.md` Phase 9 段已经有详细 M1-M? milestone
- Stream contract 已落地 — Phase 9 的 chunk 类型扩展 (image_delta /
  audio_delta) 在 `LlmStreamChunk` 上加新 variant 就行, 不破坏 stream
  消费者

**Phase 9 开工时建议**:
1. **content block schema 先 RFC** — 决定 source 是 `base64` / `url` /
   `artifact_ref` 三种 (artifact_ref 与 services-sdk 的 artifact store
   联动). 三种 source 的安全模型不同 (artifact_ref 需要 owner check),
   一开始拍准比后改方便
2. **从 Anthropic image input 起步** (Anthropic + OpenAI 都已支持 image,
   语义最稳). Provider 翻译表里加 image_blob → vendor 各家 SDK 字段
3. **artifact_ref 形态**: services-sdk 的 artifact 已经有 SHA-256 内容
   寻址, image input 用同一存储 — 避免 base64 在 transcript 里撑爆
4. **个人成长 workflow demo**: PG agent 加"上传一张图给 reflection 教练"
   的 demo, 同时验证 image input + 个人模式 UX
5. **streaming + multimodal 交互**: stream 中途收到 image input 不需要
   立即"完成", chunk 仍按 text → tool_use → end 顺序产生. Phase 8 的
   `LlmStreamChunk.end` 已经能承载 multimodal 结果

---

## 七、build / test 命令速查

```bash
# 全量
pnpm -r build
pnpm -r test

# Phase 8 关键包
pnpm --filter @aipehub/llm test
pnpm --filter @aipehub/llm-anthropic test
pnpm --filter @aipehub/llm-openai test
pnpm --filter @aipehub/host test
pnpm --filter @aipehub/web test

# 端到端 stream smoke
docker compose up
# admin URL → 派一个 LLM 任务 → 看 task 卡片实时打字效果
```

Phase 8 全绿. Phase 9 (多模态) 可以开工.
