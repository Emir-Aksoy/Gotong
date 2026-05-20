/**
 * End-to-end demo: AipeHub + Anthropic + `@aipehub/mcp-client`.
 *
 * What it shows: an `LlmAgent` driven by the Anthropic SDK is given a
 * tool-use loop wired to a freshly-spawned MCP filesystem server, then
 * asked to do something only the tool can answer — read a real file
 * off disk and summarize it.
 *
 * Run:
 *
 *   export ANTHROPIC_API_KEY=sk-ant-…
 *   pnpm install
 *   pnpm --filter @aipehub/example-mcp-tools-llm-agent build  # builds workspace deps
 *   pnpm --filter @aipehub/example-mcp-tools-llm-agent start
 *
 * Expected output (truncated):
 *
 *   → connecting MCP filesystem server…
 *   ✓ MCP tools available: fs__read_text_file, fs__list_directory, …
 *   → dispatching task to Claude…
 *   ← agent finished after N tool round(s)
 *
 *     [model response]
 *     The README opens with: "AipeHub — a polite party for AI agents…"
 *     …
 *
 *     [usage] inputTokens=… outputTokens=…
 *   → toolset disconnected
 *
 * The model decides on its own to call `fs__read_text_file` against
 * `README.md`; we don't pre-script the path. That's the whole point —
 * the tool-use loop lets the LLM choose which tools to call, with
 * what arguments, until it has enough to answer.
 */

import { Hub } from '@aipehub/core'
import { LlmAgent, type LlmRequest } from '@aipehub/llm'
import { AnthropicProvider } from '@aipehub/llm-anthropic'
import { McpToolset } from '@aipehub/mcp-client'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = dirname(HERE)
// Sandbox the filesystem MCP server at the repository root so the
// demo can ask for README.md (the most universally-useful read target).
const REPO_ROOT = join(PKG_ROOT, '..', '..')

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('✖ set ANTHROPIC_API_KEY before running this demo.')
    process.exitCode = 1
    return
  }

  // 1) Spawn the MCP filesystem server and verify its tool list.
  const toolset = new McpToolset({
    servers: [
      {
        name: 'fs',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', REPO_ROOT],
      },
    ],
  })
  console.log('→ connecting MCP filesystem server…')
  await toolset.connect()
  const tools = await toolset.listTools()
  console.log(`✓ MCP tools available: ${tools.map((t) => t.name).join(', ')}`)

  // 2) Build the LLM agent. The `tools:` field is what flips on the
  //    tool-use loop in LlmAgent.handleTask — without it the agent
  //    would single-shot the prompt and ignore the toolset.
  const provider = new AnthropicProvider({
    defaultModel: 'claude-sonnet-4-6',
  })
  const agent = new LlmAgent({
    id: 'fs-reader',
    capabilities: ['answer'],
    provider,
    tools: toolset,
    system:
      'You are an assistant with access to filesystem tools. ' +
      'Prefer reading the actual file with `fs__read_text_file` over ' +
      'guessing its contents. Quote the opening line verbatim when ' +
      'the user asks what a file says.',
    maxToolRounds: 5,
  })

  const hub = Hub.inMemory()
  await hub.start()
  hub.register(agent)
  hub.onEvent((e) => {
    // Show every event so you can see the tool-use round-trip on the wire.
    if (e.kind === 'task_result') {
      console.log(`  [event seq=${e.seq}] ${e.kind} ←`, e.data.kind)
    } else {
      console.log(`  [event seq=${e.seq}] ${e.kind}`)
    }
  })

  console.log('→ dispatching task to Claude…')
  const result = await hub.dispatch({
    from: 'system',
    strategy: { kind: 'capability', capabilities: ['answer'] },
    payload: 'Read the project README and quote its opening line verbatim.',
  })
  await hub.stop()

  if (result.kind !== 'ok') {
    console.error('✖ task failed:', result.kind === 'failed' ? result.error : result)
    await toolset.disconnect()
    process.exitCode = 1
    return
  }

  type Out = LlmAgentOutput
  const out = result.output as Out
  console.log(`← agent finished after ${out.toolRounds ?? 0} tool round(s)`)
  console.log('')
  console.log('  [model response]')
  // Indent for readability — the model's reply tends to be a few lines.
  for (const line of out.text.split('\n')) console.log(`    ${line}`)
  console.log('')
  if (out.usage) {
    console.log(
      `  [usage] inputTokens=${out.usage.inputTokens} outputTokens=${out.usage.outputTokens}`,
    )
  }

  await toolset.disconnect()
  console.log('→ toolset disconnected')
}

// Local re-shape of LlmTaskOutput so this file doesn't need to import
// it directly (the example is documentation as much as code — keeping
// the typedef local makes the wire shape visible at a glance).
interface LlmAgentOutput {
  text: string
  stopReason: string
  by: string
  toolRounds?: number
  usage?: { inputTokens: number; outputTokens: number }
}

// Tiny escape valve: TypeScript wants to see something on the
// LlmRequest type or it'll get pruned by isolatedModules.
void (null as unknown as LlmRequest)

main().catch((err) => {
  console.error('✖ demo failed:', err)
  process.exitCode = 1
})
