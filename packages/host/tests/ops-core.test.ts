import { describe, expect, it } from 'vitest'

import {
  OpsError,
  OpsTierError,
  fixMissingDirs,
  listOpsCommands,
  readBackupInventory,
  runOpsCommand,
  workspaceFixDirs,
  type OpsCaller,
  type OpsDeps,
  type OpsPathProbe,
  type WorkspaceCheckReport,
} from '../src/ops-core.js'

// ── fixtures ─────────────────────────────────────────────────────────────────

const CLI: OpsCaller = { surface: 'cli', allowConfigWrite: true }
const WEB_OWNER: OpsCaller = { surface: 'web', allowConfigWrite: true }
const WEB_VIEWER: OpsCaller = { surface: 'web', allowConfigWrite: false }
const IM: OpsCaller = { surface: 'im', allowConfigWrite: false }

function fakeReport(over: Partial<WorkspaceCheckReport> = {}): WorkspaceCheckReport {
  return {
    findings: [],
    errors: 0,
    warnings: 0,
    workflows: { ok: 2, bad: 0 },
    agents: { ok: 1, bad: 0 },
    ...over,
  }
}

/** A deps with an injected validator so read commands never touch the fs. */
function depsWith(over: Partial<OpsDeps> = {}): OpsDeps {
  return {
    spaceDir: '/space',
    validate: async () => fakeReport(),
    ...over,
  }
}

// ── the chokepoint: destructive-offline is unbypassable from the shared runner ─

describe('runOpsCommand — destructive-offline chokepoint', () => {
  for (const id of ['cold-start', 'restore', 'rotate-master-key']) {
    // Even the CLI caller is refused BY THE SHARED RUNNER: the CLI's real
    // destructive paths bypass runOpsCommand entirely (M2), so web/IM can never
    // reach a destructive op through this funnel, by construction.
    for (const caller of [CLI, WEB_OWNER, IM]) {
      it(`throws OpsTierError for '${id}' from surface=${caller.surface}`, async () => {
        const err = await runOpsCommand(id, [], caller, depsWith()).catch((e) => e)
        expect(err).toBeInstanceOf(OpsTierError)
        expect((err as OpsTierError).code).toBe('destructive_offline_cli_only')
        expect((err as OpsTierError).tier).toBe('destructive-offline')
      })
    }
  }

  it('throws OpsError (unknown_command) for an unregistered id', async () => {
    const err = await runOpsCommand('frobnicate', [], CLI, depsWith()).catch((e) => e)
    expect(err).toBeInstanceOf(OpsError)
    expect((err as OpsError).code).toBe('unknown_command')
  })
})

// ── read tier passes through the injected validator ──────────────────────────

