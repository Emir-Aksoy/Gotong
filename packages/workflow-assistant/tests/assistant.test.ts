/**
 * Unit tests for `WorkflowAssistantAgent` and its pure helpers.
 *
 * The agent itself is exercised with a `MockLlmProvider` — these are
 * NOT integration tests against real Anthropic / OpenAI. Real-provider
 * smoke tests live in `examples/workflow-assistant/` (Phase 13 M5).
 *
 * What we verify here:
 *   1. Helpers (`buildSystemPrompt` / `renderUserMessage` /
 *      `extractYamlAndExplanation`) work in isolation, in every fence
 *      shape an LLM might produce.
 *   2. The agent honours its constructor defaults (id / capability /
 *      system prompt) and that the system prompt actually carries the
 *      schema doc + few-shot examples.
 *   3. Dispatching a `workflow:assist` payload through a real Hub
 *      ends-to-end: the mock provider sees our description verbatim,
 *      and the agent extracts the YAML and returns the right output
 *      shape.
 *   4. Bad payloads throw the right errors (description missing /
 *      empty / wrong shape).
 *   5. Generated YAML that follows the schema parses through
 *      `parseWorkflow` — i.e. the schema doc embedded in the system
 *      prompt actually matches what the validator accepts. (This is a
 *      sanity check on the prompt, not on the LLM.)
 */

import { describe, expect, it } from 'vitest'
import { Hub } from '@gotong/core'
import { MockLlmProvider } from '@gotong/llm'
import { parseWorkflow, projectWorkflowGraph } from '@gotong/workflow'

