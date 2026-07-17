/**
 * `gotong model [--url <hub>] [--token <admin>] [--agent <id>]` — LSA-M6, the
 * interactive model selector. Walks a member/operator from「想换个模型」to a
 * SAVED, PROBED agent config in one terminal session:
 *
 *   pick agent → pick provider (LSA-M3 curated catalog / native / custom)
 *   → paste key (muted input) → pick model (LIVE `GET /models` when possible)
 *   → probe (hub's real `POST /api/admin/test-llm-key`, the same buildProvider
 *     chain the agent will actually use) → save (PUT, full-field echo).
 *
 * Deliberate shape decisions (each verified against the codebase, 2026-07-17):
 *
 *  - API-driven like `provision` (Bearer admin token, CLI touches no disk
 *    state). The offline agents.json path was REJECTED: writing a key needs
 *    the vault master key, and the CLI is deliberately stateless about vaults
 *    (same stance as `wechat-login`).
 *  - EDIT-ONLY: configuring an EXISTING managed agent. Creation is covered by
 *    the wizard / gallery / admin panel; this command does one thing.
 *  - PUT is a whole-spec replace, so the body is built from the agent's own
 *    `GET /:id/export` manifest and every field is echoed (fallbacks /
 *    apiKeyEnv / maintenanceModel / heartbeat / …) — capture-echo, the MR-M2
 *    panel discipline. Agents with INLINE `mcpServers` are refused loudly:
 *    the PUT contract cannot round-trip that field (registry `useMcpServers`
 *    echoes fine).
 *  - apiKeyEnv exclusivity (MR-M6): entering a NEW key, or switching the
 *    endpoint, DROPS a previously-set `apiKeyEnv` binding and says so —
 *    keeping it would make the spawn use the OLD wallet against the NEW
 *    endpoint (or silently ignore the key just pasted).
 *  - The key is read with echo muted, sent ONLY to the hub (probe + save) and
 *    to the chosen provider's official `/models` endpoint as an auth header;
 *    it is never printed, never a CLI arg, never in a URL.
 *  - The catalog is the shared `CURATED_LLM_PROVIDERS` constant from
 *    `@gotong/llm` (moved there for this command — cli cannot depend on
 *    `@gotong/host`, host already depends on cli). Red line unchanged from
 *    LSA-M3: the HUMAN registers and pastes the key; nothing here scrapes.
 *
 * Exit codes mirror `provision`: 0 saved (or clean cancel via --help), 1
 * failure/cancel, 2 usage error.
 */

import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'

import {
  CURATED_LLM_PROVIDERS,
  llmProviderTierZh,
  type ButlerLlmProviderOption,
} from '@gotong/llm'

// ── flags ───────────────────────────────────────────────────────────────────

export interface ModelFlags {
  url: string
  token: string
  agent?: string
  insecure?: boolean
}

const DEFAULT_URL = 'http://127.0.0.1:3000'

/**
 * True when the URL is plaintext http to a non-loopback host — the admin token
 * AND the pasted API key would cross the network unencrypted. (An unparseable
 * URL returns false; fetch fails loudly on it later anyway.)
 */
function isPlaintextNonLoopback(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:') return false
  const h = u.hostname
  return !(h === 'localhost' || h === '[::1]' || h === '::1' || h.startsWith('127.'))
}

/** Parse argv. Returns flags, `'help'`, or a usage-error string (exit 2). */
export function parseModelArgs(argv: readonly string[]): ModelFlags | string | 'help' {
  let url = DEFAULT_URL
  let token: string | undefined
  let agent: string | undefined
  let insecure = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--help' || a === '-h') return 'help'
    if (a === '--insecure') {
      insecure = true
      continue
    }
    if (a === '--url' || a === '--token' || a === '--agent') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) return `${a} 需要一个值`
      if (a === '--url') url = v
      else if (a === '--token') token = v
      else agent = v
      continue
    }
    return `不认识的旗标:${a}(支持 --url --token --agent --insecure)`
  }
  if (!token) return '缺 --token <admin token>(与 gotong provision 同一种令牌)'
  const cleaned = url.replace(/\/+$/, '')
  // Credential discipline: this command sends the admin token AND a pasted API
  // key in headers — plaintext http off-box would expose both on the wire.
  if (!insecure && isPlaintextNonLoopback(cleaned)) {
    return `--url 是明文 http 且不在本机回环(${cleaned}):admin 令牌与 API key 会明文走网。改用 https;确是自己内网、自担风险则加 --insecure`
  }
  return { url: cleaned, token, ...(agent ? { agent } : {}), ...(insecure ? { insecure: true } : {}) }
}

