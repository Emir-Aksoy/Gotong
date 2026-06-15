/**
 * B-M3 — the OPERATOR sensitive executors (`HostStewardSensitiveExecutors`), the
 * second half of the double gate. This focuses on the EXECUTOR in isolation:
 *
 *   1. set_credential_ref resolves the secret from a host ENV VAR (never the
 *      action) and mints an ORG vault row — and NO plaintext ever crosses back
 *      out (the returned result / the action / the would-be transcript carry only
 *      the env-var NAME). This is the single most important Phase B invariant.
 *   2. revoke_credential is guarded to ORG llm_provider rows only — a member's BYO
 *      key or an unrelated id returns `removed:false` untouched.
 *   3. set_peer_policy maps only the steward's exposed fields onto `updatePeer`
 *      (undefined-preserve: an omitted field is left unchanged).
 *   4. set_security_quota maps `period` onto the real enum and lets the
 *      IdentityStore be the authoritative gate (an off-enum period / bad metric
 *      throws there, visibly).
 *   5. ★ Gate 2 (defence in depth): `performStewardAction` WITHOUT the `sensitive`
 *      dep — the member steward's exact deps — FAILS CLOSED on every sensitive
 *      kind. The member agent/workflow executors are never even reached.
 *
 * The full park→approve→execute round trip (broker + inbox two-step) is B-M4's
 * operator-steward-e2e; here we prove the executor + the double gate directly.
 */

import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
  type SetOrgQuotaInput,
  type SetQuotaInput,
  type UpdatePeerInput,
} from '@aipehub/identity'
import type { StewardAction } from '@aipehub/hub-steward'

import {
  HostStewardSensitiveExecutors,
  type StewardSensitiveIdentity,
} from '../src/steward-sensitive.js'
import {
  performStewardAction,
  type StewardAgentDirectory,
  type StewardWorkflowEditor,
} from '../src/hub-steward-service.js'

// A made-up env var name + secret used only in this file. `set_credential_ref`
// names the VAR; the secret lives only in the env channel, never in an action.
const ENV_NAME = 'AIPE_TEST_STEWARD_KEY'
const SECRET = 'sk-this-must-never-appear-in-any-steward-artifact'
const OP = 'op-user-1' // the operator who runs the sensitive write

