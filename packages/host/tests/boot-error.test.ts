/**
 * ease-of-use ⑥-M2 + ❸-M1 — friendly boot-failure hints.
 *
 * `friendlyBootError` is a PURE function, so the whole behaviour is pinned
 * hermetically here (the top-level boot catch in main.ts is a 3-line glue
 * around it). Covers:
 *   ⑥-M2  EADDRINUSE on the web/ws port → names the right GOTONG_*_PORT var,
 *         custom ports from the env, the unknown-port fallback that names both.
 *   ❸-M1  EACCES/EPERM on `listen` → privileged-port hint (NOT a workspace fix);
 *         master key missing/invalid → GOTONG_MASTER_KEY + key-file pointer;
 *         EACCES/EPERM/EROFS on the fs → workspace-not-writable;
 *         ENOSPC/EDQUOT → disk full / over quota.
 *   And the null pass-through for any genuinely unrecognised error (so the
 *   caller keeps its default `log.fatal` path).
 */

import { describe, expect, it } from 'vitest'

import { bootPortsFromEnv, bootSpaceFromEnv, friendlyBootError } from '../src/boot-error.js'

/** A realistic Node listen-time EADDRINUSE (optionally carrying the colliding port). */
function eaddrinuse(port?: number): NodeJS.ErrnoException {
  const e = new Error('listen EADDRINUSE: address already in use') as NodeJS.ErrnoException & {
    port?: number
  }
  e.code = 'EADDRINUSE'
  e.syscall = 'listen'
  if (port !== undefined) e.port = port
  return e
}

/** EACCES raised by listen() when binding a privileged (<1024) port. */
function listenEacces(port?: number): NodeJS.ErrnoException {
  const e = new Error('listen EACCES: permission denied') as NodeJS.ErrnoException & { port?: number }
  e.code = 'EACCES'
  e.syscall = 'listen'
  if (port !== undefined) e.port = port
  return e
}

/** A filesystem errno error (not a listen) carrying an optional offending path. */
function fsError(code: string, opts: { path?: string; syscall?: string; message?: string } = {}) {
  const e = new Error(opts.message ?? `${code}: filesystem error`) as NodeJS.ErrnoException & {
    path?: string
  }
  e.code = code
  e.syscall = opts.syscall ?? 'open'
  if (opts.path !== undefined) e.path = opts.path
  return e
}

/** An IdentityError-shaped master-key failure (a plain Error whose message names it). */
function masterKeyError(message: string): Error {
  return new Error(message)
}

describe('bootPortsFromEnv', () => {
  it('defaults to 3000 / 4000', () => {
    expect(bootPortsFromEnv({})).toEqual({ webPort: 3000, wsPort: 4000 })
  })

  it('reads GOTONG_WEB_PORT / GOTONG_WS_PORT', () => {
    expect(bootPortsFromEnv({ GOTONG_WEB_PORT: '8080', GOTONG_WS_PORT: '9090' })).toEqual({
      webPort: 8080,
      wsPort: 9090,
    })
  })

  it('falls back on a garbage / non-positive value', () => {
    expect(bootPortsFromEnv({ GOTONG_WEB_PORT: 'nope', GOTONG_WS_PORT: '0' })).toEqual({
      webPort: 3000,
      wsPort: 4000,
    })
  })
})

describe('bootSpaceFromEnv', () => {
  it('defaults to .gotong', () => {
    expect(bootSpaceFromEnv({})).toBe('.gotong')
    expect(bootSpaceFromEnv({ GOTONG_SPACE: '   ' })).toBe('.gotong')
  })
  it('reads GOTONG_SPACE (trimmed)', () => {
    expect(bootSpaceFromEnv({ GOTONG_SPACE: ' /data/.gotong ' })).toBe('/data/.gotong')
  })
})

describe('friendlyBootError — EADDRINUSE (⑥-M2)', () => {
  it('names GOTONG_WEB_PORT (only) when the web port collides', () => {
    const msg = friendlyBootError(eaddrinuse(3000), {})!
    expect(msg).toContain('3000')
    expect(msg).toContain('admin UI / API')
    expect(msg).toContain('GOTONG_WEB_PORT')
    expect(msg).not.toContain('GOTONG_WS_PORT') // don't muddy a web collision with the ws var
    expect(msg).toContain('gotong doctor')
  })

  it('names GOTONG_WS_PORT (only) when the ws port collides', () => {
    const msg = friendlyBootError(eaddrinuse(4000), {})!
    expect(msg).toContain('4000')
    expect(msg).toContain('agent WebSocket')
    expect(msg).toContain('GOTONG_WS_PORT')
    expect(msg).not.toContain('GOTONG_WEB_PORT')
  })

  it('honours custom ports from the env when matching the colliding port', () => {
    const env = { GOTONG_WEB_PORT: '8080', GOTONG_WS_PORT: '9090' }
    expect(friendlyBootError(eaddrinuse(8080), env)).toContain('GOTONG_WEB_PORT')
    expect(friendlyBootError(eaddrinuse(9090), env)).toContain('GOTONG_WS_PORT')
  })

  it('names BOTH ports when the colliding port is unknown or matches neither', () => {
    const noPort = friendlyBootError(eaddrinuse(), {})!
    expect(noPort).toContain('GOTONG_WEB_PORT')
    expect(noPort).toContain('GOTONG_WS_PORT')

    const other = friendlyBootError(eaddrinuse(5555), {})!
    expect(other).toContain('5555')
    expect(other).toContain('GOTONG_WEB_PORT')
    expect(other).toContain('GOTONG_WS_PORT')
  })
})

