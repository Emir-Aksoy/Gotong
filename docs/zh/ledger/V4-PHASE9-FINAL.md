# v4 Phase 9 收尾 — 多模态 content blocks

> Status: **完成**. 6 个 commit, LLM 调用从纯文本扩成 text + image + audio + file_ref
> 内容块；workflow form 能 upload 文件; admin UI 能渲染、预览、回放整个 multimodal payload.
>
> Last updated: 2026-05-26
>
> 本文是 Phase 9 的 release-notes / hand-off. 读完应该能:
>   - 知道 Phase 9 加了什么、它怎么端到端跑通
>   - 知道每个 milestone 在代码 / docs / examples 里的入口
>   - 把 Phase 10 (agent → 子 agent dispatch) 接续起来
>
> GitHub 状态: Phase 9 全部 commit **未 push** (操作员指令 "github 额度超了"),
> 本地 `main` 分支领先 origin 76 commits (68 Phase 7 + 8 Phase 8 + 6 Phase 9).
> 后续解禁后一次 push, 无需 squash — 每个 commit 都是有意义的小步.

---

## 一、commit 时序

按写入顺序, 共 6 个 commit:

| # | sha | 内容 |
|---|---|---|
| 1 | `48acd27` | feat(llm,services-sdk,service-artifact-file): multimodal content blocks (Phase 9 M1) |
| 2 | `a6f3932` | feat(llm,llm-anthropic): Anthropic multimodal translate (Phase 9 M2) |
| 3 | `741feca` | feat(llm-openai): OpenAI multimodal translate (Phase 9 M3) |
| 4 | `cdde254` | feat(workflow,web,host): workflow YAML file upload (Phase 9 M4) |
| 5 | `0bc6462` | feat(web,host): admin UI multimodal render + GET /api/admin/uploads (Phase 9 M5) |
| 6 | *(本提交)* | feat(llm,examples,docs): multimodal-vision example + Phase 9 release notes (M6) |

代码量(累加, `986f57d..HEAD`): **27 files changed, +3700 / -50** (估算; 终值见
commit body).

---

## 二、Phase 9 解决了什么 (按 milestone)

### M1 — `LlmContentBlock` union 扩 3 个变体 + 文件常量 / 错误类

`packages/llm/src/types.ts` 把:

```ts
type LlmContentBlock =
  | LlmTextBlock
  | LlmToolUseBlock
  | LlmToolResultBlock
  // 新增 ↓
  | LlmImageBlock          // { type:'image', source: LlmImageSource }
  | LlmAudioBlock          // { type:'audio', source: LlmImageSource, format? }
  | LlmFileRefBlock        // { type:'file_ref', artifactId, mime }
```

`LlmImageSource` 判别联合(三种 kind):
- `{ kind: 'base64', data, mime }` — inline 字节, 带 cap 检查
- `{ kind: 'url',    url }`         — provider 直接吃 URL (Anthropic / OpenAI 都支持)
- `{ kind: 'artifact_ref', artifactId, mime }` — provider 通过 `LlmArtifactResolver` fetch bytes

同包加了:
- `LlmArtifactResolver = (artifactId) => Promise<{bytes, mime}>` 类型
- `MultimodalNotSupportedError` / `MultimodalInlineSizeError` 错误类
- `DEFAULT_MULTIMODAL_INLINE_BYTE_CAP = 1 MB`(env `GOTONG_MULTIMODAL_MAX_INLINE_MB` 覆盖)
- `isMultimodalBlock` / `extractInlineBase64Size` / `readMultimodalInlineCapFromEnv` helpers

附带改动:
- `@gotong/services-sdk` 的 `ArtifactHandle` 加 `readBytes(refOrPath)` 方法
- `@gotong/service-artifact-file` 实现 `readBytes`(Buffer fast path)
- `@gotong/sdk-node` 的 RPC ArtifactHandle 显式 reject `readBytes`(SDK 远程客户端
  本期不支持二进制 RPC; 文档明示)

### M2 — Anthropic provider 三块翻译 + artifact resolver fan-out

`packages/llm-anthropic/src/provider.ts` 加了:

- `translateImageSource()` — base64 (cap 检查) / url 直传 / artifact_ref → 走
  resolver fetch 然后转 base64
- `translateBlock(block, ctx)` async — image / audio (Anthropic 不支持 audio, 抛 typed
  error) / file_ref (按 mime 分流: `image/*` → image, `text/*` 或 JSON → text, 其它 → throw)
- `bytesToBase64` Buffer fast path + 跨 runtime 兜底
- `stream()` 保持同步 (LlmAgent 的 `sync throw → onAuthFailure` 路径不破), 内部
  `streamImpl()` async generator `await buildBody`. 单元测 14 个

