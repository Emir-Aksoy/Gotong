/**
 * `aipehub setting` tests — the deterministic ops console CLI face.
 *
 * Like `start` / `check`, `setting` never imports `@aipehub/host` at build time;
 * it resolves the host lazily and drives its non-booting `./ops` subpath. So both
 * the host-present and host-absent paths are driven through INJECTED seams
 * (`resolveHost` / `importOps` / `runProcess` / `confirm` / `io`), keeping the
 * suite hermetic — it never touches a real workspace, the host package, a shell,
 * or readline.
 *
 * The load-bearing assertions:
 *   - online commands funnel through the shared `runOpsCommand` (args verbatim);
 *   - the DESTRUCTIVE trio uses a SEPARATE adapter and runs NOTHING when the
 *     operator declines confirmation — the tier boundary is observable here;
 *   - cold-start's pre-flight gate (doctor + check) decides whether it boots.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  setting,
  runSettingShell,
  parseSettingCommand,
} from '../src/commands/setting.js'
import { runCli } from '../src/main.js'
import type { ReplIo } from '../src/repl/loop.js'

// ── tiny fakes ───────────────────────────────────────────────────────────────

/** A fake `@aipehub/host/ops` module whose `runOpsCommand` is a spy. */
function fakeOps(
  runImpl: (...a: unknown[]) => Promise<{ lines: string[] }> = async () => ({ lines: ['ok'] }),
) {
  const runOpsCommand = vi.fn(runImpl)
  const listOpsCommands = vi.fn(() => [
    { id: 'status', tier: 'read', title: 'Status', summary: '', runnableHere: true },
    { id: 'fix-dirs', tier: 'safe-mutate', title: 'Fix dirs', summary: '', runnableHere: true },
    { id: 'restore', tier: 'destructive-offline', title: 'Restore', summary: '', whereToRun: 'cli', runnableHere: true },
  ])
  return { module: { runOpsCommand, listOpsCommands }, runOpsCommand, listOpsCommands }
}

/** Scripted ReplIo: returns queued lines, then null (EOF). Captures writes. */
function scriptedIo(lines: string[]): { io: ReplIo; writes: string[] } {
  const writes: string[] = []
  let i = 0
  const io: ReplIo = {
    async read(): Promise<string | null> {
      return i < lines.length ? lines[i++]! : null
    },
    write(chunk: string): void {
      writes.push(chunk)
    },
    close(): void {},
  }
  return { io, writes }
}

// A realistic resolved `.` entry so host-root derivation is assertable.
const HOST_ENTRY = 'file:///opt/app/node_modules/@aipehub/host/dist/index.js'
const HOST_ROOT = '/opt/app/node_modules/@aipehub/host'

// ═════════════════════════════════════════════════════════════════════════════
// dispatch wiring
// ═════════════════════════════════════════════════════════════════════════════