// ── injectable IO ───────────────────────────────────────────────────────────

/** Terminal IO seam — tests inject a scripted fake; `readSecret` never echoes. */
export interface ModelIo {
  /** Read one line (no trailing newline). `null` = EOF/closed → treat as cancel. */
  read(prompt: string): Promise<string | null>
  /** Read one line with echo MUTED (key entry). `null` = EOF → cancel. */
  readSecret(prompt: string): Promise<string | null>
  write(chunk: string): void
  close(): void
}

/** Real readline-backed IO. Echo-muting uses the classic muted-Writable trick. */
export function makeModelIo(): ModelIo {
  let muted = false
  const out = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      if (!muted) process.stdout.write(chunk)
      cb()
    },
  })
  const rl = createInterface({
    input: process.stdin,
    output: out,
    terminal: process.stdin.isTTY ?? false,
  })
  const ask = (prompt: string): Promise<string | null> =>
    new Promise((resolve) => {
      let settled = false
      const onClose = () => {
        if (!settled) {
          settled = true
          resolve(null)
        }
      }
      rl.once('close', onClose)
      rl.question(prompt, (answer) => {
        rl.removeListener('close', onClose)
        if (!settled) {
          settled = true
          resolve(answer)
        }
      })
    })
  return {
    read: (p) => ask(p),
    readSecret: async (p) => {
      process.stdout.write(p)
      muted = true
      try {
        return await ask('')
      } finally {
        muted = false
        process.stdout.write('\n')
      }
    },
    write: (chunk) => process.stdout.write(chunk),
    close: () => rl.close(),
  }
}

// ── pure halves (unit-tested directly) ──────────────────────────────────────

/** What the interactive flow settles on before saving. */
export interface ModelSelection {
  provider: 'anthropic' | 'openai' | 'openai-compatible' | 'mock'
  baseURL?: string
  providerLabel?: string
  /** `undefined` = leave unset (provider default). */
  model?: string
  /** `undefined` = don't touch the stored key. Never ''. */
  apiKey?: string
}

/** True when the exported spec carries INLINE mcpServers (PUT can't echo them). */
export function hasInlineMcpServers(agent: Record<string, unknown>): boolean {
  const m = agent.mcpServers
  return Array.isArray(m) && m.length > 0
}

/**
 * Build the PUT body from the agent's exported manifest + the selection.
 * Everything not being changed is echoed verbatim (PUT is a whole-spec
 * replace). Returns the dropped `apiKeyEnv` name (if any) so the caller can
 * tell the user — see the header for why keeping it would lie.
 */
export function buildPutBody(
  exported: Record<string, unknown>,
  sel: ModelSelection,
): { body: Record<string, unknown>; droppedApiKeyEnv?: string } {
  const body: Record<string, unknown> = { ...exported }
  delete body.kind // export carries `kind: 'llm'`; the PUT contract doesn't take it
  const prevProvider = typeof exported.provider === 'string' ? exported.provider : undefined
  const prevBase = typeof exported.baseURL === 'string' ? exported.baseURL : undefined

  body.provider = sel.provider
  if (sel.model !== undefined) body.model = sel.model
  else delete body.model
  if (sel.provider === 'openai-compatible') {
    body.baseURL = sel.baseURL
    if (sel.providerLabel) body.providerLabel = sel.providerLabel
    else delete body.providerLabel
  } else {
    delete body.baseURL
    delete body.providerLabel
  }
  if (sel.apiKey !== undefined) body.apiKey = sel.apiKey

  let droppedApiKeyEnv: string | undefined
  const prevEnv = typeof exported.apiKeyEnv === 'string' ? exported.apiKeyEnv : undefined
  if (prevEnv) {
    const endpointChanged =
      sel.provider !== prevProvider ||
      (sel.provider === 'openai-compatible' && sel.baseURL !== prevBase)
    if (sel.apiKey !== undefined || endpointChanged) {
      delete body.apiKeyEnv
      droppedApiKeyEnv = prevEnv
    }
  }
  return { body, ...(droppedApiKeyEnv ? { droppedApiKeyEnv } : {}) }
}

