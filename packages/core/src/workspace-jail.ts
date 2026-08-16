/**
 * workspace-jail.ts — Layer 1 of the lightweight FS sandbox: a portable,
 * pure-lexical ARGV PATH JAIL (用户 2026-06-29「不用 Docker 的轻量文件围栏」).
 *
 * # The two-layer sandbox (this is layer 1)
 *
 * The hub drives external commands (cli-agent / acp-agent / the butler's
 * governed shell tool). We want them confined to allowed folders WITHOUT the
 * weight of Docker. Two layers, composed:
 *
 *   - **Layer 1 (here): argv path jail** — pure JS, 100% portable
 *     (Mac/Linux/Windows identical). Inspect the about-to-spawn `command` + its
 *     `args`: resolve every path-like argument and confirm it stays inside the
 *     allowed roots; reject anything we CAN'T reason about (shell metacharacters,
 *     an interpreter command that escapes argv reasoning, a path escaping the
 *     roots). This is a **policy gate + UX, not a security boundary** — its
 *     verdict feeds the same pre-spawn seam as `dangerousCommandGate`, so a
 *     `{ park }` suspends the task for a human to approve in `/me` (fail-closed:
 *     if we can't prove confinement, ask a person).
 *
 *   - **Layer 2 (M2): OS kernel jail** — `sandbox-exec` (macOS) / `bwrap`
 *     (Linux) actually confine the spawned process tree to the roots. THAT is
 *     the boundary. Layer 1 deliberately stays lexical (it never touches the
 *     filesystem), so a symlink inside an allowed root that points out is NOT
 *     layer 1's job to catch — layer 2 enforces the real perimeter.
 *
 * # Why lexical / pure
 *
 * `path.resolve` collapses `..` lexically, so `/work/../etc/passwd` → `/etc/...`
 * is caught here with zero fs access — deterministic, testable, and identical on
 * every OS. Resolving symlinks (`realpath`) would couple this to the filesystem
 * and still not be a real boundary; we leave that to layer 2 and keep layer 1 a
 * fast, portable, side-effect-free check.
 *
 * # What it is NOT for
 *
 * A freeform PROMPT passed to an agent CLI (e.g. `codex exec "<natural
 * language>"`) is not structured argv — scanning prose for metacharacters would
 * park on every sentence with a semicolon. Callers pass the STRUCTURAL argv
 * (command + flags + explicit path args) to {@link jailArgv}; the freeform
 * payload is confined by layer 2, and destructive-intent in the prompt is the
 * job of the complementary `dangerousCommandGate`.
 */

import path from 'node:path'

/** Why an invocation could not be proven confined to the allowed roots. */
export type JailParkCode =
  /** A path argument resolves outside every allowed root. */
  | 'path_escape'
  /** A shell metacharacter (`; & | $ \` < >` / newline) we can't reason about. */
  | 'shell_metacharacter'
  /** The command is a shell / interpreter / exec-launcher that escapes argv reasoning. */
  | 'interpreter_command'
  /** No allowed roots configured — nothing can be proven safe (fail-closed). */
  | 'no_allowed_roots'

/**
 * Verdict shape — intentionally the superset of cli-agent's `CliGateVerdict`
 * (`{ allow } | { park, reason }`) plus a machine-readable `code`, so wiring it
 * beside `dangerousCommandGate` is a trivial adapt (drop `code`).
 */
export type JailVerdict =
  | { readonly allow: true }
  | { readonly park: true; readonly reason: string; readonly code: JailParkCode }

export interface JailArgvOptions {
  /** The command about to be spawned (its basename is checked for interpreters). */
  command: string
  /** The structural arguments. Do NOT pass a freeform prompt here (see file doc). */
  args: readonly string[]
  /** Directories the invocation is confined to. Relative roots resolve against `cwd`. */
  allowedRoots: readonly string[]
  /** Working directory path arguments resolve against. Default `process.cwd()`. */
  cwd?: string
  /** Extra command basenames to treat as escape-capable interpreters. */
  extraInterpreters?: readonly string[]
}

/**
 * Shell metacharacters that signal an intent we can't verify with simple argv
 * reasoning: command chaining (`;` `&` `|`), substitution (`$` backtick),
 * redirection (`<` `>`), and newlines. Globs (`* ? [ ]`) and `~` are excluded —
 * under `shell: false` they're literal, and they appear in legitimate args.
 */
