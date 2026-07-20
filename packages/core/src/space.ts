import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { chmod, lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Codes used by {@link SpaceUnsafeError} so callers can branch on
 * "wrong owner" vs "symlink" without parsing the human-readable
 * message. Exported for tests and for hosts that want to surface a
 * specific actionable hint in their UI.
 */
export type SpaceUnsafeCode =
  | 'workspace_symlink'
  | 'workspace_wrong_owner'
  | 'workspace_not_directory'

/**
 * Thrown by `Space.init` / `Space.open` when the workspace root or one
 * of its sensitive children fails the filesystem-trust checks added
 * in v3.4 (see AUDIT-v3.3.md finding H7). Two attack scenarios this
 * defends against:
 *
 *   1. Symlink pre-staging — attacker on a shared host creates
 *      `<root>/runtime/secret.key` as a symbolic link to a victim's
 *      file BEFORE the victim runs `gotong-host`. Without this check
 *      our `writeFile(secret.key, …)` would follow the symlink and
 *      overwrite the victim's file with random key material.
 *
 *   2. Workspace-root hijack — attacker creates `<root>` itself as a
 *      symlink (or as a regular dir owned by their uid). Our writes
 *      would either land in the attacker's territory or — worse —
 *      land in the symlink target (e.g. the victim's home directory).
 *
 * The check is strictly POSIX. On Windows we skip both the symlink
 * and the ownership test: NTFS ACLs are the real boundary there and
 * `process.getuid` isn't defined.
 */
export class SpaceUnsafeError extends Error {
  readonly code: SpaceUnsafeCode
  readonly path: string
  constructor(message: string, code: SpaceUnsafeCode, path: string) {
    super(message)
    this.name = 'SpaceUnsafeError'
    this.code = code
    this.path = path
  }
}

/**
 * Workspace root directory mode — owner-only. Pairs with `SECURE_FILE_MODE`
 * (see `./fs-atomic.js`) so that even if an individual file slips through
 * (e.g. tmp file from a third-party tool), the parent directory denies
 * traversal.
 */
const SECURE_DIR_MODE = 0o700

import {
  decryptSecret,
  emptySecretsFile,
  encryptSecret,
  loadOrCreateMasterKey,
  type EncryptedSecret,
  type SecretsFile,
} from './secrets.js'
import {
  SECURE_FILE_MODE,
  writeJsonAtomic,
  writeJsonAtomicSync,
} from './fs-atomic.js'
import { FileStorage } from './storage/file.js'
import { DEFAULT_TENANT } from './tenant.js'
import type { ParticipantId } from './types.js'

/**
 * Space — the on-disk truth of an Gotong workspace (v2.0).
 *
 * Everything that used to live in process memory or browser storage is now
 * a file under a `.gotong/`-style directory. Restart the host, switch
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
    /**
     * Hub-level MCP server registry (`mcp-servers.json`). A named set of
     * MCP servers installed once at hub scope; agents opt into them by
     * name via `ManagedAgentSpec.useMcpServers` (the `uses:`-for-services
     * analogue). File-first so `cp -r .gotong` carries the installed
     * integrations with the room.
     */
    mcpServers: '',
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
  /**
   * Per-file write serialisation. Read-modify-write methods (upsertAgent,
   * touchWorker, addAdminSession, set*ApiKey, …) used to lose updates
   * when two callers raced: both read the same JSON, both modified
   * their own copy, both wrote — last write wins, first write's diff
   * silently disappears. `withFileLock(path, fn)` chains every
   * mutation through a per-path promise so the read-modify-write
   * window is single-threaded for that file. Reads (admins(), agents(),
   * …) intentionally bypass the lock — they're snapshot-y and the
   * caller doesn't expect transactional reads.
   */
  private readonly fileLocks = new Map<string, Promise<unknown>>()

  private constructor(root: string) {
    this.root = root
    this.paths.space = join(root, 'space.json')
    this.paths.config = join(root, 'config.json')
    this.paths.admins = join(root, 'admins.json')
    this.paths.agents = join(root, 'agents.json')
    this.paths.workers = join(root, 'workers.json')
    this.paths.mcpServers = join(root, 'mcp-servers.json')
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
    // H7: refuse to open a workspace whose root or sensitive files
    // have been replaced with symlinks, or whose ownership doesn't
    // match the running user. Runs BEFORE any read so the attacker
    // can't read victim files through us.
    await s.assertSafeWorkspaceLocation()
    // C4: migrate pre-3.4 workspaces in place: chmod sensitive files
    // to 0o600 if they were created when the default umask was 0o022.
    // Idempotent — files already 0o600 see no observable change. Files
    // not yet created (typical on a freshly-opened workspace) ENOENT
    // and are silently skipped; they'll be written with the secure
    // mode by their first writer.
    await s.hardenFilePermissions()
    return s
  }

  /**
   * Verify the workspace root and its sensitive children are not
   * symbolic links and (on POSIX) are owned by the current effective
   * uid. Called from `Space.init` (after the mkdir cascade, before
   * the first write) and from `Space.open` (before any read).
   *
   * Throws {@link SpaceUnsafeError} with one of three codes:
   *
   *   - `workspace_symlink` — the root or a sensitive child is a
   *     symlink. Following it would let an attacker who pre-staged
   *     the link redirect our writes outside the intended workspace.
   *
   *   - `workspace_wrong_owner` — POSIX uid mismatch. The dir or
   *     file is owned by a different user. Operating on it would
   *     trust state we didn't create.
   *
   *   - `workspace_not_directory` — the root exists but isn't a
   *     directory. Most likely an operator typo (e.g.
   *     `GOTONG_SPACE=/some/file.json`); fail loud.
   *
   * No-op on Windows (NTFS ACLs are the trust boundary, not POSIX
   * mode bits / uid). Tolerates ENOENT on individual files — many of
   * them don't exist on first init.
   *
   * See AUDIT-v3.3.md finding H7.
   */
  private async assertSafeWorkspaceLocation(): Promise<void> {
    if (process.platform === 'win32') return
    // `process.getuid` is undefined on Windows (already filtered
    // above) but TypeScript types it as `(() => number) | undefined`
    // so we still need to narrow.
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : undefined

    const checkOne = async (path: string, mustExist: boolean): Promise<void> => {
      let stat
      try {
        stat = await lstat(path)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT' && !mustExist) return
        throw err
      }
      if (stat.isSymbolicLink()) {
        throw new SpaceUnsafeError(
          `refusing to open workspace: '${path}' is a symbolic link. ` +
            `An attacker who pre-stages a symlink here can redirect our ` +
            `writes to a file outside the workspace.`,
          'workspace_symlink',
          path,
        )
      }
      if (expectedUid !== undefined && stat.uid !== expectedUid) {
        throw new SpaceUnsafeError(
          `refusing to open workspace: '${path}' is owned by uid ${stat.uid}, ` +
            `but this process is running as uid ${expectedUid}. ` +
            `The workspace must be owned by the user that runs gotong-host.`,
          'workspace_wrong_owner',
          path,
        )
      }
    }

    // 1. The root itself must be a real directory (not a symlink) and
    //    owned by us. Required to exist — caller has already done the
    //    mkdir.
    let rootStat
    try {
      rootStat = await lstat(this.root)
    } catch (err) {
      // `Space.open` callsite already checked existsSync(space.json)
      // upstream, so an ENOENT here is genuinely unexpected.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    if (rootStat.isSymbolicLink()) {
      throw new SpaceUnsafeError(
        `refusing to open workspace: root '${this.root}' is a symbolic link.`,
        'workspace_symlink',
        this.root,
      )
    }
    if (!rootStat.isDirectory()) {
      throw new SpaceUnsafeError(
        `refusing to open workspace: '${this.root}' exists but is not a directory.`,
        'workspace_not_directory',
        this.root,
      )
    }
    if (expectedUid !== undefined && rootStat.uid !== expectedUid) {
      throw new SpaceUnsafeError(
        `refusing to open workspace: root '${this.root}' is owned by uid ` +
          `${rootStat.uid}, but this process is uid ${expectedUid}.`,
        'workspace_wrong_owner',
        this.root,
      )
    }

    // 2. The runtime subdirectory and every sensitive child. We
    //    tolerate ENOENT — many of these files don't exist on first
    //    init (e.g. secret.key is created lazily on first secret
    //    touch).
    const sensitiveChildren = [
      join(this.root, 'runtime'),
      this.paths.admins,
      this.paths.agents,
      this.paths.workers,
      this.paths.secrets,
      this.paths.runtime.pendingApps,
      this.paths.runtime.adminSessions,
      this.paths.runtime.workerSessions,
      this.paths.runtime.secretKey,
    ]
    for (const p of sensitiveChildren) {
      // Children are not required to exist on first init; on
      // subsequent opens they will. `mustExist: false` keeps this
      // method idempotent across the init and open paths.
      await checkOne(p, false)
    }
  }

  /**
   * Idempotent permission sweep over the workspace's sensitive files.
   * Safe to call after `Space.init` (no-op — the files were already
   * written with `SECURE_FILE_MODE`) and after `Space.open` on a
   * pre-3.4 workspace (chmod brings the legacy 0o644 files into line).
   *
   * Best-effort: chmod failures (exFAT / SMB / Windows ACLs) are
   * swallowed. The real defence is the per-write `mode` flag — this
   * sweep only catches files that pre-date the fix.
   */
  private async hardenFilePermissions(): Promise<void> {
    if (process.platform === 'win32') return
    const targets = [
      this.paths.admins,
      this.paths.agents,
      this.paths.workers,
      this.paths.secrets,
      this.paths.runtime.pendingApps,
      this.paths.runtime.adminSessions,
      this.paths.runtime.workerSessions,
      this.paths.runtime.secretKey,
    ]
    await Promise.all(
      targets.map(async (p) => {
        try {
          await chmod(p, SECURE_FILE_MODE)
        } catch (err) {
          // ENOENT — file not yet created. Tolerate. Any other error
          // (EACCES, EROFS, EINVAL on exFAT) is best-effort: the next
          // write picks up the mode anyway.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            // Intentionally silent — logger is not available at this
            // layer (core has no logger dependency). A future
            // refactor that introduces one should surface this.
          }
        }
      }),
    )
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

    // H7: refuse to init if the workspace location is unsafe (root or
    // any sensitive child is a symlink, or ownership is wrong). Runs
    // AFTER the mkdir cascade so the legitimate-state-machine has
    // already had a chance to create the directory tree, and BEFORE
    // any sensitive writes so attacker-staged symlinks can't redirect
    // them. mkdirSync on a symlinked target is a safe no-op (the
    // target dir already exists), so by the time we lstat we still
    // see the symlink and can throw.
    await s.assertSafeWorkspaceLocation()

    // C4: harden directory permissions IMMEDIATELY after the safety
    // check, BEFORE the first sensitive write, so that the
    // (admins|agents|workers|secrets).json files are never visible
    // under a world-traversable parent. POSIX only — Windows uses
    // ACLs, not mode bits.
    if (process.platform !== 'win32') {
      try { chmodSync(root, SECURE_DIR_MODE) } catch { /* tolerate exFAT/SMB */ }
      try { chmodSync(join(root, 'runtime'), SECURE_DIR_MODE) } catch { /* same */ }
    }

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
      // D1 — federation identity stamped at init. Format `hub_<8 hex>`
      // matches the peer-id grammar HubLink HELLO expects and is short
      // enough to read in logs at a glance.
      hubId: `hub_${randomBytes(4).toString('hex')}`,
    } satisfies SpaceMeta)
    writeJsonAtomicSync(s.paths.config, { ...DEFAULT_CONFIG, ...opts.config })
    writeJsonAtomicSync(s.paths.admins, { admins: [] }, SECURE_FILE_MODE)
    writeJsonAtomicSync(s.paths.agents, { agents: [] }, SECURE_FILE_MODE)
    writeJsonAtomicSync(s.paths.workers, { workers: [] }, SECURE_FILE_MODE)
    writeJsonAtomicSync(s.paths.mcpServers, { servers: [] }, SECURE_FILE_MODE)
    writeJsonAtomicSync(s.paths.runtime.pendingApps, { apps: [] }, SECURE_FILE_MODE)
    writeJsonAtomicSync(s.paths.runtime.adminSessions, { sessions: [] }, SECURE_FILE_MODE)
    writeJsonAtomicSync(s.paths.runtime.workerSessions, { sessions: [] }, SECURE_FILE_MODE)

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
    const m = await readJson<SpaceMeta>(this.paths.space)
    // D1 — lazy back-fill for pre-D1 spaces. If hubId is missing,
    // generate one and persist it under the file lock so concurrent
    // readers can't race two different ids onto disk.
    if (m.hubId === undefined) {
      return await this.withFileLock(this.paths.space, async () => {
        const cur = await readJson<SpaceMeta>(this.paths.space)
        if (cur.hubId !== undefined) return cur
        const filled: SpaceMeta = {
          ...cur,
          hubId: `hub_${randomBytes(4).toString('hex')}`,
        }
        await writeJsonAtomic(this.paths.space, filled)
        return filled
      })
    }
    return m
  }
  async config(): Promise<SpaceConfig> {
    const c = await readJson<Partial<SpaceConfig>>(this.paths.config)
    return { ...DEFAULT_CONFIG, ...c }
  }
  async updateConfig(patch: Partial<SpaceConfig>): Promise<SpaceConfig> {
    return this.withFileLock(this.paths.config, async () => {
      const current = await this.config()
      const next = { ...current, ...patch }
      await writeJsonAtomic(this.paths.config, next)
      return next
    })
  }

  // --- admins --------------------------------------------------------------

  async admins(): Promise<AdminRecord[]> {
    const data = await readJson<{ admins: AdminRecord[] }>(this.paths.admins)
    return data.admins ?? []
  }
  async createAdmin(displayName: string): Promise<{ admin: AdminRecord; token: string }> {
    return this.withFileLock(this.paths.admins, async () => {
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
      await writeJsonAtomic(this.paths.admins, { admins }, SECURE_FILE_MODE)
      return { admin, token }
    })
  }
  async removeAdmin(id: ParticipantId): Promise<boolean> {
    return this.withFileLock(this.paths.admins, async () => {
      const admins = await this.admins()
      const next = admins.filter((a) => a.id !== id)
      if (next.length === admins.length) return false
      await writeJsonAtomic(this.paths.admins, { admins: next }, SECURE_FILE_MODE)
      return true
    })
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
    return this.withFileLock(this.paths.admins, async () => {
      const admins = await this.admins()
      const idx = admins.findIndex((a) => a.id === id)
      if (idx < 0) return null
      admins[idx] = { ...admins[idx]!, contributionOptOut: value }
      await writeJsonAtomic(this.paths.admins, { admins }, SECURE_FILE_MODE)
      return admins[idx]!
    })
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
    return this.withFileLock(this.paths.agents, async () => {
      const agents = await this.agents()
      const idx = agents.findIndex((a) => a.id === rec.id)
      if (idx >= 0) {
        agents[idx] = { ...agents[idx]!, ...rec, createdAt: agents[idx]!.createdAt }
      } else {
        agents.push({ ...rec, createdAt: rec.createdAt ?? new Date().toISOString() })
      }
      await writeJsonAtomic(this.paths.agents, { agents }, SECURE_FILE_MODE)
      return agents.find((a) => a.id === rec.id)!
    })
  }
  async removeAgent(id: ParticipantId): Promise<boolean> {
    const removed = await this.withFileLock(this.paths.agents, async () => {
      const agents = await this.agents()
      const next = agents.filter((a) => a.id !== id)
      if (next.length === agents.length) return false
      await writeJsonAtomic(this.paths.agents, { agents: next }, SECURE_FILE_MODE)
      return true
    })
    if (!removed) return false
    // Drop the per-agent override key (if any) so an abandoned key
    // doesn't linger in secrets.enc.json. Outside the agents-file
    // lock so a slow secrets write can't block other agent mutations;
    // removeAgentApiKey takes its own secrets-file lock.
    await this.removeAgentApiKey(id).catch(() => { /* best-effort */ })
    return true
  }
  async touchAgent(id: ParticipantId): Promise<void> {
    await this.withFileLock(this.paths.agents, async () => {
      const agents = await this.agents()
      const idx = agents.findIndex((a) => a.id === id)
      if (idx < 0) return
      agents[idx]!.lastSeen = new Date().toISOString()
      await writeJsonAtomic(this.paths.agents, { agents }, SECURE_FILE_MODE)
    })
  }

  // --- MCP server registry (hub-level) -------------------------------------

  /**
   * The hub's installed MCP servers. Agents opt into these by name via
   * `ManagedAgentSpec.useMcpServers`. Tolerates a missing file (a space
   * created before this registry existed) by returning `[]`.
   */
  async mcpServers(): Promise<HubMcpServerRecord[]> {
    try {
      const data = await readJson<{ servers: HubMcpServerRecord[] }>(this.paths.mcpServers)
      return data.servers ?? []
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
      throw err
    }
  }

  /**
   * Install or update an MCP server in the hub registry, keyed by
   * `spec.name`. Returns the stored record (with its preserved
   * `createdAt`). The name is the registry key AND the tool-name prefix
   * agents see, so it must be unique.
   */
  async upsertMcpServer(
    rec: Omit<HubMcpServerRecord, 'createdAt'> & { createdAt?: string },
  ): Promise<HubMcpServerRecord> {
    return this.withFileLock(this.paths.mcpServers, async () => {
      const servers = await this.mcpServers()
      const name = rec.spec.name
      const idx = servers.findIndex((s) => s.spec.name === name)
      if (idx >= 0) {
        servers[idx] = { ...servers[idx]!, ...rec, createdAt: servers[idx]!.createdAt }
      } else {
        servers.push({ ...rec, createdAt: rec.createdAt ?? new Date().toISOString() })
      }
      await writeJsonAtomic(this.paths.mcpServers, { servers }, SECURE_FILE_MODE)
      return servers.find((s) => s.spec.name === name)!
    })
  }

  /** Uninstall an MCP server from the hub registry. Returns false if absent. */
  async removeMcpServer(name: string): Promise<boolean> {
    return this.withFileLock(this.paths.mcpServers, async () => {
      const servers = await this.mcpServers()
      const next = servers.filter((s) => s.spec.name !== name)
      if (next.length === servers.length) return false
      await writeJsonAtomic(this.paths.mcpServers, { servers: next }, SECURE_FILE_MODE)
      return true
    })
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
    return this.withFileLock(this.paths.workers, async () => {
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
      await writeJsonAtomic(this.paths.workers, { workers }, SECURE_FILE_MODE)
      return { worker, token }
    })
  }
  async removeWorker(id: ParticipantId): Promise<boolean> {
    return this.withFileLock(this.paths.workers, async () => {
      const workers = await this.workers()
      const next = workers.filter((w) => w.id !== id)
      if (next.length === workers.length) return false
      await writeJsonAtomic(this.paths.workers, { workers: next }, SECURE_FILE_MODE)
      return true
    })
  }
  /** Worker counterpart of {@link setAdminContributionOptOut}. */
  async setWorkerContributionOptOut(
    id: ParticipantId,
    value: boolean,
  ): Promise<WorkerRecord | null> {
    return this.withFileLock(this.paths.workers, async () => {
      const workers = await this.workers()
      const idx = workers.findIndex((w) => w.id === id)
      if (idx < 0) return null
      workers[idx] = { ...workers[idx]!, contributionOptOut: value }
      await writeJsonAtomic(this.paths.workers, { workers }, SECURE_FILE_MODE)
      return workers[idx]!
    })
  }
  async touchWorker(id: ParticipantId): Promise<void> {
    await this.withFileLock(this.paths.workers, async () => {
      const workers = await this.workers()
      const idx = workers.findIndex((w) => w.id === id)
      if (idx < 0) return
      workers[idx]!.lastSeen = new Date().toISOString()
      await writeJsonAtomic(this.paths.workers, { workers }, SECURE_FILE_MODE)
    })
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
    await this.withFileLock(this.paths.runtime.adminSessions, async () => {
      const sessions = await this.adminSessions()
      sessions.push({ sessionId, principalId: adminId, createdAt: new Date().toISOString() })
      await writeJsonAtomic(this.paths.runtime.adminSessions, { sessions }, SECURE_FILE_MODE)
    })
  }
  async findAdminSession(sessionId: string | undefined): Promise<SessionRecord | null> {
    if (!sessionId) return null
    const sessions = await this.adminSessions()
    return sessions.find((s) => s.sessionId === sessionId) ?? null
  }
  async removeAdminSession(sessionId: string): Promise<boolean> {
    return this.withFileLock(this.paths.runtime.adminSessions, async () => {
      const sessions = await this.adminSessions()
      const next = sessions.filter((s) => s.sessionId !== sessionId)
      if (next.length === sessions.length) return false
      await writeJsonAtomic(this.paths.runtime.adminSessions, { sessions: next }, SECURE_FILE_MODE)
      return true
    })
  }

  async workerSessions(): Promise<SessionRecord[]> {
    const data = await readJson<{ sessions: SessionRecord[] }>(this.paths.runtime.workerSessions)
    return data.sessions ?? []
  }
  async addWorkerSession(sessionId: string, workerId: ParticipantId): Promise<void> {
    await this.withFileLock(this.paths.runtime.workerSessions, async () => {
      const sessions = await this.workerSessions()
      sessions.push({ sessionId, principalId: workerId, createdAt: new Date().toISOString() })
      await writeJsonAtomic(this.paths.runtime.workerSessions, { sessions }, SECURE_FILE_MODE)
    })
  }
  async findWorkerSession(sessionId: string | undefined): Promise<SessionRecord | null> {
    if (!sessionId) return null
    const sessions = await this.workerSessions()
    return sessions.find((s) => s.sessionId === sessionId) ?? null
  }
  async removeWorkerSession(sessionId: string): Promise<boolean> {
    return this.withFileLock(this.paths.runtime.workerSessions, async () => {
      const sessions = await this.workerSessions()
      const next = sessions.filter((s) => s.sessionId !== sessionId)
      if (next.length === sessions.length) return false
      await writeJsonAtomic(this.paths.runtime.workerSessions, { sessions: next }, SECURE_FILE_MODE)
      return true
    })
  }

  // --- pending agent applications (runtime, but persisted) -----------------

  async pendingApps(): Promise<PersistedPendingApp[]> {
    const data = await readJson<{ apps: PersistedPendingApp[] }>(this.paths.runtime.pendingApps)
    return data.apps ?? []
  }
  async writePendingApps(apps: readonly PersistedPendingApp[]): Promise<void> {
    // The Hub calls this fire-and-forget from a concurrency-sensitive
    // syncPendingFile() — serialise through the file lock so a slow
    // disk write can't get interleaved with the next one and produce
    // a torn JSON.
    await this.withFileLock(this.paths.runtime.pendingApps, async () => {
      await writeJsonAtomic(this.paths.runtime.pendingApps, { apps: [...apps] }, SECURE_FILE_MODE)
    })
  }

  // --- transcript storage ---------------------------------------------------

  /**
   * A `FileStorage` rooted at `<root>/transcript.jsonl`.
   *
   * A Space is one tenant's workspace directory — historically the *only*
   * tenant. Route B P0-M1 makes that explicit by tagging the storage with
   * {@link DEFAULT_TENANT}; the bytes are unchanged (the root path already
   * is whatever the caller resolved, which for the default tenant is the
   * bare workspace root — see `tenantRoot`).
   */
  storage(): FileStorage {
    return new FileStorage(this.paths.transcript, DEFAULT_TENANT)
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
    await writeJsonAtomic(this.paths.secrets, file, SECURE_FILE_MODE)
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
    await this.withFileLock(this.paths.secrets, async () => {
      const file = await this.readSecretsFile()
      file.providers[provider] = enc
      await this.writeSecretsFile(file)
    })
  }

  /** Remove a workspace-level provider key. Returns true if one was removed. */
  async removeProviderApiKey(provider: string): Promise<boolean> {
    return this.withFileLock(this.paths.secrets, async () => {
      const file = await this.readSecretsFile()
      if (!file.providers[provider]) return false
      delete file.providers[provider]
      await this.writeSecretsFile(file)
      return true
    })
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
    await this.withFileLock(this.paths.secrets, async () => {
      const file = await this.readSecretsFile()
      file.agents[agentId] = enc
      await this.writeSecretsFile(file)
    })
  }

  /** Remove a per-agent key (and called automatically by `removeAgent`). */
  async removeAgentApiKey(agentId: ParticipantId): Promise<boolean> {
    return this.withFileLock(this.paths.secrets, async () => {
      const file = await this.readSecretsFile()
      if (!file.agents[agentId]) return false
      delete file.agents[agentId]
      await this.writeSecretsFile(file)
      return true
    })
  }

  // --- concurrency helper --------------------------------------------------

  /**
   * Serialise read-modify-write operations against a single file. The
   * lock is keyed by absolute path; different files run in parallel.
   * The chain is rebuilt after each release so a thrown body doesn't
   * permanently poison the slot (the `.catch(()=>{})` makes downstream
   * waiters insensitive to upstream errors).
   */
  private withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.fileLocks.get(path) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    // Store the swallowed-error variant so we never break the chain.
    this.fileLocks.set(path, next.catch(() => undefined))
    return next as Promise<T>
  }
}

