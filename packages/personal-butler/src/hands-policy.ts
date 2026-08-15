/**
 * hands-policy.ts — HANDS-M1: the ONE tier policy every "hand" action asks
 * before it touches a file or spawns a process (docs/zh/ATONG-HANDS.md §4.1).
 *
 * # What this is
 *
 * The butler's hands (M2 `hands_run` / `hands_write` / `hands_read` /
 * `hands_list` / `hands_rm`) are the widest injection→RCE surface the butler
 * will ever have. Two things confine them: the OS kernel jail (layer 2, host
 * side, M2) and THIS pure classifier (server-authoritative, fail-closed). The
 * classifier answers one question per action — which of the four tiers it
 * lands in — and hands the answer to `GovernedActionToolset.classify` as a
 * plain `GovernedVerdict`:
 *
 *   tier 1  workspace file ops + OFFLINE runs      → allow   (jail + caps bound it)
 *   tier 2  runs that need the network             → approve (park EVERY time — 岔口 3)
 *   tier 3  system-level / credential-adjacent      → refuse  (structurally can't or must not)
 *   —       anything malformed / escaping / unknown → refuse  (fail-closed, never allow)
 *
 * (Tier 0 — knowledge / notebook / panel / memory — is served by those tools'
 * own writers and never by raw hand writes; the hands' workspace root is a
 * sibling directory, so a raw write to a tier-0 truth file is a *path escape*
 * here, refused before any tool sees it.)
 *
 * # Why the file resolver follows symlinks (unlike layer-1 `jailArgv`)
 *
 * `hands_write/read/list/rm` are performed by the HUB PROCESS itself, not by a
 * jailed child — the kernel jail cannot save a write that goes through a
 * symlink planted inside the workspace and pointing at `<space>/agents.json`.
 * So the resolver realpaths the deepest existing ancestor and requires the
 * result to stay under the (realpath'd) workspace root, and for mutating ops
 * refuses when the final component itself is a symlink (a dangling symlink to
 * an outside path would otherwise be *created through*). Symlinks that resolve
 * INSIDE the workspace stay usable (pnpm's `node_modules/.pnpm` layout depends
 * on that).
 *
 * # Why the network flag decides tier 1 vs 2
 *
 * Offline in the jail, the worst a command can do is burn CPU / fill its own
 * workspace (both capped by M2). With the network it can exfiltrate whatever
 * the model was tricked into echoing and pull arbitrary code — that is a real
 * side effect on the world, so it parks for the member every time. Known
 * network commands (`curl`, `npm install`, `git clone`, …) are *inferred* as
 * net so the model does not have to remember the flag; the inference is UX,
 * not security — a mis-inferred command simply fails offline in the jail.
 *
 * # Why a deny-list at all when the jail is the boundary
 *
 * `sudo` / `apt` / `systemctl` / `docker` / `launchctl` … either cannot work
 * (hub is not root, jail is unprivileged) or must not (persistence outside the
 * jail). Refusing them up front says so in one line instead of burning a
 * human approval on something that would fail anyway. It is a courtesy layer;
 * the jail is what holds.
 *
 * Pure: no I/O of its own. Filesystem facts come in through an injected
 * `HandsFsProbe` (`nodeHandsFsProbe` is the real one; tests pass fakes).
 */

import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { isInsideRoots } from '@gotong/core'

import type { GovernedVerdict } from './governed-toolset.js'

// ─── Constants (single source of truth; the M2 executor enforces these) ──────

/**
 * Hard caps for the hands. Explicit and refused loudly when exceeded — the
 * project rule "no silent caps" (docs/zh/ATONG-HANDS.md §三 residual: the jail
 * has no cgroup, so time / bytes / count are what bound resource abuse).
 */
export const HANDS_LIMITS = Object.freeze({
  /** One `hands_run` may live this long; the child is killed after. */
  maxRunSec: 120,
  /** stdout+stderr tail returned to the model (and kept in the audit row). */
  maxOutputBytes: 32 * 1024,
  /** Whole per-member workspace, measured before every write / run. */
  maxWorkspaceBytes: 512 * 1024 * 1024,
  /** A relative path argument. */
  maxPathChars: 1024,
  /** argv entries per run. */
  maxArgv: 256,
  /** Characters in a single argv entry (`python -c "<script>"` needs room). */
  maxArgChars: 8 * 1024,
  /** `hands_write` content. */
  maxWriteBytes: 1024 * 1024,
  /** `hands_read` returns at most this many bytes (head), and says so. */
  maxReadBytes: 256 * 1024,
  /** Concurrent runs per member. */
  maxConcurrentRuns: 1,
})