import {
  buildSystemPrompt,
  detailInstruction,
  extractYamlAndExplanation,
  inventoryFromContextHints,
  renderExplainMessage,
  renderUserMessage,
  verdictForYaml,
  verdictForYamlWithDeepCheck,
  WORKFLOW_ASSISTANT_CAPABILITY,
  WORKFLOW_ASSISTANT_DEFAULT_ID,
  WorkflowAssistantAgent,
  type WorkflowAssistantOutput,
  type WorkflowAssistantPayload,
  type WorkflowExample,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// Sample YAML the mock will pretend the LLM generated. Real, parseable
// against `gotong.workflow/v1`.
// ---------------------------------------------------------------------------

const SAMPLE_YAML = `schema: gotong.workflow/v1

workflow:
  id: news-digest
  name: Weekly news digest
  description: Crawl 3 sources, summarize, post to channel.

  trigger:
    capability: run-news-digest

  steps:
    - id: crawl
      dispatch:
        strategy: { kind: capability, capabilities: [crawl-news] }
        title: "Crawl sources"
        payload:
          sources: $trigger.payload.sources

    - id: summarize
      dispatch:
        strategy: { kind: capability, capabilities: [summarize] }
        title: "Summarize crawl results"
        payload:
          raw: $crawl.output

  output:
    summary: $summarize.output
`

const SAMPLE_RESPONSE_TEXT = `这是一个 3 步的新闻摘要 workflow：crawl → summarize → 输出。

\`\`\`yaml
${SAMPLE_YAML.trim()}
\`\`\`

注意 \`run-news-digest\` 是 trigger capability — 派任务到这个 cap 就跑整个 flow。`

// ---------------------------------------------------------------------------
// Pure-helper tests
// ---------------------------------------------------------------------------

describe('extractYamlAndExplanation', () => {
  it('extracts the first ```yaml fence', () => {
    const { yaml, explanation } = extractYamlAndExplanation(SAMPLE_RESPONSE_TEXT)
    expect(yaml).toBe(SAMPLE_YAML.trim())
    expect(explanation).toContain('3 步的新闻摘要')
    expect(explanation).toContain('run-news-digest')
    expect(explanation).not.toContain('```yaml')
  })

  it('accepts ```yml fence too', () => {
    const raw = 'prefix\n```yml\nschema: gotong.workflow/v1\n```\nsuffix'
    const { yaml, explanation } = extractYamlAndExplanation(raw)
    expect(yaml).toBe('schema: gotong.workflow/v1')
    expect(explanation).toBe('prefix\n\nsuffix')
  })

  it('falls back to plain ``` fence if no yaml lang tag', () => {
    const raw = 'desc\n```\nschema: gotong.workflow/v1\n```\n'
    const { yaml, explanation } = extractYamlAndExplanation(raw)
    expect(yaml).toBe('schema: gotong.workflow/v1')
    expect(explanation).toBe('desc')
  })

  it('case-insensitive on the lang tag', () => {
    const raw = '```YAML\nschema: foo\n```'
    const { yaml } = extractYamlAndExplanation(raw)
    expect(yaml).toBe('schema: foo')
  })

  it('no fence at all → yaml=empty, explanation=raw', () => {
    const raw = "Sorry, I can't help with that."
    const { yaml, explanation } = extractYamlAndExplanation(raw)
    expect(yaml).toBe('')
    expect(explanation).toBe("Sorry, I can't help with that.")
  })

  it('prefers ```yaml over plain ``` even if plain fence comes first', () => {
    const raw = '```\nfirst\n```\n\n```yaml\nschema: real\n```'
    const { yaml } = extractYamlAndExplanation(raw)
    expect(yaml).toBe('schema: real')
  })
})

describe('renderUserMessage', () => {
  it('description only', () => {
    expect(renderUserMessage({ description: 'crawl news weekly' })).toBe('crawl news weekly')
  })

  it('appends agent hints under a divider', () => {
    const msg = renderUserMessage({
      description: 'crawl news weekly',
      contextHints: {
        agents: [
          { id: 'writer', capabilities: ['draft', 'edit'] },
          { id: 'reviewer', capabilities: ['review'], description: 'native zh editor' },
        ],
      },
    })
    expect(msg).toContain('crawl news weekly')
    expect(msg).toContain('---')
    expect(msg).toContain('Available agents:')
    expect(msg).toContain('writer [draft, edit]')
    expect(msg).toContain('reviewer [review] — native zh editor')
  })

  it('mcp servers + existing workflow ids', () => {
    const msg = renderUserMessage({
      description: 'foo',
      contextHints: {
        mcpServers: ['brave-search', 'fs'],
        existingWorkflowIds: ['editorial-flow', 'personal-growth-flow'],
      },
    })
    expect(msg).toContain('Available MCP servers:')
    expect(msg).toContain('- brave-search')
    expect(msg).toContain('Existing workflow ids')
    expect(msg).toContain('editorial-flow')
  })

  it('empty contextHints arrays do not emit empty sections', () => {
    const msg = renderUserMessage({
      description: 'foo',
      contextHints: { agents: [], mcpServers: [] },
    })
    expect(msg).toBe('foo')
    expect(msg).not.toContain('---')
  })

  it('trims whitespace on description', () => {
    expect(renderUserMessage({ description: '  bar  \n' })).toBe('bar')
  })
})

describe('buildSystemPrompt', () => {
  it('returns base verbatim when no examples', () => {
    expect(buildSystemPrompt('BASE', [])).toBe('BASE')
  })

  it('appends each example as a User/Assistant pair with yaml fence', () => {
    const examples: WorkflowExample[] = [
      { description: 'edit Chinese articles', yaml: 'schema: gotong.workflow/v1\nworkflow:\n  id: editorial' },
    ]
    const out = buildSystemPrompt('BASE', examples)
    expect(out).toContain('BASE')
    expect(out).toContain('# Examples')
    expect(out).toContain('--- example 1 ---')
    expect(out).toContain('User: edit Chinese articles')
    expect(out).toContain('Assistant:')
    expect(out).toContain('```yaml')
    expect(out).toContain('id: editorial')
  })

  it('numbers multiple examples', () => {
    const out = buildSystemPrompt('B', [
      { description: 'a', yaml: 'x' },
      { description: 'b', yaml: 'y' },
    ])
    expect(out).toContain('--- example 1 ---')
    expect(out).toContain('--- example 2 ---')
  })
})

// ---------------------------------------------------------------------------
// Agent integration with mock provider
// ---------------------------------------------------------------------------

function makeAssistantTask(payload: WorkflowAssistantPayload) {
  return {
    from: 'admin' as const,
    strategy: { kind: 'capability' as const, capabilities: [WORKFLOW_ASSISTANT_CAPABILITY] },
    payload,
  }
}

describe('WorkflowAssistantAgent — defaults', () => {
  it('default id and capability', () => {
    const a = new WorkflowAssistantAgent({
      provider: new MockLlmProvider({ reply: '' }),
    })
    expect(a.id).toBe(WORKFLOW_ASSISTANT_DEFAULT_ID)
    expect(a.capabilities).toEqual([WORKFLOW_ASSISTANT_CAPABILITY])
  })

  it('custom id / capabilities still work', () => {
    const a = new WorkflowAssistantAgent({
      provider: new MockLlmProvider({ reply: '' }),
      id: 'my-assistant',
      capabilities: ['custom:assist'],
    })
    expect(a.id).toBe('my-assistant')
    expect(a.capabilities).toEqual(['custom:assist'])
  })
})

describe('WorkflowAssistantAgent — request building', () => {
  it('description goes through as the user message', async () => {
    let captured: { system?: string; userMsg?: string } = {}
    const provider = new MockLlmProvider({
      reply: (req) => {
        captured = {
          system: req.system,
          userMsg: typeof req.messages[0]?.content === 'string' ? req.messages[0].content : '',
        }
        return SAMPLE_RESPONSE_TEXT
      },
    })

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    const result = await hub.dispatch(makeAssistantTask({
      description: 'Crawl 3 news sources and summarize',
    }))
    await hub.stop()

    expect(result.kind).toBe('ok')
    expect(captured.userMsg).toBe('Crawl 3 news sources and summarize')
    // System prompt should carry the schema doc.
    expect(captured.system).toContain('gotong.workflow/v1')
    expect(captured.system).toContain('trigger:')
    expect(captured.system).toContain('steps:')
    expect(captured.system).toContain('$trigger.payload')
  })

  it('contextHints are appended after a --- divider', async () => {
    let userMsg = ''
    const provider = new MockLlmProvider({
      reply: (req) => {
        const c = req.messages[0]?.content
        userMsg = typeof c === 'string' ? c : ''
        return SAMPLE_RESPONSE_TEXT
      },
    })

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    await hub.dispatch(makeAssistantTask({
      description: 'crawl',
      contextHints: {
        agents: [{ id: 'writer', capabilities: ['draft'] }],
        mcpServers: ['brave-search'],
      },
    }))
    await hub.stop()

    expect(userMsg).toContain('crawl')
    expect(userMsg).toContain('---')
    expect(userMsg).toContain('writer [draft]')
    expect(userMsg).toContain('brave-search')
  })

  it('few-shot examples land in the system prompt', async () => {
    let system = ''
    const provider = new MockLlmProvider({
      reply: (req) => {
        system = req.system ?? ''
        return SAMPLE_RESPONSE_TEXT
      },
    })

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new WorkflowAssistantAgent({
        provider,
        examples: [
          {
            description: 'simple 2-step draft + review',
            yaml: 'schema: gotong.workflow/v1\nworkflow:\n  id: example-1',
          },
        ],
      }),
    )

    await hub.dispatch(makeAssistantTask({ description: 'anything' }))
    await hub.stop()

    expect(system).toContain('--- example 1 ---')
    expect(system).toContain('simple 2-step draft + review')
    expect(system).toContain('id: example-1')
  })

  it('honours maxTokens / temperature / model passthrough', async () => {
    let req: { maxTokens?: number; temperature?: number; model?: string } = {}
    const provider = new MockLlmProvider({
      reply: (r) => {
        req = { maxTokens: r.maxTokens, temperature: r.temperature, model: r.model }
        return SAMPLE_RESPONSE_TEXT
      },
    })

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(
      new WorkflowAssistantAgent({
        provider,
        maxTokens: 1234,
        temperature: 0.1,
        model: 'mock-large',
      }),
    )

    await hub.dispatch(makeAssistantTask({ description: 'x' }))
    await hub.stop()

    expect(req.maxTokens).toBe(1234)
    expect(req.temperature).toBe(0.1)
    expect(req.model).toBe('mock-large')
  })
})