describe('runCli setting wiring', () => {
  it('routes `setting` through the dispatcher (not "unknown command")', async () => {
    // Under Vitest `import.meta.resolve` is unavailable, so the real
    // `resolveModule('@aipehub/host')` returns null → host-absent branch → exit
    // 1 with the install hint. The point of THIS test is wiring: the dispatcher
    // reaches `setting` (returns 1), not the default arm (returns 2).
    const errs: string[] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation((l: unknown) => {
      errs.push(String(l))
    })
    const code = await runCli(['setting', 'status'])
    errSpy.mockRestore()

    expect(code).toBe(1)
    expect(errs.join('\n')).toContain('@aipehub/host is not installed')
  })

  it('`help setting` documents the command', () => {
    const writes: string[] = []
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    runCli(['help', 'setting'])
    out.mockRestore()
    const text = writes.join('')
    expect(text).toContain('aipehub setting')
    expect(text).toContain('cold-start')
    expect(text).toContain('CLI ONLY')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// host absent
// ═════════════════════════════════════════════════════════════════════════════

describe('setting — host absent', () => {
  it('prints the install hint and exits 1 without importing ops', async () => {
    const importOps = vi.fn(async () => fakeOps().module)
    const err: string[] = []
    const code = await setting(['status'], {
      resolveHost: () => null,
      importOps,
      err: (l) => err.push(l),
    })
    expect(code).toBe(1)
    expect(importOps).not.toHaveBeenCalled()
    const text = err.join('\n')
    expect(text).toContain('@aipehub/host is not installed')
    expect(text).toContain('npm i -g @aipehub/host')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// online ops (read / safe-mutate) — through the shared runner
// ═════════════════════════════════════════════════════════════════════════════

describe('setting — online ops via runOpsCommand', () => {
  it('runs status, forwards the cli caller + space deps, prints the lines', async () => {
    const { module, runOpsCommand } = fakeOps(async () => ({ lines: ['workspace : .aipehub', 'config    : ok'] }))
    const out: string[] = []
    const code = await setting(['status'], {
      resolveHost: () => HOST_ENTRY,
      importOps: async () => module,
      env: { AIPE_SPACE: '/srv/space' },
      out: (l) => out.push(l),
    })
    expect(code).toBe(0)
    expect(runOpsCommand).toHaveBeenCalledTimes(1)
    expect(runOpsCommand).toHaveBeenCalledWith(
      'status',
      [],
      { surface: 'cli', allowConfigWrite: true },
      { spaceDir: '/srv/space', env: { AIPE_SPACE: '/srv/space' } },
    )
    expect(out.join('')).toContain('config    : ok')
  })

  it('forwards subcommand args verbatim (check --strict)', async () => {
    const { module, runOpsCommand } = fakeOps()
    await setting(['check', '--strict'], {
      resolveHost: () => HOST_ENTRY,
      importOps: async () => module,
      out: () => {},
    })
    expect(runOpsCommand).toHaveBeenCalledWith('check', ['--strict'], expect.anything(), expect.anything())
  })

  it('defaults spaceDir to .aipehub when AIPE_SPACE is unset', async () => {
    const { module, runOpsCommand } = fakeOps()
    await setting(['list'], {
      resolveHost: () => HOST_ENTRY,
      importOps: async () => module,
      env: {},
      out: () => {},
    })
    expect(runOpsCommand).toHaveBeenCalledWith('list', [], expect.anything(), { spaceDir: '.aipehub', env: {} })
  })

  it('surfaces an OpsError message and exits 1 (unknown command)', async () => {
    const { module } = fakeOps(async () => {
      throw new Error("unknown setting command: 'nope'. Run `setting list` to see them.")
    })
    const err: string[] = []
    const code = await setting(['nope'], {
      resolveHost: () => HOST_ENTRY,
      importOps: async () => module,
      err: (l) => err.push(l),
    })
    expect(code).toBe(1)
    expect(err.join('')).toContain("unknown setting command: 'nope'")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// destructive-offline adapter (CLI-only) — confirmation gates execution
// ═════════════════════════════════════════════════════════════════════════════

describe('setting restore — destructive, confirmation-gated', () => {
  it('runs NOTHING when the operator declines confirmation', async () => {
    const runProcess = vi.fn(async () => 0)
    const out: string[] = []
    const code = await setting(['restore', 'backup.tgz', '/target'], {
      resolveHost: () => HOST_ENTRY,
      confirm: async () => false,
      runProcess,
      out: (l) => out.push(l),
    })
    expect(code).toBe(1)
    expect(runProcess).not.toHaveBeenCalled()
    expect(out.join('')).toContain('aborted')
  })

  it('runs bash restore.sh with the host-derived script path on confirm', async () => {
    const runProcess = vi.fn(async () => 0)
    const code = await setting(['restore', 'backup.tgz', '/target'], {
      resolveHost: () => HOST_ENTRY,
      confirm: async () => true,
      runProcess,
      out: () => {},
    })
    expect(code).toBe(0)
    expect(runProcess).toHaveBeenCalledTimes(1)
    expect(runProcess).toHaveBeenCalledWith('bash', [
      `${HOST_ROOT}/scripts/backup/restore.sh`,
      'backup.tgz',
      '/target',
    ])
  })

  it('passes --force through to restore.sh and skips confirm with --yes', async () => {
    const runProcess = vi.fn(async () => 0)
    const confirm = vi.fn(async () => true)
    const code = await setting(['restore', 'backup.tgz', '/target', '--force', '--yes'], {
      resolveHost: () => HOST_ENTRY,
      confirm,
      runProcess,
      out: () => {},
    })
    expect(code).toBe(0)
    // --yes means the confirm prompt is never shown.
    expect(confirm).not.toHaveBeenCalled()
    expect(runProcess).toHaveBeenCalledWith('bash', [
      `${HOST_ROOT}/scripts/backup/restore.sh`,
      'backup.tgz',
      '/target',
      '--force',
    ])
  })

  it('rejects missing args with a usage error (exit 2)', async () => {
    const runProcess = vi.fn(async () => 0)
    const err: string[] = []
    const code = await setting(['restore', 'only-one'], {
      resolveHost: () => HOST_ENTRY,
      runProcess,
      err: (l) => err.push(l),
    })
    expect(code).toBe(2)
    expect(runProcess).not.toHaveBeenCalled()
    expect(err.join('')).toContain('usage: aipehub setting restore')
  })
})

describe('setting rotate-master-key — destructive, confirmation-gated', () => {
  it('runs NOTHING when declined', async () => {
    const runProcess = vi.fn(async () => 0)
    const code = await setting(['rotate-master-key'], {
      resolveHost: () => HOST_ENTRY,
      confirm: async () => false,
      runProcess,
      out: () => {},
    })
    expect(code).toBe(1)
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('spawns the host bin with the rotate-master-key subcommand on confirm', async () => {
    const runProcess = vi.fn(async () => 0)
    const code = await setting(['rotate-master-key', '--yes'], {
      resolveHost: () => HOST_ENTRY,
      runProcess,
      out: () => {},
    })
    expect(code).toBe(0)
    expect(runProcess).toHaveBeenCalledWith(process.execPath, [
      `${HOST_ROOT}/bin/aipehub-host.js`,
      'rotate-master-key',
    ])
  })

  it('host absent → hint, exit 1, nothing spawned', async () => {
    const runProcess = vi.fn(async () => 0)
    const err: string[] = []
    const code = await setting(['rotate-master-key', '--yes'], {
      resolveHost: () => null,
      runProcess,
      err: (l) => err.push(l),
    })
    expect(code).toBe(1)
    expect(runProcess).not.toHaveBeenCalled()
    expect(err.join('\n')).toContain('@aipehub/host is not installed')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// cold-start — pre-flight gate decides whether it boots
// ═════════════════════════════════════════════════════════════════════════════

describe('setting cold-start — pre-flight gate', () => {
  it('boots when doctor + check are both clean', async () => {
    const runStart = vi.fn(async () => 0)
    const code = await setting(['cold-start'], {
      runDoctor: async () => 0,
      runCheck: async () => 0,
      runStart,
      out: () => {},
      err: () => {},
    })
    expect(code).toBe(0)
    expect(runStart).toHaveBeenCalledWith([])
  })

  it('does NOT boot when pre-flight fails (no --force)', async () => {
    const runStart = vi.fn(async () => 0)
    const err: string[] = []
    const code = await setting(['cold-start'], {
      runDoctor: async () => 1, // doctor found a blocker
      runCheck: async () => 0,
      runStart,
      out: () => {},
      err: (l) => err.push(l),
    })
    expect(code).toBe(1)
    expect(runStart).not.toHaveBeenCalled()
    expect(err.join('\n')).toContain('--force')
  })

  it('boots despite pre-flight failures with --force', async () => {
    const runStart = vi.fn(async () => 0)
    const code = await setting(['cold-start', '--force'], {
      runDoctor: async () => 1,
      runCheck: async () => 1,
      runStart,
      out: () => {},
      err: () => {},
    })
    expect(code).toBe(0)
    expect(runStart).toHaveBeenCalledWith([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// interactive sub-shell (runSettingShell) — reuses the ReplIo seam
// ═════════════════════════════════════════════════════════════════════════════

describe('runSettingShell — interactive', () => {
  it('runs one online command then exits on `exit`', async () => {
    const { module, runOpsCommand } = fakeOps(async () => ({ lines: ['status output'] }))
    const { io, writes } = scriptedIo(['status', 'exit'])
    const code = await runSettingShell({
      resolveHost: () => HOST_ENTRY,
      importOps: async () => module,
      io,
    })
    expect(code).toBe(0)
    expect(runOpsCommand).toHaveBeenCalledTimes(1)
    expect(runOpsCommand).toHaveBeenCalledWith('status', [], { surface: 'cli', allowConfigWrite: true }, expect.anything())
    const text = writes.join('')
    expect(text).toContain('setting console') // banner
    expect(text).toContain('status output')
  })

  it('skips blank lines and prints the command list on `help`', async () => {
    const { module, runOpsCommand } = fakeOps()
    const { io, writes } = scriptedIo(['', '   ', 'help', 'exit'])
    await runSettingShell({ resolveHost: () => HOST_ENTRY, importOps: async () => module, io })
    expect(runOpsCommand).not.toHaveBeenCalled()
    expect(writes.join('')).toContain('setting commands:')
  })

  it('refuses destructive commands in-shell, pointing at the direct form', async () => {
    const { module, runOpsCommand } = fakeOps()
    const runProcess = vi.fn(async () => 0)
    const { io, writes } = scriptedIo(['restore backup.tgz /t', 'exit'])
    await runSettingShell({
      resolveHost: () => HOST_ENTRY,
      importOps: async () => module,
      runProcess,
      io,
    })
    // destructive ops never reach the runner OR a spawned process from the shell.
    expect(runOpsCommand).not.toHaveBeenCalled()
    expect(runProcess).not.toHaveBeenCalled()
    expect(writes.join('')).toContain('aipehub setting restore')
  })

  it('exits 1 when the host is absent', async () => {
    const err: string[] = []
    const { io } = scriptedIo(['status', 'exit'])
    const code = await runSettingShell({ resolveHost: () => null, io, err: (l) => err.push(l) })
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('@aipehub/host is not installed')
  })

  it('bare `setting` (no subcommand) enters the shell', async () => {
    const { module, runOpsCommand } = fakeOps()
    const { io } = scriptedIo(['exit'])
    const code = await setting([], { resolveHost: () => HOST_ENTRY, importOps: async () => module, io })
    expect(code).toBe(0)
    // shell opened, read 'exit' immediately → no command run, clean exit.
    expect(runOpsCommand).not.toHaveBeenCalled()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// parseSettingCommand — pure
// ═════════════════════════════════════════════════════════════════════════════

describe('parseSettingCommand', () => {
  it('classifies empties, exits, helps, and commands', () => {
    expect(parseSettingCommand('')).toEqual({ kind: 'empty' })
    expect(parseSettingCommand('   ')).toEqual({ kind: 'empty' })
    expect(parseSettingCommand('exit')).toEqual({ kind: 'exit' })
    expect(parseSettingCommand('quit')).toEqual({ kind: 'exit' })
    expect(parseSettingCommand(':q')).toEqual({ kind: 'exit' })
    expect(parseSettingCommand('help')).toEqual({ kind: 'help' })
    expect(parseSettingCommand('?')).toEqual({ kind: 'help' })
    expect(parseSettingCommand('status')).toEqual({ kind: 'command', id: 'status', args: [] })
    expect(parseSettingCommand('check --strict')).toEqual({ kind: 'command', id: 'check', args: ['--strict'] })
    expect(parseSettingCommand('  fix-dirs  ')).toEqual({ kind: 'command', id: 'fix-dirs', args: [] })
  })
})
