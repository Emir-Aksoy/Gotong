/**
 * panel-routes.ts — SDUI-M2/M3. The member panel's HTTP face.
 *
 *   GET /api/me/panel[?client=N] →  { schemaVersion, config, source, contract }
 *                               `?client=` is the renderer's own schemaVersion
 *                               (SHELL-M3). Advisory: it changes the `contract`
 *                               verdict the client is handed, never the config.
 *   PUT /api/me/panel           body { libraryId } | { reset: true }
 *   GET /api/me/panel/library   →  { panels: [{ id, title, description? }] }
 *
 *   GET /api/me/panel/data/schedules   C1a hub-internal named data sources —
 *   GET /api/me/panel/data/tasks       read-only projections the renderer
 *   GET /api/me/panel/data/status      fetches per component. Three-state
 *   GET /api/me/panel/data/usage       honest: surface absent (or the specific
 *   GET /api/me/panel/data/content     source unwired on this host) → 200
 *   { available: false } — the renderer shows 「数据源未启用」, never a broken
 *   card; wired → { available: true, schedules|tasks|cards|days: [...] }.
 *   `usage` takes ?range=week|month (whitelisted, default week — a display
 *   param; userId stays session-pinned). `content` (C1-c) takes ?id=<fileId>
 *   and answers { available, exists, markdown?, updatedAt? } — the member's
 *   own butler-written display file; never-written is exists:false, not 404.
 *
 *   PUT /api/admin/panel/users/:userId   same body — owner installs a shape
 *                                        for a member (fork D; the member can
 *                                        switch back any time via their own PUT)
 *
 * The config is the SDUI orchestration file. Every WRITE lands in the host
 * store's `setPanel` — the single `validatePanelConfig` choke point (web never
 * imports personal-butler; store errors surface via duck-typed `code`).
 * `source` on GET:
 *
 *   'default'   no per-member file — the built-in default panel
 *   'member'    the member's own stored config
 *   'fallback'  a stored config existed but was corrupt/invalid, so the
 *               default was served instead; the SPA shows a LOUD notice
 *               (file-first honesty: the reader degrades, never quarantines).
 *
 * The member write face is deliberately NARROW: {libraryId}|{reset} only —
 * free-form config PUT is not exposed over HTTP in M3 (the M4 butler tool
 * writes through the host store directly, same choke point). Duck-typed
 * surface (host `buildMePanelSurface` satisfies it) — web keeps zero host
 * runtime dependency (docs/zh/SURFACE-PATTERN.md). No surface wired → 503
 * (setting-ops posture). Auth: /api/me/* callers are resolved by
 * handleMeRoute's session gate (`userId` server-pinned); the admin route is
 * mounted behind server.ts `requireAdmin`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { readJsonBody, sendJson } from './http-helpers.js'

export interface MePanelResult {
  schemaVersion: number
  config: unknown
  source: 'default' | 'member' | 'fallback'
  /** SDUI-M4 attribution of the last mutation (host reads the undo slot).
   * `by:'butler'` drives the SPA's 「阿同调整了你的面板 [撤销]」 banner. */
  lastChange?: { by: 'butler' | 'human'; at: string }
}

export interface MePanelSurface {
  panel(userId: string): Promise<MePanelResult>
  resetPanel(userId: string): Promise<void>
  listLibrary(): Promise<{ id: string; title: string; description?: string }[]>
  applyLibrary(userId: string, libraryId: string): Promise<MePanelResult>
  /** SDUI-M4 one-slot undo (swap semantics; store throws duck `not_found`
   * when nothing was ever changed → 404). */
  restoreSnapshot(userId: string): Promise<MePanelResult>
  /** C1-c butler-written display content (`content:<id>` sources and the
   * `connector:<slot>` relay files). Optional — an older host without it
   * makes /data/content answer { available:false }. null = never written
   * (or invalid id): the renderer's honest cold-start state, never a 404. */
  readContent?(userId: string, fileId: string): Promise<{ markdown: string; updatedAt: string } | null>
  /** SHELL-M3 version negotiation, computed host-side (personal-butler owns
   * the verdict; web must not import it). Optional — an older host simply
   * sends no `contract` block and clients treat that as today's behaviour. */
  contract?(clientDeclared?: unknown): PanelContract
}

/** Mirror of personal-butler's `PanelContract` (duck; web stays host-free). */
export interface PanelContract {
  server: number
  client: number
  verdict: 'ok' | 'client_outdated' | 'client_ahead'
  componentTypes: readonly string[]
}