### M3 — OpenAI provider 三块翻译 + audio model gating + 兼容降级

`packages/llm-openai/src/provider.ts` 加了:

- `translateImageBlock()` → `{type:'image_url', image_url:{url:'data:...|https://...'}}`
- `translateAudioBlock()` → `{type:'input_audio', input_audio:{data, format}}`, 但仅
  当 `model.toLowerCase().includes('audio')` 才能跑(不然抛 typed error)
- `translateFileRefBlock()` — image/audio/text 三路分流
- **single-text-block collapse**: 一条 user message 退化成单一 text block 时, 把
  content 折回 string — DeepSeek/Qwen/Ollama compat mode 对 array content 不稳, 折
  回 string 解一道兼容坑
- assistant turn multimodal 显式拒绝(OpenAI 协议不允许; 抛 typed error 而不是让
  vendor 返 confused 400)

单元测 19 个, llm-openai 升到 68 测试.

### M4 — workflow `type: 'file'` 表单字段 + `/api/admin/uploads` 上传链路

工作流 YAML 现在能写:

```yaml
trigger:
  capability: describe-image
  payload_schema:
    - id: pic
      label: 上传图片
      type: file          # ← Phase 9 新增
      accept: ['image/']
      maxSizeMb: 5
```

`@gotong/workflow` 加 `'file'` 到 `PayloadFieldSpec.type` 判别联合, 加
`accept?: string[]` / `maxSizeMb?: number`(都是 UI hint, schema 验证).

`@gotong/web` 加:
- `UploadSurface` 注入接口(`put({bytes, declaredMime, filename?, by})`)
- `POST /api/admin/uploads` 路由(raw octet-stream body, **无 multipart 解析依赖**),
  返回 `{artifactId, mime, size}`. 状态码 503/401/400/413 矩阵完整

`@gotong/host` 新模块 `uploads.ts` — `createUploadSurface` 把 artifact-file 插件
attach 到 `{kind: 'shared', id: 'uploads'}` owner, artifactId 命名规范
`uploads/<YYYY-MM-DD>/<rand>.<ext>`. 上传出错降级到 503, host 不崩.

admin SPA `admin.js`:
- `renderOneField()` 加 'file' 分支
- `submitWorkflowStart()` 加 file 路径: 上传 → 拿 artifactId → 注入
  `{type:'file_ref', artifactId, mime}` 到 payload → 派发

测试: workflow schema +9, web upload route +10, host uploads +7(单元 + e2e 含
真实 artifact-file 插件 round-trip).

### M5 — Admin UI 多模态渲染 + `GET /api/admin/uploads`

`UploadSurface.get(artifactId)` — 同一个 shared/uploads handle 读 bytes 回来.

`GET /api/admin/uploads?id=<artifactId>` 路由:
- 流 bytes 回客户端, recorded mime + `Content-Disposition: inline` + cache-control
  `private, max-age=300`
- 404 unknown id, 400 traversal-shaped error
- 文件名 sanitize `[^A-Za-z0-9._-]` → `_` (CR/LF 不可能注入到 header)

admin SPA `admin.js` 新加:
- `extractMultimodalBlocks(payload)` — walk JSON tree 找 file_ref / image / audio shape
  (结构化判别, 无 llm 包依赖, 因为 admin.js 是浏览器 IIFE)
- `renderMultimodalBlock(b)` — 9 种渲染分支:
  - file_ref `image/*` → `<img>` 预览 + 点开 full-size
  - file_ref `audio/*` → `<audio controls>` mini player
  - file_ref other → 📎 download anchor
  - image source base64/url/artifact_ref → `<img>` 三种 src 形态
  - audio source base64/url/artifact_ref → `<audio>` 三种 src 形态
- Workflow start modal 上传后内联缩略图: image 显示 32px `<img>`, audio 显示
  mini `<audio>`

`styles.css` 加 `.mm-block` 卡片样式, image 上限 240×200 防 4K 上传爆 task panel.

### M6 — Example + LlmAgent 多模态入口 + release notes (本期)

#### 1. `LlmTaskPayload.messages` — LlmAgent 多模态入口

`@gotong/llm` 的 `LlmTaskPayload` 加 `messages?: LlmMessage[]`. `buildRequest()`
里 `messages` 路径优先:

```ts
if (Array.isArray(payload.messages) && payload.messages.length > 0) {
  messages = payload.messages          // ← multimodal 直通
} else {
  // ... 老的 prompt / topic / history 路径不变
}
```