describe('friendlyBootError — privileged listen port (❸-M1)', () => {
  it('treats EACCES on listen as a port-permission problem, not a workspace one', () => {
    const msg = friendlyBootError(listenEacces(80), {})!
    expect(msg).toContain('✖ Gotong could not start')
    expect(msg).toContain('1024') // names the privileged-port boundary
    expect(msg).toContain('GOTONG_WEB_PORT') // 80 matches neither default → names both vars
    expect(msg).toContain('GOTONG_WS_PORT')
    expect(msg).not.toContain('workspace') // crucially NOT a chmod-your-data-dir hint
    expect(msg).toContain('gotong doctor')
  })

  it('names the specific port var when the privileged port is the configured web port', () => {
    const msg = friendlyBootError(listenEacces(443), { GOTONG_WEB_PORT: '443' })!
    expect(msg).toContain('GOTONG_WEB_PORT')
    expect(msg).not.toContain('GOTONG_WS_PORT')
  })
})

describe('friendlyBootError — master key (❸-M1)', () => {
  it('recognises a missing env master key and points at GOTONG_MASTER_KEY', () => {
    const msg = friendlyBootError(
      masterKeyError('GOTONG_MASTER_KEY_PROVIDER=env requires GOTONG_MASTER_KEY (the 32-byte master key as hex)'),
      {},
    )!
    expect(msg).toContain('master key')
    expect(msg).toContain('GOTONG_MASTER_KEY')
    expect(msg).toContain('details:') // surfaces the underlying reason verbatim
    expect(msg).toContain('gotong doctor')
  })

  it('recognises a wrong-length key file and shows the key path under GOTONG_SPACE', () => {
    const msg = friendlyBootError(
      masterKeyError('master key file /data/.gotong/identity-master.key has wrong length (10, expected 32)'),
      { GOTONG_SPACE: '/data/.gotong' },
    )!
    expect(msg).toContain('identity-master.key')
    expect(msg).toContain('/data/.gotong/identity-master.key')
    expect(msg).toContain('restore it from your backup')
  })
})

describe('friendlyBootError — workspace not writable (❸-M1)', () => {
  it('maps a filesystem EACCES to a workspace-permission hint with the offending path', () => {
    const msg = friendlyBootError(fsError('EACCES', { path: '/data/.gotong/identity.sqlite' }), {})!
    expect(msg).toContain('workspace directory is not writable')
    expect(msg).toContain('/data/.gotong/identity.sqlite')
    expect(msg).toContain('GOTONG_SPACE')
    expect(msg).toContain('chown/chmod')
    expect(msg).toContain('gotong doctor')
  })

  it('falls back to the env GOTONG_SPACE when the error carries no path', () => {
    const msg = friendlyBootError(fsError('EPERM'), { GOTONG_SPACE: '/srv/hub' })!
    expect(msg).toContain('/srv/hub')
  })

  it('a read-only filesystem (EROFS) says so explicitly', () => {
    const msg = friendlyBootError(fsError('EROFS', { path: '/mnt/ro/.gotong' }), {})!
    expect(msg).toContain('read-only filesystem')
    expect(msg).toContain('/mnt/ro/.gotong')
  })

  it('an fs EACCES on the key FILE is a permission fix, NOT a master-key-config error', () => {
    // The discriminator: fs errors name "identity-master.key" (no space), so they
    // must NOT match the /master key/ master-key branch — fixing the perms is right.
    const msg = friendlyBootError(
      fsError('EACCES', {
        path: '/data/.gotong/identity-master.key',
        message: "EACCES: permission denied, open '/data/.gotong/identity-master.key'",
      }),
      {},
    )!
    expect(msg).toContain('workspace directory is not writable')
    expect(msg).not.toContain('GOTONG_MASTER_KEY')
  })
})

describe('friendlyBootError — disk full (❸-M1)', () => {
  it('maps ENOSPC to a disk-full hint', () => {
    const msg = friendlyBootError(fsError('ENOSPC', { path: '/data/.gotong', syscall: 'write' }), {})!
    expect(msg).toContain('no space left')
    expect(msg).toContain('/data/.gotong')
    expect(msg).toContain('Free up space')
    expect(msg).toContain('gotong doctor')
  })

  it('maps EDQUOT to an over-quota hint', () => {
    const msg = friendlyBootError(fsError('EDQUOT', { path: '/home/user/.gotong' }), {})!
    expect(msg).toContain('quota')
    expect(msg).toContain('/home/user/.gotong')
  })
})

describe('friendlyBootError — pass-through (null)', () => {
  it('returns null for an unrecognised error (caller keeps its default path)', () => {
    expect(friendlyBootError(new Error('boom'))).toBeNull()
    // a bare errno code we do not recognise (e.g. ECONNRESET) is not friendly-able
    const econn = new Error('socket hang up') as NodeJS.ErrnoException
    econn.code = 'ECONNRESET'
    expect(friendlyBootError(econn)).toBeNull()
    expect(friendlyBootError(null)).toBeNull()
    expect(friendlyBootError(undefined)).toBeNull()
  })
})

describe('friendlyBootError — always framed', () => {
  it('every recognised failure opens with the ✖ banner and points at gotong doctor', () => {
    const cases = [
      friendlyBootError(eaddrinuse(3000), {}),
      friendlyBootError(listenEacces(80), {}),
      friendlyBootError(masterKeyError('master key material must decode to 32 bytes'), {}),
      friendlyBootError(fsError('EACCES', { path: '/x' }), {}),
      friendlyBootError(fsError('ENOSPC', { path: '/x' }), {}),
    ]
    for (const m of cases) {
      expect(m).toContain('✖ Gotong could not start')
      expect(m).toContain('Run `gotong doctor`')
    }
  })
})
