# multimodal-vision

Phase 9 demo — an `LlmAgent` reads an image and describes it in one sentence.

The whole point of this example is to show the **wire shape**: a
single `LlmImageBlock` rides on the same `LlmRequest.messages` field
that text uses. No special agent class, no special toolset; just one
more variant in the content-block discriminated union.

## Run

Pick a vendor — Anthropic Claude or OpenAI GPT — and supply a key:

```bash
# Anthropic (Claude)
ANTHROPIC_API_KEY=sk-ant-... \
  pnpm demo:multimodal -- --image=/path/to/cat.jpg

# OpenAI (GPT-4o-mini)
OPENAI_API_KEY=sk-... \
  pnpm demo:multimodal -- --image=/path/to/cat.jpg --provider=openai
```

Supported formats: `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`. If your
image is on the web, `curl -o /tmp/img.jpg https://...` first.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--image=<path>` | *(required)* | image file on disk |
| `--provider=<id>` | `anthropic` | `anthropic` or `openai` |
| `--prompt=<text>` | `"Describe this image in one concise sentence."` | override the user-side text block |

## What this proves

The agent code is **identical** to a text-only LlmAgent — the only
difference is the payload's `messages[].content` carries an
`LlmImageBlock` alongside an `LlmTextBlock`. The provider's
`translateBlock` does the vendor-specific shaping:

- **Anthropic**: `{type:'image', source:{type:'base64', media_type, data}}`
- **OpenAI**: `{type:'image_url', image_url:{url:'data:<mime>;base64,...'}}`

A multimodal upgrade for an existing text agent is therefore a
payload change, not an agent refactor. Cost is one short vision
call: roughly USD $0.001–0.003.

## See also

- `LlmImageBlock` / `LlmAudioBlock` / `LlmFileRefBlock` types in
  `packages/llm/src/types.ts`
- Anthropic translator: `packages/llm-anthropic/src/provider.ts`
  (`translateBlock`)
- OpenAI translator: `packages/llm-openai/src/provider.ts`
  (`translateImageBlock`)
- Phase 9 RFC: `docs/zh/PHASE9-MULTIMODAL-RFC.md`
- Workflow + admin UI integration: Phase 9 M4 (`/api/admin/uploads`)
  and Phase 9 M5 (transcript multimodal render).

Source: [`src/index.ts`](src/index.ts).