`system` / `maxTokens` / `temperature` / `model` 覆盖仍然生效. 这把 M1-M3 的
provider 层多模态能力**真正接到 LlmAgent**: 一个普通的 LlmAgent 实例只要
payload 里塞 `messages: [{role:'user', content:[imageBlock, textBlock]}]` 就能
跑视觉任务, 不用写子类.

测试: `agent.test.ts` +4(messages 优先级 / multimodal block 透传 / system 覆盖 /
空数组降级).

#### 2. `examples/multimodal-vision/`

新 example, 一个 LlmAgent 读 image 描述. 用法:

```bash
ANTHROPIC_API_KEY=sk-ant-... \
  pnpm demo:multimodal -- --image=/path/to/cat.jpg

# 或 OpenAI
OPENAI_API_KEY=sk-... \
  pnpm demo:multimodal -- --image=/path/to/cat.jpg --provider=openai
```

例子里没 commit 任何 binary fixture — 用户必须传 `--image=`. README 同时
列三种 source kind 的代码片段供参考.

#### 3. CLAUDE.md + 路线图

- CLAUDE.md feature matrix: Phase 9 状态 **完成**
- Phase 10 接续: agent → 子 agent dispatch toolset

---

## 三、端到端数据流(Phase 9 完成态)

```
┌──────────┐  drag image    ┌──────────┐  POST /api/admin/uploads  ┌──────────────┐
│ admin UI │ ─────────────► │ admin.js │ ───────────────────────► │  Web server  │
│ (浏览器)  │  status: 上传中 │ (SPA)    │  raw octet-stream         │  (Node)      │
└──────────┘                └──────────┘                            └──────┬───────┘
                                                                            │ UploadSurface.put
                                                                            ▼
                                                                   ┌──────────────┐
                                                                   │  HubServices │
                                                                   │  shared/     │  ──► artifact-file
                                                                   │   uploads    │       plugin → disk
                                                                   └──────┬───────┘
                                                                          │ {artifactId, mime}
                                                                          │
admin clicks "开始" ────────────────────────────────────────────────────────┘
                                                                          │
              payload = { pic: {type:'file_ref', artifactId, mime} }       │
                                                                          ▼
                                                              ┌────────────────────┐
                                                              │ POST /api/admin/   │
                                                              │   dispatch         │
                                                              └─────────┬──────────┘
                                                                        │
                                                                        ▼
                                                              ┌────────────────────┐
                                                              │ WorkflowRunner /   │
                                                              │ LlmAgent           │
                                                              └─────────┬──────────┘
                                                                        │ messages = [
                                                                        │   { role:'user',
                                                                        │     content:[fileRefBlock, textBlock] }
                                                                        │ ]
                                                                        ▼
                                                              ┌────────────────────┐
                                                              │ AnthropicProvider  │
                                                              │  /OpenAIProvider   │
                                                              │  translateBlock    │
                                                              │  → resolver fetch  │
                                                              │  → base64 image    │
                                                              └─────────┬──────────┘
                                                                        ▼
                                                                   vendor SDK
                                                                   (vision API)
```

回路另一边: admin 打开 task detail → `extractMultimodalBlocks(payload)` 找出
`file_ref` block → `<img src="/api/admin/uploads?id=...">` → `GET` 路由读 bytes →
浏览器渲染图片. **同一个 shared/uploads handle 写入 + 读取, 一套契约**.

---

## 四、可观察的破坏性变更

Phase 9 是**纯加法**, 没破坏 v3 / v8 surface. 几个值得标记的微行为:

1. `LlmTaskPayload.messages` 是新的 first-class 字段, 老的 `prompt`/`topic`/`history`
   path **完全保留**, 只在 `messages` 不存在 / 空数组时走老路.
2. `LlmContentBlock` union 加了 3 个变体. 所有 provider 自己处理(unsupported →
   throw). 用户代码不用变.
3. `ArtifactHandle.readBytes` 是新方法; v3 的 file 插件实现了, SDK 远程
   client 显式 reject 并给文档(see `packages/sdk-node/src/service-client.ts`).
4. `WebServerOptions.uploads` 是 optional 注入, 不传 host 上传路由 503.

---

## 五、关键设计决策(快速回顾)