/** The five hand tools (M2 registers exactly these names). */
export const HANDS_TOOL_NAMES = Object.freeze([
  'hands_run',
  'hands_write',
  'hands_read',
  'hands_list',
  'hands_rm',
] as const)
export type HandsToolName = (typeof HANDS_TOOL_NAMES)[number]

/**
 * Commands refused outright (tier 3). Grouped by why:
 *   - privilege / package / service management: cannot work (not root, jail
 *     is unprivileged) — refuse instead of wasting an approval;
 *   - namespace / mount games: the jail's own machinery, off-limits;
 *   - persistence outside the jail (cron / launchd / systemd-run);
 *   - host-side automation (macOS `osascript` / `open`, `xdg-open`) that
 *     reaches out of the sandbox through IPC the profile may not cover.
 * Matched on the BASENAME of argv[0] (so `/usr/bin/sudo` is caught too).
 */
export const HANDS_FORBIDDEN_COMMANDS: ReadonlySet<string> = new Set([
  // privilege
  'sudo', 'su', 'doas', 'pkexec',
  // package / service / system management
  'apt', 'apt-get', 'aptitude', 'dpkg', 'yum', 'dnf', 'apk', 'pacman', 'zypper', 'snap', 'brew',
  'systemctl', 'service', 'systemd-run', 'reboot', 'shutdown', 'halt', 'poweroff', 'init',
  'passwd', 'useradd', 'usermod', 'userdel', 'groupadd', 'visudo',
  // containers / namespaces / mounts (the jail's own machinery)
  'docker', 'podman', 'nerdctl', 'bwrap', 'sandbox-exec', 'unshare', 'nsenter', 'chroot',
  'mount', 'umount', 'losetup',
  // persistence outside the jail
  'crontab', 'at', 'launchctl',
  // host-side automation / app launching
  'osascript', 'open', 'xdg-open',
])

/**
 * Commands that (always, or for the listed subcommands) need the network.
 * `'*'` = every invocation. Used ONLY to infer `net` when the model omitted
 * it — see header ("UX, not security").
 */
export const HANDS_NET_COMMANDS: Readonly<Record<string, readonly string[] | '*'>> = Object.freeze({
  curl: '*', wget: '*', ssh: '*', scp: '*', sftp: '*', rsync: '*', ftp: '*',
  nc: '*', ncat: '*', netcat: '*', telnet: '*', ping: '*', dig: '*', nslookup: '*', host: '*',
  git: ['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule'],
  // `npx` / `pnpm dlx` / `npm exec` deliberately NOT listed: in a dev workspace
  // they mostly run already-installed bins (`npx vitest`); a missing package
  // simply fails offline and the model retries with `net: true`.
  npm: ['install', 'i', 'add', 'ci', 'update', 'up', 'upgrade', 'publish', 'audit', 'outdated', 'view', 'info', 'search', 'login'],
  pnpm: ['install', 'i', 'add', 'update', 'up', 'upgrade', 'publish', 'audit', 'outdated', 'view', 'info', 'search', 'login'],
  yarn: ['install', 'add', 'up', 'upgrade', 'publish', 'audit', 'outdated', 'info'],
  pip: ['install', 'download', 'index', 'search'],
  pip3: ['install', 'download', 'index', 'search'],
  pipx: ['install', 'run', 'upgrade'],
  uv: ['pip', 'add', 'sync', 'lock', 'tool', 'python'],
  poetry: ['install', 'add', 'update', 'lock', 'publish'],
  cargo: ['install', 'fetch', 'update', 'add', 'publish', 'search'],
  go: ['get', 'install', 'mod'],
  gem: ['install', 'update', 'push', 'fetch'],
  bundle: ['install', 'update'],
  composer: ['install', 'update', 'require'],
  gh: '*',
  twine: '*',
  'huggingface-cli': '*',
})

// ─── Types ────────────────────────────────────────────────────────────────────

/** 0 = 自留地 (not a hand action) · 1 = 工作区 · 2 = 阿同自身基础设施 · 3 = 凭证/系统级. */
export type HandsTier = 0 | 1 | 2 | 3

export type HandsFileKind = 'write' | 'read' | 'list' | 'rm'

export interface HandsFileAction {
  kind: HandsFileKind
  /** Relative to the member workspace, as the model gave it. */
  path: string
}

export interface HandsRunAction {
  kind: 'run'
  argv: readonly string[]
  /** Model's declared network need. `undefined` → inferred from argv. */
  net?: boolean
  /** Relative cwd inside the workspace. Default → workspace root. */
  cwd?: string
}

