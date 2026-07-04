/**
 * Quick-connect presets — the single source of truth for `gotong
 * connect <agent>`.
 *
 * Every mainstream coding agent in 2026 is an MCP client (or MCP host):
 * Claude Code, Codex, OpenCode, Antigravity, Cursor, OpenClaw, nanobot,
 * Hermes. So "接入 Gotong" for the whole category is ONE move — point
 * the agent's MCP config at `@gotong/mcp-server`, which is itself a
 * thin client of the Hub's admin HTTP API (see packages/mcp-server).
 *
 * What differs per agent is only the wrapper format: a `claude mcp add`
 * one-liner, a TOML table, a JSON `mcpServers` map, a YAML block. The
 * payload underneath is always the same:
 *
 *     command: node
 *     args:    [<abs path to packages/mcp-server/bin/gotong-mcp.js>]
 *     env:     GOTONG_HUB_URL, GOTONG_ADMIN_TOKEN
 *
 * (`@gotong/mcp-server` is not on npm yet, so we spawn it by absolute
 * path with `node` rather than `npx -y @gotong/mcp-server` — matches
 * the caveat in docs/zh/MCP.md.)
 *
 * This module is PURE: it renders strings from a `ConnectContext`. All
 * filesystem / env / flag resolution lives in commands/connect.ts so
 * the rendering is trivially unit-testable.
 *
 * Inbound only. This covers the "入站" axis of the agent-adapter
 * contract (agent → Gotong via MCP). Driving these agents FROM the hub
 * ("出站" / shell-out adapter) is a separate deliverable — see
 * docs/zh/AGENT-ADAPTER-CONTRACT.md.
 */

/** Default MCP server name as the agent will register it. */
export const DEFAULT_NAME = 'gotong'

/** Default Hub admin HTTP base URL (single host, loopback). */
export const DEFAULT_HUB_URL = 'http://127.0.0.1:3000'

/**
 * Shown in config when no real admin token is supplied. We never auto-
 * inline a secret into terminal output; the user pastes their own.
 */
export const TOKEN_PLACEHOLDER = '<YOUR_ADMIN_TOKEN>'

/** Shown when the mcp-server bin can't be located on disk. */
export const BIN_PLACEHOLDER = '/ABS/PATH/TO/Gotong/packages/mcp-server/bin/gotong-mcp.js'

/** Everything a preset needs to render a copy-paste connect block. */
export interface ConnectContext {
  /** MCP server name as registered in the agent's config. */
  name: string
  /** Hub admin HTTP base URL. */
  hubUrl: string
  /** Admin bearer token, or {@link TOKEN_PLACEHOLDER}. */
  token: string
  /** Absolute path to `gotong-mcp.js`, or {@link BIN_PLACEHOLDER}. */
  binPath: string
}

export interface AgentConnectPreset {
  /** Stable lowercase id used on the command line. */
  id: string
  /** Human label. */
  label: string
  /** Vendor / project. */
  vendor: string
  /** One-line mechanism summary for the list view. */
  summary: string
  /** Where to read the agent's own MCP docs. */
  docsUrl: string
  /** Render the full, copy-paste connect block. */
  render(ctx: ConnectContext): string
}

interface PresetDef {
  id: string
  label: string
  vendor: string
  summary: string
  docsUrl: string
  /** Agent-specific body only; the header/footer are composed below. */
  body(ctx: ConnectContext): string
}

const RULE = '─'.repeat(56)

function toPreset(d: PresetDef): AgentConnectPreset {
  return {
    id: d.id,
    label: d.label,
    vendor: d.vendor,
    summary: d.summary,
    docsUrl: d.docsUrl,
    render(ctx: ConnectContext): string {
      return (
        `Gotong 快捷接入 · ${d.label}（${d.vendor}）\n` +
        `${RULE}\n\n` +
        `${d.body(ctx).trim()}\n\n` +
        `文档：${d.docsUrl}\n`
      )
    },
  }
}