describe('HostStewardSensitiveExecutors — real IdentityStore (vault unlocked)', () => {
  let tmp: string
  let identity: IdentityStore
  let exec: HostStewardSensitiveExecutors

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'aipe-steward-sensitive-'))
    identity = openIdentityStore({
      dbPath: join(tmp, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
    exec = new HostStewardSensitiveExecutors({ identity })
    process.env[ENV_NAME] = SECRET
  })

  afterEach(async () => {
    delete process.env[ENV_NAME]
    identity.close()
    await rm(tmp, { recursive: true, force: true })
  })

  it('set_credential_ref resolves the secret from the env var and mints an ORG vault row — no plaintext escapes', async () => {
    const action: StewardAction = {
      kind: 'set_credential_ref',
      provider: 'anthropic',
      envVarName: ENV_NAME,
      label: 'Site Anthropic key',
    }

    // Run through the SAME chokepoint apply uses (with the operator sensitive dep).
    const result = await performStewardAction(OP, action, {
      agents: throwingAgents(),
      workflowEditor: throwingEditor(),
      sensitive: exec,
    })

    expect(result.kind).toBe('set_credential_ref')
    if (result.kind !== 'set_credential_ref') throw new Error('unreachable')

    // The secret actually landed in the vault — readable with the master key.
    expect(identity.readVaultSecret(result.credentialId)).toBe(SECRET)

    // It's an ORG-scope llm_provider row (hub-wide, what OrgApiPool reads), not a
    // member's BYO key.
    const orgKeys = identity.listVaultEntries({ kind: 'llm_provider', ownerKind: 'org' })
    const row = orgKeys.find((e) => e.id === result.credentialId)
    expect(row).toBeDefined()
    expect(row?.ownerKind).toBe('org')
    expect(row?.ownerId ?? null).toBeNull()

    // ★ NO plaintext anywhere a human / log / inbox would see: not in the result,
    // not in the action, not in the stored row's NON-secret projection. Only the
    // env-var NAME is recorded.
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(JSON.stringify(result)).toContain(ENV_NAME)
    expect(JSON.stringify(action)).not.toContain(SECRET)
    expect(JSON.stringify(row)).not.toContain(SECRET)
    expect(JSON.stringify(row?.metadata ?? {})).toContain(ENV_NAME)
  })

  it('set_credential_ref fails visibly when the named env var is unset', async () => {
    delete process.env[ENV_NAME]
    await expect(
      exec.setCredentialRef(OP, { kind: 'set_credential_ref', provider: 'anthropic', envVarName: ENV_NAME } as never),
    ).rejects.toThrow(/empty or unset/)
  })

  it('revoke_credential removes an ORG key but leaves an unrelated id / a member BYO key untouched', async () => {
    // Mint an org key via the executor, then revoke it.
    const { credentialId } = await exec.setCredentialRef(OP, {
      kind: 'set_credential_ref',
      provider: 'anthropic',
      envVarName: ENV_NAME,
    } as never)
    expect((await exec.revokeCredential(OP, credentialId)).removed).toBe(true)

    // A random id → never touches anything.
    expect((await exec.revokeCredential(OP, 'cred_does_not_exist')).removed).toBe(false)

    // A MEMBER's BYO key (ownerKind='user') is NOT an org key → guard returns
    // false; the operator steward can never revoke a member's own credential.
    const userKey = identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'user',
      ownerId: 'member-9',
      secret: 'sk-member-byo',
    })
    expect((await exec.revokeCredential(OP, userKey.id)).removed).toBe(false)
    // Still alive + still secret-readable (untouched).
    expect(identity.readVaultSecret(userKey.id)).toBe('sk-member-byo')
  })

  it('set_peer_policy maps only the exposed fields onto updatePeer (undefined-preserve)', async () => {
    const reg = identity.addPeer({
      peerId: 'orgB',
      endpointUrl: 'wss://b.example/hub',
      peerToken: 'hello-secret-token',
    })
    // Baseline: defaults (all data classes, no quota, not shared).
    expect(identity.getPeer(reg.id)?.allowedDataClasses ?? null).toBeNull()

    await exec.setPeerPolicy(OP, {
      peerId: reg.id,
      allowedDataClasses: ['public'],
      shareSummary: true,
      // perLinkQuotaBudget intentionally omitted → must stay unchanged (null).
    })

    const after = identity.getPeer(reg.id)
    expect(after?.allowedDataClasses).toEqual(['public'])
    expect(after?.shareSummary).toBe(true)
    expect(after?.perLinkQuotaBudget ?? null).toBeNull() // omitted field preserved
  })

  it('set_security_quota (scope=hub) writes a HUB-WIDE quota (no user FK) and the store rejects an off-enum one', async () => {
    // `scope:'hub'` routes to setOrgQuota — a hub-wide cap with NO user FK (a
    // per-user setQuota would FK-fail since 'hub' is not a user). Maps 'day' →
    // 'daily' and lands a readable row.
    await exec.setSecurityQuota(OP, { scope: 'hub', metric: 'llm_tokens', period: 'day', limit: 1000 })
    const row = identity.getOrgQuota('llm_tokens', 'daily')
    expect(row?.quota).toBe(1000)

    // Off-enum period passes through normalize and the store's assertUsagePeriod
    // rejects it — fail-visible, not silently accepted.
    await expect(
      exec.setSecurityQuota(OP, { scope: 'hub', metric: 'llm_tokens', period: 'fortnight', limit: 5 }),
    ).rejects.toThrow()

    // The metric is free-form by design (llm_tokens / llm_cost_micros / custom),
    // so the store accepts any non-empty name — but an EMPTY metric is rejected by
    // assertUsageMetric, demonstrating the store stays the authoritative gate here too.
    await expect(
      exec.setSecurityQuota(OP, { scope: 'hub', metric: '', period: 'daily', limit: 5 }),
    ).rejects.toThrow()
  })
})