describe('WorkflowAssistantAgent — response parsing', () => {
  it('extracts yaml + explanation from a well-formed fence', async () => {
    const provider = new MockLlmProvider({ reply: SAMPLE_RESPONSE_TEXT })

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    const result = await hub.dispatch(makeAssistantTask({ description: 'crawl' }))
    await hub.stop()

    expect(result.kind).toBe('ok')
    const out = (result as { output: WorkflowAssistantOutput }).output
    expect(out.yaml).toContain('schema: gotong.workflow/v1')
    expect(out.yaml).toContain('id: news-digest')
    expect(out.explanation).toContain('3 步的新闻摘要')
    expect(out.raw).toBe(SAMPLE_RESPONSE_TEXT)
    expect(out.by).toBe('mock')
    expect(out.draftStatus).toBe('valid')
    expect(out.validationError).toBeUndefined()
  })

  it('YAML the agent extracts parses through parseWorkflow', async () => {
    const provider = new MockLlmProvider({ reply: SAMPLE_RESPONSE_TEXT })

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    const result = await hub.dispatch(makeAssistantTask({ description: 'crawl' }))
    await hub.stop()

    const out = (result as { output: WorkflowAssistantOutput }).output
    // The whole point: what the agent extracts must round-trip
    // through the v1 validator. If the system-prompt schema doc
    // ever drifts from the actual schema, this will fail loud.
    const def = parseWorkflow(out.yaml)
    expect(def.id).toBe('news-digest')
    expect(def.trigger.capability).toBe('run-news-digest')
    expect(def.steps.length).toBe(2)
  })

  it('missing fence → draftStatus=no_yaml, explanation=full text, kind still ok', async () => {
    const provider = new MockLlmProvider({
      reply: "Sorry, I can't help with that.",
    })

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    const result = await hub.dispatch(makeAssistantTask({ description: 'x' }))
    await hub.stop()

    expect(result.kind).toBe('ok')
    const out = (result as { output: WorkflowAssistantOutput }).output
    expect(out.yaml).toBe('')
    expect(out.explanation).toBe("Sorry, I can't help with that.")
    expect(out.draftStatus).toBe('no_yaml')
    expect(out.validationError).toBeUndefined()
  })

  it('yaml fence with invalid workflow → draftStatus=invalid + validationError', async () => {
    // LLM produced a yaml fence but the schema is wrong: no trigger
    // capability, which `parseWorkflow` rejects.
    const badYaml = `schema: gotong.workflow/v1
workflow:
  id: broken-flow
  trigger: {}
  steps:
    - id: a
      dispatch:
        strategy: { kind: capability, capabilities: [foo] }
`
    const provider = new MockLlmProvider({
      reply: `Here is a draft:\n\n\`\`\`yaml\n${badYaml.trim()}\n\`\`\``,
    })

    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    const result = await hub.dispatch(makeAssistantTask({ description: 'broken' }))
    await hub.stop()

    expect(result.kind).toBe('ok')
    const out = (result as { output: WorkflowAssistantOutput }).output
    expect(out.yaml).toContain('id: broken-flow')
    expect(out.draftStatus).toBe('invalid')
    expect(out.validationError).toBeTruthy()
    // The exact message the parser produces — surfaced verbatim so admin
    // UI / route handlers don't need to re-parse.
    expect(out.validationError).toContain('trigger')
  })
})