/**
 * List models LIVE from the provider (OpenAI wire `GET /models`; Anthropic's
 * native equivalent). Returns null on ANY failure — the flow falls back to
 * manual entry, it never blocks on this convenience.
 */
export async function listRemoteModels(
  provider: 'anthropic' | 'openai' | 'openai-compatible',
  baseURL: string | undefined,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<string[] | null> {
  let url: string
  let headers: Record<string, string>
  if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/models'
    headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  } else if (provider === 'openai') {
    url = 'https://api.openai.com/v1/models'
    headers = { authorization: `Bearer ${apiKey}` }
  } else {
    if (!baseURL) return null
    url = `${baseURL.replace(/\/+$/, '')}/models`
    headers = { authorization: `Bearer ${apiKey}` }
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 10_000)
  try {
    const res = await fetchImpl(url, { headers, signal: ac.signal })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> }
    if (!Array.isArray(json.data)) return null
    const ids = json.data
      .map((m) => (typeof m.id === 'string' ? m.id : ''))
      .filter((s) => s.length > 0)
    return ids.length > 0 ? ids : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ── hub admin API helper ────────────────────────────────────────────────────

async function api(
  fetchImpl: typeof fetch,
  method: string,
  url: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 30_000)
  try {
    const res = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ac.signal,
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return { status: res.status, json }
  } finally {
    clearTimeout(timer)
  }
}

// ── interactive flow ────────────────────────────────────────────────────────

/** Thrown on EOF / explicit quit — unwinds to one「已取消」message, exit 1. */
class Cancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

async function readLine(io: ModelIo, prompt: string): Promise<string> {
  const line = await io.read(prompt)
  if (line === null) throw new Cancelled()
  return line.trim()
}

/** Loop until a number in [min, max] (or throw Cancelled on EOF). */
async function pickNumber(io: ModelIo, prompt: string, min: number, max: number): Promise<number> {
  for (;;) {
    const line = await readLine(io, prompt)
    const n = Number.parseInt(line, 10)
    if (Number.isInteger(n) && String(n) === line && n >= min && n <= max) return n
    io.write(`请输入 ${min}–${max} 之间的序号\n`)
  }
}

interface AgentRow {
  id: string
  displayName?: string
  managed?: unknown
  online?: boolean
}

function errText(json: Record<string, unknown>, status: number): string {
  const e = json.error
  return typeof e === 'string' && e ? e : `HTTP ${status}`
}

interface ModelDeps {
  io: ModelIo
  fetchImpl: typeof fetch
}

