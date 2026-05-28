/**
 * examples/workflow-assistant — Phase 13 M5 demo.
 *
 * End-to-end of the AI workflow editor pipeline:
 *
 *   1. Spin up an in-memory Hub.
 *   2. Register `WorkflowAssistantAgent` against a real LLM provider
 *      (DeepSeek by default — cheapest, fastest. Anthropic / OpenAI also
 *      supported. `--provider mock` runs offline with the stub provider
 *      so you can demo the pipeline without any keys.)
 *   3. Pretend there's a hub inventory of agents + existing workflow ids
 *      and feed it to the assistant as `contextHints`. (In a real host
 *      this is what `createWorkflowAssistAgent` does behind the scenes.)
 *   4. Dispatch 3 sample descriptions in sequence:
 *        a. "happy" path — should produce a valid workflow that the deep
 *           checker accepts against the inventory.
 *        b. "ambitious" — exercises the deep checker by asking for a
 *           workflow that probably references caps the inventory doesn't
 *           have (LLM is free to invent stuff).
 *        c. "refusal" — purposefully off-topic to show `draftStatus`
 *           = `no_yaml` handling.
 *   5. For each request, pretty-print:
 *        - draftStatus + validationError? + deepCheck?.violations[]
 *        - the YAML preview (first ~10 lines)
 *        - usage tokens
 *
 * What this demo proves (and why it matters):
 *
 *   - The Phase 13 pipeline is end-to-end: LLM → parseWorkflow →
 *     checkWorkflowStructure → ready-to-import yaml in <10s.
 *   - The deep checker catches structural problems a schema parser
 *     can't (agent IDs the LLM made up, capabilities no one provides,
 *     id collisions). That's why we shipped M4 separately from M3 —
 *     real LLMs invent stuff, and a green chip with "valid" only
 *     tells you the YAML is well-formed, not that it'll actually run.
 *   - Mock mode (`--provider mock`) lets you eyeball the data-shape
 *     without burning API tokens. CI runs in this mode.
 *
 * Run:
 *
 *   # Real DeepSeek (cheapest, ~$0.0001 per run):
 *   pnpm --filter @aipehub/example-workflow-assistant start
 *
 *   # Anthropic:
 *   AIPE_DEMO_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... \
 *     pnpm --filter @aipehub/example-workflow-assistant start
 *
 *   # OpenAI:
 *   AIPE_DEMO_PROVIDER=openai OPENAI_API_KEY=sk-... \
 *     pnpm --filter @aipehub/example-workflow-assistant start
 *
 *   # Mock (no network, no keys, deterministic):
 *   pnpm --filter @aipehub/example-workflow-assistant start:mock
 */

import { Hub } from '@aipehub/core'
import { MockLlmProvider, type LlmProvider } from '@aipehub/llm'
import { AnthropicProvider } from '@aipehub/llm-anthropic'
import { OpenAIProvider } from '@aipehub/llm-openai'
import { parseWorkflow } from '@aipehub/workflow'
import {
  inventoryFromContextHints,
  verdictForYamlWithDeepCheck,
  WORKFLOW_ASSISTANT_CAPABILITY,
  WorkflowAssistantAgent,
  type WorkflowAssistantOutput,
  type WorkflowAssistantPayload,
} from '@aipehub/workflow-assistant'

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

type ProviderKind = 'deepseek' | 'anthropic' | 'openai' | 'mock'

function parseArgs(): { provider: ProviderKind } {
  const cli = process.argv.slice(2)
  const i = cli.indexOf('--provider')
  if (i !== -1 && cli[i + 1]) {
    const v = cli[i + 1]!.toLowerCase()
    if (v === 'mock' || v === 'deepseek' || v === 'anthropic' || v === 'openai') {
      return { provider: v }
    }
  }
  const env = process.env.AIPE_DEMO_PROVIDER?.toLowerCase()
  if (env === 'mock' || env === 'deepseek' || env === 'anthropic' || env === 'openai') {
    return { provider: env }
  }
  return { provider: 'deepseek' }
}