describe('verdictForYaml', () => {
  it("empty string → 'no_yaml'", () => {
    expect(verdictForYaml('')).toEqual({ status: 'no_yaml' })
  })

  it('clean v1 yaml → valid + no validationError', () => {
    const v = verdictForYaml(SAMPLE_YAML.trim())
    expect(v.status).toBe('valid')
    expect(v.validationError).toBeUndefined()
  })

  it('garbage yaml → invalid + validationError set', () => {
    const v = verdictForYaml('this is not yaml: at all: {[')
    expect(v.status).toBe('invalid')
    expect(typeof v.validationError).toBe('string')
    expect((v.validationError ?? '').length).toBeGreaterThan(0)
  })

  it('wrong schema header → invalid', () => {
    const v = verdictForYaml('schema: gotong.workflow/v2\nworkflow: { id: x }')
    expect(v.status).toBe('invalid')
    expect(v.validationError).toContain('schema')
  })
})

describe('WorkflowAssistantAgent — bad payload', () => {
  it('missing description → failed result', async () => {
    const provider = new MockLlmProvider({ reply: SAMPLE_RESPONSE_TEXT })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    // @ts-expect-error — deliberately wrong shape for the test
    const result = await hub.dispatch(makeAssistantTask({}))
    await hub.stop()
    expect(result.kind).toBe('failed')
  })

  it('empty description → failed result', async () => {
    const provider = new MockLlmProvider({ reply: SAMPLE_RESPONSE_TEXT })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    const result = await hub.dispatch(makeAssistantTask({ description: '   ' }))
    await hub.stop()
    expect(result.kind).toBe('failed')
  })

  it('non-object payload → failed result', async () => {
    const provider = new MockLlmProvider({ reply: SAMPLE_RESPONSE_TEXT })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    const result = await hub.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: [WORKFLOW_ASSISTANT_CAPABILITY] },
      payload: 'just a string',
    })
    await hub.stop()
    expect(result.kind).toBe('failed')
  })
})

