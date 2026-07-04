/**
 * multimodal-vision — Phase 9 demo.
 *
 * Spins up an in-memory Hub with one `LlmAgent`, dispatches a
 * single task whose payload's `messages` field contains an
 * `LlmImageBlock` (base64 source), and prints the LLM's
 * description.
 *
 * Run (Anthropic):
 *
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *     pnpm demo:multimodal -- --image=/path/to/cat.jpg
 *
 * Run (OpenAI):
 *
 *   OPENAI_API_KEY=sk-... \
 *     pnpm demo:multimodal -- --image=/path/to/cat.jpg --provider=openai
 *
 * Flags (all optional except `--image`):
 *   --image=<path>       file on disk (jpg/png/webp/gif). Required.
 *   --provider=<id>      'anthropic' (default) | 'openai'
 *   --prompt=<text>      override the default "describe this image" prompt.
 *
 * The goal of this demo is to show the **wire shape**: a single
 * `LlmImageBlock` rides on `LlmRequest.messages` exactly the same
 * way text does, and the provider translates it to the vendor's
 * native vision shape. No special agent class, no special toolset.
 *
 * Cost: one short vision call is ~$0.001-0.003 depending on which
 * vendor and what model the SDK picks (defaults are the cheapest
 * vision-capable tiers).
 */

import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'

import { Hub } from '@gotong/core'
import {
  LlmAgent,
  type LlmImageBlock,
  type LlmMessage,
  type LlmProvider,
  type LlmTextBlock,
  type LlmTaskPayload,
} from '@gotong/llm'
import { AnthropicProvider } from '@gotong/llm-anthropic'
import { OpenAIProvider } from '@gotong/llm-openai'

interface Cli {
  imagePath: string
  provider: 'anthropic' | 'openai'
  prompt: string
}

function parseCli(argv: readonly string[]): Cli {
  let imagePath: string | undefined
  let provider: Cli['provider'] = 'anthropic'
  let prompt = 'Describe this image in one concise sentence.'
  for (const raw of argv) {
    if (raw.startsWith('--image=')) imagePath = raw.slice('--image='.length)
    else if (raw.startsWith('--provider=')) {
      const v = raw.slice('--provider='.length)
      if (v !== 'anthropic' && v !== 'openai') {
        throw new Error(`--provider must be 'anthropic' or 'openai' (got '${v}')`)
      }
      provider = v
    } else if (raw.startsWith('--prompt=')) prompt = raw.slice('--prompt='.length)
  }
  if (!imagePath) {
    throw new Error(
      'missing --image=<path>\n' +
      '\n' +
      '  usage:\n' +
      '    ANTHROPIC_API_KEY=sk-... pnpm demo:multimodal -- --image=/tmp/cat.jpg\n' +
      '    OPENAI_API_KEY=sk-...    pnpm demo:multimodal -- --image=/tmp/cat.jpg --provider=openai\n',
    )
  }
  return { imagePath, provider, prompt }
}

/**
 * Map a filename extension to a vision-capable MIME. The provider
 * translators (Anthropic, OpenAI) accept these for vision input;
 * anything else surfaces a clear error before the wire call.
 */
function mimeFor(path: string): string {
  const ext = extname(path).toLowerCase()
  switch (ext) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.png':  return 'image/png'
    case '.webp': return 'image/webp'
    case '.gif':  return 'image/gif'
    default:
      throw new Error(
        `unsupported image extension '${ext}'. Pick one of: .jpg, .jpeg, .png, .webp, .gif`,
      )
  }
}

function pickProvider(kind: Cli['provider']): LlmProvider {
  if (kind === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set in the environment')
    }
    // Vision-capable Claude. The provider defaults to a vision-
    // capable model when none is passed; we leave the SDK to pick.
    return new AnthropicProvider({ defaultMaxTokens: 256 })
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set in the environment')
  }
  // gpt-4o-mini is the cheapest vision-capable OpenAI tier as of writing.
  return new OpenAIProvider({ defaultModel: 'gpt-4o-mini' })
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))

  // Read the image off disk. We slurp the whole file (vision-cap
  // images are small by definition); a 50MB file would have been
  // rejected by the host's upload route before reaching an agent
  // anyway. base64 encoding is the lingua franca of the provider
  // translators — every vendor SDK accepts it directly.
  const stat = statSync(cli.imagePath)
  const bytes = readFileSync(cli.imagePath)
  const mime = mimeFor(cli.imagePath)
  const data = bytes.toString('base64')

  console.log('\n=== Gotong demo: multimodal-vision ===')
  console.log(`  image    : ${cli.imagePath} (${stat.size} bytes, ${mime})`)
  console.log(`  provider : ${cli.provider}`)
  console.log(`  prompt   : ${cli.prompt}\n`)

  const hub = Hub.inMemory()
  await hub.start()
  hub.onEvent((e) => {
    if (e.kind === 'task_result') {
      const r = e.data
      if (r.kind === 'ok') console.log(`  [seq=${String(e.seq).padStart(2, '0')}] RESULT ok by ${r.by}`)
      else if (r.kind === 'failed') console.log(`  [seq=${String(e.seq).padStart(2, '0')}] RESULT failed: ${r.error}`)
    }
  })

  const provider = pickProvider(cli.provider)

  hub.register(
    new LlmAgent({
      id: 'vision-agent',
      capabilities: ['describe-image'],
      provider,
      system:
        'You are a careful image-describer. When given an image, ' +
        'reply with exactly one sentence — no preamble, no apology, ' +
        'no follow-up question. Just the description.',
      maxTokens: 256,
    }),
  )

  // Build the LlmRequest-style payload by hand: a single user
  // message that interleaves image + text blocks. The LlmAgent's
  // task runner sees `payload.messages` and hands it to the
  // provider, which translates to the vendor's vision wire shape.
  const userMessage: LlmMessage = {
    role: 'user',
    content: [
      {
        type: 'image',
        source: { kind: 'base64', data, mime },
      } satisfies LlmImageBlock,
      {
        type: 'text',
        text: cli.prompt,
      } satisfies LlmTextBlock,
    ],
  }
  const payload: LlmTaskPayload = {
    messages: [userMessage],
  }

  const result = await hub.dispatch({
    from: 'system',
    strategy: { kind: 'capability', capabilities: ['describe-image'] },
    payload,
    title: 'describe an image',
  })

  if (result.kind !== 'ok') {
    console.error(`\n❌ dispatch failed: ${JSON.stringify(result, null, 2)}`)
    await hub.stop()
    process.exit(1)
  }

  const out = result.output as {
    text: string
    by: string
    usage?: { inputTokens: number; outputTokens: number }
  }
  console.log(`\n  🖼️  description (by=${out.by}):`)
  console.log(`     ${out.text.replace(/\n/g, '\n     ')}`)
  if (out.usage) {
    console.log(`\n  usage: input=${out.usage.inputTokens} output=${out.usage.outputTokens}`)
  }
  console.log(`\n  transcript: ${hub.transcript.size()} entries`)

  await hub.stop()
  process.exit(0)
}

main().catch((err) => {
  console.error('[multimodal-vision] fatal:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
