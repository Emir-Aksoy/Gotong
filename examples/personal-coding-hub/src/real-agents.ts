/**
 * real-agents.ts — the shared real-run wiring for personal-coding-hub.
 *
 * Both entrypoints (the one-shot `index.real.ts` and the interactive `cli.ts`)
 * build the SAME three pieces here, so the wiring lives in one place:
 *
 *   · makeRouter()  — the router brain = MiniMax (M2.1) via OpenAIProvider. Needs
 *     MINIMAX_API_KEY, passed EXPLICITLY — never exported as OPENAI_API_KEY (codex
 *     reads that), so the router's key can't leak into the coding agents.
 *   · makeCoder()   — one coding agent. In `stub` mode it's the in-process mock
 *     (cheap dry run). Otherwise it drives the REAL CLI via that CLI's OWN login
 *     (~/.claude.json / ~/.codex/auth.json) — we inject NO key. Sandboxed to cwd.
 *
 * The hub never sees the coding agents' credentials and the coding agents never
 * see the router's — three independent auth layers, kept apart on purpose.
 */

import { fileURLToPath } from 'node:url'

import type { Hub, TaskId } from '@aipehub/core'
import { DispatchToolset, LlmAgent } from '@aipehub/llm'
import { OpenAIProvider } from '@aipehub/llm-openai'
import { dangerousCommandGate, type CliChunk } from '@aipehub/cli-agent'

import { SharedWorkspaceCli } from './shared-workspace-cli.js'
import type { SharedWorkspace } from './workspace.js'

const MOCK_CODER = fileURLToPath(new URL('./mock-coder.mjs', import.meta.url))

export const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL ?? 'https://api.minimaxi.com/v1'
export const MINIMAX_MODEL = process.env.MINIMAX_MODEL ?? 'MiniMax-M2.1'

export const ROUTER_ID = 'router'
export type CoderId = 'claude-code' | 'codex'

export const ROUTER_SYSTEM =
  'You are the router for a personal coding hub. You manage two coding agents: ' +
  '`claude-code` and `codex`. Read the GOAL and dispatch the RIGHT agent(s) — NOT a ' +
  'fixed pipeline:\n' +
  '· a trivial fix (typo / rename) → codex only, implement directly;\n' +
  '· a review/explain ask (do NOT change code) → claude-code only, no implementation;\n' +
  '· a feature that needs design first → claude-code drafts, then codex implements.\n' +
  'Dispatch with the `dispatch_task` tool: set `agentId` to "claude-code" or "codex", ' +
  'and put the concrete instruction in `payload.prompt`. Dispatch one agent per call ' +
  'and wait for it to finish (PROGRESS.md carries the handoff) before the next. When ' +
  'the work is routed and done, reply with ONE line naming who you routed and why.'

/**
 * MiniMax M2.1 is a reasoning model: it prepends a `<think>…</think>` block to its
 * final assistant message (the OpenAIProvider still parses tool_calls correctly
 * alongside it). Strip it so the router's one-line summary prints clean.
 */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

/** The router LlmAgent — MiniMax brain + a dispatch tool scoped to the two coders. */
export function makeRouter(hub: Hub, apiKey: string): LlmAgent {
  return new LlmAgent({
    id: ROUTER_ID,
    capabilities: ['route'],
    provider: new OpenAIProvider({
      name: 'minimax',
      apiKey, // ← EXPLICIT; never via OPENAI_API_KEY (codex reads that)
      baseURL: MINIMAX_BASE_URL,
      defaultModel: MINIMAX_MODEL,
      maxTokensField: 'max_tokens', // MiniMax uses the legacy OpenAI field
    }),
    system: ROUTER_SYSTEM,
    tools: DispatchToolset.create({ hub, selfId: ROUTER_ID, allowedAgents: ['claude-code', 'codex'] }),
  })
}

/**
 * One coding agent. `stub` → the in-process mock (no CLI call). Otherwise the REAL
 * CLI, which authenticates via its OWN login — we set NO `env`, so it inherits the
 * ambient environment and resolves its own subscription / key. Each CLI is
 * sandboxed to the workspace (claude acceptEdits, codex workspace-write).
 */
export function makeCoder(
  id: CoderId,
  ws: SharedWorkspace,
  stub: boolean,
  onChunk?: (taskId: TaskId, chunk: CliChunk) => void,
): SharedWorkspaceCli {
  const spec = stub
    ? { command: process.execPath, args: [MOCK_CODER, '--agent', id, '--prompt', '{prompt}'] }
    : id === 'claude-code'
      ? { command: 'claude', args: ['-p', '{prompt}', '--permission-mode', 'acceptEdits'] }
      : { command: 'codex', args: ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '{prompt}'] }
  return new SharedWorkspaceCli({
    id,
    capabilities: ['code'],
    command: spec.command,
    args: spec.args,
    promptVia: 'arg',
    cwd: ws.dir,
    // No `env`: the CLI inherits ambient env and uses its OWN login. We never set
    // ANTHROPIC_API_KEY / OPENAI_API_KEY here — the MiniMax key stays the router's.
    gate: dangerousCommandGate(),
    timeoutMs: 240_000,
    onChunk: onChunk ?? ((_taskId, chunk) => process.stdout.write(`        │ ${chunk.text.replace(/\n+$/, '')}\n`)),
  })
}