// The standard JSON `"<name>": { command/args/env }` entry, shared by
// the agents that use a `mcpServers` (or `mcp.servers`) JSON map. `pad`
// is the indentation of the *outer* key so the nested lines line up.
function jsonServerEntry(ctx: ConnectContext, pad: string): string {
  const p2 = `${pad}  `
  const p3 = `${pad}    `
  return (
    `${pad}"${ctx.name}": {\n` +
    `${p2}"command": "node",\n` +
    `${p2}"args": ["${ctx.binPath}"],\n` +
    `${p2}"env": {\n` +
    `${p3}"GOTONG_HUB_URL": "${ctx.hubUrl}",\n` +
    `${p3}"GOTONG_ADMIN_TOKEN": "${ctx.token}"\n` +
    `${p2}}\n` +
    `${pad}}`
  )
}

// YAML `<name>: { command/args/env }` block under some parent key.
function yamlServerEntry(ctx: ConnectContext, pad: string): string {
  const p2 = `${pad}  `
  return (
    `${pad}${ctx.name}:\n` +
    `${p2}command: node\n` +
    `${p2}args:\n` +
    `${p2}  - ${ctx.binPath}\n` +
    `${p2}env:\n` +
    `${p2}  GOTONG_HUB_URL: ${ctx.hubUrl}\n` +
    `${p2}  GOTONG_ADMIN_TOKEN: ${ctx.token}`
  )
}