// ───────────────────────────────────────────────────────────────────
// Phase 13 M4 — deep check integration
// ───────────────────────────────────────────────────────────────────

describe('inventoryFromContextHints', () => {
  it('returns empty inventory when hints have no agents / ids', () => {
    expect(inventoryFromContextHints({})).toEqual({})
  })

  it('passes through agents (id + capabilities only — strips description)', () => {
    const inv = inventoryFromContextHints({
      agents: [
        { id: 'writer', capabilities: ['draft'], description: 'ignored here' },
      ],
    })
    expect(inv.agents).toEqual([{ id: 'writer', capabilities: ['draft'] }])
  })

  it('passes through existingWorkflowIds', () => {
    const inv = inventoryFromContextHints({
      existingWorkflowIds: ['a', 'b'],
    })
    expect(inv.existingWorkflowIds).toEqual(['a', 'b'])
  })

  it('drops mcpServers (deep checker ignores them)', () => {
    const inv = inventoryFromContextHints({
      mcpServers: ['search'],
      agents: [{ id: 'x', capabilities: ['y'] }],
    }) as Record<string, unknown>
    expect(inv.mcpServers).toBeUndefined()
  })
})

describe('verdictForYamlWithDeepCheck', () => {
  it("forwards 'no_yaml' verbatim", () => {
    const v = verdictForYamlWithDeepCheck('', undefined)
    expect(v.status).toBe('no_yaml')
    expect(v.deepCheck).toBeUndefined()
  })

  it("forwards 'invalid' verbatim", () => {
    const v = verdictForYamlWithDeepCheck('not a workflow', undefined)
    expect(v.status).toBe('invalid')
    expect(v.deepCheck).toBeUndefined()
  })

  it('skips deep check when inventory is undefined even on valid yaml', () => {
    const v = verdictForYamlWithDeepCheck(SAMPLE_YAML.trim(), undefined)
    expect(v.status).toBe('valid')
    expect(v.deepCheck).toBeUndefined()
  })

  it("runs deep check on 'valid' + inventory; passes when inventory satisfies it", () => {
    const v = verdictForYamlWithDeepCheck(SAMPLE_YAML.trim(), {
      agents: [
        { id: 'crawler', capabilities: ['crawl-news'] },
        { id: 'summarizer', capabilities: ['summarize'] },
      ],
    })
    expect(v.status).toBe('valid')
    expect(v.deepCheck?.ok).toBe(true)
  })

  it("returns deepCheck.ok=false with violations when inventory doesn't satisfy", () => {
    const v = verdictForYamlWithDeepCheck(SAMPLE_YAML.trim(), {
      agents: [{ id: 'noop', capabilities: ['something-else'] }],
      existingWorkflowIds: ['news-digest'], // collision with SAMPLE_YAML.id
    })
    expect(v.status).toBe('valid')
    expect(v.deepCheck?.ok).toBe(false)
    const kinds = (v.deepCheck?.violations ?? []).map((x) => x.kind)
    expect(kinds).toContain('id_collision')
    expect(kinds).toContain('unknown_capability')
  })
})

