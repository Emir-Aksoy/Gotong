/**
 * real-agents.ts — the shared real-run wiring for codex-deepseek-hub.
 *
 * Three independent pieces, three independent auth layers kept apart on purpose:
 *
 *   · makeRouter()  — the router brain = DeepSeek (chat) via OpenAIProvider. Needs
 *     DEEPSEEK_API_KEY, passed EXPLICITLY to the provider.
 *   · makeCoder('codex')        — the real `codex` CLI under its OWN login
 *     (~/.codex/auth.json). The hub injects NO key.
 *   · makeCoder('deepseek-tui') — a DeepSeek-backed terminal coder. The command is
 *     CONFIGURABLE (DEEPSEEK_TUI_CMD / DEEPSEEK_TUI_ARGS); the default is Aider on
 *     DeepSeek, headless single-message. It reads DEEPSEEK_API_KEY from the ambient
 *     env (same DeepSeek account as the router brain — that's fine, it's yours).
 *
 * stub mode → both coders are the in-process mock (cheap dry run, no CLI / no key).
 */

import { fileURLToPath } from 'node:url'

import type { Hub, TaskId } from '@aipehub/core'
import { DispatchToolset, LlmAgent } from '@aipehub/llm'
import { OpenAIProvider } from '@aipehub/llm-openai'
import { dangerousCommandGate, type CliChunk } from '@aipehub/cli-agent'

import { SharedWorkspaceCli } from './shared-workspace-cli.js'
import type { SharedWorkspace } from './workspace.js'

const MOCK_CODER = fileURLToPath(new URL('./mock-coder.mjs', import.meta.url))

// DeepSeek is OpenAI-compatible — point OpenAIProvider at its base URL.
export const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'

export const ROUTER_ID = 'router'
export type CoderId = 'codex' | 'deepseek-tui'

/**
 * The "DeepSeek TUI" coder slot. DeepSeek's API is OpenAI-compatible, so ANY
 * OpenAI-compatible terminal coder works — configure YOURS via env. The default
 * is Aider pointed at DeepSeek (native `--model deepseek/*`, reads
 * DEEPSEEK_API_KEY), running ONE headless message and exiting. Swap it for
 * OpenCode / Crush / your own DeepSeek TUI by setting:
 *   DEEPSEEK_TUI_CMD   — the executable (default 'aider')
 *   DEEPSEEK_TUI_ARGS  — space-separated args; MUST contain the {prompt} token
 */
export const DEEPSEEK_TUI_CMD = process.env.DEEPSEEK_TUI_CMD ?? 'aider'
export const DEEPSEEK_TUI_ARGS = (
  process.env.DEEPSEEK_TUI_ARGS ?? '--model deepseek/deepseek-chat --message {prompt} --yes-always --no-auto-commit'
)
  .split(' ')
  .filter(Boolean)

export const ROUTER_SYSTEM =
  'You are the router for a personal coding hub. You manage two coding agents: ' +
  '`deepseek-tui` (a DeepSeek-backed terminal coder whose reasoner leads analysis / design / ' +
  'review) and `codex` (the fast implementer). ' +
  'Dispatch the RIGHT agent(s) by COMBINING two things — NOT a fixed pipeline:\n' +
  '1) Analyze the GOAL:\n' +
  '   · a trivial fix (typo / rename) → one implementer, directly;\n' +
  '   · a review/explain ask (do NOT change code) → one reviewer, no implementation;\n' +
  '   · a feature that needs design first → a lead drafts, then an implementer builds.\n' +
  "2) Honor the user's arrangement, when stated in the goal (e.g. \"codex is rate-limited\", " +
  '"only use one agent today"): NEVER dispatch a coder the user says is unavailable — the ' +
  'on-call coder covers that role instead; if the budget caps to one coder, the lead does ' +
  'BOTH the draft and the implementation itself.\n' +
  'Dispatch with the `dispatch_task` tool: set `agentId` to "deepseek-tui" or "codex", ' +
  'and put the concrete instruction in `payload.prompt`. Dispatch one agent per call ' +
  'and wait for it to finish (PROGRESS.md carries the handoff) before the next. When ' +
  'the work is routed and done, reply with ONE line naming who you routed and why.'

/**
 * Some DeepSeek reasoning models prepend a `<think>…</think>` block to the final
 * message (deepseek-chat does not). Strip it defensively so the router's one-line
 * summary prints clean if a reasoner model is configured via DEEPSEEK_MODEL.
 */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

/** The router LlmAgent — DeepSeek brain + a dispatch tool scoped to the two coders. */
export function makeRouter(hub: Hub, apiKey: string): LlmAgent {
  return new LlmAgent({
    id: ROUTER_ID,
    capabilities: ['route'],
    provider: new OpenAIProvider({
      name: 'deepseek',
      apiKey, // ← EXPLICIT; the deepseek-tui coder reads its own from the ambient env
      baseURL: DEEPSEEK_BASE_URL,
      defaultModel: DEEPSEEK_MODEL,
      maxTokensField: 'max_tokens',
    }),
    system: ROUTER_SYSTEM,
    tools: DispatchToolset.create({ hub, selfId: ROUTER_ID, allowedAgents: ['codex', 'deepseek-tui'] }),
  })
}

/**
 * One coding agent. `stub` → the in-process mock (no CLI call). Otherwise the REAL
 * CLI: `codex` authenticates via its own login (we inject NO key); the DeepSeek TUI
 * runs the configured command and reads DEEPSEEK_API_KEY from the ambient env. Each
 * coder is sandboxed to the workspace `cwd`.
 */
export function makeCoder(
  id: CoderId,
  ws: SharedWorkspace,
  stub: boolean,
  onChunk?: (taskId: TaskId, chunk: CliChunk) => void,
): SharedWorkspaceCli {
  const spec = stub
    ? { command: process.execPath, args: [MOCK_CODER, '--agent', id, '--prompt', '{prompt}'] }
    : id === 'codex'
      ? { command: 'codex', args: ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '{prompt}'] }
      : { command: DEEPSEEK_TUI_CMD, args: DEEPSEEK_TUI_ARGS }
  return new SharedWorkspaceCli({
    id,
    capabilities: ['code'],
    command: spec.command,
    args: spec.args,
    promptVia: 'arg',
    cwd: ws.dir,
    // No env injected: codex uses its own login (~/.codex/auth.json) and the
    // DeepSeek TUI inherits the ambient env (DEEPSEEK_API_KEY). The router's key is
    // passed to the provider EXPLICITLY, so it never leaks in through here.
    gate: dangerousCommandGate(),
    timeoutMs: 240_000,
    onChunk: onChunk ?? ((_taskId, chunk) => process.stdout.write(`        │ ${chunk.text.replace(/\n+$/, '')}\n`)),
  })
}