/** The whole interactive session. Split from `model()` so tests drive it with fakes. */
export async function runModelSelector(flags: ModelFlags, deps: ModelDeps): Promise<number> {
  const { io, fetchImpl } = deps
  const base = flags.url

  // 1. pick the agent -------------------------------------------------------
  const listRes = await api(fetchImpl, 'GET', `${base}/api/admin/agents`, flags.token)
  if (listRes.status === 401 || listRes.status === 403) {
    io.write(`✗ 认证失败(${listRes.status}):--token 不对或权限不足(要 admin 令牌,与 gotong provision 同款)\n`)
    return 1
  }
  if (listRes.status !== 200) {
    io.write(`✗ 拉取 agent 列表失败:${errText(listRes.json, listRes.status)}\n`)
    return 1
  }
  const allAgents = Array.isArray(listRes.json.agents) ? (listRes.json.agents as AgentRow[]) : []
  const managed = allAgents.filter((a) => a && typeof a.id === 'string' && a.managed)
  if (managed.length === 0) {
    io.write('这个 hub 上还没有托管 agent。先用向导 / 模板画廊 / 面板建一个,再回来配模型。\n')
    return 1
  }

  let agentId: string
  if (flags.agent) {
    const hit = managed.find((a) => a.id === flags.agent)
    if (!hit) {
      io.write(`✗ 找不到托管 agent '${flags.agent}'(外接 agent 没有可配的模型)\n`)
      return 1
    }
    agentId = hit.id
  } else if (managed.length === 1) {
    agentId = managed[0]!.id
    io.write(`只有一个托管 agent:${agentId}${managed[0]!.displayName ? ` — ${managed[0]!.displayName}` : ''}\n`)
  } else {
    io.write('要给哪个 agent 配模型?\n')
    managed.forEach((a, i) => {
      io.write(`  ${i + 1}. ${a.id}${a.displayName ? ` — ${a.displayName}` : ''}${a.online ? ' [在线]' : ''}\n`)
    })
    const n = await pickNumber(io, '选序号: ', 1, managed.length)
    agentId = managed[n - 1]!.id
  }

  // 2. capture the current spec (full-field echo source) --------------------
  const expRes = await api(
    fetchImpl,
    'GET',
    `${base}/api/admin/agents/${encodeURIComponent(agentId)}/export`,
    flags.token,
  )
  if (expRes.status !== 200) {
    io.write(`✗ 导出 '${agentId}' 当前配置失败:${errText(expRes.json, expRes.status)}\n`)
    return 1
  }
  const exported = (expRes.json.agent ?? {}) as Record<string, unknown>
  // The PUT contract rebuilds the spec as kind:'llm' unconditionally — editing
  // any other kind through this command would silently DEMOTE it. Refuse.
  if (typeof exported.kind === 'string' && exported.kind !== 'llm') {
    io.write(
      `✗ '${agentId}' 是 kind=${exported.kind} 的特殊 agent,编辑接口会把它降级成普通 llm。\n` +
        '  这类 agent 请走 导出 → 手改 manifest → 重新导入。\n',
    )
    return 1
  }
  if (hasInlineMcpServers(exported)) {
    io.write(
      `✗ '${agentId}' 带内联 mcpServers 配置,而编辑接口无法原样带回它(会静默丢失)。\n` +
        '  这类 agent 请走 导出 → 手改 manifest → 重新导入,或在面板迁到 MCP 注册表(useMcpServers)后再用本命令。\n',
    )
    return 1
  }

  const curProvider = typeof exported.provider === 'string' ? exported.provider : '(未知)'
  const curModel = typeof exported.model === 'string' ? exported.model : undefined
  const curBase = typeof exported.baseURL === 'string' ? exported.baseURL : undefined
  const curLabel = typeof exported.providerLabel === 'string' ? exported.providerLabel : undefined
  const curEnv = typeof exported.apiKeyEnv === 'string' ? exported.apiKeyEnv : undefined
  const fallbackCount = Array.isArray(exported.fallbacks) ? exported.fallbacks.length : 0
  io.write(
    `当前:provider=${curProvider}${curLabel ? `(${curLabel})` : ''}` +
      `${curBase ? ` baseURL=${curBase}` : ''} model=${curModel ?? '(provider 默认)'}` +
      `${curEnv ? ` apiKeyEnv=${curEnv}` : ''}${fallbackCount ? ` 备用链=${fallbackCount} 条` : ''}\n\n`,
  )

  // 3. pick the provider ----------------------------------------------------
  io.write('选 provider:\n')
  io.write('  0. 只换模型(沿用当前 provider 与 key)\n')
  CURATED_LLM_PROVIDERS.forEach((o, i) => {
    io.write(`  ${i + 1}. 【${llmProviderTierZh(o.tier)}】${o.name} — ${o.whatFor}\n`)
  })
  const nAnthropic = CURATED_LLM_PROVIDERS.length + 1
  const nOpenai = CURATED_LLM_PROVIDERS.length + 2
  const nCustom = CURATED_LLM_PROVIDERS.length + 3
  io.write(`  ${nAnthropic}. Anthropic 官方 API\n`)
  io.write(`  ${nOpenai}. OpenAI 官方 API\n`)
  io.write(`  ${nCustom}. 自定义 OpenAI 兼容端点\n`)
  const pick = await pickNumber(io, '选序号: ', 0, nCustom)

  let provider: ModelSelection['provider']
  let baseURL: string | undefined
  let providerLabel: string | undefined
  let catalogPick: ButlerLlmProviderOption | undefined
  if (pick === 0) {
    if (curProvider !== 'anthropic' && curProvider !== 'openai' && curProvider !== 'openai-compatible' && curProvider !== 'mock') {
      io.write(`✗ 当前 provider '${curProvider}' 无法沿用\n`)
      return 1
    }
    provider = curProvider
    baseURL = curBase
    providerLabel = curLabel
  } else if (pick <= CURATED_LLM_PROVIDERS.length) {
    catalogPick = CURATED_LLM_PROVIDERS[pick - 1]!
    provider = 'openai-compatible'
    baseURL = catalogPick.baseUrl
    providerLabel = catalogPick.name
    io.write(`\n${catalogPick.name} — 费用真相:${catalogPick.costTruth}\n`)
    io.write(`还没有 key?注册页:${catalogPick.signupUrl}(注册、拿 key 都是你来做,框架不代办)\n`)
    catalogPick.signupSteps.forEach((s, i) => io.write(`  ${i + 1}. ${s}\n`))
  } else if (pick === nAnthropic || pick === nOpenai) {
    provider = pick === nAnthropic ? 'anthropic' : 'openai'
  } else {
    provider = 'openai-compatible'
    for (;;) {
      const u = await readLine(io, 'base URL(如 https://api.example.com/v1): ')
      if (/^https?:\/\/\S+$/.test(u)) {
        baseURL = u.replace(/\/+$/, '')
        break
      }
      io.write('要一个 http(s):// 开头的 URL\n')
    }
    const label = await readLine(io, '显示名(可空,面板里区分这条端点用): ')
    if (label) providerLabel = label
  }

  // 4. the key (muted; empty = keep the stored one where that's coherent) ----
  const sameEndpointAsCurrent =
    provider === curProvider && (provider !== 'openai-compatible' || baseURL === curBase)
  let apiKey: string | undefined // undefined = keep stored key untouched
  if (pick !== 0) {
    for (;;) {
      const k = await io.readSecret(
        `API key(输入不回显${sameEndpointAsCurrent ? ',回车=沿用已存 key' : provider === 'openai-compatible' ? '' : ',回车=不带新 key'}): `,
      )
      if (k === null) throw new Cancelled()
      const key = k.trim()
      if (key) {
        apiKey = key
        break
      }
      if (sameEndpointAsCurrent) break // keep stored key
      if (provider !== 'openai-compatible') {
        // Endpoint changed + no new key: the pool PREFERS a stored per-agent
        // key over the workspace default, so if this agent stored the OLD
        // vendor's key it will be sent to the new provider and 401. Only
        // proceed on an explicit yes — never imply "workspace key will be
        // used" when a stored key would shadow it.
        io.write(
          '⚠ 没输新 key:若该 agent 之前存过 per-agent key(可能是旧厂商的),hub 会优先用它打新 provider(会 401);没存过才落到 workspace 默认 key。\n',
        )
        const go = await readLine(io, '确定不带新 key 继续?(y=继续 / 其他=回去贴 key): ')
        if (go.toLowerCase() === 'y') break
        continue
      }
      io.write('openai-compatible 需要 per-agent key(workspace 默认 key 不适用),请粘贴\n')
    }
  }

  // MR-M6 — a fallback candidate WITHOUT its own apiKeyEnv resolves through the
  // SAME single per-agent key slot a new primary key writes to: saving would
  // hand the new vendor's key to that candidate and destroy the key it relied
  // on (unrecoverable). Warn before spending the probe, act only on a yes.
  if (apiKey !== undefined) {
    const fallbacks = Array.isArray(exported.fallbacks)
      ? (exported.fallbacks as Array<Record<string, unknown>>)
      : []
    const sharedSlot = fallbacks.filter((f) => typeof f?.apiKeyEnv !== 'string' || !f.apiKeyEnv).length
    if (sharedSlot > 0) {
      io.write(
        `⚠ 备用链里有 ${sharedSlot} 条候选没配自己的 apiKeyEnv,它们与主 key 共用同一个存储槽:\n` +
          '  写入新 key 会覆盖那个槽 — 候选若靠的是另一家的 key,会被顶掉且不可恢复。\n' +
          '  想彻底分离两把 key:先在面板给候选配 apiKeyEnv(env 凭证)再来。\n',
      )
      const go = await readLine(io, '仍要写入新 key?(y=继续 / 其他=放弃): ')
      if (go.toLowerCase() !== 'y') throw new Cancelled()
    }
  }

  // 5. the model (live listing only when we HOLD a fresh key — a stored key
  //    never leaves the hub, so那条路走手动输入) ------------------------------
  let models: string[] | null = null
  if (apiKey !== undefined && provider !== 'mock') {
    models = await listRemoteModels(provider, baseURL, apiKey, fetchImpl)
    if (models === null) io.write('(拉不到该端点的模型列表,改手动输入)\n')
  } else if (pick !== 0) {
    io.write('(没有新 key 可用来拉模型列表 — key 不出 hub,改手动输入)\n')
  }
  const pickModel = async (): Promise<string | undefined> => {
    if (models && models.length > 0) {
      const shown = models.slice(0, 40)
      shown.forEach((m, i) => io.write(`  ${i + 1}. ${m}\n`))
      if (models.length > shown.length) io.write(`  …… 共 ${models.length} 个,没列出的直接输名字\n`)
      for (;;) {
        const line = await readLine(io, `选序号或直接输模型名(回车=${curModel ?? 'provider 默认'}): `)
        if (!line) return curModel
        const n = Number.parseInt(line, 10)
        if (Number.isInteger(n) && String(n) === line) {
          if (n >= 1 && n <= shown.length) return shown[n - 1]!
          io.write(`序号超界(1–${shown.length}),或直接输模型名\n`)
          continue
        }
        return line
      }
    }
    const line = await readLine(io, `模型名(回车=${curModel ?? 'provider 默认'}): `)
    return line || curModel
  }
  let model = await pickModel()

  // 6. probe through the hub (real buildProvider chain) — only meaningful
  //    when we actually hold the key we're about to save ---------------------
  if (apiKey !== undefined && provider !== 'mock') {
    probeLoop: for (;;) {
      io.write('探针:让 hub 用这把 key 发一次最小请求…\n')
      const probeRes = await api(fetchImpl, 'POST', `${base}/api/admin/test-llm-key`, flags.token, {
        provider,
        apiKey,
        ...(baseURL ? { baseURL } : {}),
        ...(model ? { model } : {}),
      })
      if (probeRes.status === 503) {
        io.write('⚠ 这个 host 没接 key 测试面(503),探不了。\n')
        const go = await readLine(io, '跳过探针直接保存?(y/N): ')
        if (go.toLowerCase() === 'y') break probeLoop
        throw new Cancelled()
      }
      if (probeRes.status !== 200) {
        io.write(`✗ 探针请求失败:${errText(probeRes.json, probeRes.status)}\n`)
        return 1
      }
      const v = probeRes.json as { ok?: boolean; code?: string; message?: string; latencyMs?: number; model?: string }
      if (v.ok) {
        io.write(`✓ 探针通过(${v.model ?? model ?? ''} ${typeof v.latencyMs === 'number' ? `${v.latencyMs}ms` : ''})\n`)
        break probeLoop
      }
      io.write(`✗ 探针失败 [${v.code ?? 'unknown'}]:${v.message ?? '(无详情)'}\n`)
      io.write('  1. 重选模型  2. 重新贴 key  3. 放弃\n')
      const act = await pickNumber(io, '选序号: ', 1, 3)
      if (act === 3) throw new Cancelled()
      if (act === 1) {
        model = await pickModel()
      } else {
        const k = await io.readSecret('API key(输入不回显): ')
        if (k === null || !k.trim()) throw new Cancelled()
        apiKey = k.trim()
      }
    }
  } else {
    io.write('(未输入新 key,跳过探针 — 保存后可在面板用「测试连接 / 测试路由」验证)\n')
  }

  // 7. save ------------------------------------------------------------------
  const sel: ModelSelection = {
    provider,
    ...(baseURL ? { baseURL } : {}),
    ...(providerLabel ? { providerLabel } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
  }
  const { body, droppedApiKeyEnv } = buildPutBody(exported, sel)
  const putRes = await api(
    fetchImpl,
    'PUT',
    `${base}/api/admin/agents/${encodeURIComponent(agentId)}`,
    flags.token,
    body,
  )
  if (putRes.status !== 200) {
    io.write(`✗ 保存失败:${errText(putRes.json, putRes.status)}\n`)
    return 1
  }
  io.write(`✓ 已保存,'${agentId}' 已按新配置重启生效:${provider}${baseURL ? ` @ ${baseURL}` : ''} / ${model ?? '(provider 默认)'}\n`)
  if (droppedApiKeyEnv) {
    io.write(
      `  注意:已解除 apiKeyEnv=${droppedApiKeyEnv} 绑定(排他语义下留着它会压住这次的改动);` +
        `${apiKey !== undefined ? '新 key 已入金库' : '这次没写新 key,hub 将按「已存 key → workspace 默认」顺序解析'}。` +
        '还想走 env 凭证就在面板重新设。\n',
    )
  }
  if (fallbackCount > 0) {
    io.write(`  备用链 ${fallbackCount} 条已原样保留;可在面板用「测试路由」逐候选验证。\n`)
  }
  return 0
}

const HELP = `gotong model [--url <hub>] [--token <admin>] [--agent <id>]

交互式给一个托管 agent 选 provider / 模型 / key:
策展目录(OpenRouter/Groq/Cerebras/Gemini/Together/DeepSeek)+ Anthropic/OpenAI
官方 + 自定义 OpenAI 兼容端点 → 贴 key(不回显)→ 现场拉模型列表 → hub 真探针
→ 保存(既有备用链等配置原样保留)。

  --url       hub 地址(默认 ${DEFAULT_URL};非本机回环的明文 http 会被拒 — 令牌与 key 不走明文)
  --token     admin 令牌(必填,与 gotong provision 同款)
  --agent     直接指定 agent id(不指定则列出来选)
  --insecure  放行非回环的明文 http(仅限自己内网,自担风险)

注册账号、拿 key 永远是你自己来 — 本命令只引导与校验,不代办、不上网捡 key。
`

/** Entry point wired in main.ts. */
export async function model(args: readonly string[], deps?: Partial<ModelDeps>): Promise<number> {
  const flags = parseModelArgs(args)
  if (flags === 'help') {
    console.log(HELP)
    return 0
  }
  if (typeof flags === 'string') {
    console.error(`用法错误:${flags}\n`)
    console.error(HELP)
    return 2
  }
  const io = deps?.io ?? makeModelIo()
  const fetchImpl = deps?.fetchImpl ?? fetch
  try {
    return await runModelSelector(flags, { io, fetchImpl })
  } catch (err) {
    if (err instanceof Cancelled) {
      io.write('已取消,未做任何改动。\n')
      return 1
    }
    throw err
  } finally {
    io.close()
  }
}