/** C1a — host `buildMePanelData` satisfies this (duck; web stays host-free).
 * Each getter: null → that source is not wired on THIS host (renderer shows
 * 「数据源未启用」); [] → wired but empty. Row shapes are host-owned DTOs the
 * web layer passes through verbatim — the renderer is their only consumer. */
export interface MePanelDataSurface {
  schedulesForUser(userId: string): Promise<unknown[] | null>
  tasksForUser(userId: string): Promise<unknown[] | null>
  hubStatus(): Promise<unknown[] | null>
  usageForUser(userId: string, range: 'week' | 'month'): Promise<unknown[] | null>
  /** OBS-M2 long-run progress. Optional — an older host without it makes
   * /data/longrun answer { available:false }, same as `readContent`. Returns an
   * object rather than a bare array so the `more` overflow count travels on the
   * wire (no silent caps). */
  longRunForUser?(
    userId: string,
    maxFinished?: number,
  ): Promise<{ tasks: unknown[]; more: number } | null>
}

export interface MePanelRouteDeps {
  panel: MePanelSurface | undefined
  /** Absent → every /data/* route answers { available: false } (never 500). */
  panelData?: MePanelDataSurface
}

/** Exact-match table — unknown /data/* subpaths fall through to the site 404. */
const PANEL_DATA_ROUTES: Record<
  string,
  'schedules' | 'tasks' | 'status' | 'usage' | 'content' | 'longrun'
> = {
  '/api/me/panel/data/schedules': 'schedules',
  '/api/me/panel/data/tasks': 'tasks',
  '/api/me/panel/data/status': 'status',
  '/api/me/panel/data/usage': 'usage',
  '/api/me/panel/data/content': 'content',
  '/api/me/panel/data/longrun': 'longrun',
}

/** `?limit=` 只封顶**已结束**那一截(见 host 侧 `longRunForUser`);上下界
 * 与 panel schema 里那个 `limit` 参数逐字同(1..10)。读不出数就交回
 * undefined 用观察者自己的缺省——一个写坏的展示参数不该把整张卡弄空。 */
function parseLongRunLimit(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 10) return undefined
  return n
}

function storeErrorStatus(err: unknown): number {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'not_found') return 404
  if (code === 'invalid' || code === 'too_large') return 400
  return 500
}

/** Shared by the member and admin write faces:
 *  {libraryId} | {reset:true} | {restore:true} (M4 undo — banner's 撤销). */
async function applyPanelWrite(
  surface: MePanelSurface,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  const body = (await readJsonBody(req).catch(() => null)) as
    | { libraryId?: unknown; reset?: unknown; restore?: unknown }
    | null
  // Fail-closed on ambiguity: exactly ONE mode, no stray keys. A priority
  // union would silently pick a winner for {restore:true, libraryId:"x"} —
  // whichever the caller meant, guessing writes the wrong panel.
  const badRequest = (): void =>
    sendJson(res, { error: 'body must be { libraryId }, { reset: true } or { restore: true }' }, 400)
  if (!body || typeof body !== 'object') {
    badRequest()
    return
  }
  const unknownKey = Object.keys(body).some((k) => !['libraryId', 'reset', 'restore'].includes(k))
  const modes = [
    body.restore === true,
    body.reset === true,
    typeof body.libraryId === 'string' && body.libraryId.length > 0,
  ].filter(Boolean).length
  if (unknownKey || modes !== 1) {
    badRequest()
    return
  }
  try {
    if (body.restore === true) {
      sendJson(res, await surface.restoreSnapshot(userId))
      return
    }
    if (body.reset === true) {
      await surface.resetPanel(userId)
      sendJson(res, await surface.panel(userId))
      return
    }
    sendJson(res, await surface.applyLibrary(userId, body.libraryId as string))
  } catch (err) {
    sendJson(
      res,
      { error: err instanceof Error ? err.message : String(err) },
      storeErrorStatus(err),
    )
  }
}

