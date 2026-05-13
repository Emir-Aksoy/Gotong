import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  decryptSecret,
  emptySecretsFile,
  encryptSecret,
  loadOrCreateMasterKey,
  type EncryptedSecret,
  type SecretsFile,
} from './secrets.js'
import { FileStorage } from './storage/file.js'
import type { ParticipantId } from './types.js'

/**
 * Space — the on-disk truth of an AipeHub workspace (v2.0).
 *
 * Everything that used to live in process memory or browser storage is now
 * a file under a `.aipehub/`-style directory. Restart the host, switch
 * machines, hand the directory to a teammate — same state shows up.
 *
 * Layout:
 *
 *   <root>/
 *     space.json                   — name, description, created_at
 *     config.json                  — host/port/heartbeat/gating/defaults
 *     admins.json                  — { admins: [{ id, displayName, tokenHash, createdAt }] }
 *     agents.json                  — { agents: [{ id, allowedCapabilities, apiKeyHash?, createdAt, lastSeen? }] }
 *     workers.json                 — { workers: [{ id, capabilities, tokenHash, createdAt, lastSeen? }] }
 *     transcript.jsonl             — append-only Hub transcript (FileStorage)
 *     runtime/
 *       pending-apps.json          — { apps: [{ id, agents, meta, pendingSince }] }
 *       admin-sessions.json        — { sessions: [{ sessionId, adminId, createdAt }] }
 *       worker-sessions.json       — { sessions: [{ sessionId, workerId, createdAt }] }
 *
 * Token storage is one-way: we store `sha256:<hex>` digests, never plaintext
 * tokens. The plaintext is returned exactly once by `createAdmin` /
 * `createWorker` so the caller can ship it to the user. Verify with the
 * matching `verifyAdminToken` / `verifyWorkerToken`.
 *
 * Writes go through `writeJsonAtomic` (write to `.tmp` then rename) so
 * power-cuts can't leave a half-written settings file.
 */
export class Space {
  readonly root: string

  // typed file paths
  readonly paths = {
    space: '',
    config: '',
    admins: '',
    agents: '',
    workers: '',
    transcript: '',
    secrets: '',
    /**
     * Hub Services root (v2.2). The host's `bootstrapServices` reads
     * `<services>/plugins.json` and gives each loaded plugin a subdir
     * `<services>/<type>/<impl>/` to put its data in. Core itself does
     * not import the services-sdk — this path is just a string the host
     * uses. Created (empty) by `Space.init`; safe to be absent at
     * `Space.open` time (host will create on demand).
     */
    services: '',
    runtime: {
      pendingApps: '',
      adminSessions: '',
      workerSessions: '',
      secretKey: '',
    },
  }
  /** Cached master key — lazily loaded the first time secrets are touched. */
  private masterKey: Buffer | null = null

  private constructor(root: string) {
    this.root = root
    this.paths.space = join(root, 'space.json')
    this.paths.config = join(root, 'config.json')
    this.paths.admins = join(root, 'admins.json')
    this.paths.agents = join(root, 'agents.json')
    this.paths.workers = join(root, 'workers.json')
    this.paths.transcript = join(root, 'transcript.jsonl')
    this.paths.secrets = join(root, 'secrets.enc.json')
    this.paths.services = join(root, 'services')
    this.paths.runtime.pendingApps = join(root, 'runtime', 'pending-apps.json')
    this.paths.runtime.adminSessions = join(root, 'runtime', 'admin-sessions.json')
    this.paths.runtime.workerSessions = join(root, 'runtime', 'worker-sessions.json')
    this.paths.runtime.secretKey = join(root, 'runtime', 'secret.key')
  }

  /**
   * Open an existing space (must already have been initialised). Throws if
   * the directory does not contain `space.json`.
   */
  static async open(root: string): Promise<Space> {
    const s = new Space(root)
    if (!existsSync(s.paths.space)) {
      throw new Error(
        `Space at '${root}' is not initialised. Call Space.init(root, { name }) first, or use Space.openOrInit(root).`,
      )
    }
    return s
  }

