/**
 * setting-ops-boundary-e2e (setting-ops M6) — the load-bearing proof that the
 * unified `setting` console's tier boundary is REAL across all three surfaces,
 * run against the REAL stack (real ops-core, real `serveWeb`, the production
 * `handleImMessage` router, and a true bash backup→restore→verify→boot).
 *
 * M1 pinned the chokepoint with injected fakes; M4 pinned the web seam; M5 pinned
 * the IM seam — each hermetic, each on a stub engine. M6 wires the SAME ops-core
 * engine into all three faces at once and proves the boundary by physics, not by
 * a canned stub:
 *
 *   ① read tier is identical across CLI ops-core, web `POST /run`, and the IM
 *      command mode — one engine, one workspace, the same read snapshot;
 *   ② destructive-offline is CLI-only BY PHYSICS: `runOpsCommand('restore')` throws
 *      `OpsTierError` for EVERY caller surface (the shared runner never runs a
 *      destructive op — even the CLI adapter shells out directly instead), the web
 *      surface has no restore route (404) and refuses a hand-crafted `/run`
 *      {id:'restore'} (403), the IM console refuses it with a "run on the CLI" hint
 *      — and then the real restore genuinely runs through the bash/CLI path and the
 *      restored hub boots + the admin token still verifies. The destructive op
 *      works; it just only works where the hub is down (the offline CLI);
 *   ③ safe-mutate (`fix-dirs`) creates a missing dir, then no-ops (idempotent);
 *   ④ config-write lands + is audited on the CLI and the web (owner) surfaces, the
 *      IM console refuses it (config-write is never on IM), and a secret-name key is
 *      hard-refused before anything touches disk.
 *
 * Determinism: no network beyond loopback HTTP, no LLM, no clock assertions. The
 * destructive half needs `bash` + `tar` + `jq` (verify.sh needs jq); when any is
 * missing — or on Windows — the whole suite skips, exactly like the
 * backup-restore-smoke harness this extends. The bash scripts are the deliverable
 * under test (this file never edits them); the rest is real host/web/IM wiring.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Hub, Space, type Logger } from '@gotong/core'
import {
  AUDIT_ACTIONS,
  loadOrCreateMasterKey,
  openIdentityStore,
  type IdentityStore,
} from '@gotong/identity'
import type { ImAttachment, ImBridge, ImMessage, ImUser } from '@gotong/im-adapter'
import { serveWeb, type WebServerHandle } from '@gotong/web'

import {
  handleImMessage,
  makeIdentityImBindingResolver,
  type HostImConfig,
  type ImSettingOps,
} from '../src/im-bridge.js'
import {
  listOpsCommands,
  runOpsCommand,
  OpsError,
  OpsTierError,
  type OpsCaller,
  type OpsDeps,
} from '../src/ops-core.js'
import { createSettingOpsService, type SettingAuditSink } from '../src/setting-ops-service.js'

// --- bash/tar/jq skip gate (mirrors backup-restore-smoke) -------------------
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const scriptsDir = join(repoRoot, 'scripts', 'backup')
const BACKUP = join(scriptsDir, 'backup.sh')
const RESTORE = join(scriptsDir, 'restore.sh')

function hasCmd(name: string): boolean {
  try {
    execFileSync('bash', ['-lc', `command -v ${name}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const TOOLS_OK = process.platform !== 'win32' && hasCmd('bash') && hasCmd('tar') && hasCmd('jq')
const maybe = TOOLS_OK ? describe : describe.skip
if (!TOOLS_OK) {
  // eslint-disable-next-line no-console
  console.warn('[skip] setting-ops-boundary-e2e: needs bash + tar + jq (POSIX only)')
}

const silentLogger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }

// --- hermetic in-memory IM bridge (same ImBridge contract the real bridges use)
class FakeBridge implements ImBridge {
  readonly platform = 'telegram'
  readonly outbound: Array<{ to: ImUser; text: string }> = []
  private listener: ((msg: ImMessage) => void | Promise<void>) | null = null
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(to: ImUser, text: string, _options?: { attachments?: ImAttachment[]; chatId?: string }): Promise<void> {
    this.outbound.push({ to, text })
  }
  onMessage(listener: (msg: ImMessage) => void | Promise<void>): () => void {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }
  async inject(msg: ImMessage): Promise<void> {
    if (this.listener) await this.listener(msg)
  }
}

const ALICE: ImUser = { platform: 'telegram', platformUserId: '7001', displayName: 'Alice' }
const BOB: ImUser = { platform: 'telegram', platformUserId: '7002', displayName: 'Bob' }
function msgFrom(user: ImUser, text: string): ImMessage {
  return { from: user, text, chatId: `private:${user.platformUserId}`, ts: 1_700_000_000_000 }
}
function last(bridge: FakeBridge): string {
  const out = bridge.outbound.at(-1)
  if (!out) throw new Error('no outbound message was sent')
  return out.text
}

maybe('setting-ops M6 — physical tier boundary across CLI / web / IM (real stack)', () => {
  let workRoot: string
  let spaceDir: string
  let backupDir: string
  let restoreDir: string
  let cfgEnv: string // CLI config-set target (isolated from the seed)
  let cfgPricing: string // web config-price target (isolated from the seed)
  let adminToken: string

  // The shared deterministic env the three faces report on (empty = no GOTONG_*
  // leaking from process.env, so the read snapshot is identical everywhere).
  const opsEnv: Record<string, string | undefined> = {}
  const cliCaller: OpsCaller = { surface: 'cli', allowConfigWrite: true }
  const imCaller: OpsCaller = { surface: 'im', allowConfigWrite: false }

  // Seed-space online handles (the running hub the web + ops-core read).
  let seedHub: Hub
  let seedWeb: WebServerHandle
  const webAuditRows: Array<{ action: string; metadata: Record<string, unknown> | null }> = []
  const cliAuditRows: Array<Record<string, unknown>> = []

  // IM handles.
  let imIdentity: IdentityStore
  let bridge: FakeBridge
  let imConfig: HostImConfig
  const operators = new Set<string>()

  // Restored-space handles (booted in the ②-physical test, torn down in afterAll).
  let restoredHub: Hub | undefined
  let restoredWeb: WebServerHandle | undefined

  beforeAll(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'gotong-setting-m6-'))
    spaceDir = join(workRoot, 'space')
    backupDir = join(workRoot, 'backups')
    restoreDir = join(workRoot, 'restored')
    const cfgDir = join(workRoot, 'cfg')
    mkdirSync(cfgDir, { recursive: true })
    cfgEnv = join(cfgDir, 'gotong.env')
    cfgPricing = join(cfgDir, 'pricing.json')

    // --- seed a realistic mini-space (mirrors backup-restore-smoke) ----------
    const init = await Space.init(spaceDir, { name: 'setting-m6', adminDisplayName: 'M6Admin' })
    if (!init.adminToken) throw new Error('expected admin token from Space.init')
    adminToken = init.adminToken
    await init.space.setProviderApiKey('anthropic', 'sk-ant-fake-m6-key')
    await init.space.upsertAgent({ id: 'writer', allowedCapabilities: ['draft'] })
    await init.space.upsertAgent({ id: 'reviewer', allowedCapabilities: ['review'] })

    // v4 identity layer so the backup/restore round-trip is honest (the
    // ciphertext travels, its KEK does not — same invariant as the smoke test).
    const masterKey = loadOrCreateMasterKey(join(spaceDir, 'identity-master.key'))
    const idStore = openIdentityStore({ dbPath: join(spaceDir, 'identity.sqlite'), masterKey })
    idStore.createVaultEntry({
      kind: 'oidc_client_secret',
      ownerKind: 'org',
      secret: 'sk-fake-vault-secret-not-a-real-credential',
      label: 'm6',
    })
    idStore.close()

    // --- the WEB face: real serveWeb + the real createSettingOpsService ------
    // No identity is passed to serveWeb, so the v3 admin-token holder resolves to
    // the owner (isOwner: true) — config-write is permitted on the web surface.
    seedHub = new Hub({ space: init.space })
    await seedHub.start()
    const webAudit: SettingAuditSink = {
      writeAuditLog(input) {
        webAuditRows.push({ action: input.action, metadata: input.metadata ?? null })
        return undefined
      },
    }
    const settingOps = createSettingOpsService({
      spaceDir,
      env: opsEnv,
      envFilePath: cfgEnv,
      pricingPath: cfgPricing,
      audit: webAudit,
    })
    seedWeb = await serveWeb(seedHub, { host: '127.0.0.1', port: 0, settingOps })

    // --- the IM face: production handleImMessage + real ops-core through it --
    imIdentity = openIdentityStore({ dbPath: ':memory:' })
    const aliceId = imIdentity.createUser({ email: 'alice@example.com', displayName: 'Alice' }).id
    imIdentity.createUser({ email: 'bob@example.com', displayName: 'Bob' })
    operators.add(aliceId) // Alice is an operator; Bob is a bound ordinary member.

    const imOps: ImSettingOps = {
      list: () => listOpsCommands(imCaller),
      run: async (id, args) => {
        const r = await runOpsCommand(id, args, imCaller, { spaceDir, env: opsEnv })
        return { lines: r.lines }
      },
    }
    bridge = new FakeBridge()
    imConfig = {
      hub: seedHub,
      resolver: makeIdentityImBindingResolver(imIdentity),
      freeTextCapability: 'chat',
      onUnbind: async (platform, platformUserId) => {
        const n = imIdentity.removeImBinding(platform, platformUserId)
        return { removed: n > 0 }
      },
      log: silentLogger,
      setting: {
        isOperator: (userId) => operators.has(userId),
        mode: new Map<string, boolean>(),
        ops: imOps,
      },
    }
    bridge.onMessage((m) => handleImMessage(bridge, m, imConfig))

    // Bind Alice through the real `/bind` router path.
    await bridge.inject(msgFrom(ALICE, `/bind ${imIdentity.issueImBindingCode({ userId: aliceId }).code}`))
    bridge.outbound.length = 0
  }, 60_000)

  afterAll(async () => {
    if (restoredWeb) await restoredWeb.close()
    if (restoredHub) await restoredHub.stop()
    if (seedWeb) await seedWeb.close()
    if (seedHub) await seedHub.stop()
    if (imIdentity) imIdentity.close()
    if (workRoot) await rm(workRoot, { recursive: true, force: true })
  })

  const authJson = () => ({
    authorization: `Bearer ${adminToken}`,
    'content-type': 'application/json',
  })
  const SETTING = '/api/admin/setting'

  // ① ─────────────────────────────────────────────────────────────────────────
  it('① read tier is identical across CLI ops-core, web /run, and the IM console', async () => {
    // CLI / ops-core direct.
    const cli = await runOpsCommand('status', [], cliCaller, { spaceDir, env: opsEnv })
    expect(cli.tier).toBe('read')
    expect(cli.lines.join('\n')).toContain(spaceDir)

    // Web `POST /run {id:'status'}` — same engine, same workspace.
    const r = await fetch(`${seedWeb.url}${SETTING}/run`, {
      method: 'POST',
      headers: authJson(),
      body: JSON.stringify({ id: 'status' }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { result: { tier: string; lines: string[] } }
    expect(j.result.tier).toBe('read')
    expect(j.result.lines.join('\n')).toContain(spaceDir)

    // IM command mode — the same read snapshot reaches the operator's chat.
    await bridge.inject(msgFrom(ALICE, '/setting'))
    await bridge.inject(msgFrom(ALICE, 'status'))
    const imText = last(bridge)
    expect(imText).toContain(spaceDir)
    expect(imText).toContain('defns')
    await bridge.inject(msgFrom(ALICE, 'exit')) // leave the console clean for later tests
  })

  // ② refusals ─────────────────────────────────────────────────────────────────
  it('② destructive-offline is refused on every online surface (ops-core throws, web 403 + no route, IM hint)', async () => {
    // The shared runner NEVER runs a destructive op — for ANY caller surface,
    // including the CLI (whose adapter invokes the real scripts directly instead).
    for (const surface of ['cli', 'web', 'im'] as const) {
      await expect(
        runOpsCommand('restore', ['x', 'y'], { surface, allowConfigWrite: surface !== 'im' }, { spaceDir, env: opsEnv }),
      ).rejects.toBeInstanceOf(OpsTierError)
    }
    // ...and it carries the stable chokepoint code.
    await runOpsCommand('restore', [], cliCaller, { spaceDir, env: opsEnv }).then(
      () => {
        throw new Error('expected restore to throw')
      },
      (e: unknown) => {
        expect(e).toBeInstanceOf(OpsTierError)
        expect((e as OpsTierError).code).toBe('destructive_offline_cli_only')
      },
    )

    // Web: a hand-crafted `/run {id:'restore'}` is refused by the host chokepoint.
    const run = await fetch(`${seedWeb.url}${SETTING}/run`, {
      method: 'POST',
      headers: authJson(),
      body: JSON.stringify({ id: 'restore' }),
    })
    expect(run.status).toBe(403)
    expect(((await run.json()) as { error: string }).error).toBe('destructive_offline_cli_only')

    // ...and there is NO dedicated destructive route — a fabricated one is 404.
    const fab = await fetch(`${seedWeb.url}${SETTING}/restore`, {
      method: 'POST',
      headers: authJson(),
      body: JSON.stringify({ file: 'x', target: 'y' }),
    })
    expect(fab.status).toBe(404)

    // IM: in command mode, `restore` is refused with a "run on the CLI" hint.
    await bridge.inject(msgFrom(ALICE, '/setting'))
    await bridge.inject(msgFrom(ALICE, 'restore'))
    expect(last(bridge)).toContain('✗')
    expect(last(bridge)).toMatch(/CLI/i)
    await bridge.inject(msgFrom(ALICE, 'exit'))
  })

  // ② physical ─────────────────────────────────────────────────────────────────
  it('②-physical: the real restore runs ONLY via the bash/CLI path, and the restored hub boots', async () => {
    // The destructive op the three online faces just refused DOES work — through
    // the offline CLI/shell path, exactly where the hub is down. backup.sh →
    // restore.sh (runs verify.sh internally) → boot the restored space.
    execFileSync('bash', [BACKUP, spaceDir, backupDir], { encoding: 'utf8' })
    const tarball = join(backupDir, readdirSync(backupDir).find((f) => f.endsWith('.tar.gz'))!)
    const out = execFileSync('bash', [RESTORE, tarball, restoreDir], { encoding: 'utf8' })
    expect(out).toContain('verify.sh')
    expect(out).toMatch(/0 errors/)

    const space = await Space.open(restoreDir)
    restoredHub = new Hub({ space })
    await restoredHub.start()
    restoredWeb = await serveWeb(restoredHub, { host: '127.0.0.1', port: 0 })

    const health = await fetch(`${restoredWeb.url}/healthz`)
    expect(health.status).toBe(200)

    // The v3 admin token kept from Space.init still authenticates against the
    // restored space, and the seeded agents came through the round-trip intact.
    const res = await fetch(`${restoredWeb.url}/api/admin/agents`, {
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { agents: Array<{ id: string }> }
    expect(body.agents.map((a) => a.id).sort()).toEqual(['reviewer', 'writer'])
  }, 60_000)

  // ③ ─────────────────────────────────────────────────────────────────────────
  it('③ safe-mutate fix-dirs creates a missing dir, then no-ops (idempotent)', async () => {
    // A fresh space dir that exists, but whose workflows/definitions does NOT.
    const freshSpace = join(workRoot, 'fresh')
    mkdirSync(freshSpace, { recursive: true })
    const deps: OpsDeps = { spaceDir: freshSpace, env: {} }

    const run1 = await runOpsCommand('fix-dirs', [], cliCaller, deps)
    expect(run1.tier).toBe('safe-mutate')
    const out1 = run1.data!.outcomes as Array<{ outcome: string }>
    expect(out1.some((o) => o.outcome === 'created')).toBe(true)
    expect(existsSync(join(freshSpace, 'workflows', 'definitions'))).toBe(true)

    // Second run: everything already exists → idempotent no-op.
    const run2 = await runOpsCommand('fix-dirs', [], cliCaller, deps)
    const out2 = run2.data!.outcomes as Array<{ outcome: string }>
    expect(out2.every((o) => o.outcome === 'exists')).toBe(true)
  })

  // ④ ─────────────────────────────────────────────────────────────────────────
  it('④ config-write lands + audits on CLI and web; IM refuses; secret-name refused', async () => {
    // CLI: a legal owner write of a whitelisted non-secret knob lands + audits.
    const set = await runOpsCommand('config-set', ['GOTONG_MODE', 'team'], cliCaller, {
      spaceDir,
      env: opsEnv,
      envFilePath: cfgEnv,
      audit: (m) => cliAuditRows.push(m),
    })
    expect(set.tier).toBe('config-write')
    expect(readFileSync(cfgEnv, 'utf8')).toContain('GOTONG_MODE=team')
    expect(cliAuditRows.some((m) => m.key === 'GOTONG_MODE' && m.value === 'team')).toBe(true)

    // Web (owner): config-price lands in pricing.json + audits as setting_config_write.
    webAuditRows.length = 0
    const price = await fetch(`${seedWeb.url}${SETTING}/run`, {
      method: 'POST',
      headers: authJson(),
      body: JSON.stringify({ id: 'config-price', args: ['acme-model-1', '3', '15'] }),
    })
    expect(price.status).toBe(200)
    expect(((await price.json()) as { result: { tier: string } }).result.tier).toBe('config-write')
    expect(readFileSync(cfgPricing, 'utf8')).toContain('acme-model-1')
    expect(webAuditRows.some((r) => r.action === AUDIT_ACTIONS.SETTING_CONFIG_WRITE)).toBe(true)

    // IM: config-write is never on the IM surface — refused with an owner hint.
    await bridge.inject(msgFrom(ALICE, '/setting'))
    await bridge.inject(msgFrom(ALICE, 'config-set GOTONG_WEB_PORT 8080'))
    expect(last(bridge)).toContain('✗')
    expect(last(bridge)).toMatch(/owner/i)
    await bridge.inject(msgFrom(ALICE, 'exit'))

    // A secret-name key is hard-refused BEFORE any write — nothing lands.
    await expect(
      runOpsCommand('config-set', ['ANTHROPIC_API_KEY', 'sk-should-never-land'], cliCaller, {
        spaceDir,
        env: opsEnv,
        envFilePath: cfgEnv,
        audit: (m) => cliAuditRows.push(m),
      }),
    ).rejects.toMatchObject({ code: 'secret_key_refused' })
    const envText = readFileSync(cfgEnv, 'utf8')
    expect(envText).not.toContain('ANTHROPIC_API_KEY')
    expect(envText).not.toContain('sk-should-never-land')

    // The refusal is a typed OpsError (belt-and-suspenders on the .code shape).
    await runOpsCommand('config-set', ['SOME_SECRET', 'x'], cliCaller, {
      spaceDir,
      env: opsEnv,
      envFilePath: cfgEnv,
    }).then(
      () => {
        throw new Error('expected secret-name refusal')
      },
      (e: unknown) => expect(e).toBeInstanceOf(OpsError),
    )
  })
})
