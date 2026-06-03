/**
 * v5 A-M2 — HostMeAgentService. Exercises the real Space + real IdentityStore
 * (resource_grants) + a fake ManagedAgentLifecycle, so ownership recording, the
 * ownership gate, id namespacing, provider constraints, the per-member cap, and
 * spawn-failure rollback are all covered against the actual stores.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space, type AgentRecord, type ManagedAgentLifecycle, type ParticipantId } from '@aipehub/core'
import { AUDIT_ACTIONS, openIdentityStore, userPrincipal, type IdentityStore } from '@aipehub/identity'

import { HostMeAgentService } from '../src/me-agent-service.js'

class FakeLifecycle implements ManagedAgentLifecycle {
  started: AgentRecord[] = []
  stopped: ParticipantId[] = []
  removed: ParticipantId[] = []
  providers: string[] = ['anthropic', 'mock']
  failStart = false

  async start(record: AgentRecord): Promise<void> {
    if (this.failStart) throw new Error('no API key for provider')
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

interface Harness {
  tmp: string
  space: Space
  hub: Hub
  identity: IdentityStore
  lifecycle: FakeLifecycle
  svc: HostMeAgentService
}

const USER = 'user-alice'
const OTHER = 'user-bob'

async function setup(maxPerMember?: number): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-host-meagent-'))
  const init = await Space.init(tmp, { name: 'meagent-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()
  const identity = openIdentityStore({ dbPath: ':memory:' })
  const lifecycle = new FakeLifecycle()
  const svc = new HostMeAgentService({ space, hub, identity, lifecycle, maxPerMember })
  return { tmp, space, hub, identity, lifecycle, svc }
}

const baseInput = {
  id: 'writer',
  label: '写手',
  capabilities: ['write-zh'],
  system: 'You write Chinese.',
  provider: 'mock',
}

describe('HostMeAgentService (v5 A-M2)', () => {
  let h: Harness

  afterEach(async () => {
    await rm(h.tmp, { recursive: true, force: true })
  })

  it('create: composes a namespaced id, writes the owner grant, spawns', async () => {
    h = await setup()
    const v = await h.svc.create(USER, baseInput)
    expect(v.id).toBe(`me.${USER}.writer`)
    expect(v.system).toBe('You write Chinese.')
    expect(v.provider).toBe('mock')
    // owner grant recorded in resource_grants
    expect(h.identity.hasResourceGrant('agent', v.id, userPrincipal(USER), 'owner')).toBe(true)
    // persisted + spawned
    expect((await h.space.agents()).some((a) => a.id === v.id)).toBe(true)
    expect(h.lifecycle.started.map((r) => r.id)).toEqual([`me.${USER}.writer`])
  })

  it('create: rejects openai-compatible (needs a baseURL — operator infra)', async () => {
    h = await setup()
    await expect(h.svc.create(USER, { ...baseInput, provider: 'openai-compatible' })).rejects.toMatchObject({
      status: 400,
    })
  })

  it('create: rejects a provider with no configured key', async () => {
    h = await setup()
    h.lifecycle.providers = ['mock'] // anthropic not available
    await expect(h.svc.create(USER, { ...baseInput, provider: 'anthropic' })).rejects.toMatchObject({
      status: 400,
    })
  })

  it('create: collision on the same handle → 409', async () => {
    h = await setup()
    await h.svc.create(USER, baseInput)
    await expect(h.svc.create(USER, baseInput)).rejects.toMatchObject({ status: 409 })
  })

  it('create: per-member cap → 400', async () => {
    h = await setup(1)
    await h.svc.create(USER, baseInput)
    await expect(h.svc.create(USER, { ...baseInput, id: 'second' })).rejects.toMatchObject({ status: 400 })
  })

  it('create: a spawn failure rolls back persistence + grant', async () => {
    h = await setup()
    h.lifecycle.failStart = true
    await expect(h.svc.create(USER, baseInput)).rejects.toMatchObject({ status: 400 })
    expect(await h.space.agents()).toHaveLength(0)
    expect(h.identity.getResourceGrant('agent', `me.${USER}.writer`, userPrincipal(USER))).toBeNull()
  })

  it('listOwned: only the caller’s live agents (ghost + cross-user filtered)', async () => {
    h = await setup()
    const mine = await h.svc.create(USER, baseInput)
    await h.svc.create(OTHER, { ...baseInput, id: 'bobwriter' }) // bob's, not alice's

    // a dangling grant whose agent was deleted out-of-band must NOT surface
    h.identity.setResourceGrant({
      resourceKind: 'agent',
      resourceId: `me.${USER}.ghost`,
      principal: userPrincipal(USER),
      perm: 'owner',
    })

    const owned = await h.svc.listOwned(USER)
    expect(owned.map((a) => a.id)).toEqual([mine.id])
  })

  it('update: owner can edit; a non-owner gets 404; unknown id → 404', async () => {
    h = await setup()
    const v = await h.svc.create(USER, baseInput)
    h.lifecycle.started.length = 0

    const updated = await h.svc.update(USER, v.id, { system: 'New prompt', label: '改名' })
    expect(updated.system).toBe('New prompt')
    expect(updated.label).toBe('改名')
    expect(h.lifecycle.started.map((r) => r.id)).toEqual([v.id]) // respawned

    await expect(h.svc.update(OTHER, v.id, { system: 'x' })).rejects.toMatchObject({ status: 404 })
    await expect(h.svc.update(USER, `me.${USER}.nope`, { system: 'x' })).rejects.toMatchObject({ status: 404 })
  })

  it('remove: owner deletes (grant + record + stop + cleanup); non-owner → 404', async () => {
    h = await setup()
    const v = await h.svc.create(USER, baseInput)

    await expect(h.svc.remove(OTHER, v.id)).rejects.toMatchObject({ status: 404 })

    const removed = await h.svc.remove(USER, v.id)
    expect(removed).toBe(true)
    expect((await h.space.agents()).some((a) => a.id === v.id)).toBe(false)
    expect(h.identity.getResourceGrant('agent', v.id, userPrincipal(USER))).toBeNull()
    expect(h.lifecycle.stopped).toContain(v.id)
    expect(h.lifecycle.removed).toContain(v.id)
  })

  it('availableProviders excludes openai-compatible', async () => {
    h = await setup()
    h.lifecycle.providers = ['anthropic', 'openai', 'openai-compatible', 'mock']
    expect(await h.svc.availableProviders()).toEqual(['anthropic', 'openai', 'mock'])
  })
})

// ---------------------------------------------------------------------------
// Route B P1-M1 — the viewer < editor < owner ladder is ENFORCED, not just
// recorded. Before this, sharing an agent at 'editor' was a dangerous illusion:
// the grant existed but `update` demanded 'owner', so an editor got a flat 404.
// Each test below pins one rung; neutralising a guard reds exactly one:
//   - lower `update`'s required level to 'viewer' → "viewer → 403" reds.
//   - make `remove`'s level 'editor' → "editor → 403 on remove" reds.
//   - raise `read`'s level above 'viewer' → "viewer can read" reds (M1c).
//   - collapse the 403/404 split (always 404) → "viewer → 403" + audit reds.
//   - drop the denial audit → the audit-row test reds.
// ---------------------------------------------------------------------------
describe('HostMeAgentService RBAC ladder (Route B P1-M1)', () => {
  let h: Harness

  afterEach(async () => {
    await rm(h.tmp, { recursive: true, force: true })
  })

  /** Share USER's agent with OTHER (bob) at a given level. */
  function shareWith(agentId: string, perm: 'viewer' | 'editor' | 'owner'): void {
    h.identity.setResourceGrant({
      resourceKind: 'agent',
      resourceId: agentId,
      principal: userPrincipal(OTHER),
      perm,
      grantedBy: USER,
    })
  }

  it('viewer is read-only: read → ok, update → 403 AND remove → 403 (nothing mutates)', async () => {
    h = await setup()
    const v = await h.svc.create(USER, baseInput)
    shareWith(v.id, 'viewer')
    h.lifecycle.started.length = 0

    // the READ half of "read-only" — a viewer sees the full config (M1c)
    const seen = await h.svc.read(OTHER, v.id)
    expect(seen.id).toBe(v.id)
    expect(seen.system).toBe(baseInput.system) // including the system prompt

    await expect(h.svc.update(OTHER, v.id, { system: 'x' })).rejects.toMatchObject({ status: 403 })
    await expect(h.svc.remove(OTHER, v.id)).rejects.toMatchObject({ status: 403 })
    // neither respawned nor torn down — the read-only grant changed nothing
    expect(h.lifecycle.started).toHaveLength(0)
    expect(h.lifecycle.stopped).toHaveLength(0)
    expect((await h.space.agents()).some((a) => a.id === v.id)).toBe(true)
  })

  it('editor can edit but NOT delete: update → ok, remove → 403', async () => {
    h = await setup()
    const v = await h.svc.create(USER, baseInput)
    shareWith(v.id, 'editor')
    h.lifecycle.started.length = 0

    const updated = await h.svc.update(OTHER, v.id, { system: 'edited by an editor' })
    expect(updated.system).toBe('edited by an editor')
    expect(h.lifecycle.started.map((r) => r.id)).toEqual([v.id]) // respawned with new config

    await expect(h.svc.remove(OTHER, v.id)).rejects.toMatchObject({ status: 403 })
    expect((await h.space.agents()).some((a) => a.id === v.id)).toBe(true) // still there
  })

  it('owner satisfies every rung: a co-owner can update AND delete', async () => {
    h = await setup()
    const v = await h.svc.create(USER, baseInput)
    shareWith(v.id, 'owner') // bob is now a co-owner
    await h.svc.update(OTHER, v.id, { system: 'co-owner edit' })
    expect(await h.svc.remove(OTHER, v.id)).toBe(true)
  })

  it('no grant at all → 404 (anti-enumeration preserved)', async () => {
    h = await setup()
    const v = await h.svc.create(USER, baseInput)
    await expect(h.svc.read(OTHER, v.id)).rejects.toMatchObject({ status: 404 })
    await expect(h.svc.update(OTHER, v.id, { system: 'x' })).rejects.toMatchObject({ status: 404 })
    await expect(h.svc.remove(OTHER, v.id)).rejects.toMatchObject({ status: 404 })
  })

  it('read floor: an editor / owner can also read; a stranger probe → 404, not audited', async () => {
    h = await setup()
    const v = await h.svc.create(USER, baseInput)

    // editor and owner are above the viewer floor — both read fine
    shareWith(v.id, 'editor')
    expect((await h.svc.read(OTHER, v.id)).id).toBe(v.id)
    expect((await h.svc.read(USER, v.id)).id).toBe(v.id) // the owner

    // a stranger with no grant reading is a blind probe: 404 + never audited
    const before = h.identity.listAuditLog!({ action: AUDIT_ACTIONS.RESOURCE_ACCESS_DENIED }).length
    await expect(h.svc.read('user-carol', v.id)).rejects.toMatchObject({ status: 404 })
    const after = h.identity.listAuditLog!({ action: AUDIT_ACTIONS.RESOURCE_ACCESS_DENIED }).length
    expect(after).toBe(before)
  })

  it('an over-privilege 403 writes a resource_access_denied audit row; a bare 404 probe does NOT', async () => {
    h = await setup()
    const v = await h.svc.create(USER, baseInput)

    // viewer over-reaches to edit → 403 + one denial audit row
    shareWith(v.id, 'viewer')
    await expect(h.svc.update(OTHER, v.id, { system: 'x' })).rejects.toMatchObject({ status: 403 })
    const denied = h.identity.listAuditLog!({ action: AUDIT_ACTIONS.RESOURCE_ACCESS_DENIED })
    expect(denied.length).toBeGreaterThanOrEqual(1)
    expect(denied[0]).toMatchObject({
      actorUserId: OTHER,
      success: false,
      metadata: { resourceKind: 'agent', resourceId: v.id, required: 'editor' },
    })

    // a blind probe by a stranger (no grant) is a 404 — never audited (it's
    // indistinguishable from "agent doesn't exist", so logging it is just noise)
    const before = h.identity.listAuditLog!({ action: AUDIT_ACTIONS.RESOURCE_ACCESS_DENIED }).length
    await expect(h.svc.update('user-carol', v.id, { system: 'x' })).rejects.toMatchObject({ status: 404 })
    const after = h.identity.listAuditLog!({ action: AUDIT_ACTIONS.RESOURCE_ACCESS_DENIED }).length
    expect(after).toBe(before)
  })
})
