/**
 * `gotong` CLI entry point. Dispatches to the subcommand handlers in
 * `./commands/`. Kept deliberately tiny — the bin shim imports this
 * file for its side-effects (call `runCli`).
 *
 * Subcommands supported in v1.2:
 *
 *   - `gotong init`                    bootstrap a workspace on disk
 *   - `gotong start`                   launch `@gotong/host` (delegated)
 *   - `gotong doctor`                  pre-flight environment check
 *   - `gotong new agent <name>`        scaffold a TypeScript sidecar
 *   - `gotong new python-agent <name>` scaffold a Python sidecar
 *   - `gotong ping <ws-url>`           handshake-only probe of a Hub
 *   - `gotong help [cmd]`              usage
 *
 * The CLI deliberately does NOT depend on `@gotong/sdk-node` or
 * `@gotong/host` at runtime — both pull in transitive deps (LLM
 * SDKs, sqlite, …) that bloat install time. The only runtime dep is
 * `@gotong/protocol` for the wire-protocol version string. `ping`
 * uses a hand-rolled WebSocket client (the `ws` package, declared as
 * a devDep so the published CLI bundles it via `bundleDependencies`).
 * `start` keeps that discipline: it resolves `@gotong/host` lazily at
 * runtime (never a build-time dep) and only launches it if present.
 */

import { init } from './commands/init.js'
import { start } from './commands/start.js'
import { doctor } from './commands/doctor.js'
import { check } from './commands/check.js'
import { newAgent } from './commands/new-agent.js'
import { ping } from './commands/ping.js'
import { repl } from './commands/repl.js'
import { connect } from './commands/connect.js'
import { mintPeerToken } from './commands/mint-peer-token.js'
import { setting } from './commands/setting.js'
import { printHelp } from './commands/help.js'

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printHelp(rest[0])
    return 0
  }
  if (cmd === '--version' || cmd === '-v') {
    // package.json version, lazily read so the CLI doesn't trip on
    // a missing path in a dev checkout.
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const here = dirname(fileURLToPath(import.meta.url))
    try {
      const raw = await readFile(join(here, '..', '..', 'package.json'), 'utf8')
      const json = JSON.parse(raw) as { version?: string }
      console.log(json.version ?? '?')
    } catch {
      console.log('?')
    }
    return 0
  }
  try {
    switch (cmd) {
      case 'init':
        return await init(rest)
      case 'start':
        return await start(rest)
      case 'doctor':
        return await doctor(rest)
      case 'check':
        return await check(rest)
      case 'new': {
        const [kind, ...args] = rest
        if (kind === 'agent') return await newAgent({ language: 'ts', args })
        if (kind === 'python-agent') return await newAgent({ language: 'py', args })
        printHelp('new')
        return 2
      }
      case 'ping':
        return await ping(rest)
      case 'repl':
        return await repl(rest)
      case 'connect':
        return connect(rest)
      case 'mint-peer-token':
        return mintPeerToken(rest)
      case 'setting':
        return await setting(rest)
      default:
        console.error(`unknown command: ${cmd}`)
        printHelp()
        return 2
    }
  } catch (err) {
    console.error(`[gotong] ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}

// Top-level for the bin shim. When invoked through Vitest the file is
// imported for tests, in which case we don't want to call runCli().
// Guard with the standard "main module" check (Node 20+).
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('gotong.js')
if (isMain) {
  runCli().then((code) => {
    if (typeof code === 'number' && code !== 0) process.exit(code)
  }).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
