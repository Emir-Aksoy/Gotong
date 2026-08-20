/**
 * setkey-link-store.ts — HANDS-M3b. One-time links for `/setkey link`: the
 * path where the key never enters the chat at all.
 *
 * A member on a phone types `/setkey link`, gets a URL back, opens it, and
 * pastes the key into a form served by their own hub over TLS. The IM platform
 * carries the URL, not the secret.
 *
 * ── Why a file and not a table ───────────────────────────────────────────────
 * The two existing code families (`im_binding_codes`, `device_pairing_codes`)
 * live in the identity DB for a specific reason: consuming the code and MINTING
 * the thing it buys must happen in one transaction, or two racing clients both
 * walk away with a credential. That reason does not hold here — what this token
 * buys is a vault write in a different store, so a DB transaction around the
 * claim would not cover the effect anyway. What is left to guarantee is much
 * smaller: single use.
 *
 * `unlinkSync` gives exactly that, from the kernel, in one call. Two requests
 * racing the same token both read the file and both try to remove it; exactly
 * one succeeds and the loser sees ENOENT. That is the whole concurrency story.
 *
 * (The other half of the reasoning is a house rule: `identity/src/store.ts` is
 * the largest file in the repo and its budget gate carries a note that the next
 * track to touch it must first extract the pairing-code family. Adding a third
 * ~200-line copy of that shape is precisely what the note was written against.)
 *
 * ── What is on disk ─────────────────────────────────────────────────────────
 * `<space>/runtime/setkey-links/<sha256(token)>.json` — the FILE NAME is the
 * lookup key, so the token itself is never written down: someone reading the
 * directory learns that a link exists and for whom, but cannot reconstruct a
 * working URL. The body holds only `{userId, expiresAt, createdAt}`.
 *
 * Minting drops the member's other live links (same "new code kills the old
 * one" semantics as the pairing families) and sweeps expired ones — a link left
 * on a screen the member walked away from stops working the moment they ask for
 * another.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

/** Ten minutes. Long enough to walk to a laptop, short enough to be forgotten. */
export const SETKEY_LINK_TTL_MS = 10 * 60_000

/** 256 bits of URL-safe randomness. This is a bearer token; it is not typed. */
const TOKEN_BYTES = 32

/** A stored link is a few dozen bytes; anything larger is not ours. */
const MAX_RECORD_BYTES = 4096

export interface SetKeyLink {
  token: string
  userId: string
  expiresAt: number
  createdAt: number
}

interface StoredLink {
  userId: string
  expiresAt: number
  createdAt: number
}

/**
 * Turn `GOTONG_PUBLIC_URL` into the base a link may be built on, or null.
 *
 * Two refusals, both deliberate:
 *
 *   - **Absent → null, never a guess.** The SAML ACS URL has the same problem
 *     (it can't be request-derived) and falls back to `host:port` for local
 *     dev. That fallback is wrong here: an IM reply is read on a phone, and
 *     printing `http://127.0.0.1:3000/...` into a chat window hands the member
 *     a link that cannot possibly work, with no clue why. Refusing and saying
 *     so is the honest answer. If the operator sets the variable to a loopback
 *     address on purpose we honour it — that is a statement, not a guess.
 *   - **Plaintext only on loopback.** This URL carries a token that authorises
 *     writing a credential; over plain http on a LAN it travels in the clear.
 *     Same rule the shell's base-URL chokepoint applies, for the same reason.
 */
export function setKeyLinkBaseUrl(raw: string | undefined | null): string | null {
  const trimmed = (raw ?? '').trim()
  if (trimmed.length === 0) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()
  const loopback =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '[::1]' ||
    isIpv4Loopback(host)
  if (url.protocol === 'http:' && !loopback) return null
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

/**
 * 127.0.0.0/8, and only as a literal address.
 *
 * A bare `/^127\./` test on `url.hostname` looks right and is not:
 * `127.attacker.example` is an ordinary DNS name that matches it, and matching
 * it would let the plaintext carve-out ship a bearer token across the open
 * network — the exact thing the carve-out exists to prevent. So the whole
 * string has to BE an address. Shorthand forms need no special handling: the
 * WHATWG parser has already normalised `127.1` / `2130706433` / `0x7f000001`
 * to dotted-quad by the time we see `hostname`, while a name stays a name.
 *
 * Digits are compared by code point rather than a character class, for the
 * reason spelled out on `secretProblem` in im-credentials-service.ts.
 */
function isIpv4Loopback(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return false
    for (let i = 0; i < part.length; i++) {
      const c = part.charCodeAt(i)
      if (c < 48 || c > 57) return false
    }
    if (Number(part) > 255) return false
  }
  return parts[0] === '127'
}

/**
 * Token shape gate. Applied BEFORE the token touches a path — the filename is
 * a hash so traversal is structurally impossible, but a shape check keeps
 * absurd input (a megabyte of text from a crawler) from being hashed at all.
 */