export type HandsAction = HandsFileAction | HandsRunAction

/** Machine-readable outcome — stable strings the M2 audit row records. */
export type HandsPolicyCode =
  /** File op inside the workspace (tier 1, allow). */
  | 'workspace_file'
  /** Offline run (tier 1, allow). */
  | 'run_offline'
  /** Run that needs the network (tier 2, approve). */
  | 'run_net'
  /** argv[0] is on the forbidden list (tier 3, refuse). */
  | 'run_forbidden'
  /** Malformed argv (empty / too many / too long / control bytes) — refuse. */
  | 'run_invalid'
  /** Malformed path (empty / absolute / control bytes / backslash / `~`) — refuse. */
  | 'path_invalid'
  /** Path resolves outside the workspace (lexically or via symlink) — refuse. */
  | 'path_escape'
  /** Mutating op through a symlink final component — refuse. */
  | 'path_symlink'
  /** Unknown tool name or argument shape — refuse (fail-closed). */
  | 'invalid_call'

export interface HandsPolicyDecision {
  tier: HandsTier
  verdict: GovernedVerdict
  code: HandsPolicyCode
  /**
   * File actions & run cwd: the ABSOLUTE, realpath-anchored path the executor
   * must use (never re-resolve the model's string). Absent on refuse.
   */
  resolvedPath?: string
  /** Run actions: the effective network need after inference. Absent on refuse. */
  net?: boolean
}

/**
 * Filesystem facts the resolver needs. Injected so the policy stays testable
 * without a real workspace; `nodeHandsFsProbe` is the real one.
 */
export interface HandsFsProbe {
  /** realpath of an EXISTING absolute path; `null` when it does not exist / cannot resolve. */
  realpath(absPath: string): string | null
  /** `true` when `absPath` itself is a symlink (lstat, no follow); `false` if not or missing. */
  isSymlink(absPath: string): boolean
}

export const nodeHandsFsProbe: HandsFsProbe = {
  realpath(absPath) {
    try {
      return realpathSync.native(absPath)
    } catch {
      return null
    }
  },
  isSymlink(absPath) {
    try {
      return lstatSync(absPath).isSymbolicLink()
    } catch {
      return false
    }
  },
}

