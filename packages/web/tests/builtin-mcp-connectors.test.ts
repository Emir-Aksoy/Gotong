/**
 * Anti-rot acceptance gate for the built-in MCP CONNECTOR directory (MCD-M1).
 *
 * `src/builtin-mcp-connectors.ts` is a HAND-AUTHORED framework-level constant
 * (unlike the AUTO-GENERATED builtin-templates.ts). Each entry's `spec` is the
 * exact `McpServerSpec` the one-click install posts to `/api/admin/mcp-servers`.
 *
 * This test re-parses EVERY embedded `spec` through the REAL
 * `validateMcpServersArray` — the same validator the install route runs. So a
 * preset can't silently ship a spec that would blow up on install (bad name,
 * missing command, malformed transport): the drift surfaces here, loudly.
 *
 * It also pins the curated id set (add/remove = visible diff) and enforces the
 * "no plaintext secrets" rule: every `needsEnv` credential must appear in the
 * spec only as a `${NAME}` placeholder, never a literal value.
 */

import { describe, expect, it } from 'vitest'

import {
  BUILTIN_MCP_CONNECTORS,
  MCP_CONNECTOR_CATEGORIES,
  type BuiltinMcpConnector,
} from '../src/builtin-mcp-connectors.js'
import { validateMcpServersArray } from '../src/manifest.js'

// The curated directory — pinning ids makes "someone quietly added/removed a
// connector" a test diff, not a surprise in the admin UI.
const EXPECTED_IDS = [
  'mcp-registry-search',
  'chroma-rag',
  'obsidian-notes',
  'notion-notes',
  'todoist-tasks',
  'mem0-memory',
  'elasticsearch',
  'tavily-web-search',
  'brave-web-search',
  'filesystem',
]

// MU-M4: the data-leaves-box disclosure set. Pinning it makes "someone flipped a
// connector's off-box status" a visible diff — and enforces the honest-coverage
// rule (every cloud-SaaS connector carries the flag; local ones don't).
// LSA-M2: web-search connectors ship the flag too — the query itself goes off-box.
const DATA_LEAVES_BOX_IDS = [
  'notion-notes',
  'todoist-tasks',
  'mem0-memory',
  'tavily-web-search',
  'brave-web-search',
]

/**
 * Every place a credential can live in a spec, transport-agnostic: `env` values
 * (stdio) AND `headers` values (http/sse). MU-M4's Mem0 connector rides a bearer
 * token in an Authorization header, so the "never plaintext" rules must look there
 * too, not only in `env`.
 */
const credentialSlotsOf = (c: BuiltinMcpConnector): Array<{ where: string; value: string }> => {
  const spec = c.spec as {
    env?: Record<string, string>
    headers?: Record<string, string>
  }
  const slots: Array<{ where: string; value: string }> = []
  for (const [k, v] of Object.entries(spec.env ?? {})) slots.push({ where: `env[${k}]`, value: v })
  for (const [k, v] of Object.entries(spec.headers ?? {})) slots.push({ where: `headers[${k}]`, value: v })
  return slots
}