export const CONNECT_PRESETS: readonly AgentConnectPreset[] = [
  toPreset({
    id: 'claude-code',
    label: 'Claude Code',
    vendor: 'Anthropic',
    summary: 'claude mcp add（或 ~/.claude.json）',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/mcp',
    body: (ctx) =>
      `方式 A — 一行命令（推荐）：\n` +
      `  claude mcp add ${ctx.name} \\\n` +
      `    -e GOTONG_HUB_URL=${ctx.hubUrl} \\\n` +
      `    -e GOTONG_ADMIN_TOKEN=${ctx.token} \\\n` +
      `    -- node ${ctx.binPath}\n\n` +
      `方式 B — 写入 ~/.claude.json 顶层 "mcpServers"：\n` +
      `  "mcpServers": {\n` +
      `${jsonServerEntry(ctx, '    ')}\n` +
      `  }`,
  }),
  toPreset({
    id: 'codex',
    label: 'Codex',
    vendor: 'OpenAI',
    summary: '~/.codex/config.toml 的 [mcp_servers.*]',
    docsUrl: 'https://github.com/openai/codex',
    body: (ctx) =>
      `写入 ~/.codex/config.toml：\n` +
      `  [mcp_servers.${ctx.name}]\n` +
      `  command = "node"\n` +
      `  args = ["${ctx.binPath}"]\n` +
      `  env = { GOTONG_HUB_URL = "${ctx.hubUrl}", GOTONG_ADMIN_TOKEN = "${ctx.token}" }\n\n` +
      `验证：codex 启动后 /mcp 应列出 "${ctx.name}" 的工具。`,
  }),
  toPreset({
    id: 'opencode',
    label: 'OpenCode',
    vendor: 'sst/opencode',
    summary: 'opencode.json 的 "mcp"（type: local）',
    docsUrl: 'https://opencode.ai/docs/mcp-servers/',
    body: (ctx) =>
      `写入 opencode.json（项目根或 ~/.config/opencode/opencode.json）：\n` +
      `  {\n` +
      `    "$schema": "https://opencode.ai/config.json",\n` +
      `    "mcp": {\n` +
      `      "${ctx.name}": {\n` +
      `        "type": "local",\n` +
      `        "command": ["node", "${ctx.binPath}"],\n` +
      `        "enabled": true,\n` +
      `        "environment": {\n` +
      `          "GOTONG_HUB_URL": "${ctx.hubUrl}",\n` +
      `          "GOTONG_ADMIN_TOKEN": "${ctx.token}"\n` +
      `        }\n` +
      `      }\n` +
      `    }\n` +
      `  }`,
  }),
  toPreset({
    id: 'antigravity',
    label: 'Antigravity',
    vendor: 'Google',
    summary: '~/.gemini/config/mcp_config.json 的 mcpServers',
    docsUrl: 'https://antigravity.google/docs/mcp',
    body: (ctx) =>
      `写入 ~/.gemini/config/mcp_config.json（IDE 与 CLI 共享）：\n` +
      `  {\n` +
      `    "mcpServers": {\n` +
      `${jsonServerEntry(ctx, '      ')}\n` +
      `    }\n` +
      `  }`,
  }),
  toPreset({
    id: 'cursor',
    label: 'Cursor',
    vendor: 'Cursor',
    summary: '~/.cursor/mcp.json 的 mcpServers',
    docsUrl: 'https://docs.cursor.com/context/mcp',
    body: (ctx) =>
      `写入 ~/.cursor/mcp.json（全局）或项目 .cursor/mcp.json：\n` +
      `  {\n` +
      `    "mcpServers": {\n` +
      `${jsonServerEntry(ctx, '      ')}\n` +
      `    }\n` +
      `  }`,
  }),
  toPreset({
    id: 'openclaw',
    label: 'OpenClaw',
    vendor: 'OpenClaw',
    summary: 'openclaw mcp add（或 ~/.openclaw/openclaw.json）',
    docsUrl: 'https://docs.openclaw.ai/cli/mcp',
    body: (ctx) =>
      `方式 A — 一行命令：\n` +
      `  openclaw mcp add ${ctx.name} \\\n` +
      `    --command node \\\n` +
      `    --arg ${ctx.binPath} \\\n` +
      `    --env GOTONG_HUB_URL=${ctx.hubUrl} \\\n` +
      `    --env GOTONG_ADMIN_TOKEN=${ctx.token}\n\n` +
      `方式 B — 写入 ~/.openclaw/openclaw.json：\n` +
      `  {\n` +
      `    "mcp": {\n` +
      `      "servers": {\n` +
      `${jsonServerEntry(ctx, '        ')}\n` +
      `      }\n` +
      `    }\n` +
      `  }\n\n` +
      `说明：OpenClaw 本身是网关/编排器；接 Gotong 后其 runtime 可消费 hub 的工具。`,
  }),
  toPreset({
    id: 'nanobot',
    label: 'nanobot',
    vendor: 'nanobot-ai',
    summary: 'nanobot.yaml 的 mcpServers',
    docsUrl: 'https://github.com/nanobot-ai/nanobot',
    body: (ctx) =>
      `写入 nanobot.yaml，然后 nanobot run ./nanobot.yaml：\n` +
      `  mcpServers:\n` +
      `${yamlServerEntry(ctx, '    ')}\n\n` +
      `说明：nanobot 官方示例多为 remote URL；本地 stdio 用上面的 command/args/env。`,
  }),
  toPreset({
    id: 'hermes',
    label: 'Hermes Agent',
    vendor: 'Nous Research',
    summary: 'hermes mcp add（或 ~/.hermes/config.yaml）',
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp',
    body: (ctx) =>
      `方式 A — 一行命令：\n` +
      `  hermes mcp add ${ctx.name} --command node --args ${ctx.binPath}\n\n` +
      `方式 B — 写入 ~/.hermes/config.yaml：\n` +
      `  mcp_servers:\n` +
      `${yamlServerEntry(ctx, '    ')}\n\n` +
      `说明：Hermes 启动时发现并注册 MCP 工具；可用 tools: include/exclude 过滤。`,
  }),
]

/** All supported agent ids, in display order. */
export const CONNECT_IDS: readonly string[] = CONNECT_PRESETS.map((p) => p.id)

/** Case-insensitive lookup. Returns undefined for an unknown id. */
export function findConnectPreset(id: string): AgentConnectPreset | undefined {
  const want = id.trim().toLowerCase()
  return CONNECT_PRESETS.find((p) => p.id === want)
}

/** Render the list of supported agents + the resolved context banner. */
export function renderConnectList(ctx: ConnectContext): string {
  const idW = Math.max(...CONNECT_IDS.map((s) => s.length))
  const rows = CONNECT_PRESETS.map(
    (p) => `  ${p.id.padEnd(idW)}  ${p.label}（${p.vendor}）— ${p.summary}`,
  ).join('\n')
  return (
    `Gotong 快捷接入 — 支持的 agent（都是 MCP 客户端，统一接 @gotong/mcp-server）\n` +
    `${RULE}\n` +
    `${rows}\n\n` +
    `用法：gotong connect <id> [--hub=URL] [--token=TOKEN] [--name=NAME] [--bin=PATH]\n` +
    `当前：hub=${ctx.hubUrl}  name=${ctx.name}\n` +
    `      bin=${ctx.binPath}\n`
  )
}
