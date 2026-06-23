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
  'elasticsearch',
  'filesystem',
]

const envOf = (c: BuiltinMcpConnector): Record<string, string> | undefined =>
  (c.spec as { env?: Record<string, string> }).env

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

  it('every needsEnv credential is a ${ENV} placeholder, never plaintext', () => {
    for (const c of BUILTIN_MCP_CONNECTORS) {
      if (!c.needsEnv || c.needsEnv.length === 0) continue
      const env = envOf(c)
      expect(env, `${c.id} declares needsEnv but spec has no env`).toBeTruthy()
      for (const name of c.needsEnv) {
        expect(env?.[name], `${c.id} env[${name}]`).toBe('${' + name + '}')
      }
    }
  })

  it('no env value hardcodes a secret-shaped literal', () => {
    // Any value that LOOKS like it should be a placeholder (has ${...}) must be
    // a clean ${NAME} ref; fixed config literals (e.g. OTEL_LOG_LEVEL=none) are
    // fine. This catches a half-typed placeholder like "${ES_API_KEY" too.
    for (const c of BUILTIN_MCP_CONNECTORS) {
      const env = envOf(c)
      if (!env) continue
      for (const [k, v] of Object.entries(env)) {
        if (v.includes('${') || v.includes('}')) {
          expect(v, `${c.id} env[${k}] malformed placeholder`).toMatch(
            /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/,
          )
        }
      }
    }
  })
})