  /**
   * Initialise a fresh space at `root`. Creates the directory tree, writes
   * a default `space.json` / `config.json` / `admins.json` (with one
   * admin if `adminDisplayName` is supplied), and returns both the Space
   * and the plaintext admin token (or null if no admin was bootstrapped).
   */
  static async init(
    root: string,
    opts: {
      name: string
      description?: string
      adminDisplayName?: string
      config?: Partial<SpaceConfig>
    },
  ): Promise<{ space: Space; adminToken: string | null; adminId: string | null }> {
    mkdirSync(root, { recursive: true })
    mkdirSync(join(root, 'runtime'), { recursive: true })
    // services/ is created up-front so `bootstrapServices` (host-side)
    // can drop `plugins.json` and per-plugin subdirs without re-checking
    // the parent at every boot. It stays empty until plugins register.
    mkdirSync(join(root, 'services'), { recursive: true })
    const s = new Space(root)

    if (existsSync(s.paths.space)) {
      throw new Error(
        `Space at '${root}' is already initialised. Use Space.open(root) or Space.openOrInit(root) instead.`,
      )
    }

    const now = new Date().toISOString()
    writeJsonAtomicSync(s.paths.space, {
      name: opts.name,
      description: opts.description ?? '',
      createdAt: now,
      version: SPACE_FILE_VERSION,
    } satisfies SpaceMeta)
    writeJsonAtomicSync(s.paths.config, { ...DEFAULT_CONFIG, ...opts.config })
    writeJsonAtomicSync(s.paths.admins, { admins: [] })
    writeJsonAtomicSync(s.paths.agents, { agents: [] })
    writeJsonAtomicSync(s.paths.workers, { workers: [] })
    writeJsonAtomicSync(s.paths.runtime.pendingApps, { apps: [] })
    writeJsonAtomicSync(s.paths.runtime.adminSessions, { sessions: [] })
    writeJsonAtomicSync(s.paths.runtime.workerSessions, { sessions: [] })

    let adminToken: string | null = null
    let adminId: string | null = null
    if (opts.adminDisplayName) {
      const out = await s.createAdmin(opts.adminDisplayName)
      adminToken = out.token
      adminId = out.admin.id
    }

    return { space: s, adminToken, adminId }
  }

  /** Open the space at `root`, initialising it if absent. */
  static async openOrInit(
    root: string,
    opts: {
      name: string
      description?: string
      adminDisplayName?: string
      config?: Partial<SpaceConfig>
    },
  ): Promise<{ space: Space; adminToken: string | null; adminId: string | null }> {
    if (existsSync(join(root, 'space.json'))) {
      const space = await Space.open(root)
      return { space, adminToken: null, adminId: null }
    }
    return Space.init(root, opts)
  }

  // --- meta + config --------------------------------------------------------

  async meta(): Promise<SpaceMeta> {
    return readJson<SpaceMeta>(this.paths.space)
  }
  async config(): Promise<SpaceConfig> {
    const c = await readJson<Partial<SpaceConfig>>(this.paths.config)
    return { ...DEFAULT_CONFIG, ...c }
  }
  async updateConfig(patch: Partial<SpaceConfig>): Promise<SpaceConfig> {
    const current = await this.config()
    const next = { ...current, ...patch }
    await writeJsonAtomic(this.paths.config, next)
    return next
  }

  // --- admins --------------------------------------------------------------

