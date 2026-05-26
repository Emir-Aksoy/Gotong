/**
 * Phase 9 M4 — host-side upload surface backing /api/admin/uploads.
 *
 * Wires the artifact plugin's `'file'` impl to a single system-owned
 * handle scoped to `{ kind: 'shared', id: 'uploads' }`. Admin file
 * uploads land on disk under one shared, gc-able namespace so they're
 * trivial to sweep periodically (`shared/uploads/uploads/<date>/...`).
 *
 * `artifactId` convention: `uploads/<YYYY-MM-DD>/<rand>.<ext>`
 *   - date directory gives an admin an obvious "what's old" axis for
 *     manual / automated sweeps;
 *   - `<rand>` is 12 hex chars — short enough for URLs, long enough
 *     to deny easy enumeration;
 *   - `<ext>` is the sanitised filename extension or empty when the
 *     filename was absent / unsafe (mime is the source of truth
 *     anyway; ext is just a debuggability nicety).
 *
 * The returned `artifactId` IS the sanitised relative path the
 * artifact plugin uses internally. Phase 9 M2/M3 providers wire an
 * `LlmArtifactResolver` that calls `handle.readBytes(artifactId)`
 * against this same handle — closing the upload → multimodal-input
 * loop end-to-end.
 *
 * Failure modes:
 *   - `attachUploadsHandle` throws when the artifact plugin isn't
 *     loaded; we surface that to the caller (main.ts) which decides
 *     whether to bring up the host without an uploads surface (Web
 *     responds 503 on the upload endpoint, the rest of the host
 *     stays usable).
 *   - `put()` propagates plugin errors verbatim (mime not allowed,
 *     size over cap). The Web layer maps them to 4xx by message
 *     pattern — same pattern already used for /api/admin/agents
 *     errors.
 */

import { randomBytes } from 'node:crypto'

import type { Logger } from '@aipehub/core'
import type { ArtifactHandle, Owner } from '@aipehub/services-sdk'
import type { UploadSurface } from '@aipehub/web'

import type { HubServices } from './services/index.js'

/**
 * The upload namespace owner. `'shared'` (not `'agent'` / `'user'`)
 * because uploads outlive both: a user might dispatch a workflow
 * whose `LlmAgent` runs days later, and that agent must still be
 * able to resolve the artifact. Using `'shared'` keeps the path
 * stable across the dispatcher's lifetime.
 */
const UPLOADS_OWNER: Owner = { kind: 'shared', id: 'uploads' }
const UPLOADS_IMPL = 'file'

/**
 * Generous host-side config. Web's HTTP ceiling is 50 MB so the
 * plugin shouldn't reject anything Web accepted — keeping them
 * symmetric prevents a confusing "200 OK on the wire, 500 inside"
 * trace. Wildcard mime: file uploads are by definition arbitrary
 * user content; the workflow form's `accept:` hint is the proper
 * narrowing point (UI + admin discipline), not the plugin.
 */
const HARD_CEILING_BYTES = 50 * 1024 * 1024

export interface CreateUploadSurfaceOpts {
  services: HubServices
  logger: Logger
  /** Test seam — defaults to `new Date()`. */
  now?: () => Date
  /** Test seam — defaults to `crypto.randomBytes`. */
  randomHex?: (bytes: number) => string
}

export async function createUploadSurface(
  opts: CreateUploadSurfaceOpts,
): Promise<UploadSurface> {
  const handle = await attachUploadsHandle(opts.services)
  const now = opts.now ?? (() => new Date())
  const randomHex = opts.randomHex ?? ((n) => randomBytes(n).toString('hex'))

  return {
    async put(params) {
      const ext = extractSafeExt(params.filename)
      const datePart = formatDate(now())
      // 6 bytes → 12 hex chars. Collision probability with 1M uploads
      // per day per directory is ~2.7e-13 — orders of magnitude below
      // any realistic concern, and `writeFile` would clobber rather
      // than corrupt anyway.
      const rand = randomHex(6)
      const artifactId = `uploads/${datePart}/${rand}${ext}`
      const ref = await handle.write(artifactId, params.bytes, {
        mime: params.declaredMime,
      })
      opts.logger.info('upload accepted', {
        by: params.by,
        path: ref.path,
        mime: ref.mime,
        size: ref.size,
      })
      return {
        artifactId: ref.path,
        mime: ref.mime ?? params.declaredMime,
        size: ref.size,
      }
    },
  }
}

async function attachUploadsHandle(services: HubServices): Promise<ArtifactHandle> {
  const attached = await services.attach({
    type: 'artifact',
    impl: UPLOADS_IMPL,
    owner: UPLOADS_OWNER,
    config: {
      name: 'system-uploads',
      maxBytesPerFile: HARD_CEILING_BYTES,
      allowedMimePrefixes: ['*'],
    },
  })
  return attached.handle as ArtifactHandle
}

function formatDate(d: Date): string {
  // YYYY-MM-DD in UTC. A reboot that crosses local midnight in
  // different timezones won't split the directory tree.
  return d.toISOString().slice(0, 10)
}

/**
 * Pull a path-safe extension off a filename. Strips path prefixes
 * defensively (the filename arrived as a URL query string so could
 * carry a separator), accepts only `[a-z0-9]` (lowercased) in the
 * extension, and rejects anything > 8 chars. On any rejection,
 * returns empty — the artifact still gets a stable mime; the ext
 * is a debuggability nicety, not a contract.
 */
function extractSafeExt(filename: string | undefined): string {
  if (!filename) return ''
  const lastSep = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'))
  const tail = lastSep >= 0 ? filename.slice(lastSep + 1) : filename
  const dot = tail.lastIndexOf('.')
  if (dot < 0 || dot === tail.length - 1) return ''
  const raw = tail.slice(dot + 1)
  const safe = raw.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (safe.length === 0 || safe.length > 8) return ''
  return `.${safe}`
}

/**
 * Re-export of the path used to attach the uploads namespace, so
 * other host components that want to resolve a `file_ref` artifactId
 * downstream can attach to the same handle with the same owner.
 *
 * Phase 9 M5 (admin UI render) will wire this through to the
 * download endpoint; Phase 10+ (agent dispatch) will hand the same
 * handle to the LlmArtifactResolver path.
 */
export const UPLOADS_OWNER_REF = UPLOADS_OWNER