function buildProvider(kind: ProviderKind): { provider: LlmProvider; model: string } {
  switch (kind) {
    case 'mock': {
      // Deterministic 2-step workflow that satisfies the demo inventory
      // — exercises the deepCheck=ok path without an LLM call.
      const reply = [
        'Mock provider — set AIPE_DEMO_PROVIDER=deepseek (or anthropic/openai) for real output.',
        '',
        '```yaml',
        'schema: aipehub.workflow/v1',
        'workflow:',
        '  id: demo-mock-flow',
        '  name: Mock demo flow',
        '  trigger:',
        '    capability: demo-mock:run',
        '  steps:',
        '    - id: draft',
        '      dispatch:',
        '        strategy: { kind: capability, capabilities: [draft] }',
        '        payload:',
        '          topic: $trigger.payload.topic',
        '    - id: review',
        '      dispatch:',
        '        strategy: { kind: capability, capabilities: [review] }',
        '        payload:',
        '          draft: $draft.output',
        '```',
      ].join('\n')
      return { provider: new MockLlmProvider({ reply }), model: 'mock' }
    }
    case 'deepseek': {
      const apiKey = process.env.DEEPSEEK_API_KEY
      if (!apiKey) {
        console.error('[workflow-assistant] DEEPSEEK_API_KEY missing — pass --provider mock to run offline.')
        process.exit(2)
      }
      const model = process.env.AIPE_DEMO_MODEL ?? 'deepseek-v4-flash'
      return {
        provider: new OpenAIProvider({
          apiKey,
          baseURL: 'https://api.deepseek.com/v1',
          defaultModel: model,
          name: 'deepseek',
        }),
        model,
      }
    }
    case 'anthropic': {
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) {
        console.error('[workflow-assistant] ANTHROPIC_API_KEY missing — pass --provider mock to run offline.')
        process.exit(2)
      }
      const model = process.env.AIPE_DEMO_MODEL ?? 'claude-3-5-haiku-latest'
      return { provider: new AnthropicProvider({ apiKey }), model }
    }
    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY
      if (!apiKey) {
        console.error('[workflow-assistant] OPENAI_API_KEY missing — pass --provider mock to run offline.')
        process.exit(2)
      }
      const model = process.env.AIPE_DEMO_MODEL ?? 'gpt-4o-mini'
      return { provider: new OpenAIProvider({ apiKey, defaultModel: model }), model }
    }
  }
}

// ---------------------------------------------------------------------------
// Synthetic hub inventory — what a real host would feed via contextHints.
// Mix of real capabilities (so the LLM can use them) + a fake one
// ('telegram:send') we'd expect a real workflow to reference.
// ---------------------------------------------------------------------------

const DEMO_HINTS: NonNullable<WorkflowAssistantPayload['contextHints']> = {
  agents: [
    { id: 'crawler', capabilities: ['crawl-rss'], description: '抓取 RSS feed' },
    { id: 'summarizer', capabilities: ['summarize'], description: '把文本摘要为 3 句话' },
    { id: 'telegram-bot', capabilities: ['telegram:send'], description: '推消息到 Telegram 群' },
    { id: 'writer', capabilities: ['draft'], description: '草拟内容' },
    { id: 'reviewer', capabilities: ['review'], description: '审核草稿' },
  ],
  existingWorkflowIds: ['daily-greeting', 'news-digest'],
}

// ---------------------------------------------------------------------------
// Pretty printing
// ---------------------------------------------------------------------------

function statusChip(out: WorkflowAssistantOutput): string {
  if (out.draftStatus === 'no_yaml') return '◌ no_yaml'
  if (out.draftStatus === 'invalid') return '✗ invalid'
  // valid
  if (out.deepCheck && out.deepCheck.ok === false) {
    return `⚠ valid+warnings (${out.deepCheck.violations.length})`
  }
  return '✓ valid+deepCheck.ok'
}

function previewYaml(yaml: string, maxLines = 12): string {
  if (!yaml) return '(empty)'
  const lines = yaml.split('\n')
  if (lines.length <= maxLines) return yaml
  return lines.slice(0, maxLines).join('\n') + `\n... (+${lines.length - maxLines} more lines)`
}