  async admins(): Promise<AdminRecord[]> {
    const data = await readJson<{ admins: AdminRecord[] }>(this.paths.admins)
    return data.admins ?? []
  }
  async createAdmin(displayName: string): Promise<{ admin: AdminRecord; token: string }> {
    const admins = await this.admins()
    const id = uniqueId(admins.map((a) => a.id), 'admin')
    const token = mintToken()
    const admin: AdminRecord = {
      id,
      displayName,
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
    }
    admins.push(admin)
    await writeJsonAtomic(this.paths.admins, { admins })
    return { admin, token }
  }
  async removeAdmin(id: ParticipantId): Promise<boolean> {
    const admins = await this.admins()
    const next = admins.filter((a) => a.id !== id)
    if (next.length === admins.length) return false
    await writeJsonAtomic(this.paths.admins, { admins: next })
    return true
  }
  /**
   * Toggle an admin's "don't count my dispatches in the contribution
   * leaderboard" preference. Returns the updated record on success, null
   * if the id is unknown.
   */
  async setAdminContributionOptOut(
    id: ParticipantId,
    value: boolean,
  ): Promise<AdminRecord | null> {
    const admins = await this.admins()
    const idx = admins.findIndex((a) => a.id === id)
    if (idx < 0) return null
    admins[idx] = { ...admins[idx]!, contributionOptOut: value }
    await writeJsonAtomic(this.paths.admins, { admins })
    return admins[idx]!
  }
  /** Return the matched admin (without sensitive fields) on success, null on fail. */
  async verifyAdminToken(token: string | undefined): Promise<AdminRecord | null> {
    if (!token) return null
    const admins = await this.admins()
    const candidateHash = hashToken(token)
    for (const a of admins) {
      if (constantTimeEqualString(a.tokenHash, candidateHash)) return a
    }
    return null
  }

  // --- agents --------------------------------------------------------------

  async agents(): Promise<AgentRecord[]> {
    const data = await readJson<{ agents: AgentRecord[] }>(this.paths.agents)
    return data.agents ?? []
  }
  async upsertAgent(rec: Omit<AgentRecord, 'createdAt'> & { createdAt?: string }): Promise<AgentRecord> {
    const agents = await this.agents()
    const idx = agents.findIndex((a) => a.id === rec.id)
    if (idx >= 0) {
      agents[idx] = { ...agents[idx]!, ...rec, createdAt: agents[idx]!.createdAt }
    } else {
      agents.push({ ...rec, createdAt: rec.createdAt ?? new Date().toISOString() })
    }
    await writeJsonAtomic(this.paths.agents, { agents })
    return agents.find((a) => a.id === rec.id)!
  }
  async removeAgent(id: ParticipantId): Promise<boolean> {
    const agents = await this.agents()
    const next = agents.filter((a) => a.id !== id)
    if (next.length === agents.length) return false
    await writeJsonAtomic(this.paths.agents, { agents: next })
    // If this agent had a per-agent override key, drop it too so an
    // abandoned key doesn't linger in secrets.enc.json after the record
    // is gone. Best-effort: the file may not exist on a fresh space.
    await this.removeAgentApiKey(id).catch(() => { /* ignore */ })
    return true
  }
  async touchAgent(id: ParticipantId): Promise<void> {
    const agents = await this.agents()
    const idx = agents.findIndex((a) => a.id === id)
    if (idx < 0) return
    agents[idx]!.lastSeen = new Date().toISOString()
    await writeJsonAtomic(this.paths.agents, { agents })
  }

  // --- workers -------------------------------------------------------------

  async workers(): Promise<WorkerRecord[]> {
    const data = await readJson<{ workers: WorkerRecord[] }>(this.paths.workers)
    return data.workers ?? []
  }
  async createWorker(
    id: ParticipantId,
    capabilities: readonly string[],
  ): Promise<{ worker: WorkerRecord; token: string }> {
    const workers = await this.workers()
    if (workers.some((w) => w.id === id)) {
      throw new Error(`worker id '${id}' is already taken`)
    }
    const token = mintToken()
    const worker: WorkerRecord = {
      id,
      capabilities: [...capabilities],
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
    }
    workers.push(worker)
    await writeJsonAtomic(this.paths.workers, { workers })
    return { worker, token }
  }
  async removeWorker(id: ParticipantId): Promise<boolean> {
    const workers = await this.workers()
    const next = workers.filter((w) => w.id !== id)
    if (next.length === workers.length) return false
    await writeJsonAtomic(this.paths.workers, { workers: next })
    return true
  }
  /** Worker counterpart of {@link setAdminContributionOptOut}. */
  async setWorkerContributionOptOut(
    id: ParticipantId,
    value: boolean,
  ): Promise<WorkerRecord | null> {
    const workers = await this.workers()
    const idx = workers.findIndex((w) => w.id === id)
    if (idx < 0) return null
    workers[idx] = { ...workers[idx]!, contributionOptOut: value }
    await writeJsonAtomic(this.paths.workers, { workers })
    return workers[idx]!
  }
  async touchWorker(id: ParticipantId): Promise<void> {
    const workers = await this.workers()
    const idx = workers.findIndex((w) => w.id === id)
    if (idx < 0) return
    workers[idx]!.lastSeen = new Date().toISOString()
    await writeJsonAtomic(this.paths.workers, { workers })
  }
  async verifyWorkerToken(token: string | undefined): Promise<WorkerRecord | null> {
    if (!token) return null
    const workers = await this.workers()
    const candidateHash = hashToken(token)
    for (const w of workers) {
      if (constantTimeEqualString(w.tokenHash, candidateHash)) return w
    }
    return null
  }

