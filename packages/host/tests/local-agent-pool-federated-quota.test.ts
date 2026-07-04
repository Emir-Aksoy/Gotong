/**
 * Audit A3 — a federated task must NEVER debit a local per-user budget.
 *
 * The threat: a peer reaches us over A2A / a relayed dispatch and sets
 * `origin.userId` to whatever it likes — including a *real* local user's
 * id. Before the fix, both accounting paths trusted that id blindly:
 *   - the pre-call quota gate `checkAndIncrement`ed the claimed user's
 *     `llm_requests` counter, and
 *   - the post-call usage sink `recordUsage`d the claimed user's
 *     `llm_tokens` / `llm_cost_micros` budgets.
 * Either lets a peer silently drain (or, with a bogus id, FK-fault) a
 * local user's day budget. Federated usage belongs to the per-link
 * contract (P4-M4 inbound quota), not the per-user gate.
 *
 * The fix discriminates with `resolveLedgerPeerId(task)`: when the task's
 * `origin.orgId` maps to a registered peer row, it's federated — skip the
 * per-user gate AND the per-user budget debit, while STILL appending the
 * ledger row WITH `peerId` for isolated peer-aware accounting.
 *
 * We exercise the real, non-mock-only hooks by registering the agent under
 * a NON-`mock` provider name and injecting a deterministic provider via the
 * pool's `providerFactory` test seam — the only way to drive the gate +
 * federated sink without a network call.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLogger, Hub, Space, type AgentRecord } from '@gotong/core'
import { MockLlmProvider } from '@gotong/llm'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@gotong/identity'

import { LocalAgentPool } from '../src/local-agent-pool.js'
import { OrgApiPool } from '../src/org-api-pool.js'
import { bootstrapServices, type HubServices } from '../src/services/index.js'

const logger = createLogger('lap-fed-quota-test', { disabled: true })

describe('LocalAgentPool — federated origin never debits a local per-user budget (audit A3)', () => {
  let root: string
  let space: Space
  let hub: Hub
  let services: HubServices
  let identity: IdentityStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-lap-fedquota-'))
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

  /**
   * Spawn a managed agent under the `anthropic` provider name (so the
   * non-mock-only quota gate + budget sink are installed) but with a
   * deterministic in-memory provider injected via the test seam. A priced
   * model id lets us assert a non-zero `llm_cost_micros` debit.
   */
  async function spawnNonMockAgent(): Promise<void> {
    await space.upsertAgent({
      id: 'echo-anthropic',
      allowedCapabilities: ['echo'],
      createdAt: new Date().toISOString(),
      managed: {
        kind: 'llm',
        provider: 'anthropic',
        system: 'hi',
        model: 'claude-opus-4',
      },
    } satisfies AgentRecord)
    const orgApiPool = new OrgApiPool({ identity })
    const pool = new LocalAgentPool({
      hub,
      space,
      services,
      identity,
      orgApiPool,
      providerFactory: () => new MockLlmProvider({ reply: () => 'ok' }),
    })
    await pool.start()
  }

  function usedFor(userId: string, metric: string): number {
    const rows = identity.listUsage({ userId, metric, period: 'daily' })
    return rows.length > 0 ? rows[0].used : 0
  }

  it('debits the local user on a local call, but a federated call claiming that same user debits nothing', async () => {
    await spawnNonMockAgent()
    const user = identity.createUser({
      email: 'fed@test.local',
      displayName: 'Local U',
      role: 'member',
    })
    // The federated origin's wire id maps to this registered peer row.
    const peer = identity.addPeer({
      peerId: 'peerX',
      endpointUrl: 'wss://peerx.example/hub',
      peerToken: 'shared-secret',
    })

    // 1) LOCAL-origin call — the per-user budget IS debited on all three
    //    metrics (gate → llm_requests, sink → llm_tokens / cost).
    const local = await hub.dispatch({
      from: user.id,
      strategy: { kind: 'capability', capabilities: ['echo'] },
      payload: { user: 'hi' },
      origin: { orgId: 'local', userId: user.id },
    })
    expect(local.kind).toBe('ok')

    const reqAfterLocal = usedFor(user.id, 'llm_requests')
    const tokAfterLocal = usedFor(user.id, 'llm_tokens')
    const costAfterLocal = usedFor(user.id, 'llm_cost_micros')
    expect(reqAfterLocal).toBe(1) // gate debited exactly one request
    expect(tokAfterLocal).toBeGreaterThan(0) // sink debited tokens
    expect(costAfterLocal).toBeGreaterThan(0) // model priced → cost > 0

    // The local call's ledger row is NOT peer-attributed.
    const localRows = identity.queryLedger({ userId: user.id })
    expect(localRows).toHaveLength(1)
    expect(localRows[0].peerId).toBeNull()

    // 2) FEDERATED-origin call — peer 'peerX' CLAIMS local user U. The
    //    per-user budget must be UNTOUCHED: preCallHook skips the gate AND
    //    the sink skips recordUsage. (If either guard regresses this goes
    //    red: a reverted gate bumps llm_requests to 2, a reverted sink
    //    doubles llm_tokens / cost.)
    const fed = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['echo'] },
      payload: { user: 'hi from peer' },
      origin: { orgId: 'peerX', userId: user.id },
    })
    expect(fed.kind).toBe('ok')

    expect(usedFor(user.id, 'llm_requests')).toBe(reqAfterLocal)
    expect(usedFor(user.id, 'llm_tokens')).toBe(tokAfterLocal)
    expect(usedFor(user.id, 'llm_cost_micros')).toBe(costAfterLocal)

    // ...yet the ledger DID record the federated call, attributed to the
    // peer ROW id (trustworthy) — observability stays whole, isolated per
    // peer. The claimed user id is recorded but never debited.
    const allRows = identity.queryLedger({})
    const fedRow = allRows.find((r) => r.peerId !== null)
    expect(fedRow).toBeDefined()
    expect(fedRow?.peerId).toBe(peer.id)
    expect(fedRow?.userId).toBe(user.id)
  })
})