export interface HandsPolicyContext {
  /**
   * The member's workspace root, ABSOLUTE and already realpath'd by the host
   * (the host owns `assertSafeOwnerId` + `ownerDir` — this module never builds
   * that path). Anything that resolves outside it is refused.
   */
  workspaceRoot: string
  fs: HandsFsProbe
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Classify one hand action. Never throws — bad input is a `refuse` decision.
 * Pure given `ctx.fs`.
 */
export function classifyHandsAction(action: HandsAction, ctx: HandsPolicyContext): HandsPolicyDecision {
  try {
    if (!action || typeof action !== 'object') return refuse('invalid_call', '看不懂这个动作(不是对象)')
    switch (action.kind) {
      case 'write':
      case 'read':
      case 'list':
      case 'rm':
        return classifyFile(action, ctx)
      case 'run':
        return classifyRun(action, ctx)
      default:
        return refuse('invalid_call', `看不懂这个动作(kind=${String((action as { kind?: unknown }).kind)})`)
    }
  } catch (err) {
    // A throwing probe / a pathological input must never turn into `allow`.
    return refuse('invalid_call', `分类时出错,按拒绝处理:${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Adapter for `GovernedActionToolset.classify` — maps a hand tool call
 * (`name`, LLM-supplied `args`) to a verdict. Unknown names / shapes → refuse.
 */
export function handsGovernedClassifier(
  ctx: HandsPolicyContext,
): (name: string, args: Record<string, unknown>) => GovernedVerdict {
  return (name, args) => classifyHandsToolCall(name, args, ctx).verdict
}

/** Same as the adapter but returns the full decision (the M2 executor wants `resolvedPath` / `net`). */
export function classifyHandsToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: HandsPolicyContext,
): HandsPolicyDecision {
  const action = parseHandsToolCall(name, args)
  if (action === null) return refuse('invalid_call', `不认识的手部动作或参数形状(${name})`)
  return classifyHandsAction(action, ctx)
}

/**
 * Turn a tool call into a structured action. Returns `null` for an unknown
 * tool name or a shape the policy will not reason about (fail-closed upstream).
 * Deliberately strict: no coercion of numbers-as-strings, no default argv.
 */
export function parseHandsToolCall(name: string, args: Record<string, unknown>): HandsAction | null {
  if (!args || typeof args !== 'object') return null
  switch (name) {
    case 'hands_run': {
      const argv = args.argv
      if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) return null
      const net = args.net
      if (net !== undefined && typeof net !== 'boolean') return null
      const cwd = args.cwd
      if (cwd !== undefined && typeof cwd !== 'string') return null
      const out: HandsRunAction = { kind: 'run', argv: argv as string[] }
      if (net !== undefined) out.net = net
      if (cwd !== undefined) out.cwd = cwd
      return out
    }
    case 'hands_write':
    case 'hands_read':
    case 'hands_rm': {
      if (typeof args.path !== 'string') return null
      const kind: HandsFileKind = name === 'hands_write' ? 'write' : name === 'hands_read' ? 'read' : 'rm'
      return { kind, path: args.path }
    }
    case 'hands_list': {
      const p = args.path
      if (p !== undefined && typeof p !== 'string') return null
      return { kind: 'list', path: p === undefined ? '.' : p }
    }
    default:
      return null
  }
}

/**
 * Resolve a model-supplied relative path against the workspace, fail-closed.
 * Exposed for the M2 executor (which must call it for every file op) and tests.
 *
 * `mutating` — `write` / `rm` (and nothing else): additionally refuses a
 * symlink final component (see header). Returns the absolute path to operate
 * on, or a refuse decision.
 */
export function resolveWorkspacePath(
  raw: string,
  ctx: HandsPolicyContext,
  opts: { mutating: boolean },
): { ok: true; abs: string } | { ok: false; code: HandsPolicyCode; reason: string } {
  const bad = pathShapeProblem(raw)
  if (bad !== null) return { ok: false, code: 'path_invalid', reason: bad }
  const root = canonicalRoot(ctx)
  const lexical = path.resolve(root, raw)
  if (!isInsideRoots(lexical, [root])) {
    return { ok: false, code: 'path_escape', reason: `路径「${raw}」跑出了工作区——手只能在工作区里动` }
  }
  // Follow symlinks: realpath the deepest EXISTING ancestor (the target itself
  // when it exists), re-attach the not-yet-existing remainder, and require the
  // result to stay under the root. `root` is realpath'd by the host, so a
  // symlink resolving inside it compares equal.
  const anchored = anchorRealpath(lexical, root, ctx.fs)
  if (!isInsideRoots(anchored, [root])) {
    return { ok: false, code: 'path_escape', reason: `路径「${raw}」经符号链接指到了工作区外——拒绝` }
  }
  if (opts.mutating && ctx.fs.isSymlink(lexical)) {
    return { ok: false, code: 'path_symlink', reason: `「${raw}」本身是个符号链接——不经链接写或删,先 hands_rm 掉链接本体再说` }
  }
  return { ok: true, abs: anchored }
}

/**
 * Would this argv need the network? Basename of argv[0] + the first argument
 * that is neither a flag nor the value of a known value-taking global flag
 * (`git -C <dir> pull`, `git -c k=v fetch`).
 */
export function inferNeedsNet(argv: readonly string[]): boolean {
  const cmd = commandBasename(argv[0] ?? '')
  const rule = HANDS_NET_COMMANDS[cmd]
  if (rule === undefined) return false
  if (rule === '*') return true
  const valueFlags = cmd === 'git' ? GIT_VALUE_FLAGS : EMPTY_SET
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('-')) {
      if (valueFlags.has(a)) i++ // skip the flag's value
      continue
    }
    return rule.includes(a)
  }
  return false
}

const GIT_VALUE_FLAGS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
const EMPTY_SET: ReadonlySet<string> = new Set()

// ─── Internals ────────────────────────────────────────────────────────────────

function classifyFile(action: HandsFileAction, ctx: HandsPolicyContext): HandsPolicyDecision {
  const mutating = action.kind === 'write' || action.kind === 'rm'
  const r = resolveWorkspacePath(action.path, ctx, { mutating })
  if (!r.ok) return refuse(r.code, r.reason)
  return { tier: 1, verdict: { decision: 'allow' }, code: 'workspace_file', resolvedPath: r.abs }
}

function classifyRun(action: HandsRunAction, ctx: HandsPolicyContext): HandsPolicyDecision {
  const argv = action.argv
  if (!Array.isArray(argv) || argv.length === 0) return refuse('run_invalid', '没有要执行的命令(argv 为空)')
  if (argv.length > HANDS_LIMITS.maxArgv) {
    return refuse('run_invalid', `参数太多(${argv.length} > ${HANDS_LIMITS.maxArgv})`)
  }
  for (const a of argv) {
    if (typeof a !== 'string') return refuse('run_invalid', 'argv 每项都得是字符串')
    if (a.length > HANDS_LIMITS.maxArgChars) {
      return refuse('run_invalid', `单个参数太长(${a.length} > ${HANDS_LIMITS.maxArgChars} 字符)`)
    }
    if (hasHostileArgChar(a)) return refuse('run_invalid', '参数里有控制字节——拒绝')
  }
  const cmd = argv[0]!
  if (cmd.trim().length === 0) return refuse('run_invalid', '命令名为空')
  const base = commandBasename(cmd)
  if (HANDS_FORBIDDEN_COMMANDS.has(base)) {
    return refuse(
      'run_forbidden',
      `「${base}」是系统级命令(提权/装系统包/服务/容器/持久化),阿同的手做不了也不该做——这类事请你在服务器上亲手做,我可以把步骤写给你`,
    )
  }
  let resolvedCwd: string | undefined
  if (action.cwd !== undefined) {
    const r = resolveWorkspacePath(action.cwd, ctx, { mutating: false })
    if (!r.ok) return refuse(r.code, `cwd ${r.reason}`)
    resolvedCwd = r.abs
  }
  const net = action.net === undefined ? inferNeedsNet(argv) : action.net
  const base_: HandsPolicyDecision = net
    ? {
        tier: 2,
        verdict: {
          decision: 'approve',
          reason: `「${describeArgv(argv)}」要联网${action.net === undefined ? '(按命令推断)' : ''}——联网的命令每次都先请你确认`,
        },
        code: 'run_net',
        net: true,
      }
    : { tier: 1, verdict: { decision: 'allow' }, code: 'run_offline', net: false }
  if (resolvedCwd !== undefined) base_.resolvedPath = resolvedCwd
  return base_
}

function refuse(code: HandsPolicyCode, reason: string): HandsPolicyDecision {
  return { tier: 3, verdict: { decision: 'refuse', reason }, code }
}

/** `null` when the shape is acceptable, else a member-facing reason. */
function pathShapeProblem(raw: unknown): string | null {
  if (typeof raw !== 'string') return '路径要是字符串'
  if (raw.length === 0 || raw.trim().length === 0) return '路径为空'
  if (raw.length > HANDS_LIMITS.maxPathChars) return `路径太长(${raw.length} > ${HANDS_LIMITS.maxPathChars})`
  if (path.isAbsolute(raw) || raw.startsWith('/')) return `路径「${raw}」是绝对路径——只接受工作区内的相对路径`
  if (raw.startsWith('~')) return `路径「${raw}」以 ~ 开头——不展开家目录,只接受工作区内的相对路径`
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return '路径里有控制字节'
    if (c === 0x5c) return '路径不用反斜杠,用 / 分隔'
  }
  return null
}

/** Control bytes other than \t \n \r are never legitimate in an argument. */
function hasHostileArgChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

/**
 * realpath the deepest existing ancestor of `abs` (or `abs` itself), then
 * re-attach the missing tail. Stops at `root` — never walks above it (that
 * would just re-derive the host's realpath'd root anyway).
 */
function anchorRealpath(abs: string, root: string, fs: HandsFsProbe): string {
  let probe = abs
  const tail: string[] = []
  // Walk up until something exists (root always exists — host created it).
  for (;;) {
    const real = fs.realpath(probe)
    if (real !== null) return tail.length === 0 ? real : path.join(real, ...tail.reverse())
    if (probe === root || path.dirname(probe) === probe) {
      // Root itself unresolvable (host bug / vanished) — hand back the lexical
      // path; the caller's `isInsideRoots` still holds lexically, and the M2
      // executor's own I/O will fail loudly on a vanished root.
      return abs
    }
    tail.push(path.basename(probe))
    probe = path.dirname(probe)
  }
}

/**
 * The workspace root the resolver compares against: absolute + realpath'd.
 * The host is asked to pass it that way already; re-deriving here is cheap
 * insurance against the macOS `/tmp` → `/private/tmp` class of mismatch, where
 * a lexical root and a realpath'd child would disagree and refuse everything.
 */
function canonicalRoot(ctx: HandsPolicyContext): string {
  const abs = path.resolve(ctx.workspaceRoot)
  return ctx.fs.realpath(abs) ?? abs
}

function commandBasename(cmd: string): string {
  const b = path.basename(cmd.trim())
  return b.toLowerCase()
}

function describeArgv(argv: readonly string[]): string {
  const s = argv.slice(0, 4).join(' ') + (argv.length > 4 ? ' …' : '')
  return s.length > 60 ? `${s.slice(0, 57)}...` : s
}