| 决策 | 选择 | 理由 |
|---|---|---|
| inline 字节 cap | 1 MB 默认, env 覆盖 | 防止 LLM 调用一次烧 base64 几十 MB |
| unsupported block | **throw**, 不静默退化为 text | debuggability — silent fail 是最讨厌的 bug |
| source 三种 kind | 不收窄 | base64 (local) / url (web) / artifact_ref (host) 各有场景 |
| artifact resolver 形状 | `(id) => Promise<{bytes, mime}>` | provider-neutral; 不耦合 services-sdk 接口 |
| async buildBody | inner generator await | 保留 outer `stream()` 的 sync-throw 契约 |
| OpenAI single-text collapse | array → string | DeepSeek/Qwen/Ollama compat mode 对 array content 不稳 |
| upload owner | `shared/uploads` 不是 `user/<id>` | upload 比 user session 长寿; agent 可能几小时后才 read |
| upload route | raw octet-stream, **不**用 multipart | 少一个 parser dep, fetch File 流原生支持 |
| download route | query `?id=` 不是 path `/:id` | artifactId 含 `/`, query 比 wildcard 路由清晰 |

---

## 六、测试覆盖

按包(Phase 9 累计新增):

| 包 | Phase 9 新增 | 总数 |
|---|---|---|
| `@gotong/llm` | +4 (M6 agent multimodal) | 114 |
| `@gotong/llm-anthropic` | +14 (M2) | 44 + 1 skipped |
| `@gotong/llm-openai` | +19 (M3) | 68 + 1 skipped |
| `@gotong/workflow` | +9 (M4 schema) | 107 |
| `@gotong/web` | +17 (M4 POST + M5 GET) | 317 |
| `@gotong/host` | +8 (uploads 单元+ e2e) | 236 |
| `@gotong/service-artifact-file` | +2 (readBytes) | 89 |

总: **+73 测试, workspace 2002 → 2075 passing, 0 回归.**

---

## 七、Phase 10 入口

下一步: **Agent → 子 agent dispatch toolset**.

目标: 让一个 `LlmAgent` 通过 tool-use loop **派发 task 给其它 capability**, 不只是
调 MCP tool. 这把 "agent 调 tool" 升级成 "agent 调 agent" — coordinator 类
workflow 不再需要靠 workflow runner 编排, agent 自己能动态决定派发哪个 sub-agent.

相关位置:
- `LlmAgentToolset` 现在只有 MCP tool 一种实现 — Phase 10 加 `DispatchToolset`
- LlmAgent 在 tool-use 循环里识别 dispatch 工具, 调 `hub.dispatch()`, 把结果作为
  tool_result 回给 LLM
- 跨 hub 派发 (peer routing) 走 FED-M2 task.origin 已有的链路

RFC 待写; 入口在 `docs/zh/ledger/V4-PHASE7-13-PLAN.md` 的 Phase 10 段.

---

## 八、运维 checklist (Phase 9 操作员侧)

1. **env**: `GOTONG_MULTIMODAL_MAX_INLINE_MB`(默认 1) 控 inline base64 cap. 这个
   只影响 provider 侧的硬上限, 跟 web 上传那 50 MB ceiling 是两个独立旋钮.
2. **磁盘**: `<space>/services/artifact/file/shared/uploads/<YYYY-MM-DD>/...`. 一年
   后开始累积; 操作员可以写个 cron 删 > 90 天的目录(本期不内置 sweep — RFC §3
   留给 Phase 10+).
3. **plugin allow-list**: 上传通过 host wiring 时 mime allow-list 是 `['*']`(因为
   用户上传 by definition 是任意内容); 如果操作员想收紧, 改 `packages/host/src/
   uploads.ts` 里 `attachUploadsHandle` 的 config.
4. **HTTP 上限**: 50 MB 是写死在 `packages/web/src/server.ts` 的 upload 路由里;
   操作员想改要改源码 + 跟着调 `createUploadSurface` 的 `maxBytesPerFile` 保持一致.
5. **观察上传量**: 现在没专门的指标 — 用 `/api/admin/metrics` 看 HTTP 2xx 总数
   推测; Phase 10+ 加专用 counter.

---

## 九、Phase 9 文档地图

| 文件 | 用途 |
|---|---|
| `docs/zh/ledger/V4-PHASE9-FINAL.md` | 本文 — release notes / hand-off |
| `docs/zh/ledger/PHASE9-MULTIMODAL-RFC.md` | M1 设计决策记录(6 决策) |
| `examples/multimodal-vision/README.md` | example 使用文档 |
| `packages/llm/src/types.ts` | types 入口(`LlmContentBlock` union) |
| `packages/llm-anthropic/src/provider.ts` | Anthropic 翻译 |
| `packages/llm-openai/src/provider.ts` | OpenAI 翻译 |
| `packages/host/src/uploads.ts` | host 上传 surface 实现 |
| `packages/web/src/server.ts` | POST/GET /api/admin/uploads 路由 |
| `packages/web/static/admin.js` | admin UI render + 上传逻辑 |

Phase 9 完结. ✅
