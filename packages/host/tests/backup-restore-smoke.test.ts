/**
 * backup-restore-smoke.test.ts — Phase 19 P3-M2.
 *
 * The disaster-recovery runbook in `docs/OPERATIONS.md` as an executable
 * test. It drives the real `scripts/backup/*.sh` end-to-end and proves the
 * chain an operator would actually run after losing a box:
 *
 *   seed a realistic space   →  backup.sh   →  aipehub-<label>-<ts>.tar.gz
 *   tar.gz  →  restore.sh (which runs verify.sh internally)  →  restored dir
 *   boot the RESTORED space  →  HTTP smoke (admin token + agents survived)
 *
 * The bash scripts ARE the deliverable under test — this test never edits
 * them. If a future change breaks the round-trip (a bad tar flag, a verify
 * check that rejects a valid space, a forgotten exclude) this goes red.
 *
 * Two invariants worth proving on the restored copy:
 *   1. The ciphertext travels but its keys do NOT. `secrets.enc.json` (v3)
 *      and `identity.sqlite`'s vault (v4) both ride along in the archive,
 *      while their master keys — `runtime/secret.key` and
 *      `identity-master.key` — are deliberately excluded. A backup that
 *      bundled either key next to the data it unlocks would defeat the
 *      at-rest encryption for that copy (the L5 DR-drill finding). The host
 *      lazily mints a fresh v3 key on boot; the operator restores the v4
 *      KEK separately. This is why the seed below creates a real identity
 *      layer — a v3-only seed never exercises the `identity-master.key`
 *      exclusion, so the assertion would be a no-op false-green.
 *   2. The v3 admin token still verifies — `admins.json` stores only a hash,
 *      so the token the operator kept from `Space.init` keeps working.
 *
 * Determinism: no network, no LLM, no clock assertions. External deps are
 * just `bash` + `tar` + `jq` (verify.sh needs jq). When any is missing — or
 * on Windows, which has no bash — the test skips instead of false-failing;
 * the round-trip logic is plain shell that CI exercises on Linux/macOS.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Hub, Space } from '@aipehub/core'
import { loadOrCreateMasterKey, openIdentityStore } from '@aipehub/identity'
import { serveWeb, type WebServerHandle } from '@aipehub/web'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const scriptsDir = join(repoRoot, 'scripts', 'backup')
const BACKUP = join(scriptsDir, 'backup.sh')
const RESTORE = join(scriptsDir, 'restore.sh')

/** Is a command resolvable on PATH? Used to skip when bash/tar/jq are absent. */
function hasCmd(name: string): boolean {
  try {
    execFileSync('bash', ['-lc', `command -v ${name}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// The whole suite needs a POSIX shell + tar + jq. Probe once; on Windows the
// very first `bash` invocation throws, so `hasCmd` returns false and we skip.
const TOOLS_OK =
  process.platform !== 'win32' && hasCmd('bash') && hasCmd('tar') && hasCmd('jq')

const maybe = TOOLS_OK ? describe : describe.skip

if (!TOOLS_OK) {
  // eslint-disable-next-line no-console
  console.warn('[skip] backup-restore-smoke: needs bash + tar + jq (POSIX only)')
}

maybe('Phase 19 P3-M2 — backup → restore → verify → boot round-trip', () => {
  let workRoot: string
  let spaceDir: string
  let backupDir: string
  let restoreDir: string
  let adminToken: string

  // Boot handles for the restored space (torn down in afterAll).
  let hub: Hub | undefined
  let web: WebServerHandle | undefined

  beforeAll(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'aipe-dr-'))
    spaceDir = join(workRoot, 'space')
    backupDir = join(workRoot, 'backups')
    restoreDir = join(workRoot, 'restored')

    // --- seed a realistic mini-space (mirrors drill-init.example.mjs) ------
    // Space.init writes space.json + admins.json; the agent/worker/secret
    // writes flesh it out and — critically — create runtime/secret.key
    // lazily on the first secret write, exactly like a live deployment.
    const init = await Space.init(spaceDir, {
      name: 'dr-drill',
      adminDisplayName: 'DrillAdmin',
    })
    if (!init.adminToken) throw new Error('expected admin token from Space.init')
    adminToken = init.adminToken
    await init.space.setProviderApiKey('anthropic', 'sk-ant-fakedrillkey')
    await init.space.upsertAgent({ id: 'writer', allowedCapabilities: ['draft'] })
    await init.space.upsertAgent({ id: 'reviewer', allowedCapabilities: ['review'] })
    await init.space.createWorker('alice', ['draft', 'review'])

    // --- seed the v4 identity layer on top (the part the old seed lacked) --
    // Space.init produces a pure v3 space (no identity.sqlite / no KEK), so
    // the original `not.toContain('secret.key')` never touched the v4 vault
    // key. Stand up a real identity DB + a vault entry so the archive has the
    // two things the exclusion is supposed to keep apart: the encrypted vault
    // (identity.sqlite) and the key that unlocks it (identity-master.key).
    const masterKeyPath = join(spaceDir, 'identity-master.key')
    const identityDbPath = join(spaceDir, 'identity.sqlite')
    const masterKey = loadOrCreateMasterKey(masterKeyPath) // mints a 0600 KEK file
    const idStore = openIdentityStore({ dbPath: identityDbPath, masterKey })
    idStore.createVaultEntry({
      kind: 'oidc_client_secret',
      ownerKind: 'org',
      secret: 'sk-fake-vault-secret-not-a-real-credential',
      label: 'dr-smoke',
    })
    idStore.close()

    // Sanity: the live space has BOTH master keys the backup must exclude,
    // and both ciphertext stores that must travel.
    expect(existsSync(join(spaceDir, 'runtime', 'secret.key'))).toBe(true)
    expect(existsSync(join(spaceDir, 'secrets.enc.json'))).toBe(true)
    expect(existsSync(identityDbPath)).toBe(true)
    expect(existsSync(masterKeyPath)).toBe(true)
  }, 60_000)

  afterAll(async () => {
    if (web) await web.close()
    if (hub) await hub.stop()
    if (workRoot) await rm(workRoot, { recursive: true, force: true })
  })

  it('backup.sh packages the space, excluding the secret key', () => {
    execFileSync('bash', [BACKUP, spaceDir, backupDir], { encoding: 'utf8' })
    const tarballs = readdirSync(backupDir).filter(
      (f) => f.startsWith('aipehub-') && f.endsWith('.tar.gz'),
    )
    expect(tarballs).toHaveLength(1)

    // The archive must NOT carry the master key (else a leaked backup =
    // game over). `tar -tzf` lists members without extracting.
    const tarball = join(backupDir, tarballs[0]!)
    const listing = execFileSync('bash', ['-lc', `tar -tzf "${tarball}"`], {
      encoding: 'utf8',
    })
    expect(listing).toContain('space.json')
    expect(listing).toContain('secrets.enc.json')
    expect(listing).not.toContain('secret.key')
    // v4: the encrypted vault DB travels, but its KEK must NOT. A leaked
    // backup carrying identity-master.key next to identity.sqlite would
    // defeat the vault encryption — the L5 DR-drill finding this guards.
    expect(listing).toContain('identity.sqlite')
    expect(listing).not.toContain('identity-master.key')
  })

  it('restore.sh extracts + runs verify.sh, landing a structurally sound space', () => {
    const tarball = join(
      backupDir,
      readdirSync(backupDir).find((f) => f.endsWith('.tar.gz'))!,
    )
    // restore.sh runs verify.sh internally and exits non-zero if it fails,
    // so a clean exit already means verify passed. We still assert verify's
    // success marker is in the output to prove the step actually ran.
    const out = execFileSync('bash', [RESTORE, tarball, restoreDir], {
      encoding: 'utf8',
    })
    expect(out).toContain('verify.sh')
    expect(out).toMatch(/0 errors/)

    // Structural invariants of the restored copy.
    expect(existsSync(join(restoreDir, 'space.json'))).toBe(true)
    expect(existsSync(join(restoreDir, 'admins.json'))).toBe(true)
    expect(existsSync(join(restoreDir, 'agents.json'))).toBe(true)
    // Encrypted secrets travel; the key to decrypt them deliberately does not.
    expect(existsSync(join(restoreDir, 'secrets.enc.json'))).toBe(true)
    expect(existsSync(join(restoreDir, 'runtime', 'secret.key'))).toBe(false)
    // v4 vault: the DB travels; its KEK does not (mirrors the secret.key rule).
    expect(existsSync(join(restoreDir, 'identity.sqlite'))).toBe(true)
    expect(existsSync(join(restoreDir, 'identity-master.key'))).toBe(false)
  })

  it('the restored space boots and serves — admin token + agents survived', async () => {
    // Open the RESTORED dir (not the seed). The host mints a fresh
    // secret.key lazily; nothing at this boot path touches the old
    // encrypted provider key, so the absent key is a non-issue.
    const space = await Space.open(restoreDir)
    hub = new Hub({ space })
    await hub.start()
    web = await serveWeb(hub, { host: '127.0.0.1', port: 0 })

    // Liveness.
    const health = await fetch(`${web.url}/healthz`)
    expect(health.status).toBe(200)
    expect(await health.text()).toBe('ok')

    // The v3 admin token kept from Space.init still authenticates against
    // the restored admins.json (hash match), and the two seeded agents
    // came through the round-trip intact.
    const res = await fetch(`${web.url}/api/admin/agents`, {
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { agents: Array<{ id: string }> }
    const ids = body.agents.map((a) => a.id).sort()
    expect(ids).toEqual(['reviewer', 'writer'])
  }, 60_000)
})