describe('HostStewardSensitiveExecutors — argument mapping (recording fake)', () => {
  // A recording fake satisfies the narrow StewardSensitiveIdentity duck-type — the
  // per-user quota has no read-back getter, so capture the exact setQuota args.
  function recordingIdentity() {
    const quotaCalls: SetQuotaInput[] = []
    const orgQuotaCalls: SetOrgQuotaInput[] = []
    const peerCalls: Array<{ id: string; input: UpdatePeerInput }> = []
    const fake: StewardSensitiveIdentity = {
      createVaultEntry: () => {
        throw new Error('not used in this test')
      },
      listVaultEntries: () => [],
      revokeVaultEntry: () => false,
      updatePeer: (id, input) => {
        peerCalls.push({ id, input })
        return undefined
      },
      setQuota: (input) => {
        quotaCalls.push(input)
        return undefined
      },
      setOrgQuota: (input) => {
        orgQuotaCalls.push(input)
        return undefined
      },
    }
    return { fake, quotaCalls, orgQuotaCalls, peerCalls }
  }

  it('setSecurityQuota maps a per-user scope→userId via setQuota, normalizes the period, and floors a fractional limit', async () => {
    const { fake, quotaCalls, orgQuotaCalls } = recordingIdentity()
    const exec = new HostStewardSensitiveExecutors({ identity: fake })

    await exec.setSecurityQuota(OP, { scope: 'member-7', metric: 'dispatch', period: 'month', limit: 99.7 })

    expect(orgQuotaCalls).toHaveLength(0) // a non-hub scope is per-user
    expect(quotaCalls).toHaveLength(1)
    expect(quotaCalls[0]).toEqual({
      userId: 'member-7', // scope → userId
      metric: 'dispatch',
      period: 'monthly', // 'month' normalized
      quota: 99, // 99.7 floored
    })
  })

  it('setSecurityQuota routes scope=hub to setOrgQuota (hub-wide, no user FK)', async () => {
    const { fake, quotaCalls, orgQuotaCalls } = recordingIdentity()
    const exec = new HostStewardSensitiveExecutors({ identity: fake })

    await exec.setSecurityQuota(OP, { scope: 'hub', metric: 'llm_cost_micros', period: 'day', limit: 5_000_000 })

    expect(quotaCalls).toHaveLength(0) // hub scope never goes to the per-user path
    expect(orgQuotaCalls).toHaveLength(1)
    expect(orgQuotaCalls[0]).toEqual({
      metric: 'llm_cost_micros',
      period: 'daily', // 'day' normalized
      quota: 5_000_000,
    })
  })

  it('setPeerPolicy only forwards the fields the action carried (no spurious keys)', async () => {
    const { fake, peerCalls } = recordingIdentity()
    const exec = new HostStewardSensitiveExecutors({ identity: fake })

    await exec.setPeerPolicy(OP, { peerId: 'peer-3', perLinkQuotaBudget: 500 })

    expect(peerCalls).toHaveLength(1)
    expect(peerCalls[0]?.id).toBe('peer-3')
    // Exactly one field — the one the action carried; nothing else touched.
    expect(Object.keys(peerCalls[0]?.input ?? {})).toEqual(['perLinkQuotaBudget'])
    expect(peerCalls[0]?.input.perLinkQuotaBudget).toBe(500)
  })
})

describe('★ double gate — performStewardAction WITHOUT the sensitive dep fails closed', () => {
  // The member steward's EXACT deps: agents + workflowEditor, NO `sensitive`. Every
  // sensitive kind must throw "requires the operator executor" — and the member
  // executors are never reached (they throw if touched, proving short-circuit).
  const SENSITIVE: StewardAction[] = [
    { kind: 'set_credential_ref', provider: 'anthropic', envVarName: ENV_NAME },
    { kind: 'revoke_credential', credentialId: 'cred_x' },
    { kind: 'set_peer_policy', peerId: 'peer_x', allowedDataClasses: ['public'] },
    { kind: 'set_security_quota', scope: 'hub', metric: 'llm_tokens', period: 'day', limit: 1 },
  ]

  for (const action of SENSITIVE) {
    it(`${action.kind} cannot run without the operator executor`, async () => {
      await expect(
        performStewardAction('member-1', action, {
          agents: throwingAgents(),
          workflowEditor: throwingEditor(),
          // no `sensitive` — the member steward never constructs it
        }),
      ).rejects.toThrow(/requires the operator executor/)
    })
  }
})

// --- minimal fakes: the member executors that must NEVER be reached on a
//     sensitive kind (they throw loudly if the gate failed to short-circuit). ---

function throwingAgents(): StewardAgentDirectory {
  const boom = (): never => {
    throw new Error('member agent executor reached on a sensitive kind — gate bug')
  }
  return {
    listOwned: boom,
    availableProviders: boom,
    create: boom,
    update: boom,
    remove: boom,
  }
}

function throwingEditor(): StewardWorkflowEditor {
  return {
    edit: () => {
      throw new Error('member workflow editor reached on a sensitive kind — gate bug')
    },
  }
}