describe('runOpsCommand — read tier', () => {
  it('status reads the injected validator (no fs) and reports file-only when no live health', async () => {
    let called = 0
    const res = await runOpsCommand('status', [], CLI, depsWith({
      validate: async () => {
        called++
        return fakeReport({ warnings: 1 })
      },
    }))
    expect(called).toBe(1)
    expect(res.tier).toBe('read')
    expect(res.lines.join('\n')).toContain('/space')
    // No injected health → "not running (file checks only)".
    expect(res.lines.join('\n')).toContain('not running')
    expect(res.data?.spacePath).toBe('/space')
  })

  it('status folds in live health when a running host injected it', async () => {
    const res = await runOpsCommand('status', [], WEB_OWNER, depsWith({
      health: {
        snapshot: async () => ({
          agents: [],
          agentsMissingKey: 1,
          managedCount: 3,
          onlineCount: 2,
          mcpServers: [],
          mcpUnwired: 0,
          spaceWritable: true,
          spacePath: '/space',
          checkedAt: '2026-06-26T00:00:00.000Z',
        }),
      },
    }))
    const text = res.lines.join('\n')
    expect(text).toContain('2/3 agent(s) online')
    expect(text).toContain('1 missing key')
    expect((res.data as Record<string, unknown>).health).toBeDefined()
  })

  it('status degrades to file-only when the health probe throws (best-effort)', async () => {
    const res = await runOpsCommand('status', [], WEB_OWNER, depsWith({
      health: { snapshot: async () => { throw new Error('hub down') } },
    }))
    expect(res.lines.join('\n')).toContain('not running')
    expect((res.data as Record<string, unknown>).health).toBeUndefined()
  })

  it('check renders the full validator report', async () => {
    const res = await runOpsCommand('check', [], CLI, depsWith())
    expect(res.tier).toBe('read')
    // formatCheckReport on a clean report prints the pass line.
    expect(res.lines.join('\n')).toContain('workspace check passed')
    expect((res.data as Record<string, unknown>).errors).toBe(0)
  })

  it('list shows every command with a runnable mark for the caller', async () => {
    const res = await runOpsCommand('list', [], IM, depsWith())
    const text = res.lines.join('\n')
    expect(text).toContain('status')
    // restore is destructive-offline → NOT runnable on IM → carries a hint.
    expect(text).toMatch(/restore/)
    const cmds = (res.data as { commands: { id: string; runnableHere: boolean }[] }).commands
    expect(cmds.find((c) => c.id === 'restore')?.runnableHere).toBe(false)
    expect(cmds.find((c) => c.id === 'status')?.runnableHere).toBe(true)
  })

  it('inventory lists parsed backups newest-first via the injected readdir', async () => {
    const res = await runOpsCommand('inventory', [], CLI, depsWith({
      backupDir: '/backups',
      readdirImpl: async () => [
        'aipehub-myspace-20260101T000000Z.tar.gz',
        'aipehub-myspace-20260626T101530Z.tar.gz',
        'not-a-backup.txt',
      ],
      statSizeImpl: async () => 4096,
    }))
    const inv = res.data as { items: { timestamp: string }[]; ignored: number }
    expect(inv.items.map((i) => i.timestamp)).toEqual([
      '20260626T101530Z',
      '20260101T000000Z',
    ])
    expect(inv.ignored).toBe(1)
  })
})

// ── safe-mutate: fix-dirs ────────────────────────────────────────────────────

describe('runOpsCommand — fix-dirs (safe-mutate)', () => {
  it('creates the missing workflows dir and no-ops the existing space root', async () => {
    const created: string[] = []
    const probe = async (p: string): Promise<OpsPathProbe> =>
      p === '/space' ? 'writable' : 'creatable'
    const res = await runOpsCommand('fix-dirs', [], CLI, depsWith({
      probePathImpl: probe,
      mkdirpImpl: async (p) => { created.push(p) },
    }))
    expect(res.tier).toBe('safe-mutate')
    expect(created).toEqual(['/space/workflows/definitions'])
    const outcomes = (res.data as { outcomes: { dir: string; outcome: string }[] }).outcomes
    expect(outcomes.find((o) => o.dir === '/space')?.outcome).toBe('exists')
    expect(outcomes.find((o) => o.dir === '/space/workflows/definitions')?.outcome).toBe('created')
  })

  it('is runnable on every surface (read+safe-mutate)', async () => {
    for (const caller of [CLI, WEB_VIEWER, IM]) {
      const res = await runOpsCommand('fix-dirs', [], caller, depsWith({
        probePathImpl: async () => 'writable',
      }))
      expect(res.command).toBe('fix-dirs')
    }
  })
})

// ── fixMissingDirs unit (the safe-mutate primitive) ──────────────────────────

describe('fixMissingDirs', () => {
  it('reports created / exists / failed per the path probe', async () => {
    const out = await fixMissingDirs(['/a', '/b', '/c', '/d'], {
      probePathImpl: async (p) =>
        p === '/a' ? 'writable' : p === '/b' ? 'creatable' : p === '/c' ? 'exists-readonly' : 'not-a-dir',
      mkdirpImpl: async () => {},
    })
    expect(out).toEqual([
      { dir: '/a', outcome: 'exists' },
      { dir: '/b', outcome: 'created' },
      { dir: '/c', outcome: 'exists', detail: expect.stringContaining('not writable') },
      { dir: '/d', outcome: 'failed', detail: expect.stringContaining('a file exists') },
    ])
  })

  it('surfaces a mkdir failure as outcome=failed (never throws)', async () => {
    const out = await fixMissingDirs(['/x'], {
      probePathImpl: async () => 'creatable',
      mkdirpImpl: async () => { const e: NodeJS.ErrnoException = new Error('nope'); e.code = 'EACCES'; throw e },
    })
    expect(out[0]!.outcome).toBe('failed')
    expect(out[0]!.detail).toContain('EACCES')
  })
})

