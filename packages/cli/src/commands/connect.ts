/**
 * `aipehub connect [agent]` — print the exact MCP quick-connect config
 * for a mainstream coding agent (Claude Code, Codex, OpenCode,
 * Antigravity, Cursor, OpenClaw, nanobot, Hermes).
 *
 * With no agent id it lists what's supported. The heavy lifting (the
 * per-agent config text) is in ../connect/presets.ts (pure); this file
 * only resolves the three runtime values that go into every block —
 * the Hub URL, the admin token, and the absolute path to the
 * mcp-server bin — then renders.
 *
 * Output discipline: the config block goes to stdout (so it pipes /
 * copy-pastes cleanly); warnings (placeholder token, bin not found) go
 * to stderr. Exit 0 on a printed block or the list, 2 on bad input.
 */

import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { printHelp } from './help.js'
import {
  BIN_PLACEHOLDER,
  DEFAULT_HUB_URL,
  DEFAULT_NAME,
  TOKEN_PLACEHOLDER,
  findConnectPreset,
  renderConnectList,
  type ConnectContext,
} from '../connect/presets.js'

interface ConnectFlags {
  agent?: string
  hub?: string
  token?: string
  name?: string
  bin?: string
  help?: boolean
}

export function connect(args: readonly string[]): number {
  const flags = parseArgs(args)
  if (!flags) return 2
  if (flags.help) {
    printHelp('connect')
    return 0
  }

  const bin = resolveBinPath(flags.bin)
  const ctx: ConnectContext = {
    name: flags.name ?? DEFAULT_NAME,
    // Hub URL is not a secret — env is a convenient default.
    hubUrl: flags.hub ?? process.env.AIPE_HUB_URL ?? DEFAULT_HUB_URL,
    // Token IS a secret — never auto-inline from env into terminal
    // output. The user opts in explicitly with --token.
    token: flags.token ?? TOKEN_PLACEHOLDER,
    binPath: bin.path,
  }

  if (!bin.resolved) {
    console.error(
      `[connect] 未找到 mcp-server bin，配置里用了占位符。\n` +
        `          请加 --bin=/abs/path/to/packages/mcp-server/bin/aipehub-mcp.js`,
    )
  }
  if (ctx.token === TOKEN_PLACEHOLDER) {
    const envHint = process.env.AIPE_ADMIN_TOKEN
      ? '（检测到 $AIPE_ADMIN_TOKEN，可加 --token="$AIPE_ADMIN_TOKEN" 直接填入）'
      : '（admin token 在 aipehub init 时生成，或在 admin UI 设置里查看）'
    console.error(`[connect] 未提供 --token，配置里用了占位符 ${TOKEN_PLACEHOLDER}${envHint}`)
  }

  if (!flags.agent) {
    process.stdout.write(renderConnectList(ctx))
    return 0
  }

  const preset = findConnectPreset(flags.agent)
  if (!preset) {
    console.error(`[connect] 未知 agent：${flags.agent}`)
    process.stdout.write(renderConnectList(ctx))
    return 2
  }
  process.stdout.write(preset.render(ctx))
  return 0
}

function parseArgs(args: readonly string[]): ConnectFlags | null {
  const flags: ConnectFlags = {}
  const positional: string[] = []
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      flags.help = true
    } else if (arg.startsWith('--hub=')) {
      flags.hub = arg.slice('--hub='.length)
    } else if (arg.startsWith('--token=')) {
      flags.token = arg.slice('--token='.length)
    } else if (arg.startsWith('--name=')) {
      const name = arg.slice('--name='.length)
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        console.error('[connect] --name 只能含字母、数字、. _ -')
        return null
      }
      flags.name = name
    } else if (arg.startsWith('--bin=')) {
      flags.bin = arg.slice('--bin='.length)
    } else if (arg.startsWith('-')) {
      console.error(`[connect] 未知选项：${arg}`)
      return null
    } else {
      positional.push(arg)
    }
  }
  if (positional[0]) flags.agent = positional[0].toLowerCase()
  return flags
}

/**
 * Locate `packages/mcp-server/bin/aipehub-mcp.js`. Tries, in order: an
 * explicit --bin, the sibling package relative to this module (works in
 * a monorepo checkout, src or dist), the cwd's packages/ dir, and the
 * cwd's node_modules. Falls back to a clearly-fake placeholder so the
 * printed config is obviously-incomplete rather than silently wrong.
 */
function resolveBinPath(override?: string): { path: string; resolved: boolean } {
  if (override) {
    return { path: isAbsolute(override) ? override : resolvePath(process.cwd(), override), resolved: true }
  }
  const candidates = [
    fileURLToPath(new URL('../../../mcp-server/bin/aipehub-mcp.js', import.meta.url)),
    join(process.cwd(), 'packages', 'mcp-server', 'bin', 'aipehub-mcp.js'),
    join(process.cwd(), 'node_modules', '@aipehub', 'mcp-server', 'bin', 'aipehub-mcp.js'),
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return { path: candidate, resolved: true }
    } catch {
      /* ignore unreadable candidate */
    }
  }
  return { path: BIN_PLACEHOLDER, resolved: false }
}
