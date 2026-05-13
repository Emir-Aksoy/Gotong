import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
    runtime: {
      pendingApps: '',
      adminSessions: '',
      workerSessions: '',
    },
  }

  private constructor(root: string) {
    this.root = root
    this.paths.space = join(root, 'space.json')
    this.paths.config = join(root, 'config.json')
    this.paths.admins = join(root, 'admins.json')
    this.paths.agents = join(root, 'agents.json')
    this.paths.workers = join(root, 'workers.json')
    this.paths.transcript = join(root, 'transcript.jsonl')
    this.paths.runtime.pendingApps = join(root, 'runtime', 'pending-apps.json')
    this.paths.runtime.adminSessions = join(root, 'runtime', 'admin-sessions.json')
    this.paths.runtime.workerSessions = join(root, 'runtime', 'worker-sessions.json')
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
}

export interface AgentRecord {
  id: ParticipantId
  allowedCapabilities: readonly string[]
  apiKeyHash?: string
  createdAt: string
  lastSeen?: string
}

export interface WorkerRecord {
  id: ParticipantId
  capabilities: readonly string[]
  tokenHash: string
  createdAt: string
  lastSeen?: string
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