async function runOne(
  hub: Hub,
  label: string,
  description: string,
): Promise<void> {
  console.log('\n' + '─'.repeat(72))
  console.log(`▶ scenario: ${label}`)
  console.log(`  description: ${description}`)
  const t0 = Date.now()
  const result = await hub.dispatch({
    from: 'demo-admin',
    strategy: { kind: 'capability', capabilities: [WORKFLOW_ASSISTANT_CAPABILITY] },
    payload: {
      description,
      contextHints: DEMO_HINTS,
    } satisfies WorkflowAssistantPayload,
    title: `workflow:assist (${label})`,
  })
  const ms = Date.now() - t0
  if (result.kind !== 'ok') {
    console.log(`  ✗ dispatch failed: ${JSON.stringify(result)}`)
    return
  }
  const out = result.output as WorkflowAssistantOutput
  console.log(`  ⏱  ${ms}ms · status=${statusChip(out)}`)
  if (out.usage) {
    console.log(`     tokens in=${out.usage.inputTokens} out=${out.usage.outputTokens}`)
  }
  if (out.explanation) {
    const exp = out.explanation.split('\n').slice(0, 3).join('\n     ')
    console.log(`     LLM explanation: ${exp}`)
  }
  if (out.draftStatus === 'invalid' && out.validationError) {
    console.log(`     ✗ schema error: ${out.validationError}`)
  }
  if (out.deepCheck && out.deepCheck.violations.length > 0) {
    console.log('     deep-check violations:')
    for (const v of out.deepCheck.violations) {
      console.log(`       • [${v.kind}] ${v.message}`)
      console.log(`         @ ${v.path}`)
    }
  }
  if (out.yaml) {
    console.log('     yaml preview:')
    for (const line of previewYaml(out.yaml).split('\n')) {
      console.log(`       │ ${line}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { provider } = parseArgs()
  const { provider: llm, model } = buildProvider(provider)

  console.log('=== Phase 13 M5 — workflow assistant end-to-end ===')
  console.log(`  provider: ${provider}  (model=${model})`)
  console.log(`  inventory: ${DEMO_HINTS.agents!.length} agents, ${DEMO_HINTS.existingWorkflowIds!.length} existing workflow ids`)

  const hub = Hub.inMemory()
  await hub.start()
  hub.register(
    new WorkflowAssistantAgent({
      provider: llm,
      // The agent's own default is fine for everything else; just pin
      // maxTokens generously so a 60-line yaml doesn't truncate.
      maxTokens: 4096,
    }),
  )

  // Sanity-check that the helper path matches what the agent does: feed
  // the inventory through `inventoryFromContextHints` so reviewers can
  // see what shape goes into the checker.
  const inv = inventoryFromContextHints(DEMO_HINTS)
  console.log(`  inventory shape: ${JSON.stringify(inv).slice(0, 80)}…`)

  // ── Scenario A: happy path ─────────────────────────────────────────
  await runOne(
    hub,
    'happy',
    [
      '每天早上 8 点抓 RSS feed 列表里的文章，summarize 每篇,',
      '然后把摘要推到 Telegram 群里。',
    ].join(' '),
  )

  // ── Scenario B: id-collision pressure ──────────────────────────────
  // The inventory says `news-digest` already exists; ask for the same
  // thing and see if the deep checker catches an id collision (LLM may
  // or may not pick a fresh id).
  await runOne(
    hub,
    'collision-pressure',
    '生成一个工作流叫 news-digest, 抓 5 个新闻源,然后用 summarize 总结。',
  )

  // ── Scenario C: deep-check pressure ────────────────────────────────
  // Ask for a capability the inventory doesn't have to see the checker
  // flag `unknown_capability`.
  await runOne(
    hub,
    'unknown-cap-pressure',
    '生成一个工作流：调用 image-generation 服务画图,然后推到 Discord 频道。',
  )

  // ── Scenario D: ad-hoc verify helper directly ──────────────────────
  // Show callers can also re-run the verdict in isolation without
  // dispatching — useful for SDK consumers / batch validation.
  console.log('\n' + '─'.repeat(72))
  console.log('▶ scenario: standalone helper (verdictForYamlWithDeepCheck)')
  const handCrafted = `schema: aipehub.workflow/v1
workflow:
  id: news-digest
  trigger:
    capability: hand-crafted:run
  steps:
    - id: a
      dispatch:
        strategy: { kind: explicit, to: nonexistent-bot }
        payload: { msg: 'hi' }
    - id: b
      dispatch:
        strategy: { kind: capability, capabilities: [draft] }
        payload: { input: $futureStep.output }
`
  const verdict = verdictForYamlWithDeepCheck(handCrafted.trim(), inv)
  console.log(`  status=${verdict.status}`)
  if (verdict.deepCheck) {
    console.log(`  deepCheck.ok=${verdict.deepCheck.ok}`)
    for (const v of verdict.deepCheck.violations) {
      console.log(`    • [${v.kind}] ${v.message}`)
    }
  }
  // And a sanity round-trip through parseWorkflow so docs stay honest:
  // valid yaml from the assistant should always re-parse without throwing.
  try {
    parseWorkflow(handCrafted.trim())
    console.log('  parseWorkflow: ok (round-trip)')
  } catch (err) {
    console.log(`  parseWorkflow: ✗ ${(err as Error).message}`)
  }

  console.log('\n' + '─'.repeat(72))
  console.log(`transcript: ${hub.transcript.size()} entries — every assist call is auditable`)
  await hub.stop()
}

main().catch((err) => {
  console.error('[workflow-assistant] fatal:', err)
  process.exit(1)
})
