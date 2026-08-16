/**
 * Layer 2 of the lightweight FS sandbox — the OS kernel jail (the real
 * boundary). Pure builders are deterministic; `detectFsJail` is exercised with
 * an injected probe + platform override, so no test spawns a real child. A
 * functional real-machine probe (Mac Seatbelt / Linux bwrap) is a JAIL-M3
 * deliverable, not a unit test.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  MAC_ESSENTIAL_WRITABLE,
  buildBwrapArgs,
  buildSeatbeltProfile,
  detectFsJail,
  resetFsJailCache,
  wrapWithFsJail,
  jailWrapOptions,
  type FsJailSpec,
  type JailProbe,
} from '../src/index.js'

const ROOT = '/work'

describe('buildSeatbeltProfile', () => {
  it('allows by default, denies writes, then re-allows the given subpaths', () => {
    const p = buildSeatbeltProfile(['/work', '/data'])
    expect(p).toContain('(version 1)')
    expect(p).toContain('(allow default)')
    expect(p).toContain('(deny file-write*)')
    // re-allow block lists each writable root as a quoted subpath
    expect(p).toContain('(allow file-write*')
    expect(p).toContain('(subpath "/work")')
    expect(p).toContain('(subpath "/data")')
    // the deny precedes the re-allow (last-match-wins in SBPL → roots win)
    expect(p.indexOf('(deny file-write*)')).toBeLessThan(p.indexOf('(allow file-write*'))
  })

  it('deduplicates repeated roots', () => {
    const p = buildSeatbeltProfile(['/work', '/work'])
    expect(p.match(/\(subpath "\/work"\)/g)).toHaveLength(1)
  })

  it('escapes quotes and backslashes in a path literal', () => {
    const p = buildSeatbeltProfile(['/a"b\\c'])
    expect(p).toContain('(subpath "/a\\"b\\\\c")')
  })
})

describe('buildBwrapArgs', () => {
  it('binds / read-only, re-binds each root read-write, fresh dev/proc/tmp', () => {
    const args = buildBwrapArgs(['/work', '/data'], '/work')
    const joined = args.join(' ')
    expect(joined).toContain('--ro-bind / /')
    expect(joined).toContain('--dev /dev')
    expect(joined).toContain('--proc /proc')
    expect(joined).toContain('--tmpfs /tmp')
    expect(joined).toContain('--die-with-parent')
    expect(joined).toContain('--bind /work /work')
    expect(joined).toContain('--bind /data /data')
    expect(joined).toContain('--chdir /work')
  })

  it('the rw re-bind comes AFTER the ro-bind (later bind overrides the subtree)', () => {
    const args = buildBwrapArgs(['/work'], '/work')
    expect(args.indexOf('--ro-bind')).toBeLessThan(args.indexOf('--bind'))
  })

  it('deduplicates repeated roots', () => {
    const args = buildBwrapArgs(['/work', '/work'], '/work')
    expect(args.filter((a) => a === '--bind')).toHaveLength(1)
  })
})

describe('wrapWithFsJail', () => {
  // Three cases below bake POSIX absolute paths into their golden strings, and
  // wrapWithFsJail resolves roots with the host OS's path rules — on win32
  // `/work` comes out as `D:\work`, so the literals can never match. The jail
  // kinds themselves never run on Windows (detectFsJail → 'none' there), and
  // the pure-builder describes above cover the profile/args logic on every OS.
  const posixOnly = it.skipIf(process.platform === 'win32')

  posixOnly('wraps a command under sandbox-exec with a profile carrying the roots + essentials', () => {
    const w = wrapWithFsJail({
      command: 'codex',
      args: ['exec', '--sandbox', 'workspace-write'],
      allowedRoots: [ROOT],
      cwd: ROOT,
      kind: 'sandbox-exec',
    })
    expect(w).toMatchObject({ command: 'sandbox-exec', jailed: true, kind: 'sandbox-exec' })
    expect(w.args[0]).toBe('-p')
    const profile = w.args[1]!
    expect(profile).toContain('(subpath "/work")')
    for (const ess of MAC_ESSENTIAL_WRITABLE) expect(profile).toContain(`(subpath "${ess}")`)
    // original command + its args trail the profile, in order
    expect(w.args.slice(2)).toEqual(['codex', 'exec', '--sandbox', 'workspace-write'])
  })

  it('wraps a command under bwrap with rw binds for the roots and the original command last', () => {
    const w = wrapWithFsJail({
      command: 'claude-code',
      args: ['--print'],
      allowedRoots: [ROOT],
      cwd: ROOT,
      kind: 'bwrap',
    })
    expect(w).toMatchObject({ command: 'bwrap', jailed: true, kind: 'bwrap' })
    expect(w.args).toContain('--bind')
    // the original command + args are the tail
    expect(w.args.slice(-2)).toEqual(['claude-code', '--print'])
  })

  posixOnly('resolves relative roots against cwd before binding', () => {
    const w = wrapWithFsJail({
      command: 'tool',
      args: [],
      allowedRoots: ['proj'],
      cwd: '/home/me',
      kind: 'bwrap',
    })
    expect(w.args.join(' ')).toContain('--bind /home/me/proj /home/me/proj')
  })

  posixOnly('folds extraWritableRoots into the writable set', () => {
    const w = wrapWithFsJail({
      command: 'tool',
      args: [],
      allowedRoots: [ROOT],
      cwd: ROOT,
      kind: 'sandbox-exec',
      extraWritableRoots: ['/cache'],
    })
    expect(w.args[1]).toContain('(subpath "/cache")')
  })

  it('passes through unchanged for kind "none" (caller degrades + warns)', () => {
    const w = wrapWithFsJail({
      command: 'codex',
      args: ['exec'],
      allowedRoots: [ROOT],
      cwd: ROOT,
      kind: 'none',
    })
    expect(w).toEqual({ command: 'codex', args: ['exec'], jailed: false, kind: 'none' })
  })
})

// HANDS-M2 hardening: every knob is additive. The load-bearing assertion is the
// first one — an absent / empty `hardening` MUST build the exact classic argv
// and profile, because cli-agent / acp-agent never pass it and their jail must
// not move an inch when the hub's own hands learn to cut the network.
describe('wrapWithFsJail hardening (HANDS-M2)', () => {
  const posixOnly = it.skipIf(process.platform === 'win32')
  const SPACE = '/srv/hub/space'
  const WORKSPACE = `${SPACE}/butler/hands/user/u1/workspace`

  it('absent and empty hardening are byte-identical to the classic jail (both enforcers)', () => {
    for (const kind of ['sandbox-exec', 'bwrap'] as const) {
      const base = { command: 'tool', args: ['x'], allowedRoots: [ROOT], cwd: ROOT, kind }
      const classic = wrapWithFsJail(base)
      expect(wrapWithFsJail({ ...base, hardening: {} })).toEqual(classic)
      expect(wrapWithFsJail({ ...base, hardening: { unshareNet: false, hiddenPaths: [] } })).toEqual(classic)
      expect(wrapWithFsJail({ ...base, hardening: { hiddenPaths: ['  ', ''] } })).toEqual(classic)
    }
    // and the pure builders agree with themselves
    expect(buildBwrapArgs([ROOT], ROOT, undefined)).toEqual(buildBwrapArgs([ROOT], ROOT))
    expect(buildSeatbeltProfile([ROOT], undefined)).toBe(buildSeatbeltProfile([ROOT]))
    expect(buildSeatbeltProfile([ROOT], {})).toBe(buildSeatbeltProfile([ROOT]))
  })

  it('bwrap: unshare flags precede the mounts; hidden tmpfs comes BEFORE the writable binds and is remounted ro AFTER them', () => {
    const args = buildBwrapArgs([WORKSPACE], WORKSPACE, {
      unshareNet: true,
      unsharePid: true,
      hiddenPaths: [SPACE],
    })
    const iNet = args.indexOf('--unshare-net')
    const iPid = args.indexOf('--unshare-pid')
    const iTmpfs = args.indexOf('--tmpfs', args.indexOf('--tmpfs') + 1) // second --tmpfs (first is /tmp)
    const iBind = args.indexOf('--bind')
    const iRemount = args.indexOf('--remount-ro')
    const iChdir = args.indexOf('--chdir')
    expect(iNet).toBeGreaterThan(0)
    expect(iPid).toBeGreaterThan(iNet)
    expect(args[iTmpfs + 1]).toBe(SPACE)
    expect(iTmpfs).toBeGreaterThan(iPid)
    expect(iBind).toBeGreaterThan(iTmpfs)
    expect(args.slice(iBind, iBind + 3)).toEqual(['--bind', WORKSPACE, WORKSPACE])
    expect(iRemount).toBeGreaterThan(iBind)
    expect(args[iRemount + 1]).toBe(SPACE)
    expect(iChdir).toBeGreaterThan(iRemount)
    // the classic prefix is untouched
    expect(args.slice(0, 9)).toEqual(['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'])
  })

  it('bwrap: only the requested flags appear (net without pid, and vice versa)', () => {
    const net = buildBwrapArgs([ROOT], ROOT, { unshareNet: true })
    expect(net).toContain('--unshare-net')
    expect(net).not.toContain('--unshare-pid')
    expect(net).not.toContain('--remount-ro')
    const pid = buildBwrapArgs([ROOT], ROOT, { unsharePid: true })
    expect(pid).toContain('--unshare-pid')
    expect(pid).not.toContain('--unshare-net')
  })

  it('seatbelt: hidden paths are denied for read+write, roots UNDER them are re-allowed after, network denied last', () => {
    const p = buildSeatbeltProfile([WORKSPACE, '/tmp'], { hiddenPaths: [SPACE], unshareNet: true })
    const lines = p.split('\n')
    const classic = buildSeatbeltProfile([WORKSPACE, '/tmp']).split('\n')
    // classic prefix byte-identical, hardening strictly appended
    expect(lines.slice(0, classic.length)).toEqual(classic)
    const iDeny = lines.indexOf('(deny file-read* file-write*')
    const iAllow = lines.indexOf('(allow file-read* file-write*')
    const iNet = lines.indexOf('(deny network*)')
    expect(iDeny).toBeGreaterThan(0)
    expect(lines[iDeny + 1]).toBe(`  (subpath "${SPACE}")`)
    expect(iAllow).toBeGreaterThan(iDeny)
    expect(lines[iAllow + 1]).toBe(`  (subpath "${WORKSPACE}")`)
    // /tmp is not under the hidden path → not in the re-allow block
    expect(lines.slice(iAllow, iNet).join('\n')).not.toContain('"/tmp"')
    expect(iNet).toBe(lines.length - 1)
  })

  it('seatbelt: no root under a hidden path → deny block only, no empty re-allow', () => {
    const p = buildSeatbeltProfile([ROOT], { hiddenPaths: ['/srv/secret'] })
    expect(p).toContain('(deny file-read* file-write*\n  (subpath "/srv/secret")\n)')
    expect(p).not.toContain('(allow file-read* file-write*')
  })

  it('seatbelt: unsharePid → the process-isolation approximation (signal/process-info within the sandbox, no lsopen, no AppleEvents), appended before the network deny', () => {
    const p = buildSeatbeltProfile([ROOT], { unsharePid: true, unshareNet: true }).split('\n')
    const classic = buildSeatbeltProfile([ROOT]).split('\n')
    expect(p.slice(0, classic.length)).toEqual(classic)
    expect(p.slice(classic.length)).toEqual([
      '(deny signal)',
      '(allow signal (target same-sandbox))',
      '(deny process-info*)',
      '(allow process-info* (target same-sandbox))',
      '(deny lsopen)',
      '(deny appleevent-send)',
      '(deny job-creation)',
      '(deny network*)',
    ])
    // the deny is unfiltered and the allow is the narrower rule — `(target others)`
    // on the deny is silently ignored by current macOS (verified), so a profile
    // written the other way round would let a jailed command kill the hub.
    expect(buildSeatbeltProfile([ROOT], { unsharePid: true })).not.toContain('(target others)')
  })

  it('seatbelt: readOnlyRoots re-expose read-only under a hidden path (only those inside one), before the writable re-allow', () => {
    const NODE = '/home/hub/.nvm/versions/node/v20'
    const p = buildSeatbeltProfile([WORKSPACE], {
      hiddenPaths: ['/home/hub', SPACE],
      readOnlyRoots: [NODE, '/usr/local', WORKSPACE],
    })
    const lines = p.split('\n')
    const iDeny = lines.indexOf('(deny file-read* file-write*')
    const iRo = lines.indexOf('(allow file-read*')
    const iRw = lines.indexOf('(allow file-read* file-write*')
    expect(iDeny).toBeGreaterThan(0)
    expect(iRo).toBeGreaterThan(iDeny)
    expect(iRw).toBeGreaterThan(iRo)
    expect(lines.slice(iRo, iRw)).toEqual(['(allow file-read*', `  (subpath "${NODE}")`, ')'])
    // /usr/local is not hidden (dropped); the workspace is a writable root (left to the rw re-allow)
    expect(p).not.toContain('"/usr/local"')
    const iMeta = lines.indexOf('(allow file-read-metadata')
    expect(lines.slice(iRw, iMeta)).toEqual(['(allow file-read* file-write*', `  (subpath "${WORKSPACE}")`, ')'])
  })

  // HANDS-M2b — a re-exposed root under a hidden path is reachable but not
  // RESOLVABLE: `realpath(3)` walks it component by component, so `node
  // test.js` inside the member workspace died on `lstat '<space>'` while
  // `node -e '…'` worked. The ancestors are not a secret we hold (the child is
  // told them via cwd/HOME); their CONTENTS still are.
  it('seatbelt: hidden ancestors of a re-exposed root get metadata-only traversal, and nothing else does', () => {
    const NODE = '/home/hub/.nvm/versions/node/v20'
    const p = buildSeatbeltProfile([WORKSPACE], {
      hiddenPaths: ['/home/hub', SPACE],
      readOnlyRoots: [NODE],
      hiddenFiles: ['/etc/gotong.env'],
    })
    const lines = p.split('\n')
    const iMeta = lines.indexOf('(allow file-read-metadata')
    expect(iMeta).toBeGreaterThan(lines.indexOf('(allow file-read* file-write*'))
    const block = lines.slice(iMeta + 1, lines.indexOf(')', iMeta))
    expect(block).toEqual([
      // the hidden root ITSELF is the first component that fails to `lstat`
      '  (literal "/home/hub")',
      '  (literal "/home/hub/.nvm")',
      '  (literal "/home/hub/.nvm/versions")',
      '  (literal "/home/hub/.nvm/versions/node")',
      `  (literal "${SPACE}")`,
      `  (literal "${SPACE}/butler")`,
      `  (literal "${SPACE}/butler/hands")`,
      `  (literal "${SPACE}/butler/hands/user")`,
      `  (literal "${SPACE}/butler/hands/user/u1")`,
    ])
    // ancestors ABOVE the hidden subtree are already allowed by default and
    // need no rule; and it is metadata only — no `subpath`, so nothing recurses.
    expect(block).not.toContain('  (literal "/home")')
    expect(block.join('\n')).not.toContain('subpath')
    expect(block).not.toContain('  (literal "/srv/hub")')
    // a hidden FILE still wins — it is emitted after this block
    expect(lines.indexOf('(deny file-read* file-write*', iMeta)).toBeGreaterThan(iMeta)
  })

  it('seatbelt: nothing hidden → no traversal block at all (classic profile untouched)', () => {
    expect(buildSeatbeltProfile([ROOT], { unshareNet: true })).not.toContain('file-read-metadata')
    expect(buildSeatbeltProfile([WORKSPACE], { readOnlyRoots: [WORKSPACE] })).not.toContain('file-read-metadata')
  })

  it('seatbelt: hiddenFiles are literal denies appended AFTER every re-allow; a file under a hidden dir is dropped', () => {
    const p = buildSeatbeltProfile([WORKSPACE], {
      hiddenPaths: [SPACE],
      hiddenFiles: ['/etc/gotong.env', '/var/run/docker.sock', `${SPACE}/hands.json`],
      unshareNet: true,
    })
    const lines = p.split('\n')
    const iRw = lines.indexOf('(allow file-read* file-write*')
    const iFiles = lines.lastIndexOf('(deny file-read* file-write*')
    expect(iFiles).toBeGreaterThan(iRw)
    expect(lines.slice(iFiles, iFiles + 4)).toEqual([
      '(deny file-read* file-write*',
      '  (literal "/etc/gotong.env")',
      '  (literal "/var/run/docker.sock")',
      ')',
    ])
    expect(p).not.toContain('hands.json')
    expect(lines[lines.length - 1]).toBe('(deny network*)')
  })

  it('seatbelt: denySharedTmp drops /tmp + /var/folders (both spellings) from the writable perimeter, keeps /dev and every real root — even one under /tmp', () => {
    const roots = ['/private/tmp/space/ws', ...MAC_ESSENTIAL_WRITABLE]
    const p = buildSeatbeltProfile(roots, { denySharedTmp: true })
    expect(p).toContain('(subpath "/dev")')
    expect(p).toContain('(subpath "/private/tmp/space/ws")')
    for (const shared of ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']) {
      expect(p).not.toContain(`(subpath "${shared}")`)
    }
    // absent → byte-identical classic
    expect(buildSeatbeltProfile(roots, { denySharedTmp: false })).toBe(buildSeatbeltProfile(roots))
  })

  it('bwrap: readOnlyRoots ro-bind between the hidden tmpfs and the writable binds; hiddenFiles are /dev/null decoys after the binds; denySharedTmp is a no-op', () => {
    const NODE = '/home/hub/.nvm/versions/node/v20'
    const args = buildBwrapArgs([WORKSPACE], WORKSPACE, {
      hiddenPaths: ['/home/hub', SPACE],
      readOnlyRoots: [NODE, '/usr/local'],
      hiddenFiles: ['/etc/gotong.env', `${SPACE}/hands.json`],
      denySharedTmp: true,
    })
    const joined = args.join(' ')
    const iTmpfsHome = joined.indexOf('--tmpfs /home/hub')
    const iRo = joined.indexOf(`--ro-bind ${NODE} ${NODE}`)
    const iBind = joined.indexOf(`--bind ${WORKSPACE} ${WORKSPACE}`)
    const iFile = joined.indexOf('--ro-bind /dev/null /etc/gotong.env')
    const iRemount = joined.indexOf('--remount-ro')
    expect(iTmpfsHome).toBeGreaterThan(0)
    expect(iRo).toBeGreaterThan(iTmpfsHome)
    expect(iBind).toBeGreaterThan(iRo)
    expect(iFile).toBeGreaterThan(iBind)
    expect(iRemount).toBeGreaterThan(iFile)
    expect(joined).not.toContain('/usr/local') // not hidden → already readable → dropped
    expect(joined).not.toContain('hands.json') // under a hidden dir → already gone → dropped
    // denySharedTmp changes nothing on bwrap
    const without = buildBwrapArgs([WORKSPACE], WORKSPACE, {
      hiddenPaths: ['/home/hub', SPACE],
      readOnlyRoots: [NODE, '/usr/local'],
      hiddenFiles: ['/etc/gotong.env', `${SPACE}/hands.json`],
    })
    expect(args).toEqual(without)
  })

  // The load-bearing case for the layered emission: `<space>` is hidden, the
  // member workspace INSIDE it is re-bound writable — and the operator hides
  // something inside THAT. Emitting by kind (all hides, then all re-exposes)
  // would put the re-expose last and silently undo the nested hide, i.e. hand
  // the whole workspace back including the path the operator took away.
  it('seatbelt: a hide NESTED INSIDE a re-exposed root is emitted after it (deepest wins), and a hidden file inside one is no longer dropped', () => {
    const NESTED = `${WORKSPACE}/private`
    const SECRET = `${WORKSPACE}/.env.local`
    const lines = buildSeatbeltProfile([WORKSPACE], {
      hiddenPaths: [SPACE, NESTED],
      hiddenFiles: [SECRET, `${SPACE}/agents.json`],
    }).split('\n')
    const iSpace = lines.indexOf(`  (subpath "${SPACE}")`)
    // lastIndexOf: the workspace appears twice — once in the classic write
    // allow at the top, once as the re-expose inside the hidden `<space>`.
    const iWs = lines.lastIndexOf(`  (subpath "${WORKSPACE}")`)
    const iNested = lines.indexOf(`  (subpath "${NESTED}")`)
    expect(iSpace).toBeGreaterThan(0)
    expect(iWs).toBeGreaterThan(iSpace) // workspace re-exposed after the hide
    expect(iNested).toBeGreaterThan(iWs) // …and the nested hide wins over it
    expect(lines[iNested - 1]).toBe('(deny file-read* file-write*')
    // a hidden file inside the re-exposed root survives; one swallowed by a
    // hide with nothing re-exposing it is still dropped as redundant
    expect(lines).toContain(`  (literal "${SECRET}")`)
    expect(lines.join('\n')).not.toContain('agents.json')
    expect(lines.lastIndexOf(`  (literal "${SECRET}")`)).toBeGreaterThan(iNested)
  })

  it('bwrap: the nested hide is mounted AFTER the bind that re-exposes it; both hidden mounts are remounted ro at the end', () => {
    const NESTED = `${WORKSPACE}/private`
    const SECRET = `${WORKSPACE}/.env.local`
    const args = buildBwrapArgs([WORKSPACE], WORKSPACE, {
      hiddenPaths: [SPACE, NESTED],
      hiddenFiles: [SECRET],
    })
    const joined = args.join(' ')
    const iSpace = joined.indexOf(`--tmpfs ${SPACE} `)
    const iBind = joined.indexOf(`--bind ${WORKSPACE} ${WORKSPACE}`)
    const iNested = joined.indexOf(`--tmpfs ${NESTED} `)
    const iFile = joined.indexOf(`--ro-bind /dev/null ${SECRET}`)
    expect(iSpace).toBeGreaterThan(0)
    expect(iBind).toBeGreaterThan(iSpace)
    expect(iNested).toBeGreaterThan(iBind)
    expect(iFile).toBeGreaterThan(iNested)
    expect(joined.indexOf(`--remount-ro ${SPACE} `)).toBeGreaterThan(iFile)
    expect(joined.indexOf(`--remount-ro ${NESTED}`)).toBeGreaterThan(iFile)
  })

  it('a read-only re-expose also keeps a hide nested inside it (three alternating layers)', () => {
    const HOME = '/home/hub'
    const TOOLS = `${HOME}/.nvm`
    const INNER = `${TOOLS}/private`
    const lines = buildSeatbeltProfile([ROOT], {
      hiddenPaths: [HOME, INNER],
      readOnlyRoots: [TOOLS],
    }).split('\n')
    const iHome = lines.indexOf(`  (subpath "${HOME}")`)
    const iTools = lines.indexOf(`  (subpath "${TOOLS}")`)
    const iInner = lines.indexOf(`  (subpath "${INNER}")`)
    expect(iHome).toBeGreaterThan(0)
    expect(iTools).toBeGreaterThan(iHome)
    expect(lines[iTools - 1]).toBe('(allow file-read*')
    expect(iInner).toBeGreaterThan(iTools)
    expect(lines[iInner - 1]).toBe('(deny file-read* file-write*')
  })

  posixOnly('wrapWithFsJail resolves relative hidden paths against cwd, de-duplicates them and drops one nested under another', () => {
    const w = wrapWithFsJail({
      command: 'tool',
      args: [],
      allowedRoots: ['work'],
      cwd: '/srv/hub/space',
      kind: 'bwrap',
      hardening: { hiddenPaths: ['.', '/srv/hub/space', 'secret'] },
    })
    const joined = w.args.join(' ')
    expect(joined).toContain('--tmpfs /srv/hub/space ')
    // `secret` is under `/srv/hub/space` → redundant → dropped
    expect(joined).not.toContain('--tmpfs /srv/hub/space/secret ')
    expect(w.args.filter((a) => a === '--tmpfs').length).toBe(2) // /tmp + the one unique hidden
    expect(joined).toContain('--bind /srv/hub/space/work /srv/hub/space/work')
  })

  posixOnly('wrapWithFsJail: every new field is additive — the classic argv/profile is byte-identical without them', () => {
    for (const kind of ['sandbox-exec', 'bwrap'] as const) {
      const base = { command: 'tool', args: ['x'], allowedRoots: [ROOT], cwd: ROOT, kind }
      const classic = wrapWithFsJail(base)
      expect(wrapWithFsJail({ ...base, hardening: { hiddenFiles: [], readOnlyRoots: [' '], denySharedTmp: false } })).toEqual(classic)
    }
  })
})

describe('detectFsJail', () => {
  const okProbe: JailProbe = async () => ({ ok: true })
  const failProbe: JailProbe = async () => ({ ok: false, detail: 'no userns' })

  it('darwin + working sandbox-exec → kind sandbox-exec', async () => {
    const cap = await detectFsJail({ platform: 'darwin', probe: okProbe, noCache: true })
    expect(cap).toEqual({ kind: 'sandbox-exec' })
  })

  it('darwin + failing probe → none with a fallback reason', async () => {
    const cap = await detectFsJail({ platform: 'darwin', probe: failProbe, noCache: true })
    expect(cap.kind).toBe('none')
    expect(cap.reason).toContain('sandbox-exec')
    expect(cap.reason).toContain('human gate')
  })

  it('linux + working bwrap → kind bwrap', async () => {
    const cap = await detectFsJail({ platform: 'linux', probe: okProbe, noCache: true })
    expect(cap).toEqual({ kind: 'bwrap' })
  })

  it('linux + missing/blocked bwrap → none mentioning bubblewrap + userns', async () => {
    const cap = await detectFsJail({ platform: 'linux', probe: failProbe, noCache: true })
    expect(cap.kind).toBe('none')
    expect(cap.reason).toContain('bubblewrap')
    expect(cap.reason).toContain('user namespaces')
  })

  it('probes functionally — runs the enforcer, not a which lookup', async () => {
    const probe = vi.fn<JailProbe>(async () => ({ ok: true }))
    await detectFsJail({ platform: 'linux', probe, noCache: true })
    expect(probe).toHaveBeenCalledTimes(1)
    const [command, args] = probe.mock.calls[0]!
    expect(command).toBe('bwrap')
    expect(args).toContain('--ro-bind') // a real bwrap invocation over `true`
    expect(args).toContain('true')
  })

  it('an unsupported platform (win32) → none, Windows deferred', async () => {
    const cap = await detectFsJail({ platform: 'win32', probe: okProbe, noCache: true })
    expect(cap.kind).toBe('none')
    expect(cap.reason).toContain('win32')
  })

  it('caches the result and reset clears it', async () => {
    resetFsJailCache()
    const probe = vi.fn<JailProbe>(async () => ({ ok: true }))
    const a = await detectFsJail({ platform: 'linux', probe })
    const b = await detectFsJail({ platform: 'linux', probe })
    expect(a).toEqual(b)
    expect(probe).toHaveBeenCalledTimes(1) // second call served from cache
    resetFsJailCache()
    await detectFsJail({ platform: 'linux', probe })
    expect(probe).toHaveBeenCalledTimes(2) // probed again after reset
    resetFsJailCache()
  })
})

/**
 * HANDS-M2b — the spec→options copier. Its whole reason to exist is that the
 * outbound adapters used to copy `FsJailSpec` fields BY NAME, so a field they
 * had never heard of (`hardening`) went missing while the jail still reported
 * `jailed: true` — a weaker perimeter that looks identical from the outside.
 */
