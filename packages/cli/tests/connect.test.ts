/**
 * Quick-connect preset tests — exercise the pure renderer directly
 * (no MCP server, no filesystem) plus a few runCli smoke checks for the
 * command wiring.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  CONNECT_IDS,
  CONNECT_PRESETS,
  TOKEN_PLACEHOLDER,
  findConnectPreset,
  renderConnectList,
  type ConnectContext,
} from '../src/connect/presets.js'
import { runCli } from '../src/main.js'

const CTX: ConnectContext = {
  name: 'aipehub',
  hubUrl: 'http://127.0.0.1:3000',
  token: TOKEN_PLACEHOLDER,
  binPath: '/abs/packages/mcp-server/bin/aipehub-mcp.js',
}

const EXPECTED_IDS = [
  'claude-code',
  'codex',
  'opencode',
  'antigravity',
  'cursor',
  'openclaw',
  'nanobot',
  'hermes',
]

describe('connect presets', () => {
  it('ships exactly the eight requested agents', () => {
    expect(CONNECT_PRESETS).toHaveLength(8)
    expect([...CONNECT_IDS].sort()).toEqual([...EXPECTED_IDS].sort())
  })

  it('every render carries the universal payload (bin + hub + env + name)', () => {
    for (const preset of CONNECT_PRESETS) {
      const out = preset.render(CTX)
      expect(out, preset.id).toContain(CTX.binPath)
      expect(out, preset.id).toContain(CTX.hubUrl)
      expect(out, preset.id).toContain('AIPE_HUB_URL')
      expect(out, preset.id).toContain('AIPE_ADMIN_TOKEN')
      expect(out, preset.id).toContain(CTX.name)
      // header + docs footer always present
      expect(out, preset.id).toContain(preset.label)
      expect(out, preset.id).toContain(preset.docsUrl)
    }
  })

  it('renders each agent in its own native format', () => {
    const r = (id: string) => findConnectPreset(id)!.render(CTX)
    expect(r('claude-code')).toContain('claude mcp add aipehub')
    expect(r('codex')).toContain('[mcp_servers.aipehub]')
    expect(r('codex')).toContain('~/.codex/config.toml')
    expect(r('opencode')).toContain('"type": "local"')
    expect(r('opencode')).toContain('opencode.json')
    expect(r('antigravity')).toContain('~/.gemini/config/mcp_config.json')
    expect(r('antigravity')).toContain('"mcpServers"')
    expect(r('cursor')).toContain('~/.cursor/mcp.json')
    expect(r('openclaw')).toContain('openclaw mcp add aipehub')
    expect(r('nanobot')).toContain('nanobot.yaml')
    expect(r('nanobot')).toContain('mcpServers:')
    expect(r('hermes')).toContain('hermes mcp add aipehub')
    expect(r('hermes')).toContain('~/.hermes/config.yaml')
  })

  it('uses the token placeholder by default and inlines a real token', () => {
    const placeholder = findConnectPreset('cursor')!.render(CTX)
    expect(placeholder).toContain(TOKEN_PLACEHOLDER)

    const real = findConnectPreset('cursor')!.render({ ...CTX, token: 'sk-live-abc123' })
    expect(real).toContain('sk-live-abc123')
    expect(real).not.toContain(TOKEN_PLACEHOLDER)
  })

  it('lookup is case-insensitive and rejects unknowns', () => {
    expect(findConnectPreset('Claude-Code')!.id).toBe('claude-code')
    expect(findConnectPreset('  CURSOR ')!.id).toBe('cursor')
    expect(findConnectPreset('devin')).toBeUndefined()
  })

  it('list view names every agent and the usage line', () => {
    const list = renderConnectList(CTX)
    for (const preset of CONNECT_PRESETS) {
      expect(list).toContain(preset.label)
    }
    expect(list).toContain('aipehub connect <id>')
    expect(list).toContain(CTX.hubUrl)
  })
})

describe('runCli connect', () => {
  it('lists supported agents with no id (exit 0)', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runCli(['connect'])).toBe(0)
    expect(out).toHaveBeenCalled()
    out.mockRestore()
    err.mockRestore()
  })

  it('prints a block for a known agent (exit 0)', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runCli(['connect', 'codex'])).toBe(0)
    out.mockRestore()
    err.mockRestore()
  })

  it('rejects an unknown agent with code 2', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runCli(['connect', 'devin'])).toBe(2)
    err.mockRestore()
    out.mockRestore()
  })

  it('rejects an unknown option with code 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runCli(['connect', '--wat'])).toBe(2)
    err.mockRestore()
  })
})