describe('WorkflowAssistantAgent — deep check via parseResponse', () => {
  it('omits deepCheck when payload had no contextHints', async () => {
    const provider = new MockLlmProvider({ reply: SAMPLE_RESPONSE_TEXT })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    const result = await hub.dispatch(makeAssistantTask({ description: 'crawl' }))
    await hub.stop()

    const out = (result as { output: WorkflowAssistantOutput }).output
    expect(out.draftStatus).toBe('valid')
    expect(out.deepCheck).toBeUndefined()
  })

  it('populates deepCheck.ok=true when contextHints satisfy the YAML', async () => {
    const provider = new MockLlmProvider({ reply: SAMPLE_RESPONSE_TEXT })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    const result = await hub.dispatch(
      makeAssistantTask({
        description: 'crawl',
        contextHints: {
          agents: [
            { id: 'crawler', capabilities: ['crawl-news'] },
            { id: 'summarizer', capabilities: ['summarize'] },
          ],
        },
      }),
    )
    await hub.stop()

    const out = (result as { output: WorkflowAssistantOutput }).output
    expect(out.draftStatus).toBe('valid')
    expect(out.deepCheck?.ok).toBe(true)
    expect(out.deepCheck?.violations).toEqual([])
  })

  it('populates deepCheck.ok=false when contextHints flag a problem', async () => {
    const provider = new MockLlmProvider({ reply: SAMPLE_RESPONSE_TEXT })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    const result = await hub.dispatch(
      makeAssistantTask({
        description: 'crawl',
        contextHints: {
          agents: [{ id: 'wrong-agent', capabilities: ['unrelated'] }],
          existingWorkflowIds: ['news-digest'],
        },
      }),
    )
    await hub.stop()

    const out = (result as { output: WorkflowAssistantOutput }).output
    expect(out.draftStatus).toBe('valid')
    expect(out.deepCheck?.ok).toBe(false)
    const kinds = (out.deepCheck?.violations ?? []).map((v) => v.kind)
    expect(kinds).toContain('id_collision')
    expect(kinds).toContain('unknown_capability')
  })

  it('omits deepCheck on invalid YAML even when hints are present', async () => {
    const badYaml = `schema: gotong.workflow/v1
workflow:
  id: broken
  trigger: {}
  steps: []
`
    const provider = new MockLlmProvider({
      reply: `oops\n\n\`\`\`yaml\n${badYaml.trim()}\n\`\`\``,
    })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    const result = await hub.dispatch(
      makeAssistantTask({
        description: 'doesnt matter',
        contextHints: { agents: [{ id: 'x', capabilities: ['y'] }] },
      }),
    )
    await hub.stop()

    const out = (result as { output: WorkflowAssistantOutput }).output
    expect(out.draftStatus).toBe('invalid')
    expect(out.deepCheck).toBeUndefined()
    expect(out.validationError).toBeTruthy()
  })
})

// ───────────────────────────────────────────────────────────────────
// Workflow Architect evolution — adjustable-depth explanation,
// explain mode, and the bound DAG graph.
// ───────────────────────────────────────────────────────────────────

