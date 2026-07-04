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

import type { Hub, TaskId } from '@gotong/core'
import { DispatchToolset, LlmAgent } from '@gotong/llm'
import { OpenAIProvider } from '@gotong/llm-openai'
import { dangerousCommandGate, type CliChunk } from '@gotong/cli-agent'

import { SharedWorkspaceCli } from './shared-workspace-cli.js'
import type { SharedWorkspace } from './workspace.js'
import { renderPolicyForPrompt } from './policy.js'
import { DEFAULT_CODING_POLICY, type RoutingPolicy } from './routing.js'

const MOCK_CODER = fileURLToPath(new URL('./mock-coder.mjs', import.meta.url))

export const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL ?? 'https://api.minimaxi.com/v1'
export const MINIMAX_MODEL = process.env.MINIMAX_MODEL ?? 'MiniMax-M2.1'

export const ROUTER_ID = 'router'
export type CoderId = 'claude-code' | 'codex'

/**
 * The base routing instructions (HOW to route). The standing arrangement (WHO is
 * on the roster / on-call / leads / budget) is appended by `buildRouterSystem` from
 * the policy file — so editing routing-policy.json (or `:policy` in the CLI) changes
 * what the model sees, no code change. The base still tells the model to honor any
 * arrangement the USER states in the goal itself (显式分派).
 */
export const ROUTER_SYSTEM_BASE =
  'You are the router for a personal coding hub. You manage coding agents and ' +
  'dispatch the RIGHT one(s) by COMBINING two things — NOT a fixed pipeline:\n' +
  '1) Analyze the GOAL:\n' +
  '   · a trivial fix (typo / rename) → one implementer, directly;\n' +
  '   · a review/explain ask (do NOT change code) → one reviewer, no implementation;\n' +
  '   · a feature that needs design first → a lead drafts, then an implementer builds.\n' +
  '2) Honor the standing arrangement below AND any arrangement the USER states in the ' +
  'goal itself (e.g. "codex is rate-limited", "let claude-code lead", "only use one agent", ' +
  '"交给 codex 实现"): NEVER dispatch a coder marked off-call — the on-call coder covers ' +
  'that role instead; if the budget caps to one coder, the lead does BOTH the draft and ' +
  'the implementation itself.\n' +
  'Dispatch with the `dispatch_task` tool: set `agentId` to a coder id from the roster, ' +
  'and put the concrete instruction in `payload.prompt`. Dispatch one agent per call ' +
  'and wait for it to finish (PROGRESS.md carries the handoff) before the next. When ' +
  'the work is routed and done, reply with ONE line naming who you routed and why.'

/** Base instructions + the standing arrangement rendered from the policy file. */
export function buildRouterSystem(policy: RoutingPolicy = DEFAULT_CODING_POLICY): string {
  return `${ROUTER_SYSTEM_BASE}\n\n${renderPolicyForPrompt(policy)}`
}

/**
 * MiniMax M2.1 is a reasoning model: it prepends a `<think>…</think>` block to its
 * final assistant message (the OpenAIProvider still parses tool_calls correctly
 * alongside it). Strip it so the router's one-line summary prints clean.
 */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

/**
 * The router LlmAgent — MiniMax brain + a dispatch tool scoped to the two coders.
 * `policy` is the standing arrangement (the roster / who's on-call / budget); it is
 * rendered into the system prompt, so re-calling makeRouter with an edited policy
 * (what the CLI's `:policy` does) gives the model the new arrangement.
 */
export function makeRouter(hub: Hub, apiKey: string, policy: RoutingPolicy = DEFAULT_CODING_POLICY): LlmAgent {
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
    system: buildRouterSystem(policy),
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
    // The real CLI inherits ambient env and uses its OWN login (~/.claude.json /
    // ~/.codex/auth.json). We inject NO API key — the router's key stays the router's.
    // BUT we scrub the Claude Code "nesting" markers: this hub may itself be driven
    // from a Claude Code session (CLAUDECODE=1), and an inherited marker makes a child
    // `claude` refuse to run ("already inside Claude Code"). Deleting only the markers
    // (buildEnv treats `undefined` as delete) keeps login resolution intact — login is
    // file/keychain-based, not env-based. Harmless no-op for codex / the stub.
    env: stub ? undefined : { CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CLAUDE_CODE_SSE_PORT: undefined },
    gate: dangerousCommandGate(),
    timeoutMs: 240_000,
    onChunk: onChunk ?? ((_taskId, chunk) => process.stdout.write(`        │ ${chunk.text.replace(/\n+$/, '')}\n`)),
  })
}