  // --- sessions (admin + worker) -------------------------------------------

  async adminSessions(): Promise<SessionRecord[]> {
    const data = await readJson<{ sessions: SessionRecord[] }>(this.paths.runtime.adminSessions)
    return data.sessions ?? []
  }
  async addAdminSession(sessionId: string, adminId: ParticipantId): Promise<void> {
    const sessions = await this.adminSessions()
    sessions.push({ sessionId, principalId: adminId, createdAt: new Date().toISOString() })
    await writeJsonAtomic(this.paths.runtime.adminSessions, { sessions })
  }
  async findAdminSession(sessionId: string | undefined): Promise<SessionRecord | null> {
    if (!sessionId) return null
    const sessions = await this.adminSessions()
    return sessions.find((s) => s.sessionId === sessionId) ?? null
  }
  async removeAdminSession(sessionId: string): Promise<boolean> {
    const sessions = await this.adminSessions()
    const next = sessions.filter((s) => s.sessionId !== sessionId)
    if (next.length === sessions.length) return false
    await writeJsonAtomic(this.paths.runtime.adminSessions, { sessions: next })
    return true
  }

  async workerSessions(): Promise<SessionRecord[]> {
    const data = await readJson<{ sessions: SessionRecord[] }>(this.paths.runtime.workerSessions)
    return data.sessions ?? []
  }
  async addWorkerSession(sessionId: string, workerId: ParticipantId): Promise<void> {
    const sessions = await this.workerSessions()
    sessions.push({ sessionId, principalId: workerId, createdAt: new Date().toISOString() })
    await writeJsonAtomic(this.paths.runtime.workerSessions, { sessions })
  }
  async findWorkerSession(sessionId: string | undefined): Promise<SessionRecord | null> {
    if (!sessionId) return null
    const sessions = await this.workerSessions()
    return sessions.find((s) => s.sessionId === sessionId) ?? null
  }
  async removeWorkerSession(sessionId: string): Promise<boolean> {
    const sessions = await this.workerSessions()
    const next = sessions.filter((s) => s.sessionId !== sessionId)
    if (next.length === sessions.length) return false
    await writeJsonAtomic(this.paths.runtime.workerSessions, { sessions: next })
    return true
  }

  // --- pending agent applications (runtime, but persisted) -----------------

  async pendingApps(): Promise<PersistedPendingApp[]> {
    const data = await readJson<{ apps: PersistedPendingApp[] }>(this.paths.runtime.pendingApps)
    return data.apps ?? []
  }
  async writePendingApps(apps: readonly PersistedPendingApp[]): Promise<void> {
    await writeJsonAtomic(this.paths.runtime.pendingApps, { apps: [...apps] })
  }

  // --- transcript storage ---------------------------------------------------

  /** A `FileStorage` rooted at `<root>/transcript.jsonl`. */
  storage(): FileStorage {
    return new FileStorage(this.paths.transcript)
  }

  // --- secrets (v2.1) -------------------------------------------------------

  /**
   * Lazy master-key load. The key is cached on the Space instance — it's
   * needed on every spawn, and re-reading the file or env var on each
   * call would be wasteful. Tests should construct a fresh Space when
   * they want a different key.
   */
  private async getMasterKey(): Promise<Buffer> {
    if (this.masterKey) return this.masterKey
    this.masterKey = await loadOrCreateMasterKey(this.paths.runtime.secretKey)
    return this.masterKey
  }

