/**
 * HANDS-M1 — the four-tier hands policy (docs/zh/ATONG-HANDS.md §4.1 / §六 M1).
 *
 * Load-bearing boundaries under test:
 *  - the classifier NEVER answers `allow` for anything outside the workspace,
 *    for a symlink pointing out, for a forbidden command, or for malformed
 *    input — fail-closed is structural, not a default;
 *  - `net` decides tier 1 vs 2 (offline allow / networked approve), and a
 *    known network command is inferred as net when the model forgot the flag;
 *  - the resolver returns the realpath-anchored absolute path the executor
 *    must use, and refuses mutating ops THROUGH a symlink final component
 *    (dangling ones included — that is the create-through hole);
 *  - the governed adapter maps unknown tool names / shapes to refuse.
 *
 * Symlink cases use a real temp workspace (fake probes cannot honestly model
 * `realpath` of a not-yet-existing tail); everything else uses a fake probe.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  classifyHandsAction,
  classifyHandsToolCall,
  handsGovernedClassifier,
  parseHandsToolCall,
  resolveWorkspacePath,
  inferNeedsNet,
  nodeHandsFsProbe,
  HANDS_LIMITS,
  HANDS_TOOL_NAMES,
  HANDS_FORBIDDEN_COMMANDS,
  HANDS_NET_COMMANDS,
  type HandsFsProbe,
  type HandsPolicyContext,
} from '../src/index.js'

// A probe over a virtual tree: `existing` = paths that exist (realpath = itself
// unless remapped), `links` = symlink → target (realpath follows).
function fakeProbe(existing: readonly string[], links: Record<string, string> = {}): HandsFsProbe {
  const exists = new Set(existing)
  return {
    realpath(p) {
      if (p in links) return links[p]!
      return exists.has(p) ? p : null
    },
    isSymlink(p) {
      return p in links
    },
  }
}

const ROOT = '/srv/space/butler/hands/user/u1/workspace'
const ctxOf = (probe: HandsFsProbe): HandsPolicyContext => ({ workspaceRoot: ROOT, fs: probe })
const plain = ctxOf(fakeProbe([ROOT]))

describe('hands-policy · file actions (tier 1 inside the workspace, refuse outside)', () => {
  it('a relative path inside the workspace is tier 1 allow with the absolute resolved path', () => {
    for (const kind of ['write', 'read', 'list', 'rm'] as const) {
      const d = classifyHandsAction({ kind, path: 'proj/src/index.ts' }, plain)
      expect(d.tier).toBe(1)
      expect(d.verdict).toEqual({ decision: 'allow' })
      expect(d.code).toBe('workspace_file')
      expect(d.resolvedPath).toBe(path.join(ROOT, 'proj/src/index.ts'))
    }
  })

  it('`.` and nested-but-normalizing paths stay inside', () => {
    expect(classifyHandsAction({ kind: 'list', path: '.' }, plain).resolvedPath).toBe(ROOT)
    expect(classifyHandsAction({ kind: 'read', path: 'a/./b/../c.txt' }, plain).resolvedPath).toBe(
      path.join(ROOT, 'a/c.txt'),
    )
  })

  it('lexical escapes (`..`) are refused, never allowed', () => {
    for (const p of ['../agents.json', 'a/../../secrets.enc.json', '../../../../etc/passwd', 'x/../..']) {
      const d = classifyHandsAction({ kind: 'read', path: p }, plain)
      expect(d.verdict.decision).toBe('refuse')
      expect(d.code).toBe('path_escape')
      expect(d.tier).toBe(3)
      expect(d.resolvedPath).toBeUndefined()
    }
  })

  it('absolute paths, `~`, backslashes, control bytes and empty are refused as invalid', () => {
    const cases: Array<[string, string]> = [
      ['/etc/passwd', 'absolute'],
      ['~/.ssh/id_ed25519', 'tilde'],
      ['a\\b', 'backslash'],
      [`a${String.fromCharCode(0)}b`, 'nul'],
      ['a\nb', 'newline'],
      ['', 'empty'],
      ['   ', 'blank'],
    ]
    for (const [p] of cases) {
      const d = classifyHandsAction({ kind: 'write', path: p }, plain)
      expect(d.verdict.decision).toBe('refuse')
      expect(d.code).toBe('path_invalid')
    }
    const long = 'a'.repeat(HANDS_LIMITS.maxPathChars + 1)
    expect(classifyHandsAction({ kind: 'write', path: long }, plain).code).toBe('path_invalid')
  })

  it('a symlink INSIDE the workspace pointing OUTSIDE is refused for every kind (fake probe)', () => {
    const link = path.join(ROOT, 'evil')
    const probe = fakeProbe([ROOT, link], { [link]: '/srv/space' })
    for (const kind of ['write', 'read', 'list', 'rm'] as const) {
      const d = classifyHandsAction({ kind, path: 'evil/agents.json' }, ctxOf(probe))
      expect(d.verdict.decision).toBe('refuse')
      expect(d.code).toBe('path_escape')
    }
  })

  it('a symlink that resolves INSIDE the workspace stays readable (pnpm layout)', () => {
    const link = path.join(ROOT, 'node_modules/foo')
    const target = path.join(ROOT, 'node_modules/.pnpm/foo@1/node_modules/foo')
    const probe = fakeProbe([ROOT, path.join(ROOT, 'node_modules'), link, target], { [link]: target })
    const d = classifyHandsAction({ kind: 'read', path: 'node_modules/foo/package.json' }, ctxOf(probe))
    expect(d.verdict).toEqual({ decision: 'allow' })
    expect(d.resolvedPath).toBe(path.join(target, 'package.json'))
  })

  it('mutating THROUGH a symlink final component is refused even when it points inside', () => {
    const link = path.join(ROOT, 'alias.md')
    const target = path.join(ROOT, 'real.md')
    const probe = fakeProbe([ROOT, link, target], { [link]: target })
    expect(classifyHandsAction({ kind: 'read', path: 'alias.md' }, ctxOf(probe)).verdict.decision).toBe('allow')
    for (const kind of ['write', 'rm'] as const) {
      const d = classifyHandsAction({ kind, path: 'alias.md' }, ctxOf(probe))
      expect(d.verdict.decision).toBe('refuse')
      expect(d.code).toBe('path_symlink')
    }
  })

  it('a probe that throws never yields allow', () => {
    const boom: HandsFsProbe = {
      realpath() {
        throw new Error('disk on fire')
      },
      isSymlink() {
        throw new Error('disk on fire')
      },
    }
    const d = classifyHandsAction({ kind: 'read', path: 'x' }, ctxOf(boom))
    expect(d.verdict.decision).toBe('refuse')
    expect(d.code).toBe('invalid_call')
  })
})

describe('hands-policy · real filesystem symlink cases (nodeHandsFsProbe)', () => {
  let base: string
  let ws: string
  let outside: string
  beforeAll(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'hands-policy-')))
    ws = path.join(base, 'workspace')
    outside = path.join(base, 'space')
    mkdirSync(ws, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(path.join(outside, 'agents.json'), '{"agents":[]}\n')
    mkdirSync(path.join(ws, 'proj'))
    writeFileSync(path.join(ws, 'proj', 'a.txt'), 'a\n')
    // dir symlink out, file symlink out, dangling symlink out, symlink in
    symlinkSync(outside, path.join(ws, 'to-space'))
    symlinkSync(path.join(outside, 'agents.json'), path.join(ws, 'agents-link.json'))
    symlinkSync(path.join(outside, 'not-yet.txt'), path.join(ws, 'dangling.txt'))
    symlinkSync(path.join(ws, 'proj'), path.join(ws, 'proj-alias'))
  })
  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  const ctx = (): HandsPolicyContext => ({ workspaceRoot: ws, fs: nodeHandsFsProbe })

  it('write/read through a directory symlink out of the workspace → path_escape', () => {
    for (const kind of ['write', 'read', 'list', 'rm'] as const) {
      const d = classifyHandsAction({ kind, path: 'to-space/agents.json' }, ctx())
      expect(d.verdict.decision).toBe('refuse')
      expect(d.code).toBe('path_escape')
    }
    // and a NOT-YET-EXISTING file under that symlinked dir (create-through) too
    const d = classifyHandsAction({ kind: 'write', path: 'to-space/new.txt' }, ctx())
    expect(d.code).toBe('path_escape')
  })

  it('a file symlink pointing out → escape for read, escape (not merely symlink) for write', () => {
    expect(classifyHandsAction({ kind: 'read', path: 'agents-link.json' }, ctx()).code).toBe('path_escape')
    expect(classifyHandsAction({ kind: 'write', path: 'agents-link.json' }, ctx()).code).toBe('path_escape')
  })

  it('a DANGLING symlink pointing out is refused for write/rm (the create-through hole)', () => {
    // realpath fails (target missing) → anchored on parent → lexically inside;
    // ONLY the final-component symlink rule catches it.
    for (const kind of ['write', 'rm'] as const) {
      const d = classifyHandsAction({ kind, path: 'dangling.txt' }, ctx())
      expect(d.verdict.decision).toBe('refuse')
      expect(d.code).toBe('path_symlink')
    }
  })

  it('a symlink resolving inside stays usable for read and resolves to the real path', () => {
    const d = classifyHandsAction({ kind: 'read', path: 'proj-alias/a.txt' }, ctx())
    expect(d.verdict.decision).toBe('allow')
    expect(d.resolvedPath).toBe(path.join(ws, 'proj', 'a.txt'))
  })

  it('a workspace root given lexically (macOS /tmp style) still resolves against its realpath', () => {
    // On macOS `tmpdir()` is /var/... which realpaths to /private/var/...; on
    // Linux the two are equal — either way the classifier must not refuse the
    // workspace's own files just because the root string was not canonical.
    const lexicalRoot = path.join(mkdtempSync(path.join(tmpdir(), 'hands-lex-')), '')
    try {
      mkdirSync(path.join(lexicalRoot, 'w'))
      const d = classifyHandsAction({ kind: 'read', path: 'w' }, { workspaceRoot: lexicalRoot, fs: nodeHandsFsProbe })
      expect(d.verdict.decision).toBe('allow')
      expect(d.resolvedPath).toBe(path.join(realpathSync(lexicalRoot), 'w'))
    } finally {
      rmSync(lexicalRoot, { recursive: true, force: true })
    }
  })
})

describe('hands-policy · run actions (offline allow / net approve / forbidden refuse)', () => {
  it('an offline command is tier 1 allow with net=false', () => {
    const d = classifyHandsAction({ kind: 'run', argv: ['node', 'test.js'] }, plain)
    expect(d).toMatchObject({ tier: 1, code: 'run_offline', net: false, verdict: { decision: 'allow' } })
  })

  it('an interpreter / shell is NOT parked (layer 2 confines it) — unlike layer-1 jailArgv', () => {
    for (const argv of [['bash', '-c', 'echo hi'], ['python3', '-c', 'print(1)\nprint(2)'], ['sh', 'run.sh']]) {
      expect(classifyHandsAction({ kind: 'run', argv }, plain).verdict).toEqual({ decision: 'allow' })
    }
  })

  it('net:true is tier 2 approve every time, and the reason names the command', () => {
    const d = classifyHandsAction({ kind: 'run', argv: ['node', 'fetch.js'], net: true }, plain)
    expect(d.tier).toBe(2)
    expect(d.code).toBe('run_net')
    expect(d.net).toBe(true)
    expect(d.verdict.decision).toBe('approve')
    expect((d.verdict as { reason: string }).reason).toContain('node fetch.js')
    expect((d.verdict as { reason: string }).reason).toContain('联网')
  })

  it('a known network command with net omitted is INFERRED as net → approve, and says so', () => {
    for (const argv of [
      ['curl', 'https://example.com'],
      ['npm', 'install'],
      ['pnpm', 'add', 'zod'],
      ['pip', 'install', 'requests'],
      ['git', 'clone', 'https://x/y.git'],
      ['git', '-C', 'proj', 'pull'],
      ['gh', 'pr', 'list'],
      ['/usr/bin/wget', 'x'],
    ]) {
      const d = classifyHandsAction({ kind: 'run', argv }, plain)
      expect(d.code, argv.join(' ')).toBe('run_net')
      expect(d.net).toBe(true)
      expect((d.verdict as { reason: string }).reason).toContain('按命令推断')
    }
  })

  it('local subcommands of network-capable tools stay offline (npm test, git status, npx vitest)', () => {
    for (const argv of [
      ['npm', 'test'],
      ['npm', 'run', 'build'],
      ['git', 'status'],
      ['git', 'commit', '-m', 'x'],
      ['npx', 'vitest', 'run'],
      ['pnpm', 'dlx', 'cowsay'],
      ['cargo', 'test'],
    ]) {
      const d = classifyHandsAction({ kind: 'run', argv }, plain)
      expect(d.code, argv.join(' ')).toBe('run_offline')
    }
  })

  it('an explicit net:false wins over inference (runs offline, fails harmlessly in the jail)', () => {
    const d = classifyHandsAction({ kind: 'run', argv: ['curl', 'x'], net: false }, plain)
    expect(d.code).toBe('run_offline')
    expect(d.net).toBe(false)
  })

  it('every forbidden command is refused by basename, even with a full path or a net flag', () => {
    for (const cmd of HANDS_FORBIDDEN_COMMANDS) {
      const d = classifyHandsAction({ kind: 'run', argv: [cmd, '--version'] }, plain)
      expect(d.code, cmd).toBe('run_forbidden')
      expect(d.tier).toBe(3)
      expect(d.verdict.decision).toBe('refuse')
    }
    expect(classifyHandsAction({ kind: 'run', argv: ['/usr/bin/sudo', 'ls'] }, plain).code).toBe('run_forbidden')
    expect(classifyHandsAction({ kind: 'run', argv: ['SUDO', 'ls'] }, plain).code).toBe('run_forbidden')
    expect(classifyHandsAction({ kind: 'run', argv: ['systemctl', 'restart', 'gotong'], net: true }, plain).code).toBe(
      'run_forbidden',
    )
  })

  it('malformed argv is refused: empty, non-string, too many, too long, control bytes', () => {
    expect(classifyHandsAction({ kind: 'run', argv: [] }, plain).code).toBe('run_invalid')
    expect(classifyHandsAction({ kind: 'run', argv: ['   '] }, plain).code).toBe('run_invalid')
    expect(classifyHandsAction({ kind: 'run', argv: ['ls', 42 as unknown as string] }, plain).code).toBe('run_invalid')
    expect(
      classifyHandsAction({ kind: 'run', argv: Array.from({ length: HANDS_LIMITS.maxArgv + 1 }, () => 'a') }, plain).code,
    ).toBe('run_invalid')
    expect(classifyHandsAction({ kind: 'run', argv: ['echo', 'x'.repeat(HANDS_LIMITS.maxArgChars + 1)] }, plain).code).toBe(
      'run_invalid',
    )
    expect(classifyHandsAction({ kind: 'run', argv: ['echo', `a${String.fromCharCode(0)}b`] }, plain).code).toBe('run_invalid')
    expect(classifyHandsAction({ kind: 'run', argv: ['echo', `a${String.fromCharCode(0x1b)}b`] }, plain).code).toBe('run_invalid')
    // tabs / newlines inside an argument are legitimate (multi-line -c scripts)
    expect(classifyHandsAction({ kind: 'run', argv: ['python3', '-c', 'a\n\tb'] }, plain).code).toBe('run_offline')
  })

  // **可批准的命令必须是可留档的命令**(Codex 四轮 H2)。单项上限 8KB × 256 项
  // 允许出 2MB 的 argv:那种东西既进不了审计台账,也没有人在手机上读得完,却仍要
  // 一次「批准」——审批卡那句「完整命令见审计台账」于是成了空头支票。总量封顶把
  // 「能批的」与「能留档的」钉成同一件事,并指一条正路(写成脚本文件再跑)。
  it('argv 总量封顶:超了当场拒,并指出「写成脚本文件再跑」这条正路', () => {
    const cap = HANDS_LIMITS.maxArgvTotalChars
    // 每项都在单项上限内、项数也在上限内,只有**总量**越界——这条门是新的那一道
    const chunk = 'a'.repeat(HANDS_LIMITS.maxArgChars)
    const parts = Math.ceil((cap + 1) / chunk.length)
    const argv = ['echo', ...Array.from({ length: parts }, () => chunk)]
    expect(argv.length).toBeLessThanOrEqual(HANDS_LIMITS.maxArgv)
    const d = classifyHandsAction({ kind: 'run', argv }, plain)
    expect(d.code).toBe('run_invalid')
    expect(d.verdict.decision).toBe('refuse')
    if (d.verdict.decision === 'refuse') {
      expect(d.verdict.reason).toContain('命令太长')
      expect(d.verdict.reason).toContain('hands_write')
    }
    // 恰好压在上限上仍然放行(边界不许悄悄收窄):每项都不超单项上限,总量正好 = cap
    const exact = ['e', 'x'.repeat(HANDS_LIMITS.maxArgChars), 'x'.repeat(cap - 1 - HANDS_LIMITS.maxArgChars)]
    expect(exact.reduce((n, a) => n + a.length, 0)).toBe(cap)
    expect(classifyHandsAction({ kind: 'run', argv: exact }, plain).code).toBe('run_offline')
  })

  it('命令名不能以 - 开头(执行器把它交给 `sh -c` 的 "$0",会被当成 sh 自己的选项)', () => {
    // 执行器不经 shell 展开地跑 `sh -c '…' "$0" "$@"`,于是 argv[0] 落在 `$0` 上。
    // `-c`/`-s`/`--login` 这类会被 sh 当自己的选项吃掉——`hands_run(["-c","curl …"])`
    // 于是变成第二层 `sh -c`,拒绝表与联网推断查的都是 argv[0] 那个「命令名」,
    // 全被绕过。挡在策略层(而不是 `exec -- "$0"`):**dash 的 exec 不认 `--`**
    // (实测 `exec: --: not found`,rc=127),而 Linux 的 /bin/sh 通常正是 dash。
    for (const bad of ['-c', '-s', '--login', '-']) {
      const d = classifyHandsAction({ kind: 'run', argv: [bad, 'curl http://evil'] }, plain)
      expect(d.code, bad).toBe('run_invalid')
      expect(d.verdict.decision, bad).toBe('refuse')
    }
    // 参数位上的 `-x` 一如既往合法——挡的只有第 0 位
    expect(classifyHandsAction({ kind: 'run', argv: ['ls', '-la'] }, plain).code).toBe('run_offline')
  })

  it('cwd must be inside the workspace and comes back resolved; an escaping cwd refuses the run', () => {
    const probe = fakeProbe([ROOT, path.join(ROOT, 'proj')])
    const ok = classifyHandsAction({ kind: 'run', argv: ['ls'], cwd: 'proj' }, ctxOf(probe))
    expect(ok.verdict.decision).toBe('allow')
    expect(ok.resolvedPath).toBe(path.join(ROOT, 'proj'))
    const bad = classifyHandsAction({ kind: 'run', argv: ['ls'], cwd: '../..' }, ctxOf(probe))
    expect(bad.verdict.decision).toBe('refuse')
    expect(bad.code).toBe('path_escape')
    const abs = classifyHandsAction({ kind: 'run', argv: ['ls'], cwd: '/etc' }, ctxOf(probe))
    expect(abs.code).toBe('path_invalid')
  })

  it('an unknown action kind is refused, never thrown', () => {
    const d = classifyHandsAction({ kind: 'exec' } as never, plain)
    expect(d.verdict.decision).toBe('refuse')
    expect(d.code).toBe('invalid_call')
    expect(classifyHandsAction(null as never, plain).code).toBe('invalid_call')
  })
})

describe('hands-policy · governed adapter (tool name + LLM args → verdict)', () => {
  it('maps the five tool names; unknown names refuse', () => {
    const classify = handsGovernedClassifier(plain)
    expect(classify('hands_run', { argv: ['ls'] })).toEqual({ decision: 'allow' })
    expect(classify('hands_write', { path: 'a.txt' })).toEqual({ decision: 'allow' })
    expect(classify('hands_read', { path: 'a.txt' })).toEqual({ decision: 'allow' })
    expect(classify('hands_list', {})).toEqual({ decision: 'allow' })
    expect(classify('hands_rm', { path: 'a.txt' })).toEqual({ decision: 'allow' })
    expect(classify('hands_run', { argv: ['curl', 'x'] }).decision).toBe('approve')
    expect(classify('write_file', { path: 'a.txt' }).decision).toBe('refuse')
    expect(classify('run_command', { argv: ['ls'] }).decision).toBe('refuse')
    expect(HANDS_TOOL_NAMES).toEqual(['hands_run', 'hands_write', 'hands_read', 'hands_list', 'hands_rm'])
  })

  it('bad shapes refuse (no coercion): argv as string, net as string, path as number, cwd as number', () => {
    const classify = handsGovernedClassifier(plain)
    expect(classify('hands_run', { argv: 'ls -la' }).decision).toBe('refuse')
    expect(classify('hands_run', { argv: ['ls'], net: 'yes' }).decision).toBe('refuse')
    expect(classify('hands_run', { argv: ['ls'], cwd: 1 }).decision).toBe('refuse')
    expect(classify('hands_write', { path: 1 }).decision).toBe('refuse')
    expect(classify('hands_write', {}).decision).toBe('refuse')
    expect(classify('hands_list', { path: 3 }).decision).toBe('refuse')
    expect(parseHandsToolCall('hands_run', { argv: ['ls', 1] })).toBeNull()
    expect(parseHandsToolCall('nope', { argv: ['ls'] })).toBeNull()
  })

  it('classifyHandsToolCall exposes resolvedPath / net for the executor', () => {
    const d = classifyHandsToolCall('hands_write', { path: 'notes/todo.md' }, plain)
    expect(d.resolvedPath).toBe(path.join(ROOT, 'notes/todo.md'))
    const r = classifyHandsToolCall('hands_run', { argv: ['npm', 'ci'] }, plain)
    expect(r.net).toBe(true)
    expect(r.verdict.decision).toBe('approve')
    // the LLM cannot smuggle a path escape past the adapter either
    expect(classifyHandsToolCall('hands_write', { path: '../agents.json' }, plain).verdict.decision).toBe('refuse')
  })
})

describe('hands-policy · resolver + tables (exported for the executor and docs)', () => {
  it('resolveWorkspacePath returns ok/abs or a coded refusal', () => {
    expect(resolveWorkspacePath('a/b.txt', plain, { mutating: true })).toEqual({ ok: true, abs: path.join(ROOT, 'a/b.txt') })
    const r = resolveWorkspacePath('../x', plain, { mutating: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('path_escape')
  })

  it('inferNeedsNet follows the table; a `*` entry is always net, list entries need the subcommand', () => {
    expect(inferNeedsNet(['curl'])).toBe(true)
    expect(inferNeedsNet(['git', 'log'])).toBe(false)
    expect(inferNeedsNet(['git', 'push', 'origin'])).toBe(true)
    expect(inferNeedsNet(['unknown-tool', 'install'])).toBe(false)
    expect(inferNeedsNet([])).toBe(false)
    expect(HANDS_NET_COMMANDS.curl).toBe('*')
    expect(HANDS_NET_COMMANDS.git).toContain('clone')
    expect(HANDS_NET_COMMANDS.npx).toBeUndefined()
  })

  it('HANDS_LIMITS is frozen and explicit (no silent caps)', () => {
    expect(Object.isFrozen(HANDS_LIMITS)).toBe(true)
    expect(HANDS_LIMITS.maxRunSec).toBe(120)
    expect(HANDS_LIMITS.maxOutputBytes).toBe(32 * 1024)
    expect(HANDS_LIMITS.maxWorkspaceBytes).toBe(512 * 1024 * 1024)
    expect(HANDS_LIMITS.maxConcurrentRuns).toBe(1)
  })

  it('the forbidden set covers privilege, package/service management, jail machinery, persistence and host automation', () => {
    for (const c of ['sudo', 'su', 'apt', 'apt-get', 'systemctl', 'docker', 'bwrap', 'unshare', 'chroot', 'mount', 'crontab', 'launchctl', 'osascript']) {
      expect(HANDS_FORBIDDEN_COMMANDS.has(c), c).toBe(true)
    }
    // …and does NOT swallow ordinary dev tools
    for (const c of ['node', 'python3', 'git', 'npm', 'make', 'gcc', 'rm', 'bash']) {
      expect(HANDS_FORBIDDEN_COMMANDS.has(c), c).toBe(false)
    }
  })
})
