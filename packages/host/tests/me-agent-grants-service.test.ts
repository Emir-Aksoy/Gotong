/**
 * v5 A-M4 — HostMeAgentGrantsService against a REAL IdentityStore
 * resource_grants table, so the owner gate, the principal validation, the
 * orphan guard, the co-ownership effect, and the best-effort audit are all
 * covered against the actual store.
 *
 * Setup mirrors A-M2: an agent is "owned" by a member iff there's a
 * (kind='agent', resourceId, principal=user:<id>, perm='owner') grant. We seed
 * that directly (the real HostMeAgentService would, but this test isolates the
 * grants service).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  AUDIT_ACTIONS,
  IdentityStore,
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  userPrincipal,
} from '@aipehub/identity'

import { HostMeAgentGrantsService } from '../src/me-agent-grants-service.js'

const ALICE = 'user-alice'
const BOB = 'user-bob'
const AGENT = 'me.user-alice.helper'

describe('HostMeAgentGrantsService (v5 A-M4)', () => {
  let dir: string
  let identity: IdentityStore
  let svc: HostMeAgentGrantsService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipehub-megrant-'))
    identity = openIdentityStore({
      dbPath: join(dir, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
    svc = new HostMeAgentGrantsService({ identity })
    // Seed ALICE as the agent's owner (what HostMeAgentService.create would do).
    identity.setResourceGrant({
      resourceKind: 'agent',
      resourceId: AGENT,
      principal: userPrincipal(ALICE),
      perm: 'owner',
      grantedBy: ALICE,
    })
  })

  afterEach(() => {
    identity.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('list: the owner sees the grants (starting with their own owner seed)', async () => {
    const grants = await svc.list(ALICE, AGENT)
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({
      principalKind: 'user',
      principalId: ALICE,
      perm: 'owner',
      principalKey: `user:${ALICE}`,
      isSelf: true,
    })
  })

  it('list: a non-owner cannot see grants → 404 (no enumeration)', async () => {
    await expect(svc.list(BOB, AGENT)).rejects.toMatchObject({ status: 404 })
  })

  it('set: granting another USER owner is co-ownership (they now own it too)', async () => {
    const g = await svc.set(ALICE, AGENT, { principalKind: 'user', principalId: BOB, perm: 'owner' })
    expect(g).toMatchObject({ principalKind: 'user', principalId: BOB, perm: 'owner', isSelf: false })
    // BOB can now list + manage — the very same owner grant A-M2 enforces.
    expect(identity.hasResourceGrant('agent', AGENT, userPrincipal(BOB), 'owner')).toBe(true)
    const bobView = await svc.list(BOB, AGENT)
    expect(bobView.map((x) => x.principalId).sort()).toEqual([ALICE, BOB])
  })

  it('set: viewer / editor / agent / peer principals are recorded', async () => {
    await svc.set(ALICE, AGENT, { principalKind: 'user', principalId: BOB, perm: 'viewer' })
    await svc.set(ALICE, AGENT, { principalKind: 'agent', principalId: 'me.x.bot', perm: 'editor' })
    await svc.set(ALICE, AGENT, { principalKind: 'peer', principalId: 'peer-7', perm: 'viewer' })
    const grants = await svc.list(ALICE, AGENT)
    expect(grants).toHaveLength(4) // owner seed + 3
    expect(grants.find((g) => g.principalKind === 'agent')?.perm).toBe('editor')
    expect(grants.find((g) => g.principalKind === 'peer')?.principalId).toBe('peer-7')
  })

  it('set: upsert overwrites the perm for an existing principal', async () => {
    await svc.set(ALICE, AGENT, { principalKind: 'user', principalId: BOB, perm: 'viewer' })
    await svc.set(ALICE, AGENT, { principalKind: 'user', principalId: BOB, perm: 'editor' })
    const grants = await svc.list(ALICE, AGENT)
    expect(grants.filter((g) => g.principalId === BOB)).toHaveLength(1)
    expect(grants.find((g) => g.principalId === BOB)?.perm).toBe('editor')
  })

  it('set: rejects a bad principalKind / perm → 400', async () => {
    await expect(
      svc.set(ALICE, AGENT, { principalKind: 'martian', principalId: 'x', perm: 'owner' }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      svc.set(ALICE, AGENT, { principalKind: 'user', principalId: BOB, perm: 'admin' }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      svc.set(ALICE, AGENT, { principalKind: 'user', principalId: '   ', perm: 'viewer' }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('set: a non-owner cannot grant → 404', async () => {
    await expect(
      svc.set(BOB, AGENT, { principalKind: 'user', principalId: 'user-carol', perm: 'viewer' }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('orphan guard: cannot downgrade the LAST owner away from owner', async () => {
    await expect(
      svc.set(ALICE, AGENT, { principalKind: 'user', principalId: ALICE, perm: 'editor' }),
    ).rejects.toMatchObject({ status: 400 })
    // Still an owner.
    expect(identity.hasResourceGrant('agent', AGENT, userPrincipal(ALICE), 'owner')).toBe(true)
  })

  it('orphan guard: downgrading one owner is fine when another remains', async () => {
    await svc.set(ALICE, AGENT, { principalKind: 'user', principalId: BOB, perm: 'owner' })
    // Now two owners — ALICE may step down to editor.
    const g = await svc.set(ALICE, AGENT, { principalKind: 'user', principalId: ALICE, perm: 'editor' })
    expect(g.perm).toBe('editor')
    expect(identity.hasResourceGrant('agent', AGENT, userPrincipal(BOB), 'owner')).toBe(true)
  })

  it('remove: a non-owner grant is removable', async () => {
    await svc.set(ALICE, AGENT, { principalKind: 'user', principalId: BOB, perm: 'viewer' })
    expect(await svc.remove(ALICE, AGENT, `user:${BOB}`)).toBe(true)
    expect((await svc.list(ALICE, AGENT)).map((g) => g.principalId)).toEqual([ALICE])
  })

  it('orphan guard: cannot remove the only owner', async () => {
    await expect(svc.remove(ALICE, AGENT, `user:${ALICE}`)).rejects.toMatchObject({ status: 400 })
    expect(identity.hasResourceGrant('agent', AGENT, userPrincipal(ALICE), 'owner')).toBe(true)
  })

  it('remove: a co-owner can be removed once another owner remains', async () => {
    await svc.set(ALICE, AGENT, { principalKind: 'user', principalId: BOB, perm: 'owner' })
    expect(await svc.remove(ALICE, AGENT, `user:${BOB}`)).toBe(true)
    expect(identity.hasResourceGrant('agent', AGENT, userPrincipal(ALICE), 'owner')).toBe(true)
  })

  it('remove: a malformed principal key → 400', async () => {
    await expect(svc.remove(ALICE, AGENT, 'not-a-key')).rejects.toMatchObject({ status: 400 })
  })

  it('remove: a non-owner caller → 404', async () => {
    await expect(svc.remove(BOB, AGENT, `user:${ALICE}`)).rejects.toMatchObject({ status: 404 })
  })

  it('set + remove write best-effort audit rows', async () => {
    await svc.set(ALICE, AGENT, { principalKind: 'user', principalId: BOB, perm: 'editor' })
    await svc.remove(ALICE, AGENT, `user:${BOB}`)
    const sets = identity.listAuditLog!({ action: 'resource_grant_set' })
    const revokes = identity.listAuditLog!({ action: 'resource_grant_revoke' })
    const s = sets.find((a) => (a.metadata as { principal?: string } | null)?.principal === `user:${BOB}`)!
    expect(s).toBeTruthy()
    expect(s.actorUserId).toBe(ALICE)
    expect((s.metadata as { resourceId?: string }).resourceId).toBe(AGENT)
    expect((s.metadata as { perm?: string }).perm).toBe('editor')
    expect(
      revokes.some((a) => (a.metadata as { principal?: string } | null)?.principal === `user:${BOB}`),
    ).toBe(true)
  })

  // Route B P1-M1b — sharing stays OWNER-only, but an editor/viewer who holds a
  // LOWER grant now over-reaches to 403 + a denial audit (was a misleading 404).
  // A stranger with no grant still gets 404 (anti-enumeration), never audited.
  // Neutralise the shared gate's 403/404 split (always 404) and the first
  // assertion reds; drop the denial audit and the audit assertion reds.
  it('over-reach: an editor cannot list/set/remove grants → 403 + denial audit', async () => {
    // bob holds 'editor' on alice's agent — he can edit it (M1a) but NOT re-share.
    identity.setResourceGrant({
      resourceKind: 'agent',
      resourceId: AGENT,
      principal: userPrincipal(BOB),
      perm: 'editor',
      grantedBy: ALICE,
    })

    await expect(svc.list(BOB, AGENT)).rejects.toMatchObject({ status: 403 })
    await expect(
      svc.set(BOB, AGENT, { principalKind: 'user', principalId: 'user-carol', perm: 'viewer' }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(svc.remove(BOB, AGENT, `user:${ALICE}`)).rejects.toMatchObject({ status: 403 })

    const denied = identity.listAuditLog!({ action: AUDIT_ACTIONS.RESOURCE_ACCESS_DENIED })
    expect(denied.length).toBeGreaterThanOrEqual(1)
    expect(denied[0]).toMatchObject({
      actorUserId: BOB,
      success: false,
      metadata: { resourceKind: 'agent', resourceId: AGENT, required: 'owner' },
    })
    // bob never became an owner — the over-reach changed nothing
    expect(identity.hasResourceGrant('agent', AGENT, userPrincipal(BOB), 'owner')).toBe(false)
  })

  it('no relationship → 404 (anti-enumeration) and NOT audited', async () => {
    const before = identity.listAuditLog!({ action: AUDIT_ACTIONS.RESOURCE_ACCESS_DENIED }).length
    await expect(svc.list('user-stranger', AGENT)).rejects.toMatchObject({ status: 404 })
    const after = identity.listAuditLog!({ action: AUDIT_ACTIONS.RESOURCE_ACCESS_DENIED }).length
    expect(after).toBe(before)
  })
})