function isTokenShaped(token: unknown): token is string {
  if (typeof token !== 'string') return false
  if (token.length < 16 || token.length > 128) return false
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i)
    const ok =
      (c >= 48 && c <= 57) || // 0-9
      (c >= 65 && c <= 90) || // A-Z
      (c >= 97 && c <= 122) || // a-z
      c === 45 || // -
      c === 95 // _
    if (!ok) return false
  }
  return true
}

function fileNameFor(token: string): string {
  return `${createHash('sha256').update(token, 'utf8').digest('hex')}.json`
}

/**
 * One-time links on disk. Constructed per hub; holds no state of its own, so a
 * restart mid-flight leaves the link working (the file is the state).
 */
export class SetKeyLinkStore {
  private readonly dir: string

  constructor(spaceRoot: string, private readonly ttlMs: number = SETKEY_LINK_TTL_MS) {
    this.dir = join(spaceRoot, 'runtime', 'setkey-links')
  }

  /**
   * Mint a link for `userId`, killing that member's previous ones.
   *
   * The `wx` flag (O_CREAT|O_EXCL) rather than a plain write: one kernel call
   * that refuses to follow a symlink or clobber an existing name. A collision
   * on 256 bits does not happen — the retry is so that a freak one degrades to
   * a retry instead of an exception.
   */
  issue(userId: string, now: number = Date.now()): SetKeyLink {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    this.sweep(now, userId)
    const expiresAt = now + this.ttlMs
    for (let attempt = 0; attempt < 5; attempt++) {
      const token = randomBytes(TOKEN_BYTES).toString('base64url')
      const path = join(this.dir, fileNameFor(token))
      const body: StoredLink = { userId, expiresAt, createdAt: now }
      let fd: number
      try {
        fd = openSync(path, 'wx', 0o600)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw err
      }
      try {
        writeSync(fd, JSON.stringify(body))
      } finally {
        closeSync(fd)
      }
      chmodSync(path, 0o600)
      return { token, userId, expiresAt, createdAt: now }
    }
    throw new Error('setkey link: 5 random tokens all collided')
  }

  /**
   * Who is this link for, without spending it. The form page needs to know
   * whose targets to list; only the submit consumes.
   *
   * Expired links are removed here rather than merely reported, so a page load
   * after the deadline cleans up after itself.
   */
  peek(token: unknown, now: number = Date.now()): { userId: string; expiresAt: number } | null {
    const rec = this.read(token)
    if (!rec) return null
    if (rec.stored.expiresAt <= now) {
      this.removeQuietly(rec.path)
      return null
    }
    return { userId: rec.stored.userId, expiresAt: rec.stored.expiresAt }
  }

  /**
   * Spend the link. The removal IS the claim: it happens before the caller does
   * anything with the answer, so two submits racing the same token cannot both
   * be told to go ahead. A failed key write after this point burns the link —
   * the member asks for another, which is the safe direction to fail.
   */
  consume(token: unknown, now: number = Date.now()): { userId: string } | null {
    const rec = this.read(token)
    if (!rec) return null
    try {
      unlinkSync(rec.path)
    } catch {
      // Someone else got there first (or it expired out from under us). Either
      // way this caller does NOT hold the link.
      return null
    }
    if (rec.stored.expiresAt <= now) return null
    return { userId: rec.stored.userId }
  }

  /** Drop expired links, and optionally every live link belonging to one member. */
  sweep(now: number = Date.now(), forUserId?: string): void {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const path = join(this.dir, name)
      const stored = this.readFile(path)
      if (!stored) {
        this.removeQuietly(path)
        continue
      }
      if (stored.expiresAt <= now || (forUserId !== undefined && stored.userId === forUserId)) {
        this.removeQuietly(path)
      }
    }
  }

  private read(token: unknown): { path: string; stored: StoredLink } | null {
    if (!isTokenShaped(token)) return null
    const path = join(this.dir, fileNameFor(token))
    const stored = this.readFile(path)
    if (!stored) return null
    // No secret comparison here on purpose: the lookup IS the comparison. The
    // filename is the full sha256 of the token, so the filesystem either has
    // that exact name or it does not — there is no partial match to be timed,
    // and nothing on disk to compare a guess against.
    return { path, stored }
  }

  private readFile(path: string): StoredLink | null {
    let raw: string
    try {
      if (statSync(path).size > MAX_RECORD_BYTES) return null
      raw = readFileSync(path, 'utf8')
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const rec = parsed as Record<string, unknown>
      if (typeof rec.userId !== 'string' || rec.userId.length === 0) return null
      if (typeof rec.expiresAt !== 'number' || !Number.isFinite(rec.expiresAt)) return null
      const createdAt = typeof rec.createdAt === 'number' ? rec.createdAt : 0
      return { userId: rec.userId, expiresAt: rec.expiresAt, createdAt }
    } catch {
      return null
    }
  }

  private removeQuietly(path: string): void {
    try {
      unlinkSync(path)
    } catch {
      /* already gone */
    }
  }
}