const SHELL_METACHAR_RE = /[;&|$`<>\n\r]/

/**
 * Commands that can read/write the filesystem regardless of their argv, making
 * a path-argument check meaningless (false confidence). Shells, interpreters,
 * and exec-launchers. Matched on the command's basename, case-insensitively,
 * with trailing version digits stripped (`python3`, `python3.11` → `python`).
 */
export const DEFAULT_INTERPRETERS: readonly string[] = [
  // shells
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash', 'busybox',
  // interpreters
  'python', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua', 'tclsh', 'osascript',
  // exec-launchers / escape hatches
  'env', 'xargs', 'find', 'eval', 'exec', 'nohup', 'setsid', 'nice', 'timeout',
  'watch', 'ssh', 'sudo', 'doas', 'awk',
]

/**
 * Layer 1 gate: is this structured invocation provably confined to
 * `allowedRoots`? Returns `{ allow }` when yes, `{ park, reason, code }` when it
 * cannot be proven (fail-closed). Pure + synchronous — no filesystem access.
 *
 * Checks, in order (first failure wins):
 *   1. no allowed roots → `no_allowed_roots`
 *   2. command basename is an interpreter / shell / exec-launcher → `interpreter_command`
 *   3. command or any arg contains a shell metacharacter → `shell_metacharacter`
 *   4. a path-like arg resolves outside the roots → `path_escape`
 */
export function jailArgv(opts: JailArgvOptions): JailVerdict {
  const cwd = opts.cwd ?? process.cwd()
  const roots = opts.allowedRoots
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => path.resolve(cwd, r))
  if (roots.length === 0) {
    return park('no_allowed_roots', 'no allowed roots configured — refusing to run unconfined')
  }

  const interpreters = new Set(
    [...DEFAULT_INTERPRETERS, ...(opts.extraInterpreters ?? [])].map((s) => s.toLowerCase()),
  )
  const base = interpreterBasename(opts.command)
  if (interpreters.has(base)) {
    return park(
      'interpreter_command',
      `command '${opts.command}' is an interpreter/shell (${base}) that can access the ` +
        'filesystem regardless of its arguments — path confinement cannot be proven',
    )
  }

  if (SHELL_METACHAR_RE.test(opts.command)) {
    return park('shell_metacharacter', `command '${opts.command}' contains a shell metacharacter`)
  }
  for (const arg of opts.args) {
    if (SHELL_METACHAR_RE.test(arg)) {
      return park('shell_metacharacter', `argument '${arg}' contains a shell metacharacter`)
    }
  }

  for (const arg of opts.args) {
    const candidate = pathCandidate(arg)
    if (candidate === null || !looksLikePath(candidate)) continue
    if (!isInsideRoots(path.resolve(cwd, candidate), roots)) {
      return park('path_escape', `path argument '${candidate}' resolves outside the allowed roots`)
    }
  }

  return { allow: true }
}

/**
 * Is `target` inside any of `roots`? Lexical only — both sides should already be
 * absolute (callers resolve via `path.resolve`). Exposed for layer 2 and tests.
 */
export function isInsideRoots(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, target)
    // '' = exactly the root; a sub-path never starts with '..' and is not
    // absolute (an absolute `rel` means a different drive/root on Windows).
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

// ===========================================================================
// Layer 2 — OS kernel jail (the real boundary). Pure argv/profile builders;
// the runtime capability probe lives in `workspace-jail-detect.ts` (the only
// part that spawns), keeping this module side-effect-free.
// ===========================================================================

/**
 * Which OS kernel enforcer confines the spawned process tree:
 *   - `sandbox-exec` — macOS Seatbelt (system built-in; Apple-deprecated but works)
 *   - `bwrap`        — Linux bubblewrap (`apt install bubblewrap`, unprivileged userns)
 *   - `none`         — no enforcer available → caller degrades to layer 1 + human gate
 */
export type FsJailKind = 'sandbox-exec' | 'bwrap' | 'none'

/** A command transformed (or not) to run under an OS kernel jail. */
export interface WrappedCommand {
  /** The command to actually spawn (the enforcer, or the original when unjailed). */
  readonly command: string
  /** Its arguments (enforcer flags + the original command + its args, or just the original args). */
  readonly args: string[]
  /** True when an OS kernel jail wraps the process; false = unconfined (degrade + warn). */
  readonly jailed: boolean
  /** Which enforcer was applied. */
  readonly kind: FsJailKind
}

/**
 * Optional layer-2 hardening on top of the write perimeter (HANDS-M2). Every
 * field is opt-in and ABSENT means the enforcer argv/profile is byte-identical
 * to the un-hardened jail the outbound adapters have always used — the hub's
 * own hands (`personal-butler-hands`) turn these on; cli-agent / acp-agent
 * keep their agent-friendly defaults (network + reads allowed).
 */
export interface FsJailHardening {
  /**
   * Cut the process tree off the network: bwrap `--unshare-net`; Seatbelt
   * `(deny network*)`. Off by default because a driven coding agent needs its
   * provider API.
   */
  readonly unshareNet?: boolean
  /**
   * Process isolation: the tree can't see, signal or drive the hub's other
   * processes (they all run as the same UID, so without this a jailed command
   * could `kill` the hub or read its `/proc/<pid>/environ`). bwrap: a fresh PID
   * namespace (`--unshare-pid`, the hub is simply not there). Seatbelt has no
   * PID namespace; the closest approximation is appended instead — signals and
   * process-info only within the sandbox (`(deny signal)` + `(allow signal
   * (target same-sandbox))`, same for `process-info*`), no LaunchServices
   * launches (`(deny lsopen)` — `open -a` would start an app OUTSIDE the
   * sandbox) and no AppleEvents (`(deny appleevent-send)` — `osascript` could
   * drive Terminal). Verified on macOS 26: `kill` of a foreign pid → EPERM,
   * own children still killable, node/git/python/npm unaffected; `ps` (already
   * crippled under Seatbelt) stays crippled.
   */
  readonly unsharePid?: boolean
  /**
   * Directories the process must not even READ (the hub's `<space>` — vault
   * ciphertext, agents.json, sessions — the hub user's HOME, `/home`, `/root`,
   * `/run/user`). bwrap: an empty tmpfs is mounted over each hidden path BEFORE
   * the read-only / writable roots are re-bound, so a root that lives under a
   * hidden path (the member workspace under `<space>`) is re-exposed and
   * everything else under it is simply not there; the tmpfs is remounted
   * read-only at the end so a runaway writer can't fill RAM through it.
   * Seatbelt: `(deny file-read* file-write* (subpath hidden))` followed by a
   * re-allow of read+write for the roots that sit under it (last match wins).
   * Callers pass ABSOLUTE paths that EXIST (bwrap needs a mount point; on a
   * read-only `/` it cannot create one) and, for Seatbelt, the symlink-resolved
   * spelling: Seatbelt matches the canonical vnode path (verified: a deny on
   * `/private/tmp/x` also blocks `/tmp/x`, a deny on `/tmp/x` does NOT block
   * `/private/tmp/x`) — pass both spellings when they differ; the builder is
   * pure and never touches the filesystem. A hidden path nested under another
   * hidden path is dropped ONLY when nothing re-exposes it in between (see
   * {@link planJailLayers}) — a nested hide under a re-bound writable root is
   * the one case where the operator's explicit hide is the only thing standing.
   */
  readonly hiddenPaths?: readonly string[]
  /**
   * Individual files / sockets the process must not read or write even though
   * they live outside every hidden directory (an `EnvironmentFile=` outside
   * `<space>`, the docker socket). bwrap: `--ro-bind /dev/null f` — an empty
   * read-only decoy over the real file (the file must exist on the host, see
   * `hiddenPaths`). Seatbelt: `(deny file-read* file-write* (literal f))`,
   * appended AFTER every re-allow AND every layer so it always wins. A file
   * under a hidden directory is dropped ONLY when no re-exposed subtree brings
   * it back (a file inside the re-bound member workspace is emitted).
   */
  readonly hiddenFiles?: readonly string[]
  /**
   * Directories UNDER a hidden path the process may still READ — the node
   * prefix that happens to live in the hub user's home (nvm), a toolchain the
   * operator chose to expose. Only entries inside a hidden path are honoured
   * (anything else is readable already and is dropped); an entry that is also
   * a writable root is left to the root binding. bwrap: `--ro-bind r r` after
   * the hidden tmpfs and before the writable binds; Seatbelt: `(allow file-read*
   * (subpath r))` after the hidden deny (last match wins).
   */
  readonly readOnlyRoots?: readonly string[]
  /**
   * Take the box-shared temp dirs off the writable perimeter — Seatbelt only:
   * `/tmp` / `/private/tmp` AND the per-user `/var/folders` come off
   * {@link MAC_ESSENTIAL_WRITABLE} (the hub process and every member's command
   * share them because they all run as the hub's UID — a member command could
   * plant a file the hub's own `mkdtemp` staging or another member's build picks
   * up); the caller points `TMPDIR` inside a writable root instead. `/dev` stays.
   * bwrap: every run already gets a private tmpfs `/tmp` and `/var/tmp` sits
   * under the read-only `/` bind, so this is a no-op there.
   */
  readonly denySharedTmp?: boolean
}

export interface WrapWithFsJailOptions {
  /** The original command. */
  command: string
  /** The original arguments (the freeform payload is fine here — the kernel confines it). */
  args: readonly string[]
  /** Directories the process may write to. Relative roots resolve against `cwd`. */
  allowedRoots: readonly string[]
  /** Working directory. Default `process.cwd()`. */
  cwd?: string
  /** Which enforcer to apply (from {@link detectFsJail}). */
  kind: FsJailKind
  /** Extra writable directories beyond the roots (e.g. a build cache). */
  extraWritableRoots?: readonly string[]
  /**
   * Layer-2 hardening (network off / PID unshare / hidden paths). Absent = the
   * classic write-perimeter-only jail, byte-identical to before this field
   * existed.
   */
  hardening?: FsJailHardening
}

/**
 * The per-spawn jail config a caller threads to an adapter (cli-runner /
 * acp-session): the resolved enforcer `kind` (from {@link detectFsJail}) + the
 * writable roots. The adapter merges in the command/args/cwd at spawn time. One
 * shared shape so the two outbound adapters don't drift apart.
 */
export interface FsJailSpec {
  /** Directories the spawned process tree may write to. Relative → resolved against the spawn cwd. */
  allowedRoots: readonly string[]
  /** Which OS enforcer to apply. `'none'` = no jail (adapter spawns unconfined; caller degrades). */
  kind: FsJailKind
  /** Extra writable directories beyond the roots (e.g. a build/tool cache). */
  extraWritableRoots?: readonly string[]
  /**
   * HANDS-M2b — layer-2 hardening for an adapter-driven spawn (hand B runs a
   * coding CLI inside the SAME jail shape hand A uses). Absent = the classic
   * write-perimeter-only jail, byte-identical to before this field existed.
   *
   * This lives in the spec — not only in {@link WrapWithFsJailOptions} — so an
   * adapter's caller can hand over a complete perimeter. What makes that safe
   * is {@link jailWrapOptions}: adapters must not copy spec fields by name
   * (a dropped hardening key still reports `jailed: true`, i.e. a weaker jail
   * that looks identical from the outside).
   */
  hardening?: FsJailHardening
}

/**
 * Turn an {@link FsJailSpec} + the spawn's command/args/cwd into
 * {@link WrapWithFsJailOptions} — the ONE place the spec's fields are copied.
 *
 * Why a helper instead of spreading the fields at each adapter: the copy is
 * **total by construction** (`...rest` carries every field this function has
 * never heard of), so a field added to the spec later reaches every adapter
 * without anyone remembering to thread it. The two outbound adapters
 * (cli-runner, acp-session) used to hand-copy `allowedRoots`/`kind`/
 * `extraWritableRoots`, which is exactly how `hardening` would have gone
 * missing in silence.
 */
export function jailWrapOptions(
  spec: FsJailSpec,
  cmd: { command: string; args: readonly string[]; cwd?: string | undefined },
): WrapWithFsJailOptions {
  const { allowedRoots, kind, ...rest } = spec
  return {
    command: cmd.command,
    args: cmd.args,
    allowedRoots,
    kind,
    ...(cmd.cwd !== undefined ? { cwd: cmd.cwd } : {}),
    ...rest,
  }
}

/**
 * System paths a normal process must still write to (temp, device nodes) so the
 * jail doesn't break it. macOS lists them as Seatbelt writable subpaths; Linux
 * gets them via dedicated bwrap flags (`--dev`, `--tmpfs`, `--proc`).
 */
export const MAC_ESSENTIAL_WRITABLE: readonly string[] = [
  '/dev',
  '/tmp',
  '/private/tmp',
  '/var/folders',
  '/private/var/folders',
]

/**
 * Wrap a command to run under the given OS kernel jail, confined to write only
 * inside `allowedRoots` (+ essentials). Pure: builds the enforcer argv, never
 * spawns. For `kind: 'none'` the command passes through unchanged with
 * `jailed: false` so the caller applies its degradation (layer 1 + human gate +
 * a loud warning — there is no real perimeter).
 */
export function wrapWithFsJail(opts: WrapWithFsJailOptions): WrappedCommand {
  const cwd = opts.cwd ?? process.cwd()
  const roots = [...opts.allowedRoots, ...(opts.extraWritableRoots ?? [])]
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => path.resolve(cwd, r))

  const hardening = normalizeHardening(opts.hardening, cwd)

  if (opts.kind === 'sandbox-exec') {
    const profile = buildSeatbeltProfile([...roots, ...MAC_ESSENTIAL_WRITABLE], hardening)
    return {
      command: 'sandbox-exec',
      args: ['-p', profile, opts.command, ...opts.args],
      jailed: true,
      kind: 'sandbox-exec',
    }
  }
  if (opts.kind === 'bwrap') {
    return {
      command: 'bwrap',
      args: [...buildBwrapArgs(roots, cwd, hardening), opts.command, ...opts.args],
      jailed: true,
      kind: 'bwrap',
    }
  }
  return { command: opts.command, args: [...opts.args], jailed: false, kind: 'none' }
}

/**
 * Build a Seatbelt (SBPL) profile: allow everything by default, then DENY all
 * file writes, then re-allow writes only under the given subpaths. Reads,
 * network, and exec stay allowed (an agent needs them); only the write
 * perimeter is enforced. Last matching rule wins in SBPL, so the re-allow
 * overrides the blanket deny for the listed subpaths.
 *
 * With `hardening` (HANDS-M2) optional blocks are APPENDED — nothing before
 * them changes, so an absent/empty hardening yields the exact classic profile
 * (SBPL: the LAST matching rule wins, so order is semantics):
 *   1. the hide / re-expose LAYERS, emitted DEEPEST LAST ({@link planJailLayers}):
 *      `(deny file-read* file-write* (subpath hidden))` for a hidden directory,
 *      `(allow file-read* (subpath r))` for a `readOnlyRoots` entry under one,
 *      `(allow file-read* file-write* (subpath root))` for a writable root under
 *      one (the member workspace under `<space>`). Depth order is the whole
 *      point: a hide NESTED INSIDE a re-exposed subtree must be emitted after
 *      that subtree or the re-expose would silently undo it;
 *   2. hidden files: `(deny file-read* file-write* (literal f))` — after every
 *      layer so a hidden file always wins;
 *   3. `unsharePid` → the process-isolation approximation (signal / process-info
 *      only within the sandbox, no `lsopen`, no AppleEvents, no launchd jobs);
 *   4. `(deny network*)` when `unshareNet`.
 * `denySharedTmp` is not a block: it removes `/tmp`, `/private/tmp` and
 * `/var/folders` (both spellings) from the writable roots BEFORE line 4 of the
 * classic profile is built, so the blanket `(deny file-write*)` covers them.
 */
export function buildSeatbeltProfile(
  writableRoots: readonly string[],
  hardening?: FsJailHardening,
): string {
  const uniqueRoots = [...new Set(writableRoots)].filter(
    (r) => !(hardening?.denySharedTmp && MAC_SHARED_TMP.includes(r)),
  )
  const subpaths = uniqueRoots.map((r) => `  (subpath ${sbplString(r)})`)
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    ...subpaths,
    ')',
  ]
  if (hardening) {
    // Seatbelt only needs the roots that a hide would otherwise swallow: a root
    // outside every hidden path is already covered by the classic write allow
    // (and reads are allowed by default).
    const plan = planJailLayers(hardening, uniqueRoots, {
      rwRoots: uniqueRoots.filter((r) => isInsideRoots(r, hardening.hiddenPaths ?? [])),
    })
    for (const group of plan.groups) {
      const head =
        group.kind === 'hidden'
          ? '(deny file-read* file-write*'
          : group.kind === 'ro'
            ? '(allow file-read*'
            : '(allow file-read* file-write*'
      lines.push(head, ...group.paths.map((p) => `  (subpath ${sbplString(p)})`), ')')
    }
    if (plan.hiddenFiles.length > 0) {
      lines.push(
        '(deny file-read* file-write*',
        ...plan.hiddenFiles.map((f) => `  (literal ${sbplString(f)})`),
        ')',
      )
    }
  }
  if (hardening?.unsharePid) lines.push(...MAC_PROCESS_ISOLATION)
  if (hardening?.unshareNet) lines.push('(deny network*)')
  return lines.join('\n')
}

/** Box-shared temp dirs `denySharedTmp` takes off the Seatbelt writable perimeter. */
const MAC_SHARED_TMP: readonly string[] = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']

/**
 * Seatbelt's nearest thing to a PID namespace (see {@link FsJailHardening.unsharePid}).
 * `(target same-sandbox)` is what keeps a build's own workers signalable while a
 * foreign pid (the hub) gets EPERM; `(target others)` alone is silently
 * ignored by current macOS (verified), which is why the deny is unfiltered
 * and the allow is the narrower rule.
 */
const MAC_PROCESS_ISOLATION: readonly string[] = [
  '(deny signal)',
  '(allow signal (target same-sandbox))',
  '(deny process-info*)',
  '(allow process-info* (target same-sandbox))',
  '(deny lsopen)',
  '(deny appleevent-send)',
  // Belt-and-braces against the classic Seatbelt escape "hand the work to
  // launchd": a submitted job runs OUTSIDE the sandbox and outlives it.
  // Verified on macOS 26 that `launchctl submit` / `bootstrap gui/$UID`
  // ALREADY fail from inside any profile (launchd refuses job creation for a
  // sandboxed client), so this is a second lock on a door that is shut — but
  // the door being shut is Apple's undocumented behaviour, not ours.
  '(deny job-creation)',
]

/**
 * Build bubblewrap arguments for a writable jail: bind the whole filesystem
 * read-only, then re-bind each allowed root read-write (a later bind overrides
 * the ro-bind for its subtree). Fresh `/dev`, `/proc`, and a tmpfs `/tmp` keep a
 * normal process working; `--die-with-parent` reaps the tree if the hub exits.
 * Network is left shared (the agent needs it).
 *
 * With `hardening` (HANDS-M2), in this order (bwrap applies mounts in argv
 * order, so the order IS the semantics): `--unshare-net` / `--unshare-pid` →
 * the hide / re-expose LAYERS emitted DEEPEST LAST ({@link planJailLayers}):
 * an empty `--tmpfs` over a hidden path, `--ro-bind r r` for a `readOnlyRoots`
 * entry under one, `--bind r r` for a writable root — so a root under a hidden
 * path is re-bound on top and stays real, AND a hide nested inside that root is
 * mounted after it and stays hidden → `--ro-bind /dev/null f` over each hidden
 * file (after every bind, so a hidden file always wins) → `--remount-ro` on
 * each hidden tmpfs (the mount point itself only, never the roots re-bound
 * beneath it) so a runaway writer can't fill RAM through the decoy.
 * `denySharedTmp` is a no-op here (private tmpfs `/tmp` per run already).
 * Absent/empty hardening = the classic argv, roots bound in the caller's order.
 */
export function buildBwrapArgs(
  writableRoots: readonly string[],
  cwd: string,
  hardening?: FsJailHardening,
): string[] {
  const args = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--die-with-parent',
  ]
  if (hardening?.unshareNet) args.push('--unshare-net')
  if (hardening?.unsharePid) args.push('--unshare-pid')
  const roots = [...new Set(writableRoots)]
  if (!hardening) {
    for (const r of roots) args.push('--bind', r, r)
    args.push('--chdir', cwd)
    return args
  }
  // Unlike Seatbelt (where the classic write allow already covers roots outside
  // every hide) bwrap must bind EVERY writable root, so all of them take part in
  // the depth ordering — nested roots then also land parent-first.
  const plan = planJailLayers(hardening, roots, { rwRoots: roots })
  for (const group of plan.groups) {
    for (const p of group.paths) {
      if (group.kind === 'hidden') args.push('--tmpfs', p)
      else if (group.kind === 'ro') args.push('--ro-bind', p, p)
      else args.push('--bind', p, p)
    }
  }
  for (const f of plan.hiddenFiles) args.push('--ro-bind', '/dev/null', f)
  for (const group of plan.groups) {
    if (group.kind === 'hidden') for (const p of group.paths) args.push('--remount-ro', p)
  }
  args.push('--chdir', cwd)
  return args
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * One hide / re-expose rule to emit. `path` decides WHERE it applies, `kind`
 * WHAT it does; the emission order (see {@link planJailLayers}) decides who wins.
 */
type JailLayerKind = 'ro' | 'rw' | 'hidden'

interface JailLayerGroup {
  readonly kind: JailLayerKind
  readonly paths: string[]
}

/**
 * At the same path the later rule wins, so this is the tie-break: a re-expose
 * (read-only, then writable) first, the hide last — an explicit hide of a path
 * that is also a root wins over the root.
 */
const JAIL_LAYER_RANK: Record<JailLayerKind, number> = { ro: 0, rw: 1, hidden: 2 }

/**
 * Order the hide / re-expose rules so that **the deepest path wins**, and work
 * out which entries are genuinely redundant.
 *
 * Both enforcers resolve overlapping rules by ORDER (SBPL: last match wins;
 * bwrap: later mounts cover earlier ones), and the hub's hands need three
 * alternating layers: hide the hub's `<space>` and HOME → re-expose the member
 * workspace inside `<space>` (writable) and the node prefix inside HOME
 * (read-only) → hide again inside those (an operator's `hands.json` "hidden"
 * entry that happens to live under the workspace, a decoy over a file the
 * member may not read). Emitting by KIND (all hides, then all re-exposes) is
 * what a naive implementation does and it silently loses that third layer:
 * the re-expose is last, so the nested hide never applies. Sorting by depth
 * makes the nesting itself the semantics — no matter how many alternations the
 * operator configures.
 *
 * Redundancy is decided by the same rule: a nested hide (or a hidden file under
 * a hidden directory) is dropped ONLY when nothing re-exposes it in between.
 * That keeps the mount list minimal in the common case without ever letting a
 * re-expose quietly undo a hide.
 *
 * `rwRoots` are the writable roots to EMIT (Seatbelt only needs those a hide
 * would otherwise swallow; bwrap needs every one); `allRoots` are all writable
 * roots and count as re-exposures either way.
 */
function planJailLayers(
  hardening: FsJailHardening,
  allRoots: readonly string[],
  opts: { rwRoots: readonly string[] },
): { groups: JailLayerGroup[]; hiddenFiles: string[] } {
  const allHidden = [...new Set(hardening.hiddenPaths ?? [])]
  const rwRoots = [...new Set(opts.rwRoots)]
  // A read-only re-expose outside every hidden path is a no-op (reads are
  // allowed by default under both enforcers) and an entry that is also a
  // writable root would only take write access away — both are dropped.
  const readOnly = [...new Set(hardening.readOnlyRoots ?? [])].filter(
    (r) => isInsideRoots(r, allHidden) && !allRoots.includes(r),
  )
  const reexposed = [...readOnly, ...allRoots]
  const hidden = allHidden.filter(
    (h) => !isSwallowedByHidden(h, allHidden.filter((o) => o !== h), reexposed),
  )
  const hiddenFiles = [...new Set(hardening.hiddenFiles ?? [])].filter(
    (f) => !isSwallowedByHidden(f, hidden, reexposed),
  )

  const entries: { path: string; kind: JailLayerKind }[] = [
    ...hidden.map((p) => ({ path: p, kind: 'hidden' as const })),
    ...readOnly.map((p) => ({ path: p, kind: 'ro' as const })),
    ...rwRoots.map((p) => ({ path: p, kind: 'rw' as const })),
  ]
  // Nothing hidden ⇒ nothing can be swallowed ⇒ leave the caller's root order
  // alone (byte-identical to the pre-hardening argv for a hardening that only
  // asks for `--unshare-net`).
  if (hidden.length > 0) {
    entries.sort(
      (a, b) => pathDepth(a.path) - pathDepth(b.path) || JAIL_LAYER_RANK[a.kind] - JAIL_LAYER_RANK[b.kind],
    )
  }
  const groups: JailLayerGroup[] = []
  for (const e of entries) {
    const last = groups[groups.length - 1]
    if (last && last.kind === e.kind) last.paths.push(e.path)
    else groups.push({ kind: e.kind, paths: [e.path] })
  }
  return { groups, hiddenFiles }
}

/** Number of path segments; `/` = 0. The depth key the layer order sorts on. */
function pathDepth(p: string): number {
  return p.split(path.sep).filter(Boolean).length
}

/** The DEEPEST entry of `list` that contains (or equals) `target`, else null. */
function deepestContaining(target: string, list: readonly string[]): string | null {
  let best: string | null = null
  for (const c of list) {
    if (!isInsideRoots(target, [c])) continue
    if (best === null || pathDepth(c) > pathDepth(best)) best = c
  }
  return best
}

/**
 * Is `target` already invisible — inside a hidden directory with NO re-exposed
 * subtree between them? Only then is a rule for it redundant. A tie (the same
 * path both hidden and re-exposed) counts as hidden, matching the rank order.
 */
function isSwallowedByHidden(
  target: string,
  hidden: readonly string[],
  reexposed: readonly string[],
): boolean {
  const h = deepestContaining(target, hidden)
  if (h === null) return false
  const r = deepestContaining(target, reexposed)
  return r === null || pathDepth(h) >= pathDepth(r)
}

/**
 * Resolve hardening paths the same way roots are resolved (trim / drop empties /
 * absolute against `cwd`) and collapse "nothing requested" to `undefined`, so
 * `hardening: {}` and an absent field build the identical classic argv/profile.
 * Redundant nesting is NOT pruned here — that needs the writable roots (which
 * re-expose) and so belongs to {@link planJailLayers}.
 */
function normalizeHardening(h: FsJailHardening | undefined, cwd: string): FsJailHardening | undefined {
  if (!h) return undefined
  const clean = (list: readonly string[] | undefined): string[] => [
    ...new Set(
      (list ?? [])
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => path.resolve(cwd, p)),
    ),
  ]
  const hiddenPaths = clean(h.hiddenPaths)
  const hiddenFiles = clean(h.hiddenFiles)
  const readOnlyRoots = clean(h.readOnlyRoots)
  const out: FsJailHardening = {
    ...(h.unshareNet ? { unshareNet: true } : {}),
    ...(h.unsharePid ? { unsharePid: true } : {}),
    ...(hiddenPaths.length > 0 ? { hiddenPaths } : {}),
    ...(hiddenFiles.length > 0 ? { hiddenFiles } : {}),
    ...(readOnlyRoots.length > 0 ? { readOnlyRoots } : {}),
    ...(h.denySharedTmp ? { denySharedTmp: true } : {}),
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Quote a path as an SBPL string literal (escape backslash + double-quote). */
function sbplString(p: string): string {
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function park(code: JailParkCode, reason: string): JailVerdict {
  return { park: true, reason, code }
}

/** Lowercased basename with a leading-path and trailing version suffix stripped. */
function interpreterBasename(command: string): string {
  let base = path.basename(command.trim()).toLowerCase()
  // python3 / python3.11 / node20 → python / node, so a versioned interpreter
  // is still recognized.
  base = base.replace(/[\d.]+$/, '')
  return base
}

/**
 * Extract the path portion of an argument, or `null` when it isn't one:
 *   - `--flag=VALUE` → VALUE
 *   - `--flag` / `-x` (short flags) → null (not a path)
 *   - bare token → itself
 */
function pathCandidate(arg: string): string | null {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=')
    return eq >= 0 ? arg.slice(eq + 1) : null
  }
  if (arg.startsWith('-')) return null
  return arg
}

/**
 * Would this token actually touch a path that could escape? Only absolute
 * paths, anything with a separator, and bare `..` can climb out — a bare
 * filename resolves inside `cwd` (an allowed root in practice) and is skipped.
 * Tokens with whitespace are treated as prose, not paths (defends against a
 * freeform fragment slipping in).
 */
function looksLikePath(s: string): boolean {
  if (!s || /\s/.test(s)) return false
  if (path.isAbsolute(s)) return true
  if (s.includes('/') || s.includes('\\')) return true
  return s === '..'
}