describe('built-in MCP connector directory (MCD-M1)', () => {
  it('ships exactly the curated set, in order, with unique ids', () => {
    expect(BUILTIN_MCP_CONNECTORS.map((c) => c.id)).toEqual(EXPECTED_IDS)
    expect(new Set(BUILTIN_MCP_CONNECTORS.map((c) => c.id)).size).toBe(EXPECTED_IDS.length)
  })

  it('display names and technical spec.names are each unique', () => {
    const names = BUILTIN_MCP_CONNECTORS.map((c) => c.name)
    expect(new Set(names).size, 'duplicate display name').toBe(names.length)
    const specNames = BUILTIN_MCP_CONNECTORS.map((c) => c.spec.name)
    expect(new Set(specNames).size, 'duplicate spec.name').toBe(specNames.length)
  })

  it('every category is in the allowed set', () => {
    for (const c of BUILTIN_MCP_CONNECTORS) {
      expect(MCP_CONNECTOR_CATEGORIES, `${c.id} category`).toContain(c.category)
    }
  })

  it('has a whatFor and a usable spec.name on every entry', () => {
    for (const c of BUILTIN_MCP_CONNECTORS) {
      expect(c.whatFor.length, `${c.id} whatFor`).toBeGreaterThan(0)
      expect(c.spec.name, `${c.id} spec.name`).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
    }
  })

  // The load-bearing assertion: the whole array passes the real validator at
  // once — which also enforces cross-entry spec.name uniqueness (seenNames) the
  // way an actual install batch would.
  it('the whole directory passes the real validateMcpServersArray', () => {
    const specs = BUILTIN_MCP_CONNECTORS.map((c) => c.spec)
    const out = validateMcpServersArray(specs, 'builtin-mcp')
    expect(out).toHaveLength(specs.length)
    expect(out.map((s) => s.name)).toEqual(specs.map((s) => s.name))
  })

  // …and each spec stands alone too (mirrors "每条 spec 过真校验器").
  it.each(BUILTIN_MCP_CONNECTORS.map((c) => [c.id, c] as const))(
    '%s spec validates individually',
    (_id, c) => {
      const out = validateMcpServersArray([c.spec], `builtin-mcp[${c.id}]`)
      expect(out).toHaveLength(1)
      expect(out[0].name).toBe(c.spec.name)
    },
  )

  it('exposes a discovery entry pointing at the official MCP registry', () => {
    const discovery = BUILTIN_MCP_CONNECTORS.filter((c) => c.category === 'discovery')
    expect(discovery.length, 'expected a discovery connector').toBeGreaterThan(0)
    const registry = discovery.find((c) =>
      (c.homepage ?? '').includes('registry.modelcontextprotocol.io'),
    )
    expect(registry, 'discovery entry must link the official registry').toBeTruthy()
    // The fetch recipe is a broad capability — it must carry the SSRF caveat.
    expect(registry?.caveat, 'discovery entry must warn about fetch breadth').toBeTruthy()
  })

  it('every needsEnv credential is referenced only as a ${ENV} placeholder, never plaintext', () => {
    for (const c of BUILTIN_MCP_CONNECTORS) {
      if (!c.needsEnv || c.needsEnv.length === 0) continue
      const slots = credentialSlotsOf(c)
      expect(slots.length, `${c.id} declares needsEnv but spec has no env/headers`).toBeGreaterThan(0)
      for (const name of c.needsEnv) {
        const ref = '${' + name + '}'
        // The ref may be the whole value (stdio env `${NOTION_TOKEN}`) or embedded
        // in a header (`Bearer ${MEM0_API_KEY}`) — either way the literal secret
        // never appears; only the placeholder does.
        const found = slots.some((s) => s.value.includes(ref))
        expect(found, `${c.id} needsEnv ${name} not referenced as ${ref} in any env/header`).toBe(true)
      }
    }
  })

  it('no credential value hardcodes a secret; every ${...} is a clean ref', () => {
    // Strip every well-formed ${NAME} ref; any surviving `${` is a malformed /
    // half-typed placeholder (e.g. "${ES_API_KEY"). Fixed literals with no ${}
    // (Bearer prefix, OTEL_LOG_LEVEL=none) are fine. Transport-agnostic: covers
    // http/sse header credentials, not just stdio env.
    for (const c of BUILTIN_MCP_CONNECTORS) {
      for (const s of credentialSlotsOf(c)) {
        const stripped = s.value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, '')
        expect(stripped.includes('${'), `${c.id} ${s.where} malformed placeholder`).toBe(false)
      }
    }
  })

  // —— MU-M4: the data-leaves-box disclosure primitive ——
  it('pins the data-leaves-box set; the flag is a boolean where present', () => {
    const flagged = BUILTIN_MCP_CONNECTORS.filter((c) => c.dataLeavesBox).map((c) => c.id)
    expect(flagged.sort()).toEqual([...DATA_LEAVES_BOX_IDS].sort())
    for (const c of BUILTIN_MCP_CONNECTORS) {
      if (c.dataLeavesBox !== undefined) {
        expect(typeof c.dataLeavesBox, `${c.id} dataLeavesBox`).toBe('boolean')
      }
    }
  })

  it('the Mem0 memory connector is an off-box hosted-HTTP memory provider', () => {
    const mem0 = BUILTIN_MCP_CONNECTORS.find((c) => c.id === 'mem0-memory')
    expect(mem0?.category).toBe('memory')
    expect(mem0?.dataLeavesBox).toBe(true)
    expect(mem0?.needsEnv).toContain('MEM0_API_KEY')
    const spec = mem0?.spec as { transport?: string; url?: string; headers?: Record<string, string> }
    expect(spec?.transport).toBe('http')
    expect(spec?.url).toBe('https://mcp.mem0.ai/mcp')
    // The credential rides an Authorization header as a ${ENV} ref, never plaintext.
    expect(spec?.headers?.Authorization).toBe('Bearer ${MEM0_API_KEY}')
  })

  // —— LSA-M2: the general web-search connectors (fills the reserved 'web' slot) ——
  it('ships a web-search category with Tavily (hosted-HTTP+Bearer) and Brave (stdio)', () => {
    const web = BUILTIN_MCP_CONNECTORS.filter((c) => c.category === 'web')
    expect(web.map((c) => c.id).sort()).toEqual(['brave-web-search', 'tavily-web-search'])
    // Both send the query off-box → both must carry the disclosure flag + a caveat.
    for (const c of web) {
      expect(c.dataLeavesBox, `${c.id} dataLeavesBox`).toBe(true)
      expect(c.caveat, `${c.id} caveat`).toBeTruthy()
    }
  })

  it('Tavily rides hosted-HTTP + Bearer with the key NEVER in the URL query', () => {
    const tavily = BUILTIN_MCP_CONNECTORS.find((c) => c.id === 'tavily-web-search')
    expect(tavily?.category).toBe('web')
    expect(tavily?.needsEnv).toContain('TAVILY_API_KEY')
    const spec = tavily?.spec as { transport?: string; url?: string; headers?: Record<string, string> }
    expect(spec?.transport).toBe('http')
    expect(spec?.url).toBe('https://mcp.tavily.com/mcp/')
    expect(spec?.headers?.Authorization).toBe('Bearer ${TAVILY_API_KEY}')
    // Privacy red line: the secret rides the header, NEVER the URL — no ${...} and
    // no ?tavilyApiKey= smuggled into the query string (even though Tavily allows it).
    expect(spec?.url?.includes('${'), 'Tavily url must not embed a placeholder').toBe(false)
    expect(spec?.url?.toLowerCase().includes('apikey'), 'Tavily url must not carry a key param').toBe(false)
  })

  it('Brave rides local stdio with a static ${ENV} key and an explicit PATH', () => {
    const brave = BUILTIN_MCP_CONNECTORS.find((c) => c.id === 'brave-web-search')
    expect(brave?.category).toBe('web')
    expect(brave?.needsEnv).toContain('BRAVE_API_KEY')
    const spec = brave?.spec as { command?: string; args?: string[]; env?: Record<string, string> }
    expect(spec?.command).toBe('npx')
    expect(spec?.args).toContain('@brave/brave-search-mcp-server')
    expect(spec?.env?.BRAVE_API_KEY).toBe('${BRAVE_API_KEY}')
    // stdio children inherit only the listed env — PATH must be passed through so npx resolves.
    expect(spec?.env?.PATH).toBe('${PATH}')
  })
})
