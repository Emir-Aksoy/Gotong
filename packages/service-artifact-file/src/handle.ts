/**
 * ArtifactFileHandle — per-owner ArtifactHandle backed by files.
 *
 * Writes are serialised through a per-handle promise chain
 * (same pattern as memory-file). Reads / listings / exists are
 * unsynchronised.
 *
 * `ref` policy: for the file backend, `ref === path` (the
 * sanitised relative path within the owner dir). Agents may treat
 * it as an opaque string; the plugin uses it interchangeably with
 * the user path for `read` / `exists` / `remove`.
 */

import {
  access,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { Logger } from '@aipehub/core'
import type {
  ArtifactHandle,
  ArtifactRef,
  Owner,
} from '@aipehub/services-sdk'

import type { ArtifactFileConfig } from './config.js'
import { mimeAllowed } from './config.js'
import { guessMime } from './mime.js'
import { ownerDir, resolveOwnerPath, sanitisePath } from './paths.js'

export interface ArtifactFileHandleOpts {
  rootDir: string
  owner: Owner
  config: ArtifactFileConfig
  logger: Logger
  now?: () => number
}

export class ArtifactFileHandle implements ArtifactHandle {
  private readonly rootDir: string
  private readonly owner: Owner
  private readonly config: ArtifactFileConfig
  private readonly logger: Logger
  private readonly now: () => number
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(opts: ArtifactFileHandleOpts) {
    this.rootDir = opts.rootDir
    this.owner = opts.owner
    this.config = opts.config
    this.logger = opts.logger
    this.now = opts.now ?? Date.now
  }

  async write(
    path: string,
    content: string | Uint8Array,
    opts?: { mime?: string },
  ): Promise<ArtifactRef> {
    return this.serializeWrite(async () => {
      const safe = sanitisePath(path)
      const full = resolveOwnerPath(this.rootDir, this.owner, safe)
      const mime = opts?.mime ?? guessMime(safe)
      if (!mimeAllowed(mime, this.config.allowedMimePrefixes)) {
        throw new Error(
          `mime '${mime}' not in allow-list ` +
          `[${this.config.allowedMimePrefixes.join(', ')}]`,
        )
      }
      const bytes = typeof content === 'string'
        ? Buffer.byteLength(content, 'utf8')
        : content.byteLength
      if (bytes > this.config.maxBytesPerFile) {
        throw new Error(
          `artifact '${safe}' exceeds maxBytesPerFile ` +
          `(${bytes} > ${this.config.maxBytesPerFile})`,
        )
      }
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, content as Buffer | string, typeof content === 'string' ? 'utf8' : undefined)
      const st = await stat(full)
      return {
        ref: safe,
        path: safe,
        size: st.size,
        ts: this.now(),
        mime,
      }
    })
  }

  async read(refOrPath: string): Promise<{ content: string; mime: string }> {
    const safe = sanitisePath(refOrPath)
    const full = resolveOwnerPath(this.rootDir, this.owner, safe)
    const content = await readFile(full, 'utf8')
    return { content, mime: guessMime(safe) }
  }

  async list(opts: { prefix?: string } = {}): Promise<ArtifactRef[]> {
    const oDir = ownerDir(this.rootDir, this.owner)
    if (!await exists(oDir)) return []
    const refs: ArtifactRef[] = []
    for await (const full of walk(oDir)) {
      // Normalise to POSIX separators. `node:path/relative` returns the
      // host OS's separator (`\` on Windows, `/` on Linux/macOS), but
      // the wire / on-disk ref policy is "ref === sanitised relative
      // path with `/`" — guessMime + sanitisePath both assume forward
      // slashes, and an upstream `prefix` filter like `'reports/'`
      // wouldn't startsWith-match `'reports\q1.md'`. On Linux `\`
      // isn't a path separator so the replace is a no-op.
      const rel = relative(oDir, full).replace(/\\/g, '/')
      if (opts.prefix && !rel.startsWith(opts.prefix)) continue
      try {
        const st = await stat(full)
        refs.push({
          ref: rel,
          path: rel,
          size: st.size,
          ts: st.mtimeMs,
          mime: guessMime(rel),
        })
      } catch {
        // File may have been removed between readdir and stat — skip.
      }
    }
    // Newest first; ties broken by lexicographic path.
    refs.sort((a, b) => (b.ts - a.ts) || (a.path < b.path ? -1 : 1))
    return refs
  }

  async exists(refOrPath: string): Promise<boolean> {
    try {
      const safe = sanitisePath(refOrPath)
      const full = resolveOwnerPath(this.rootDir, this.owner, safe)
      await access(full)
      return true
    } catch {
      return false
    }
  }

  async remove(refOrPath: string): Promise<void> {
    return this.serializeWrite(async () => {
      try {
        const safe = sanitisePath(refOrPath)
        const full = resolveOwnerPath(this.rootDir, this.owner, safe)
        await rm(full, { force: true })
      } catch (err) {
        // sanitisePath errors propagate; missing file is a no-op via { force: true }.
        if (err instanceof Error && /traversal|null byte|relative|non-empty/.test(err.message)) {
          throw err
        }
        // Other errors swallowed — caller asked to remove and the
        // file is already gone. ENOENT is silenced by `force: true`.
      }
    })
  }

  // --- internals ----------------------------------------------------

  private serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn)
    this.writeChain = next.then(noop, noop)
    return next
  }
}

// --- helpers ----------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

async function* walk(dir: string): AsyncIterable<string> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) }
  catch { return }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

function noop(): void { /* swallow */ }
