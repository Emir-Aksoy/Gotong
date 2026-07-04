# Phase 9 多模态 content blocks — 设计 RFC

> Status: **决定稿** (Auto Mode 默认拍板, 用户可 redirect).
>
> Last updated: 2026-05-26

Phase 9 目标: `LlmMessage.content` 加 image / audio / file_ref 三个
first-class block type. 用户能给个人成长 workflow 上传一张图给 reflection
教练; team 模式 SOP workflow 可以把附件 PDF 喂给分析师 agent.

---

## 决策 1: source 三种 kind, 不收窄

```ts
type LlmImageSource =
  | { kind: 'base64'; data: string; mime: string }            // inline
  | { kind: 'url'; url: string }                              // 外链, vendor 负责拉
  | { kind: 'artifact_ref'; artifactId: string; mime: string } // services-sdk artifact
```

**为什么三种都要**:
- `base64` — 临时图(剪贴板粘贴 / 摄像头截图), 不想落 artifact 又要立刻发模型
- `url` — 公网素材, 不下载到 hub (省带宽 + provider 端缓存命中)
- `artifact_ref` — hub 内已持久化的内容(workflow 中间产物 / 用户上传后想多次引用)

三种 source 的安全模型不同, 但都是有意义的 first-class — 一开始就让用户能
选哪种最契合用例.

**备选**: 只支持 `artifact_ref` (强制所有 image 先落 artifact). 否决理由:
增加上传摩擦 + transcript 文件变大(每张图一个 artifact entry), 5MB 截图
要先 POST 再 dispatch, UX 太重.

---

## 决策 2: `LlmFileRefBlock` 保留 — 语义是 "auto-route by mime"

三个新 block:

```ts
interface LlmImageBlock {
  type: 'image'
  source: LlmImageSource         // mime 必须 image/*
}

interface LlmAudioBlock {
  type: 'audio'
  source: LlmImageSource         // 共用 source 形状; mime 必须 audio/*
  format?: 'wav' | 'mp3' | 'webm' | 'ogg'   // vendor 提示
}

interface LlmFileRefBlock {
  type: 'file_ref'
  artifactId: string             // 仅 artifact_ref 形态
  mime: string                   // provider 按 mime 路由到 image/audio/text
}
```