/** Returns true when the route was handled (mirrors handleMeWizardRoute). */
export async function handleMePanelRoute(
  deps: MePanelRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  userId: string,
): Promise<boolean> {
  const dataKind = PANEL_DATA_ROUTES[path]
  if (path !== '/api/me/panel' && path !== '/api/me/panel/library' && !dataKind) return false
  if (!deps.panel) {
    sendJson(res, { error: 'panel surface not enabled on this host' }, 503)
    return true
  }
  try {
    if (dataKind) {
      if (method !== 'GET') {
        sendJson(res, { error: 'method not allowed' }, 405)
        return true
      }
      const d = deps.panelData
      if (dataKind === 'schedules') {
        const rows = d ? await d.schedulesForUser(userId) : null
        sendJson(res, rows === null ? { available: false } : { available: true, schedules: rows })
      } else if (dataKind === 'tasks') {
        const rows = d ? await d.tasksForUser(userId) : null
        sendJson(res, rows === null ? { available: false } : { available: true, tasks: rows })
      } else if (dataKind === 'usage') {
        // ?range= is a whitelisted DISPLAY param; anything else falls back to
        // week. userId never comes from the query (session-pinned upstream).
        const q = new URL(req.url ?? '/', 'http://x').searchParams.get('range')
        const rows = d ? await d.usageForUser(userId, q === 'month' ? 'month' : 'week') : null
        sendJson(res, rows === null ? { available: false } : { available: true, days: rows })
      } else if (dataKind === 'longrun') {
        // ?limit= is a whitelisted DISPLAY param and caps only the FINISHED
        // tail — live tasks always all come back. userId stays session-pinned.
        const limit = parseLongRunLimit(new URL(req.url ?? '/', 'http://x').searchParams.get('limit'))
        const out = d && typeof d.longRunForUser === 'function' ? await d.longRunForUser(userId, limit) : null
        sendJson(
          res,
          out === null ? { available: false } : { available: true, tasks: out.tasks, more: out.more },
        )
      } else if (dataKind === 'content') {
        // C1-c — rides the panel surface itself (the content store lives in
        // the same file family). ?id= names the file; the STORE is the id
        // authority (hostile ids read as null → honest exists:false). userId
        // stays session-pinned — a member can only ever read their own files.
        const id = new URL(req.url ?? '/', 'http://x').searchParams.get('id')
        if (!id) {
          sendJson(res, { error: 'query param id is required' }, 400)
        } else if (typeof deps.panel.readContent !== 'function') {
          sendJson(res, { available: false })
        } else {
          const doc = await deps.panel.readContent(userId, id)
          sendJson(
            res,
            doc === null
              ? { available: true, exists: false }
              : { available: true, exists: true, markdown: doc.markdown, updatedAt: doc.updatedAt },
          )
        }
      } else {
        const cards = d ? await d.hubStatus() : null
        sendJson(res, cards === null ? { available: false } : { available: true, cards })
      }
      return true
    }
    if (path === '/api/me/panel/library') {
      if (method !== 'GET') {
        sendJson(res, { error: 'method not allowed' }, 405)
        return true
      }
      sendJson(res, { panels: await deps.panel.listLibrary() })
      return true
    }
    if (method === 'GET') {
      const result = await deps.panel.panel(userId)
      // SHELL-M3: `?client=` is the renderer's schemaVersion declaration. It is
      // ADVISORY — the config below is byte-identical whatever it says (or
      // doesn't); only the contract block, which tells the client whether it
      // can trust its own rendering, moves. Filtering the config by a
      // client-supplied claim would silently narrow the member's own panel.
      const declared = new URL(req.url ?? '/', 'http://x').searchParams.get('client')
      const contract = deps.panel.contract?.(declared ?? undefined)
      sendJson(res, contract ? { ...result, contract } : result)
      return true
    }
    if (method === 'PUT') {
      await applyPanelWrite(deps.panel, req, res, userId)
      return true
    }
    sendJson(res, { error: 'method not allowed' }, 405)
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
  }
  return true
}

/**
 * Owner-installs-for-member (fork D). Mounted in server.ts BEHIND requireAdmin;
 * the target userId comes from the path. The store does not verify the user
 * exists — a stray id just leaves an orphan file the member never reads;
 * traversal is impossible (ownerDir runs assertSafeOwnerId).
 */
export async function handleAdminPanelRoute(
  deps: MePanelRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  const m = /^\/api\/admin\/panel\/users\/([^/]+)$/.exec(path)
  if (!m) return false
  if (method !== 'PUT') {
    sendJson(res, { error: 'method not allowed' }, 405)
    return true
  }
  if (!deps.panel) {
    sendJson(res, { error: 'panel surface not enabled on this host' }, 503)
    return true
  }
  await applyPanelWrite(deps.panel, req, res, decodeURIComponent(m[1]!))
  return true
}