// ── workspaceFixDirs honours AIPE_WORKFLOWS_DIR ──────────────────────────────

describe('workspaceFixDirs', () => {
  it('defaults to <space> + <space>/workflows/definitions', () => {
    expect(workspaceFixDirs('/space')).toEqual(['/space', '/space/workflows/definitions'])
  })
  it('uses AIPE_WORKFLOWS_DIR override when set', () => {
    expect(workspaceFixDirs('/space', { AIPE_WORKFLOWS_DIR: '/elsewhere/defs' })).toEqual([
      '/space',
      '/elsewhere/defs',
    ])
  })
})

// ── readBackupInventory unit ─────────────────────────────────────────────────

describe('readBackupInventory', () => {
  it('returns an empty inventory for an unset dir (no error)', async () => {
    const inv = await readBackupInventory(undefined)
    expect(inv.dir).toBeNull()
    expect(inv.items).toEqual([])
    expect(inv.ignored).toBe(0)
  })

  it('parses label + sortable timestamp and sorts newest-first', async () => {
    const inv = await readBackupInventory('/b', {
      readdirImpl: async () => [
        'aipehub-prod-20260315T120000Z.tar.gz',
        'aipehub-prod-20260101T000000Z.tar.gz',
        'aipehub-prod-20260626T235959Z.tar.gz',
      ],
      statSizeImpl: async () => 10,
    })
    expect(inv.items.map((i) => i.timestamp)).toEqual([
      '20260626T235959Z',
      '20260315T120000Z',
      '20260101T000000Z',
    ])
    expect(inv.items[0]!.label).toBe('prod')
    expect(inv.items[0]!.sizeBytes).toBe(10)
  })

  it('keeps a dash-containing label intact (timestamp anchored at the tail)', async () => {
    const inv = await readBackupInventory('/b', {
      readdirImpl: async () => ['aipehub-my-fancy-space-20260101T000000Z.tar.gz'],
    })
    expect(inv.items[0]!.label).toBe('my-fancy-space')
    expect(inv.items[0]!.timestamp).toBe('20260101T000000Z')
  })

  it('counts non-matching files as ignored, omits size on a stat fault', async () => {
    const inv = await readBackupInventory('/b', {
      readdirImpl: async () => ['aipehub-a-20260101T000000Z.tar.gz', 'README.md', 'aipehub-incomplete.tar.gz'],
      statSizeImpl: async () => undefined,
    })
    expect(inv.items).toHaveLength(1)
    expect(inv.ignored).toBe(2)
    expect(inv.items[0]!.sizeBytes).toBeUndefined()
  })
})

// ── listOpsCommands — tier + per-surface runnable flags ──────────────────────

describe('listOpsCommands', () => {
  it('assigns the right tier to each command', () => {
    const byId = Object.fromEntries(listOpsCommands(CLI).map((c) => [c.id, c.tier]))
    expect(byId['status']).toBe('read')
    expect(byId['check']).toBe('read')
    expect(byId['list']).toBe('read')
    expect(byId['inventory']).toBe('read')
    expect(byId['fix-dirs']).toBe('safe-mutate')
    expect(byId['cold-start']).toBe('destructive-offline')
    expect(byId['restore']).toBe('destructive-offline')
    expect(byId['rotate-master-key']).toBe('destructive-offline')
  })

  it('destructive-offline is runnable ONLY on the CLI surface', () => {
    const runnable = (caller: OpsCaller) =>
      listOpsCommands(caller).find((c) => c.id === 'restore')!.runnableHere
    expect(runnable(CLI)).toBe(true)
    expect(runnable(WEB_OWNER)).toBe(false)
    expect(runnable(IM)).toBe(false)
  })

  it('read + safe-mutate are runnable on every surface', () => {
    for (const id of ['status', 'check', 'list', 'inventory', 'fix-dirs']) {
      for (const caller of [CLI, WEB_VIEWER, IM]) {
        expect(listOpsCommands(caller).find((c) => c.id === id)!.runnableHere).toBe(true)
      }
    }
  })

  it('always lists every tier (so each surface can DISPLAY the full lifecycle)', () => {
    const ids = listOpsCommands(IM).map((c) => c.id)
    // Even IM, which can run none of them, still sees the destructive commands.
    expect(ids).toContain('cold-start')
    expect(ids).toContain('restore')
    expect(ids).toContain('rotate-master-key')
  })
})