// --- types -----------------------------------------------------------------

export const SPACE_FILE_VERSION = 1

export interface SpaceMeta {
  name: string
  description: string
  createdAt: string
  version: number
  /**
   * D1 (v4 Phase 5) — this host's federation identity. Stamped on
   * `Space.init` as `hub_<8-hex>`; remote peers see this value as the
   * other side of their `acceptHubLinks` HELLO. Persistent across
   * restarts; an admin who needs to rename the hub edits space.json
   * directly (no API surface — renaming is a federation-breaking
   * change peers would need to be re-registered through anyway).
   *
   * Optional in the type so legacy spaces (pre-D1) still load; the
   * Space.meta accessor lazily fills in a generated value the first
   * time it's read on an upgraded space, then writes back so the next
   * call is cheap.
   */
  hubId?: string
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
 * MR-M2 — 一个降级候选,用于 {@link ManagedAgentSpec.fallbacks}。
 *
 * 只镜像主 spec 的 **provider 选择**字段(system prompt / tools / services 是
 * agent 级、不是 per-candidate —— 一个 fallback 只换模型端点,agent 本身不变)。
 * 它的 API key 走和主 provider **完全相同**的解析链(per-agent → workspace →
 * org pool → owner vault → env),按本候选的 `provider` 解析;key 绝不进本文件。
 *
 * MR-M6 —— 上面那条链有个已知盲区(MR-M2 当时显式推迟):两个不同的
 * `openai-compatible` vendor 都走 per-agent key 时会共用同一把。`apiKeyEnv`
 * 就是那个「再扩」:给本候选点名一个 **env 变量名**,key 只从它取。
 */
export interface FallbackCandidate {
  provider: 'anthropic' | 'openai' | 'openai-compatible' | 'mock'
  /** 本候选的模型 id(不同 vendor 认不同模型名);缺省用 provider 默认。 */
  model?: string
  /** `provider === 'openai-compatible'` 时必填 —— 该 vendor 的 /v1 端点。 */
  baseURL?: string
  /** 可选的可读标签,呈现在路由事件 / 健康面。 */
  providerLabel?: string
  /**
   * MR-M6 —— 可选的 **env 变量名**(不是 key 本身;值永不进本文件)。设了,
   * 本候选的 key **只**从 `process.env[apiKeyEnv]` 取:变量缺失 = 无 key =
   * 本候选被跳过(warn),绝不静默回落到 per-agent/org 链拿一把错 vendor 的
   * key。未设 = 既有解析链,逐字节不变。
   */
  apiKeyEnv?: string
}

/**
 * Recipe for an agent the **host** will spawn in-process and keep alive.
 * The `kind` discriminator picks which agent class the loader
 * instantiates:
 *
 *   - `'llm'` — base {@link LlmAgent}. No automatic services/memory
 *     plumbing; the LLM sees `task.payload` straight.
 *   - `'personal-growth'` — {@link PersonalGrowthAgent} subclass.
 *     Auto-recalls prior `growth-history` entries from `memory` before
 *     each step, prepends them as context, and auto-writes the step's
 *     output back into `memory` as a new history entry. Designed for
 *     the `personal-growth-flow` workflow but reusable by any
 *     workflow that wants the same recall/write pattern. Falls back
 *     to base LlmAgent behaviour when `services.memory` is absent.
 *
 * All other fields below apply to both kinds — same provider, system,
 * uses, mcpServers. The kind just picks the class; the wiring is the
 * same.
 *
 * **Why providers are strings, not classes**: the agents.json file must
 * be readable & writable by people who can't reach into the running
 * process. The host's `AgentSupervisor` maps a provider string to a
 * concrete `LlmProvider` implementation at spawn time. Unknown providers
 * fail loudly with a clear error.
 */
export interface ManagedAgentSpec {
  kind: 'llm' | 'personal-growth'
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
  /**
   * MR-M6 — optional **env var NAME** the primary's API key comes from
   * (the value itself never lives in this file — same discipline as the
   * provider doc above). Set ⇒ the key is read from
   * `process.env[apiKeyEnv]` ONLY: a missing/empty variable means "no
   * key" and spawn fails loudly (today's rule), never a silent fall-back
   * to the stored per-agent/org chain — that chain may hold a DIFFERENT
   * vendor's key (see {@link FallbackCandidate.apiKeyEnv}). Unset ⇒ the
   * existing resolution chain, byte-identical.
   */
  apiKeyEnv?: string
  /**
   * MR-M2 — 可选的**有序降级候选**。给了(≥1)host 就把主 provider + 这些候选
   * 包进一个确定性 RoutingProvider:主 provider 在**吐出第一个 token 之前**失败
   * (auth / 限流 / 网络 / 5xx)就顺次降级到下一候选,带 per-candidate 熔断。顺序
   * 即偏好(便宜/本地打头 + 强模型兜底,或同能力跨 vendor)。缺省 / 空 = 今天的
   * 单 provider 行为,逐字节一致 —— **这是唯一打开路由的开关**,opt-in。详见
   * `docs/zh/MODEL-ROUTING.md`。
   */
  fallbacks?: FallbackCandidate[]
  /**
   * NA-M5 — 可选的 6h 维护低价模型。设了,管家后台记忆蒸馏(6h 维护 sweep)
   * 的 LLM 调用就带 `model: <此值>` —— 同 provider 同 key 同计费,只换模型名,
   * 数据边界不动;对话热路径完全不受影响。缺省 = 维护沿用 provider 默认模型,
   * 字节不变。Hub 不解释本字段;只有 host 的维护 sweep 读它(opt-in)。
   */
  maintenanceModel?: string
  /**
   * DUO-M1 — 可选的转派目标 agent id。设了,host 才给这个管家注册 escalate
   * 工具:轻量接待模型自己决定「重活」时,把任务 fire-and-forget 转派给此
   * 目标(explicit dispatch,仅限同 owner 名下,call-time 校验 fail-closed),
   * 结果异步回推同一聊天窗。目标由 owner 配置,模型只有「转/不转」一个决定。
   * 缺省 = escalate 工具根本不注册,工具面/行为逐字节不变。Hub 不解释本字段;
   * 只有 host 的 butler factory 读它(opt-in)。详见 `docs/zh/ATONG-DUAL-BRAIN.md`。
   */
  escalateTo?: string
  /**
   * DUO-M4a — 可选的深推理开关。目前只对 `provider: 'openai-compatible'` 生效:
   * host 构造 provider 时在请求体附 `thinking: { type: <此值> }`(LongCat-2.0
   * 官方形状;思考型端点普遍认它)。`'disabled'` = 接待/轻量档,响应不出
   * reasoning 段,更快更省;`'enabled'` = 显式要深推理。缺省 = 不附任何字段,
   * 厂商默认行为,逐字节不变。Hub 不解释本字段;只有 host 的 provider 装配读它。
   */
  thinking?: 'enabled' | 'disabled'
  /**
   * Hub Services this agent uses (v2.2 — see docs/services-rfc.md §6).
   * Empty / absent means the agent has no service handles at runtime;
   * its ctx is `EMPTY_SERVICE_CTX`. Two rules enforced at yaml parse:
   *
   *   1. `type` + `impl` must exist on a loaded plugin at spawn time.
   *   2. The same `type` may appear at most twice — once as `memory`
   *      / `artifact` (singular per agent), but `datastore` can appear
   *      multiple times because each has its own `config.name`.
   *
   * The Hub forwards `config` verbatim to `plugin.validateConfig`.
   */
  uses?: ServiceUseSpec[]
  /**
   * Third-party MCP servers to attach to this agent's tool-use loop
   * (v0.3 — see docs/MCP.md § 6c). Each entry spawns a stdio MCP
   * server child process at agent-spawn time; the resulting toolset
   * is injected as `LlmAgent.tools`. Tool names are namespaced
   * `<server>__<tool>` so two servers can both declare e.g. `read`
   * without colliding.
   *
   * Empty / absent means no MCP tools — the agent's tool-use loop is
   * never engaged, behaviour matches v0.2 exactly.
   *
   * Lifecycle is owned by `LocalAgentPool`: the toolset is connected
   * just before `new LlmAgent(...)` and disconnected on `stop(id)` /
   * pool shutdown. A single agent can declare many servers; one
   * server that fails to spawn becomes `dead` but doesn't tank the
   * agent (its tools just won't appear in the LLM-facing list).
   */
  mcpServers?: McpServerSpec[]
  /**
   * Names of hub-registry MCP servers this agent opts into (the
   * `uses:`-for-services analogue for MCP). Each name is resolved
   * against the hub's `mcp-servers.json` registry at spawn time and
   * merged with any inline `mcpServers` above — so an integration
   * installed once at hub scope can be shared across many agents
   * without copying its config into each manifest.
   *
   * A name with no matching registry entry is skipped with a warning
   * (graceful, like a missing `${ENV}` ref). If a name here collides
   * with an inline `mcpServers` entry, the inline one wins (an agent
   * can override a hub default locally).
   */
  useMcpServers?: string[]
  /**
   * Phase 10 M4 — allow-list for agent-to-agent dispatch via the
   * `DispatchToolset` (the Phase 10 tool-use path). When present,
   * `LocalAgentPool` attaches a `DispatchToolset` to the agent
   * (composed with the MCP toolset if `mcpServers:` is also set)
   * and the LLM's `dispatch_task` tool will only succeed for ids
   * / capabilities listed here.
   *
   * Omit entirely (the default) → the agent has no `dispatch_task`
   * tool and cannot spawn sub-tasks. Empty arrays inside (`agents:
   * []`, `capabilities: []`) are tolerated and mean "explicitly
   * none of that flavour" rather than "all".
   *
   * Cross-hub dispatch is automatic via capability: list a peer's
   * advertised capability and the scheduler routes through the
   * cross-hub resolver. No `crossHub` knob needed.
   */
  dispatch?: DispatchAllowList
  /**
   * v5 Stream D — proactive heartbeat (OpenClaw-style). When `enabled`,
   * the host's HeartbeatScheduler parks a self-renewing `suspended_tasks`
   * row that wakes this agent every `intervalMs` and dispatches it a
   * heartbeat task. The agent runs a full turn and, when nothing needs
   * attention, returns the HEARTBEAT_OK sentinel which the host suppresses
   * (D-M3). Reuses Phase 11 suspend/resume wholesale — no new table
   * (decision v5 #1a).
   *
   * Absent → no heartbeat (default); zero cost for agents that don't opt in.
   */
  heartbeat?: HeartbeatSpec
  /**
   * Opt-in marker: spawn this `chat`-capable LLM agent as a resident
   * `PersonalButlerAgent` (cross-session memory + governed tool-loop) instead
   * of a plain `LlmAgent`. The host owns the upgrade — it builds the butler via
   * an injected factory so the agent stays the SAME live managed participant
   * (admin / lifecycle / restart / test-connection all unchanged), gaining a
   * per-user memory routed by `task.origin.userId`.
   *
   * The host can also default this ON for the chat agent via `GOTONG_BUTLER`, so
   * a typical single-bot deployment needs no per-agent flag. Absent → host
   * default (zero behaviour change for a non-chat agent either way).
   */
  butler?: boolean
}

/**
 * Phase 10 M4 — allow-list payload nested under
 * `ManagedAgentSpec.dispatch`. At spawn time `LocalAgentPool`
 * converts these arrays into a `DispatchToolset` configured with
 * the same allow-lists; the LLM's view of which ids / capabilities
 * are valid is purely yaml-driven.
 */
export interface DispatchAllowList {
  /** Explicit-strategy targets the agent may dispatch to by id. */
  agents?: string[]
  /** Capability names the agent may dispatch to (via capability strategy). */
  capabilities?: string[]
}

/**
 * v5 Stream D — per-agent proactive heartbeat config, nested under
 * `ManagedAgentSpec.heartbeat`. The host turns an `enabled` spec into a
 * self-renewing parked task (Phase 11 suspend/resume) that wakes the agent
 * on an `intervalMs` cadence. The agent needs no heartbeat awareness — it
 * just receives a normal task.
 */
export interface HeartbeatSpec {
  /** Master switch. Absent spec or `false` → the agent never self-wakes. */
  enabled: boolean
  /**
   * Wake cadence in milliseconds. The host clamps this up to a floor
   * (`GOTONG_HEARTBEAT_MIN_MS`, default 60_000) so a typo can't spin the
   * agent every millisecond. OpenClaw's default cadence is 30 minutes.
   */
  intervalMs: number
  /**
   * v5 D-M2 — standing "what to proactively check" instructions (the
   * OpenClaw `HEARTBEAT.md` analogue). Injected into the heartbeat task
   * payload so the agent knows what to look at. Free text; absent → the
   * agent just gets a bare wake with no checklist.
   */
  checklist?: string
}

/**
 * One entry under `ManagedAgentSpec.mcpServers`. A stripped-down,
 * yaml-friendly view of `@gotong/mcp-client`'s `McpServerConfig` —
 * fields are mapped to a resolved `McpServerConfig` at spawn time
 * inside `LocalAgentPool` (`resolveMcpServerConfig`).
 *
 * A discriminated union over `transport` (defaulting to `'stdio'`):
 *
 *   - `stdio` (default) — `command` + `args` spawn a local child.
 *   - `http`  — remote Streamable HTTP server at `url`; this is how an
 *     agent reaches the hosted-MCP ecosystem.
 *   - `sse`   — legacy remote HTTP+SSE server at `url`.
 *
 * Credential fields (`env` values for stdio, `headers` values for
 * http/sse) support `${ENV_VAR}` expansion at spawn time so secrets
 * stay in the host's environment / vault rather than persisted in
 * plain text in `agents.json`. Unknown refs (`${MISSING}`) become
 * empty strings and the agent's spawn logs warn about it.
 */
export interface McpStdioServerSpec {
  /**
   * Short identifier, used as the prefix on namespaced tool names
   * (`<name>__<tool>`). Must be unique within this agent's
   * `mcpServers[]` and match `/^[a-zA-Z][a-zA-Z0-9_-]*$/`
   * (a-z, A-Z, 0-9, `_`, `-`; can't start with a digit).
   */
  name: string
  /** Wire kind. Optional — omitting it means `'stdio'`. */
  transport?: 'stdio'
  /**
   * Executable to spawn. Typically `npx` for installed-on-demand
   * servers (`npx -y @modelcontextprotocol/server-filesystem`), or an
   * absolute path for site-installed ones.
   */
  command: string
  /** Command-line arguments. No shell interpolation — one arg per slot. */
  args?: string[]
  /**
   * Environment variables to expose to the child. Values may contain
   * `${ENV_VAR}` placeholders, expanded against the host process's
   * env at spawn time. Use this for credentials:
   * `{ GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' }`.
   * Setting this at all means only the keys you provide reach the
   * child (the SDK's default-inheritance set is dropped). Spell out
   * PATH yourself if your server needs it.
   */
  env?: Record<string, string>
  /**
   * Working directory for the child process. Defaults to the host's
   * own CWD. Set this for servers that look at `process.cwd()` to
   * find a project root.
   */
  cwd?: string
}

/** A remote MCP server over the Streamable HTTP transport. */
export interface McpHttpServerSpec {
  /** See {@link McpStdioServerSpec.name}. */
  name: string
  /** Selects the Streamable HTTP transport. */
  transport: 'http'
  /** Absolute server URL (e.g. `https://mcp.example.com/v1`). */
  url: string
  /**
   * Extra HTTP headers sent on every request. Values may contain
   * `${ENV_VAR}` placeholders (expanded at spawn time) so a bearer
   * token stays in the host env: `{ Authorization: 'Bearer ${MCP_PAT}' }`.
   */
  headers?: Record<string, string>
}

/** A remote MCP server over the legacy HTTP+SSE transport. */
export interface McpSseServerSpec {
  /** See {@link McpStdioServerSpec.name}. */
  name: string
  /** Selects the legacy SSE transport. */
  transport: 'sse'
  /** Absolute SSE endpoint URL. */
  url: string
  /** See {@link McpHttpServerSpec.headers}. */
  headers?: Record<string, string>
}

/** Discriminated union — see the doc block on {@link McpStdioServerSpec}. */
export type McpServerSpec =
  | McpStdioServerSpec
  | McpHttpServerSpec
  | McpSseServerSpec

/**
 * One entry in the hub-level MCP server registry (`mcp-servers.json`).
 * An MCP server installed once at hub scope; agents opt in by name via
 * `ManagedAgentSpec.useMcpServers`. `spec.name` is the registry key AND
 * the tool-name prefix the opting-in agents see, so it's unique.
 */
export interface HubMcpServerRecord {
  /** The server config. `spec.name` is the registry key. */
  spec: McpServerSpec
  /** ISO timestamp of first install (preserved across updates). */
  createdAt: string
  /** Optional human description shown in the admin UI / onboarding. */
  description?: string
  /**
   * #2-M3 — when true, this server is exposed to authenticated peer hubs
   * via the cross-hub MCP proxy: a peer's agent can call its tools through
   * the federation link while the credentials / subprocess stay on THIS
   * hub ("凭证各归各家"). Default/absent = local-only, never proxied.
   */
  shared?: boolean
}

/**
 * One entry under `ManagedAgentSpec.uses`. Plain JS interface so
 * `@gotong/core` doesn't take a runtime dep on `@gotong/services-sdk`
 * (the SDK lives "downstream" of core in the workspace graph — see
 * docs/services-rfc.md §14 for the cycle-avoidance discussion).
 *
 * Field semantics:
 *
 *   - `type` + `impl` — plugin selector. The host's `ServiceRegistry`
 *     looks up `(type, impl)` exactly; misses surface as
 *     `PluginNotFoundError` at agent spawn time.
 *   - `config` — opaque to core / web. Always passed through to
 *     `plugin.validateConfig` which decides shape + defaults.
 *     `config.scope` (`'private' | 'workflow' | 'shared:<group>'`)
 *     determines the Owner the plugin files data under; defaults to
 *     `'private'` per RFC Q1=A.
 */
export interface ServiceUseSpec {
  type: string
  impl: string
  config?: Readonly<Record<string, unknown>>
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
 * interface, so `@gotong/web` never has to import `@gotong/llm-*`
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
  /**
   * Hook called by the web layer **after** `space.removeAgent(id)`
   * persists the deletion. Optional — implementations that don't
   * care about post-removal cleanup omit it.
   *
   * The host's `LocalAgentPool` uses this hook to soft-delete every
   * Hub Service plugin's data for the now-removed agent (per RFC
   * Q3=A: 30-day retention + admin notification). Data lands in
   * each plugin's local `.trash/` directory; the lifecycle sweep
   * hard-deletes anything past `expiresAt`.
   *
   * Failures inside this hook MUST NOT roll back the deletion —
   * the agents.json entry is already gone. The web layer logs and
   * moves on.
   */
  onAgentRemoved?(id: ParticipantId): Promise<void>
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

// 原子写(唯一 tmp 名 + 创建时带权限位,v3.3 审计 H6)已抽到 ./fs-atomic.ts ——
// 同一个 bug 曾在三个包里各修一遍,现在只有一个地方可以修。