describe('detailInstruction', () => {
  it('oneliner asks for exactly one sentence', () => {
    expect(detailInstruction('oneliner')).toContain('ONE')
    expect(detailInstruction('oneliner')).toMatch(/sentence/i)
  })

  it('brief asks for 2-4 sentences (the historical default)', () => {
    expect(detailInstruction('brief')).toMatch(/brief/i)
    expect(detailInstruction('brief')).toContain('2-4')
  })

  it('detailed asks for a step-by-step walk-through with data flow + gates', () => {
    const d = detailInstruction('detailed')
    expect(d).toMatch(/detailed/i)
    expect(d).toMatch(/every step/i)
    expect(d).toMatch(/\$-ref/i)
    expect(d).toMatch(/gate/i)
  })

  it('the three depths produce distinct instructions', () => {
    const set = new Set([
      detailInstruction('oneliner'),
      detailInstruction('brief'),
      detailInstruction('detailed'),
    ])
    expect(set.size).toBe(3)
  })
})

describe('renderUserMessage — depth', () => {
  it('appends the depth instruction under a divider when detail is set', () => {
    const msg = renderUserMessage({ description: 'crawl news weekly', detail: 'detailed' })
    expect(msg).toContain('crawl news weekly')
    expect(msg).toContain('---')
    expect(msg).toContain(detailInstruction('detailed'))
  })

  it('does NOT append anything when detail is absent (byte-for-byte unchanged)', () => {
    expect(renderUserMessage({ description: 'crawl news weekly' })).toBe('crawl news weekly')
  })

  it('depth stacks below contextHints when both are present', () => {
    const msg = renderUserMessage({
      description: 'crawl',
      contextHints: { agents: [{ id: 'writer', capabilities: ['draft'] }] },
      detail: 'oneliner',
    })
    expect(msg).toContain('writer [draft]')
    expect(msg).toContain(detailInstruction('oneliner'))
  })
})

describe('renderExplainMessage', () => {
  it('presents the subject YAML and asks for prose only at the requested depth', () => {
    const msg = renderExplainMessage({
      description: '',
      mode: 'explain',
      subjectYaml: SAMPLE_YAML,
      detail: 'detailed',
    })
    expect(msg).toContain('prose explanation ONLY')
    expect(msg).toContain('do NOT output any code fence')
    expect(msg).toContain(detailInstruction('detailed'))
    expect(msg).toContain('id: news-digest')
    expect(msg).toContain('```yaml')
  })

  it('defaults to brief depth when no detail is given', () => {
    const msg = renderExplainMessage({ description: '', mode: 'explain', subjectYaml: SAMPLE_YAML })
    expect(msg).toContain(detailInstruction('brief'))
  })

  it('uses the description as a focus question when one is provided', () => {
    const msg = renderExplainMessage({
      description: 'Where could this fail at runtime?',
      mode: 'explain',
      subjectYaml: SAMPLE_YAML,
    })
    expect(msg).toContain('Where could this fail at runtime?')
  })
})

describe('verdictForYamlWithDeepCheck — bound graph', () => {
  it('attaches the projected DAG graph on valid yaml (even without inventory)', () => {
    const v = verdictForYamlWithDeepCheck(SAMPLE_YAML.trim(), undefined)
    expect(v.status).toBe('valid')
    expect(v.graph).toEqual(projectWorkflowGraph(parseWorkflow(SAMPLE_YAML.trim())))
    expect(v.graph?.workflowId).toBe('news-digest')
  })

  it('attaches the graph alongside deepCheck when inventory is present', () => {
    const v = verdictForYamlWithDeepCheck(SAMPLE_YAML.trim(), {
      agents: [
        { id: 'crawler', capabilities: ['crawl-news'] },
        { id: 'summarizer', capabilities: ['summarize'] },
      ],
    })
    expect(v.status).toBe('valid')
    expect(v.deepCheck?.ok).toBe(true)
    expect(v.graph?.workflowId).toBe('news-digest')
  })

  it('omits the graph on no_yaml and invalid', () => {
    expect(verdictForYamlWithDeepCheck('', undefined).graph).toBeUndefined()
    expect(verdictForYamlWithDeepCheck('not a workflow', undefined).graph).toBeUndefined()
  })
})