  /**
   * Read `secrets.enc.json`. Returns an empty file shape if it doesn't
   * exist yet — a fresh space starts with no keys configured.
   */
  private async readSecretsFile(): Promise<SecretsFile> {
    try {
      const raw = await readFile(this.paths.secrets, 'utf8')
      const parsed = JSON.parse(raw) as Partial<SecretsFile>
      return {
        version: 1,
        providers: parsed.providers ?? {},
        agents: parsed.agents ?? {},
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptySecretsFile()
      throw err
    }
  }

  private async writeSecretsFile(file: SecretsFile): Promise<void> {
    await writeJsonAtomic(this.paths.secrets, file)
  }

  /**
   * List which provider-level keys are configured (workspace defaults),
   * **without** returning the plaintext. UI calls this to render
   * "anthropic ✓ openai ✗" badges. Values are timestamps of the most
   * recent set, useful for "last rotated" displays.
   */
  async listProviderApiKeys(): Promise<Record<string, string>> {
    const file = await this.readSecretsFile()
    const out: Record<string, string> = {}
    for (const [provider, enc] of Object.entries(file.providers)) {
      out[provider] = enc.updatedAt
    }
    return out
  }

  /** Decrypt and return a workspace-level provider key, or null. */
  async getProviderApiKey(provider: string): Promise<string | null> {
    const file = await this.readSecretsFile()
    const enc = file.providers[provider]
    if (!enc) return null
    const key = await this.getMasterKey()
    return decryptSecret(key, enc)
  }

  /** Set / replace a workspace-level provider key. */
  async setProviderApiKey(provider: string, plaintext: string): Promise<void> {
    if (!plaintext || plaintext.length === 0) {
      throw new Error('setProviderApiKey: plaintext must be a non-empty string')
    }
    const key = await this.getMasterKey()
    const enc = encryptSecret(key, plaintext)
    const file = await this.readSecretsFile()
    file.providers[provider] = enc
    await this.writeSecretsFile(file)
  }

  /** Remove a workspace-level provider key. Returns true if one was removed. */
  async removeProviderApiKey(provider: string): Promise<boolean> {
    const file = await this.readSecretsFile()
    if (!file.providers[provider]) return false
    delete file.providers[provider]
    await this.writeSecretsFile(file)
    return true
  }

  /** Like {@link listProviderApiKeys} but for per-agent overrides. */
  async listAgentApiKeys(): Promise<Record<string, string>> {
    const file = await this.readSecretsFile()
    const out: Record<string, string> = {}
    for (const [id, enc] of Object.entries(file.agents)) out[id] = enc.updatedAt
    return out
  }

  /** Decrypt and return a per-agent key, or null. */
  async getAgentApiKey(agentId: ParticipantId): Promise<string | null> {
    const file = await this.readSecretsFile()
    const enc = file.agents[agentId]
    if (!enc) return null
    const key = await this.getMasterKey()
    return decryptSecret(key, enc)
  }

  /** Set / replace a per-agent key. */
  async setAgentApiKey(agentId: ParticipantId, plaintext: string): Promise<void> {
    if (!plaintext || plaintext.length === 0) {
      throw new Error('setAgentApiKey: plaintext must be a non-empty string')
    }
    const key = await this.getMasterKey()
    const enc = encryptSecret(key, plaintext)
    const file = await this.readSecretsFile()
    file.agents[agentId] = enc
    await this.writeSecretsFile(file)
  }

  /** Remove a per-agent key (and called automatically by `removeAgent`). */
  async removeAgentApiKey(agentId: ParticipantId): Promise<boolean> {
    const file = await this.readSecretsFile()
    if (!file.agents[agentId]) return false
    delete file.agents[agentId]
    await this.writeSecretsFile(file)
    return true
  }
}

// --- types -----------------------------------------------------------------

export const SPACE_FILE_VERSION = 1

export interface SpaceMeta {
  name: string
  description: string
  createdAt: string
  version: number
}

export interface SpaceConfig {
  host: string
  webPort: number
  wsPort: number
  heartbeatIntervalMs: number
  gating: 'open' | 'admin-approval'
  defaultLang: 'zh' | 'en'
  /**
   * When true, admin / worker cookies carry the `Secure` flag so browsers
   * only send them over HTTPS. Turn this on for any production deployment
   * fronted by TLS (Caddy / nginx / Cloudflare). Leave false for local /
   * LAN HTTP — `Secure` over HTTP makes browsers silently drop the cookie
   * and login appears to "succeed but never stick".
   */
  cookieSecure: boolean
}

export const DEFAULT_CONFIG: SpaceConfig = {
  host: '127.0.0.1',
  webPort: 3000,
  wsPort: 4000,
  heartbeatIntervalMs: 30_000,
  gating: 'admin-approval',
  defaultLang: 'zh',
  cookieSecure: false,
}

export interface AdminRecord {
  id: ParticipantId
  displayName: string
  tokenHash: string
  createdAt: string
  /**
   * If true, the contribution leaderboard ignores tasks this admin
   * dispatches. Personal preference — does **not** affect contributions
   * the admin themselves earns by completing other people's tasks. The
   * Web layer reads this when a logged-in admin POSTs to
   * `/api/admin/dispatch` and stamps `Task.countContribution` on the
   * outgoing task. Defaults to false (= "count my dispatches").
   */
  contributionOptOut?: boolean
}

export interface AgentRecord {
  id: ParticipantId
  allowedCapabilities: readonly string[]
  apiKeyHash?: string
  createdAt: string
  lastSeen?: string
  /**
   * Optional managed-agent spec (v2.1). When present, the **host process**
   * is expected to spawn an in-process agent that matches this spec on
   * boot and on `AgentSupervisor.start(record)`. The agent appears to the
   * Hub like any other registered participant — humans don't see the
   * difference.
   *
   * Absent `managed` means "I'm an externally-connected agent (SDK over
   * WS); just an allowlist entry to remember the id + caps." Both shapes
   * coexist in `agents.json`.
   */
  managed?: ManagedAgentSpec
  /**
   * Optional human-readable display name, shown in the admin UI alongside
   * the id. Useful when the id is opaque (e.g. `writer-zh-1`) but you
   * want "中文写作助手" in the list. Free text, no business logic.
   */
  displayName?: string
}

/**
 * Recipe for an agent the **host** will spawn in-process and keep alive.
 * The `kind` discriminator gives us room to grow (webhook-driven agents,
 * shell-command agents, …); today only `llm` exists.
 *
 * **Why providers are strings, not classes**: the agents.json file must
 * be readable & writable by people who can't reach into the running
 * process. The host's `AgentSupervisor` maps a provider string to a
 * concrete `LlmProvider` implementation at spawn time. Unknown providers
 * fail loudly with a clear error.
 */
export interface ManagedAgentSpec {
  kind: 'llm'
  /**
   * Provider name. Mapped to a concrete `LlmProvider` by the host. API
   * keys come from the host's environment — never from this file. The
   * four built-in providers are:
   *   - `'anthropic'`          — needs `ANTHROPIC_API_KEY`
   *   - `'openai'`             — needs `OPENAI_API_KEY`
   *   - `'openai-compatible'`  — any OpenAI-compatible HTTP endpoint
   *                              (DeepSeek, Qwen / DashScope, Zhipu,
   *                              Moonshot, Ollama, vLLM, …). Requires a
   *                              per-agent `apiKey` (workspace defaults
   *                              don't apply because every baseURL is a
   *                              different vendor) and a `baseURL`.
   *   - `'mock'`               — no key needed; canned responses for testing
   */
  provider: 'anthropic' | 'openai' | 'openai-compatible' | 'mock'
  /** Model id understood by the provider (e.g. `claude-opus-4-7`). */
  model?: string
  /** System prompt. Free-form. Length is not limited by the Hub. */
  system: string
  /**
   * Default weight the host stamps on outgoing tasks **dispatched by this
   * agent** (if/when agents can dispatch). Does not affect tasks the
   * agent receives. Same range as `Task.weight`: [0.1, 10.0], 1 decimal.
   */
  weightDefault?: number
  /**
   * API base URL — **required** when `provider === 'openai-compatible'`,
   * ignored otherwise. Must point at an OpenAI-compatible
   * `/v1/chat/completions` endpoint. Examples:
   *   - DeepSeek:  `https://api.deepseek.com/v1`
   *   - Qwen:      `https://dashscope.aliyuncs.com/compatible-mode/v1`
   *   - Zhipu:     `https://open.bigmodel.cn/api/paas/v4`
   *   - Moonshot:  `https://api.moonshot.cn/v1`
   *   - Ollama:    `http://localhost:11434/v1`
   *   - vLLM:      `http://your-host:8000/v1`
   */
  baseURL?: string
  /**
   * Optional human-readable label for an `'openai-compatible'` provider,
   * surfaced in logs and the admin UI (e.g. `"DeepSeek"`, `"通义千问"`,
   * `"Ollama local"`). Falls back to the host portion of `baseURL` when
   * omitted. Ignored for other provider strings.
   */
  providerLabel?: string
}

export interface WorkerRecord {
  id: ParticipantId
  capabilities: readonly string[]
  tokenHash: string
  createdAt: string
  lastSeen?: string
  /**
   * If true, the contribution leaderboard ignores tasks this worker
   * dispatches. Same semantics as `AdminRecord.contributionOptOut` —
   * personal preference, only affects their own outgoing dispatches.
   * Workers can't dispatch tasks through the Web UI today (no
   * `/api/worker/dispatch` route), but the field is wired through the
   * Hub already so it kicks in the moment that route exists.
   */
  contributionOptOut?: boolean
}

export interface SessionRecord {
  sessionId: string
  principalId: ParticipantId
  createdAt: string
}

export interface PersistedPendingApp {
  id: string
  agents: ReadonlyArray<{ id: ParticipantId; capabilities: readonly string[] }>
  meta?: Readonly<Record<string, unknown>>
  pendingSince: number
}

/**
 * Lifecycle hooks the Web layer calls when an admin creates / edits /
 * removes a managed agent through the HTTP API. The host implements
 * this interface via its `AgentSupervisor`; the Web layer talks to that
 * interface, so `@aipehub/web` never has to import `@aipehub/llm-*`
 * directly. Pass an implementation on `serveWeb({ lifecycle })`.
 *
 * Implementations should be **idempotent**: `start` on an already-running
 * id is a reload; `stop` on a missing id is a no-op. The Web layer
 * doesn't pre-check, just calls.
 */
export interface ManagedAgentLifecycle {
  /** Spawn (or restart) a managed agent from its persisted record. */
  start(record: AgentRecord): Promise<void>
  /** Tear down a managed agent by id. */
  stop(id: ParticipantId): Promise<void>
  /**
   * Which provider strings can actually be spawned right now. A provider
   * is available if any of three sources supplies an API key:
   *   - the per-provider workspace-level key (encrypted on disk)
   *   - the host's environment variable
   *   - `mock` — always available, needs no key
   *
   * Async because the check reads the encrypted-secrets file. The UI
   * uses the result to surface "key not set" hints on the agent-create
   * form (it still allows saving — an agent can carry its own key).
   */
  availableProviders(): Promise<readonly string[]>
}

// --- helpers ---------------------------------------------------------------

function mintToken(): string {
  // 32 bytes = 256 bits of entropy, hex-encoded for URL-safety.
  return randomBytes(32).toString('hex')
}

function hashToken(token: string): string {
  return 'sha256:' + createHash('sha256').update(token).digest('hex')
}

function constantTimeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return timingSafeEqual(ab, bb)
}

function uniqueId(existing: readonly ParticipantId[], base: string): ParticipantId {
  if (!existing.includes(base)) return base
  let i = 2
  while (existing.includes(`${base}-${i}`)) i += 1
  return `${base}-${i}`
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf8')
  return JSON.parse(raw) as T
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  await rename(tmp, path)
}

function writeJsonAtomicSync(path: string, data: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}
