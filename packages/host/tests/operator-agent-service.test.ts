/**
 * A-M2 — `HostOperatorAgentService`: the operator console steward's SITE-WIDE
 * agent executor. Same `StewardAgentDirectory` contract the member service
 * satisfies, but it manages EVERY managed agent (no namespace fence, no
 * per-member cap, full operator provider set).
 *
 * Real `Space` (so persist is real) + a `FakeLifecycle` (every host agent test
 * fakes the spawn) + a recording grant fake. The gate pins the three things the
 * site-wide write path must do, each mirroring `agents-routes.ts`:
 *   - create  → persist (space.agents) + spawn (lifecycle.start) + seed owner;
 *   - update  → re-persist the changed config + respawn;
 *   - remove  → stop + removeAgent + drop grants + onAgentRemoved.
 *
 * Plus the fences: a bad site-wide id and a provider with no key both fail loud
 * BEFORE persist, and `listOwned` returns every managed agent (operator owns the
 * whole site, not a grant-filtered subset).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Space, type AgentRecord, type ManagedAgentLifecycle, type ParticipantId } from '@aipehub/core'
import { userPrincipal, type Principal } from '@aipehub/identity'

import {
  HostOperatorAgentService,
  type OperatorAgentGrantStore,
} from '../src/operator-agent-service.js'
import type { StewardAgentDirectory } from '../src/hub-steward-service.js'

const OPERATOR = 'op1'

// --- faked spawn (every host agent test fakes this) -------------------------

class FakeLifecycle implements ManagedAgentLifecycle {
  started: AgentRecord[] = []
  stopped: ParticipantId[] = []
  removed: ParticipantId[] = []
  providers: string[] = ['mock', 'anthropic']
  async start(record: AgentRecord): Promise<void> {
    this.started.push(record)
  }
  async stop(id: ParticipantId): Promise<void> {
    this.stopped.push(id)
  }
  async availableProviders(): Promise<readonly string[]> {
    return this.providers
  }
  async onAgentRemoved(id: ParticipantId): Promise<void> {
    this.removed.push(id)
  }
}

// --- recording grant fake (mirrors the real resource_grants writes) ---------

class RecordingGrants implements OperatorAgentGrantStore {
  seeded: { agentId: string; principal: Principal }[] = []
  removed: string[] = []
  setResourceGrant(input: {
    resourceKind: 'agent'
    resourceId: string
    principal: Principal
    perm: 'owner'
    grantedBy?: string | null
  }): unknown {
    this.seeded.push({ agentId: input.resourceId, principal: input.principal })
    return undefined
  }
  removeAllResourceGrants(_kind: 'agent', id: string): number {
    this.removed.push(id)
    return 1
  }
}

// --- rig --------------------------------------------------------------------

interface Rig {
  tmp: string
  space: Space
  lifecycle: FakeLifecycle
  grants: RecordingGrants
  reconciled: string[]
  svc: HostOperatorAgentService
}

async function boot(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipe-operator-agent-'))
  const { space } = await Space.init(tmp, { name: 'operator-agent' })
  const lifecycle = new FakeLifecycle()
  const grants = new RecordingGrants()
  const reconciled: string[] = []
  const svc = new HostOperatorAgentService({
    space,
    lifecycle,
    grants,
    reconcileHeartbeats: async () => {
      reconciled.push('tick')
    },
  })
  return { tmp, space, lifecycle, grants, reconciled, svc }
}

const CREATE = {
  id: 'site.mailer',
  label: '邮件总结助手',
  provider: 'mock',
  system: '你把邮件总结成三句话。',
  capabilities: ['mail.summarize'],
}

describe('A-M2 — HostOperatorAgentService (site-wide agent executor)', () => {
  let rig: Rig

  beforeEach(async () => {
    rig = await boot()
  })
  afterEach(async () => {
    await rm(rig.tmp, { recursive: true, force: true })
  })

  it('create persists + spawns + seeds the operator as owner', async () => {
    const view = await rig.svc.create(OPERATOR, CREATE)
    expect(view.id).toBe('site.mailer')
    expect(view.provider).toBe('mock')
    expect(view.capabilities).toEqual(['mail.summarize'])

    // persisted under the SITE-WIDE id verbatim (no `me.<userId>.` prefix)
    const recs = await rig.space.agents()
    const rec = recs.find((a) => a.id === 'site.mailer')
    expect(rec?.managed?.provider).toBe('mock')
    expect(rec?.displayName).toBe('邮件总结助手')

    // spawned
    expect(rig.lifecycle.started.map((r) => r.id)).toContain('site.mailer')
    // owner seeded for the operator (a user principal), best-effort
    expect(rig.grants.seeded).toHaveLength(1)
    expect(rig.grants.seeded[0]!.agentId).toBe('site.mailer')
    expect(rig.grants.seeded[0]!.principal).toEqual(userPrincipal(OPERATOR))
    // heartbeat reconcile fired
    expect(rig.reconciled).toContain('tick')
  })

  it('update re-persists the changed config + respawns', async () => {
    await rig.svc.create(OPERATOR, CREATE)
    rig.lifecycle.started = [] // isolate the respawn

    const view = await rig.svc.update(OPERATOR, 'site.mailer', {
      system: '改成只用一句话。',
      capabilities: ['mail.summarize', 'mail.triage'],
    })
    expect(view.capabilities).toEqual(['mail.summarize', 'mail.triage'])

    const rec = (await rig.space.agents()).find((a) => a.id === 'site.mailer')
    expect(rec?.managed?.system).toBe('改成只用一句话。')
    expect(rec?.allowedCapabilities).toEqual(['mail.summarize', 'mail.triage'])
    // respawned with the new config
    expect(rig.lifecycle.started.map((r) => r.id)).toEqual(['site.mailer'])
  })

  it('remove stops + deletes + drops grants + runs onAgentRemoved', async () => {
    await rig.svc.create(OPERATOR, CREATE)
    const removed = await rig.svc.remove(OPERATOR, 'site.mailer')
    expect(removed).toBe(true)

    expect((await rig.space.agents()).some((a) => a.id === 'site.mailer')).toBe(false)
    expect(rig.lifecycle.stopped).toContain('site.mailer')
    expect(rig.lifecycle.removed).toContain('site.mailer')
    expect(rig.grants.removed).toContain('site.mailer')
  })

  it('listOwned returns EVERY managed agent (operator owns the whole site)', async () => {
    // Two agents seeded directly (as if admin-created) + one via the steward.
    await rig.space.upsertAgent({
      id: 'pre.alpha',
      allowedCapabilities: ['a'],
      managed: { kind: 'llm', provider: 'mock', system: 'A' },
    })
    await rig.space.upsertAgent({
      id: 'pre.beta',
      allowedCapabilities: ['b'],
      managed: { kind: 'llm', provider: 'mock', system: 'B' },
    })
    await rig.svc.create(OPERATOR, CREATE)

    const ids = (await rig.svc.listOwned()).map((a) => a.id).sort()
    expect(ids).toEqual(['pre.alpha', 'pre.beta', 'site.mailer'])
  })

  it('rejects a malformed site-wide id before persisting', async () => {
    await expect(rig.svc.create(OPERATOR, { ...CREATE, id: 'bad id!' })).rejects.toMatchObject({
      status: 400,
    })
    expect((await rig.space.agents()).length).toBe(0)
    expect(rig.lifecycle.started).toHaveLength(0)
  })

  it('rejects a provider with no key before persisting', async () => {
    rig.lifecycle.providers = ['mock'] // no openai key
    await expect(
      rig.svc.create(OPERATOR, { ...CREATE, id: 'site.x', provider: 'openai' }),
    ).rejects.toMatchObject({ status: 400 })
    expect((await rig.space.agents()).some((a) => a.id === 'site.x')).toBe(false)
  })

  it('structurally satisfies StewardAgentDirectory (drops into performStewardAction)', () => {
    // A compile-time + runtime assertion: the service IS a StewardAgentDirectory,
    // so the SAME `performStewardAction` chokepoint the member path uses runs it.
    const dir: StewardAgentDirectory = rig.svc
    expect(typeof dir.create).toBe('function')
    expect(typeof dir.update).toBe('function')
    expect(typeof dir.remove).toBe('function')
    expect(typeof dir.listOwned).toBe('function')
    expect(typeof dir.availableProviders).toBe('function')
  })
})
