/**
 * Audit M7 — the per-user `llm_tokens` budget must count ALL token types the
 * model processed, not just the fresh input+output slice.
 *
 * With prompt caching on (Anthropic, OpenAI), a provider reports the bulk of a
 * prompt as `cacheCreationTokens` / `cacheReadTokens` and only the un-cached
 * remainder as `inputTokens`. A call replaying a large cached prompt therefore
 * reports near-zero `inputTokens`. The budget sink summed input+output ONLY, so
 * those calls under-debited the token budget to almost nothing and the pre-call
 * peek never tripped → fail-OPEN. The ledger row already records all four
 * fields (and `estimateCostMicros` prices them); the budget must agree.
 *
 * We drive a NON-`mock` provider via the pool's `providerFactory` seam (the
 * budget sink is non-mock-only) and feed an explicit usage chunk carrying all
 * four token types.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLogger, Hub, Space, type AgentRecord } from '@aipehub/core'
import { MockLlmProvider } from '@aipehub/llm'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@aipehub/identity'

import { LocalAgentPool } from '../src/local-agent-pool.js'
import { OrgApiPool } from '../src/org-api-pool.js'
import { bootstrapServices, type HubServices } from '../src/services/index.js'

const logger = createLogger('lap-cache-tokens-test', { disabled: true })

// Explicit usage so the assertion is exact, not estimate-dependent. The bulk is
// in the cache fields — exactly the slice the buggy sum dropped.
const INPUT_TOKENS = 5
const OUTPUT_TOKENS = 7
const CACHE_CREATION_TOKENS = 100
const CACHE_READ_TOKENS = 2000
const TOTAL_TOKENS = INPUT_TOKENS + OUTPUT_TOKENS + CACHE_CREATION_TOKENS + CACHE_READ_TOKENS

describe('LocalAgentPool — token budget counts cache tokens (audit M7)', () => {
  let root: string
  let space: Space
  let hub: Hub
  let services: HubServices
  let identity: IdentityStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aipe-lap-cachetok-'))
    await rm(root, { recursive: true, force: true })
    const opened = await Space.init(root, { name: 'test' })
    space = opened.space
    hub = new Hub({ space })
    await hub.start()
    await writeFile(
      join(space.paths.services, 'plugins.json'),
      JSON.stringify({ plugins: [] }, null, 2) + '\n',
      'utf8',
    )
    const boot = await bootstrapServices({ space, hub, logger })
    services = boot.services
    identity = openIdentityStore({
      dbPath: join(root, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
  })

  afterEach(async () => {
    identity.close()
    await services.shutdownAll()
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  function usedFor(userId: string, metric: string): number {
    const rows = identity.listUsage({ userId, metric, period: 'daily' })
    return rows.length > 0 ? rows[0].used : 0
  }

  it('debits input+output+cacheCreation+cacheRead to the llm_tokens budget', async () => {
    await space.upsertAgent({
      id: 'echo-anthropic',
      allowedCapabilities: ['echo'],
      createdAt: new Date().toISOString(),
      managed: { kind: 'llm', provider: 'anthropic', system: 'hi', model: 'claude-opus-4' },
    } satisfies AgentRecord)
    const orgApiPool = new OrgApiPool({ identity })
    const pool = new LocalAgentPool({
      hub,
      space,
      services,
      identity,
      orgApiPool,
      // A single call yielding a usage chunk that carries ALL four token types.
      providerFactory: () =>
        new MockLlmProvider({
          chunks: [
            { type: 'text', text: 'ok' },
            {
              type: 'usage',
              usage: {
                inputTokens: INPUT_TOKENS,
                outputTokens: OUTPUT_TOKENS,
                cacheCreationTokens: CACHE_CREATION_TOKENS,
                cacheReadTokens: CACHE_READ_TOKENS,
              },
            },
            { type: 'end', stopReason: 'end_turn' },
          ],
        }),
    })
    await pool.start()

    const user = identity.createUser({
      email: 'cache@test.local',
      displayName: 'Local U',
      role: 'member',
    })

    const res = await hub.dispatch({
      from: user.id,
      strategy: { kind: 'capability', capabilities: ['echo'] },
      payload: { user: 'hi' },
      origin: { orgId: 'local', userId: user.id },
    })
    expect(res.kind).toBe('ok')

    // The budget must reflect every token the model processed. Summing only
    // input+output (12) instead of all four (2112) is the fail-OPEN bug.
    expect(usedFor(user.id, 'llm_tokens')).toBe(TOTAL_TOKENS)

    // Sanity: the ledger row recorded the same four fields it always did.
    const rows = identity.queryLedger({ userId: user.id })
    expect(rows).toHaveLength(1)
    expect(rows[0].cacheCreationTokens).toBe(CACHE_CREATION_TOKENS)
    expect(rows[0].cacheReadTokens).toBe(CACHE_READ_TOKENS)
  })
})
