/**
 * recovery-drill.test.ts — Route B P0-M7-M3.
 *
 * `scripts/backup/drill.sh` is the disaster-recovery drill institutionalised:
 * the manual "back up → restore → verify → eyeball it" procedure turned into
 * one cron-able command that exits non-zero when the backup does NOT cleanly
 * restore. This test proves the drill actually catches a bad backup — a drill
 * that always passes is worse than none (it manufactures false confidence).
 *
 * The drill.sh script IS the deliverable under test — this never edits it.
 *
 *   1. POSITIVE: a realistic seeded space drills green — exit 0, "DRILL PASSED",
 *      and the structural-invariant checks actually ran (their ✓ lines print).
 *   2. NEGATIVE: a space with a torn transcript line drills RED — exit non-zero,
 *      never "DRILL PASSED". A torn transcript is caught only at the verify
 *      stage (no invariant inspects the transcript), so this isolates the
 *      drill's "propagate a restore/verify failure" guard: neutralise drill.sh's
 *      `exit 4` and this space would sail through the invariants to a false PASS.
 *
 * Determinism: no network, no LLM, no clock. Deps are bash + tar + jq (the same
 * pure-shell toolkit the scripts use); when any is missing — or on Windows —
 * the suite skips instead of false-failing, exactly like backup-restore-smoke.
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Space } from '@aipehub/core'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const DRILL = join(repoRoot, 'scripts', 'backup', 'drill.sh')

function hasCmd(name: string): boolean {
  try {
    execFileSync('bash', ['-lc', `command -v ${name}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const TOOLS_OK =
  process.platform !== 'win32' && hasCmd('bash') && hasCmd('tar') && hasCmd('jq')

const maybe = TOOLS_OK ? describe : describe.skip
if (!TOOLS_OK) {
  // eslint-disable-next-line no-console
  console.warn('[skip] recovery-drill: needs bash + tar + jq (POSIX only)')
}

/** Run drill.sh, returning its exit code + combined stdout (never throws). */
function runDrill(spaceDir: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [DRILL, spaceDir], { encoding: 'utf8' })
    return { code: 0, out }
  } catch (err: any) {
    // execFileSync throws on non-zero exit; the status + captured stdout ride
    // on the error object.
    return { code: typeof err.status === 'number' ? err.status : 1, out: String(err.stdout ?? '') }
  }
}

/** Seed a realistic mini-space (mirrors drill-init.example.mjs). */
async function seedSpace(dir: string): Promise<void> {
  const init = await Space.init(dir, { name: 'dr-drill', adminDisplayName: 'DrillAdmin' })
  await init.space.setProviderApiKey('anthropic', 'sk-ant-fakedrillkey')
  await init.space.upsertAgent({ id: 'writer', allowedCapabilities: ['draft'] })
  await init.space.upsertAgent({ id: 'reviewer', allowedCapabilities: ['review'] })
}

maybe('Route B P0-M7-M3 — recovery drill catches a bad backup', () => {
  let workRoot: string
  let goodDir: string
  let tornDir: string

  beforeAll(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'aipe-drill-'))
    goodDir = join(workRoot, 'good')
    tornDir = join(workRoot, 'torn')
    await seedSpace(goodDir)
    await seedSpace(tornDir)
    // Corrupt ONLY the torn copy: a valid event line followed by a truncated
    // one — the classic "host died mid-append" shape verify.sh must catch.
    appendFileSync(
      join(tornDir, 'transcript.jsonl'),
      '{"seq":1,"kind":"task_dispatched"}\n{ "seq":2, "kind":"tas',
      'utf8',
    )
  }, 60_000)

  afterAll(async () => {
    if (workRoot) await rm(workRoot, { recursive: true, force: true })
  })

  it('a clean space drills green (exit 0, invariants ran, DRILL PASSED)', () => {
    const { code, out } = runDrill(goodDir)
    expect(code).toBe(0)
    expect(out).toContain('DRILL PASSED')
    // The structural-invariant stage actually executed — not just verify.
    expect(out).toContain('admins preserved')
    expect(out).toContain('encrypted secrets carried over')
    // backup.sh excludes BOTH master keys; drill.sh asserts each independently
    // (v3 runtime/secret.key + v4 identity-master.key), so a v4 host proves both.
    expect(out).toContain('v3 master key (runtime/secret.key) correctly absent')
    expect(out).toContain('v4 master key (identity-master.key) correctly absent')
  })

  it('a torn-transcript space drills RED (non-zero exit, never PASSED)', () => {
    const { code, out } = runDrill(tornDir)
    // The backup faithfully carries the torn transcript; verify.sh flags it,
    // restore.sh exits non-zero, and drill.sh must propagate that as a failure.
    expect(code).not.toBe(0)
    expect(out).not.toContain('DRILL PASSED')
  })
})
