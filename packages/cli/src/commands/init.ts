/**
 * `aipehub init` — bootstrap a new workspace on disk.
 *
 * Creates the `.aipehub/` directory tree with personal-mode defaults.
 * The identity layer (SQLite, owner user, org_mode=personal) is
 * bootstrapped on first `aipehub host` / `@aipehub/host` start, not
 * here — keeping the CLI free of the `better-sqlite3` native dep.
 *
 * Typical flow:
 *   1. `aipehub init`            ← creates workspace
 *   2. `export ANTHROPIC_API_KEY=sk-...`
 *   3. `npx @aipehub/host`      ← starts host, bootstraps identity
 *   4. open the admin URL in a browser
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Space } from '@aipehub/core'

// ── arg parsing ─────────────────────────────────────────────────────

interface ParsedInit {
  spaceDir: string
  adminName: string
  pinTeam: boolean
}

function parseArgs(args: readonly string[]): ParsedInit | null {
  let spaceDir = '.aipehub'
  let adminName = 'Operator'
  let pinTeam = false

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') return null
    if (arg.startsWith('--space-dir=')) {
      spaceDir = arg.slice('--space-dir='.length)
    } else if (arg.startsWith('--admin-name=')) {
      adminName = arg.slice('--admin-name='.length)
    } else if (arg === '--pin-team') {
      pinTeam = true
    } else {
      console.error(`[aipehub init] unknown option: ${arg}`)
      return null
    }
  }

  if (!spaceDir) {
    console.error('[aipehub init] --space-dir must be non-empty')
    return null
  }
  return { spaceDir, adminName, pinTeam }
}

// ── command ─────────────────────────────────────────────────────────

export async function init(args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args)
  if (!parsed) {
    printInitHelp()
    return 2
  }

  const root = resolve(parsed.spaceDir)

  if (existsSync(resolve(root, 'space.json'))) {
    console.error(`[aipehub init] workspace already exists at ${root}`)
    console.error('  Use the host to start the existing workspace.')
    return 1
  }

  try {
    const { adminToken } = await Space.init(root, {
      name: 'AipeHub',
      adminDisplayName: parsed.adminName,
      config: parsed.pinTeam ? { orgMode: 'team' } : undefined,
    })

    const mode = parsed.pinTeam ? 'team' : 'personal'

    console.log('')
    console.log(`  Workspace created at ${root}`)
    console.log(`  Mode: ${mode}`)
    if (adminToken) {
      console.log(`  Admin token: ${adminToken}`)
      console.log('  (shown once — save it now)')
    }
    console.log('')
    console.log('  Next steps:')
    console.log('    1. Set your LLM API key:')
    console.log('       export ANTHROPIC_API_KEY=sk-...')
    console.log('       # or: export OPENAI_API_KEY=sk-...')
    console.log('')
    console.log('    2. Start the hub:')
    console.log(`       AIPE_SPACE=${parsed.spaceDir} npx @aipehub/host`)
    console.log('')
    console.log('    3. Open the admin URL printed by the host.')
    console.log('')
    return 0
  } catch (err) {
    console.error(
      `[aipehub init] ${err instanceof Error ? err.message : String(err)}`,
    )
    return 1
  }
}

function printInitHelp(): void {
  process.stdout.write(`aipehub init [options]

Initializes a new AipeHub workspace. Creates the directory structure,
a bootstrap admin, and initial configuration. On first host start the
identity layer auto-detects single-user and enters personal mode
("my AI desktop").

Options:
  --space-dir=<path>      Workspace root (default: .aipehub)
  --admin-name=<name>     First admin display name (default: Operator)
  --pin-team              Force team mode instead of personal auto-detect
  --help / -h             Show this message

Examples:
  aipehub init
  aipehub init --space-dir=/opt/aipehub --admin-name="Alice"
  aipehub init --pin-team
`)
}