**为什么 LlmFileRefBlock 保留 (不折叠进 LlmImageBlock.source.kind='artifact_ref')**:
- LlmImageBlock = "我已经确定这是图, 请按 image API 翻译"
- LlmFileRefBlock = "这是一个 artifact, mime 不一定, 请 provider 按
  mime 自适应路由 (image/* → vision API; audio/* → audio API; text/* →
  prepend as text)"

UX 流程不同:
- Admin UI 图片专用上传按钮 → 一定是 LlmImageBlock
- Admin UI 通用 attach button (用户拖任意文件进来) → LlmFileRefBlock, mime
  在 provider 翻译时决议

避免 LlmImageBlock 被迫做"我也可能不是 image, 你按 mime 自决议"的双面胶.

**备选 1**: 折叠 LlmFileRefBlock 进 LlmImageBlock — 但用户给一个 PDF
artifact 时无地方放. 否决.

**备选 2**: 加 `LlmFileBlock` 通用 wrapping 包所有非文本 block — 但实际
vision/audio API 形状差异大, vendor 翻译时还得拆, 抽象不省事. 否决.

---

## 决策 3: `artifact_ref` 需要 owner check + readBytes 接口

services-sdk 的 `ArtifactHandle` 目前只有 `read()` 返回 `{ content: string }`
(utf-8). image binary 拿不到. 给 `ArtifactHandle` 加:

```ts
interface ArtifactHandle {
  // ... 已有
  /**
   * Read content as raw bytes. Throws if not found.
   * For text artifacts, this returns the utf-8 encoded bytes — caller
   * decodes if it knows the encoding.
   */
  readBytes(refOrPath: string): Promise<{ bytes: Uint8Array; mime: string }>
}
```

**owner check**: provider 翻译 LlmImageBlock / LlmFileRefBlock 时,
`ArtifactHandle` 已经是 per-owner 实例 (`ServiceCtx.artifact`), 走 owner
天然就 scoped. 跨 owner 引用 (user A 派任务用 user B 的 artifact) 在
M1-M3 范围内**不支持** — 抛 `MultimodalArtifactNotFoundError`. Phase 10
agent-to-agent dispatch 之后才可能需要(子 agent 引用父 agent 的产物),
那时再扩 ArtifactRegistry.

**为什么不接 OwnerRef 解决跨用户引用**: 复杂度爆炸 — 跨 org / 跨 hub
还要走 D2 routing. Phase 9 范围内 user 上传后立刻 dispatch, owner 就是
自己, 同一个 ServiceCtx.artifact 就能找到.

---

## 决策 4: base64 inline cap = 1 MB, 超过自动建议 artifact_ref

`LlmRequest` 翻译时 provider 检查 base64 size:

```ts
const MAX_BASE64_INLINE_BYTES = 1024 * 1024   // 1 MB
// env override: GOTONG_MULTIMODAL_MAX_INLINE_MB
```

超过 1 MB 抛 `MultimodalInlineSizeError`, error message 提示 "上传到
artifact 再用 artifact_ref 引用".

**为什么 1 MB**:
- 10 MB base64 image = 13.3 MB 字符串塞进 transcript jsonl → 文件膨胀
  + grep / replay 变慢
- 1 MB 够覆盖 99% UI 截图 / 头像 / 简单 photo. 高分辨率素材本来就该落 artifact
- vendor 端 (Anthropic / OpenAI) 自己也有 inline image size limit
  (3.75 MB / 20 MB), 我们在它之前先拦一道

**stream 端不会限**: streaming 是字节流, 不存 inline base64. cap 只在
non-stream request 翻译时检查.

---

## 决策 5: `LlmStreamChunk` 不扩多模态输出

Phase 9 只做 **input 端**: user → model 上传图.
Model **输出端**仍然是 text + tool_use chunk.

**为什么**:
- Anthropic / OpenAI 当前 streaming 都不流式吐 image (vision API 是
  text-out only). 提前扩 chunk variant 没真实需求, 是过度抽象.
- 真的有"生成图返回流"是 Phase 11+ 或 Phase 13 AI 辅助 workflow 编辑器
  时再说.
- 现有 `LlmStreamChunk` 5 个 variant (text/tool_use/usage/end/error) 在
  Phase 9 不动一行代码 — 减少冲突.

---

## 决策 6: provider 不支持时 throw, 不静默降级

```ts
export class MultimodalNotSupportedError extends Error {
  code = 'MULTIMODAL_NOT_SUPPORTED'
  constructor(public providerName: string, public blockType: string, public detail?: string) {
    super(`${providerName} doesn't support ${blockType}${detail ? `: ${detail}` : ''}`)
  }
}
```

抛出时机:
- Anthropic + audio block → throw (Anthropic 暂不支持 audio input)
- OpenAI 模型不是 `gpt-4o-*` 或 `whisper-*` + audio block → throw
- 任何 provider + `LlmFileRefBlock` 但 artifact mime 不在 image/audio/text → throw

**为什么不静默把不支持的 block 降级成 text "[image attached]"**:
- 错误隐式 → 用户以为 LLM 看到图了但实际没看到, 生成的输出无法 debug
- 让 LlmAgent / workflow 主动 catch 这个错改 prompt 或换 provider, 是
  正确的边界处理姿势

---

## M1 范围 (本次 commit)

1. 扩 `LlmContentBlock` union 加 `LlmImageBlock` / `LlmAudioBlock` /
   `LlmFileRefBlock`
2. 加 `LlmImageSource` type
3. 加 `MultimodalNotSupportedError` 导出
4. 给 `ArtifactHandle` 加 `readBytes()` 方法
5. `ArtifactFileHandle` (service-artifact-file) 实现 readBytes
6. helper: `isMultimodalBlock(b): boolean` (后续 M2/M3 翻译用)
7. helper: `extractInlineBase64Size(block): number` (M2/M3 cap 检查用)
8. 单测覆盖

不动:
- LlmStreamChunk (决策 5)
- provider 翻译 (M2/M3)
- workflow YAML / web UI (M4/M5)

---

## 用户在 RFC 内可 redirect 的地方

按用户偏好 ("Auto Mode + 不清楚的留 inline 注释默认选择, 你会 redirect"),
本 RFC 任一决策都可在 M2 之前推翻; 推翻后只回滚 M1 types 改动 + 重写 RFC.
最贵的是决策 3 的 owner check 范围 — 推到 cross-owner 要重做 services-sdk
的 ArtifactRegistry, 是 1-2 天工作量. 其余决策推翻代价都在 4 小时以内.

明确**不在 Phase 9 范围**的需求 (留给 Phase 10+):
- 跨用户 / 跨 org artifact 引用 (Phase 10 agent dispatch 后再说)
- 模型输出端 streaming image / audio
- video block (需要 Anthropic / OpenAI 都先支持)
- "图 → tool 调用一系列动作" 的 visual reasoning loop (本身是 tool-use
  pattern + image 组合, Phase 10 dispatch + Phase 9 image 落地后水到渠成)