describe('WorkflowAssistantAgent — author mode attaches graph', () => {
  it('valid author output carries the DAG graph', async () => {
    const provider = new MockLlmProvider({ reply: SAMPLE_RESPONSE_TEXT })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    const result = await hub.dispatch(makeAssistantTask({ description: 'crawl' }))
    await hub.stop()

    const out = (result as { output: WorkflowAssistantOutput }).output
    expect(out.draftStatus).toBe('valid')
    expect(out.graph).toEqual(projectWorkflowGraph(parseWorkflow(SAMPLE_YAML.trim())))
  })

  it('detail is injected into the user message the LLM sees', async () => {
    let userMsg = ''
    const provider = new MockLlmProvider({
      reply: (req) => {
        const c = req.messages[0]?.content
        userMsg = typeof c === 'string' ? c : ''
        return SAMPLE_RESPONSE_TEXT
      },
    })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    await hub.dispatch(makeAssistantTask({ description: 'crawl', detail: 'detailed' }))
    await hub.stop()

    expect(userMsg).toContain(detailInstruction('detailed'))
  })
})

describe('WorkflowAssistantAgent — explain mode', () => {
  it('echoes the subject YAML + graph deterministically, ignoring the LLM yaml echo', async () => {
    // The mock returns prose AND a bogus, DIFFERENT yaml fence. Explain mode
    // must ignore that fence entirely: yaml + graph come from subjectYaml.
    const bogus = `Here is what it does.\n\n\`\`\`yaml\nschema: gotong.workflow/v1\nworkflow:\n  id: WRONG\n  trigger: { capability: nope }\n  steps:\n    - id: x\n      dispatch: { strategy: { kind: capability, capabilities: [nope] }, payload: {} }\n\`\`\``
    let userMsg = ''
    const provider = new MockLlmProvider({
      reply: (req) => {
        const c = req.messages[0]?.content
        userMsg = typeof c === 'string' ? c : ''
        return bogus
      },
    })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    const result = await hub.dispatch(
      makeAssistantTask({ description: '', mode: 'explain', subjectYaml: SAMPLE_YAML, detail: 'brief' }),
    )
    await hub.stop()

    const out = (result as { output: WorkflowAssistantOutput }).output
    // YAML + graph are the SUBJECT, never the LLM's WRONG echo.
    expect(out.yaml).toBe(SAMPLE_YAML)
    expect(out.draftStatus).toBe('valid')
    expect(out.graph).toEqual(projectWorkflowGraph(parseWorkflow(SAMPLE_YAML.trim())))
    expect(out.graph?.workflowId).toBe('news-digest')
    // Explanation is the full prose response (no fence extraction).
    expect(out.explanation).toBe(bogus.trim())
    // The LLM was shown the subject + a prose-only instruction + depth.
    expect(userMsg).toContain('prose explanation ONLY')
    expect(userMsg).toContain('id: news-digest')
    expect(userMsg).toContain(detailInstruction('brief'))
  })

  it('reports draftStatus=invalid when the subject YAML is itself broken', async () => {
    const broken = 'schema: gotong.workflow/v1\nworkflow:\n  id: broken\n  trigger: {}\n  steps: []\n'
    const provider = new MockLlmProvider({ reply: 'It looks broken.' })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    const result = await hub.dispatch(
      makeAssistantTask({ description: '', mode: 'explain', subjectYaml: broken }),
    )
    await hub.stop()

    const out = (result as { output: WorkflowAssistantOutput }).output
    expect(out.draftStatus).toBe('invalid')
    expect(out.graph).toBeUndefined()
    expect(out.validationError).toBeTruthy()
    // We still echo the subject and surface the prose.
    expect(out.yaml).toBe(broken)
    expect(out.explanation).toBe('It looks broken.')
  })

  it('explain mode with an empty subjectYaml is a failed dispatch', async () => {
    const provider = new MockLlmProvider({ reply: 'x' })
    const hub = Hub.inMemory()
    await hub.start()
    hub.register(new WorkflowAssistantAgent({ provider }))

    const result = await hub.dispatch(
      makeAssistantTask({ description: 'explain please', mode: 'explain', subjectYaml: '   ' }),
    )
    await hub.stop()
    expect(result.kind).toBe('failed')
  })
})