describe('jailWrapOptions', () => {
  const spec: FsJailSpec = {
    allowedRoots: ['/work'],
    kind: 'bwrap',
    extraWritableRoots: ['/cache'],
    hardening: { unshareNet: true, hiddenPaths: ['/secrets'] },
  }

  it('carries every field of the spec across, plus the command/args/cwd', () => {
    const o = jailWrapOptions(spec, { command: 'coder', args: ['--go'], cwd: '/work' })
    expect(o).toEqual({
      command: 'coder',
      args: ['--go'],
      cwd: '/work',
      allowedRoots: ['/work'],
      kind: 'bwrap',
      extraWritableRoots: ['/cache'],
      hardening: { unshareNet: true, hiddenPaths: ['/secrets'] },
    })
  })

  it('forwards a field this function has never heard of (total by construction)', () => {
    // Stand-in for "someone adds a key to FsJailSpec next year". A by-name copy
    // would silently drop it; the rest-spread carries it without being taught.
    const future = { ...spec, someFutureConfinement: true } as FsJailSpec
    const o = jailWrapOptions(future, { command: 'coder', args: [] }) as Record<string, unknown>
    expect(o.someFutureConfinement).toBe(true)
  })

  it('omits cwd when the caller has none (wrapWithFsJail then defaults it)', () => {
    expect('cwd' in jailWrapOptions(spec, { command: 'coder', args: [] })).toBe(false)
  })

  it('the hardening it carries really reaches the enforcer argv', () => {
    const hardened = wrapWithFsJail(jailWrapOptions(spec, { command: 'coder', args: [], cwd: '/work' }))
    expect(hardened.args).toContain('--unshare-net')
    const { hardening: _dropped, ...plain } = spec
    const soft = wrapWithFsJail(jailWrapOptions(plain, { command: 'coder', args: [], cwd: '/work' }))
    expect(soft.args).not.toContain('--unshare-net')
  })
})
