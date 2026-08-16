/**
 * HANDS-M2 承重门 — 手 A 原生执行器(`personal-butler-hands.ts`)。
 *
 * 分三层,由轻到重:
 *
 *   ① `loadHandsConfig` 三态 + `armButlerHands` fail-closed:缺席 → 零副作用不装;
 *      形状不对/越界/未知键/坏路径清单 → warn + 不装(绝不 clamp 后静默装上);
 *      enabled 但监狱缺席 → warn 带安装提示 + 不装(**手不装比裸跑强**);
 *      `jailShapeFor` 藏什么/再放开什么/PATH 剩什么(假探针,任何机器都跑)。
 *   ② toolset 形状/分级/标题 + 纯件(TailBuffer/childEnv/measureTree)——零 spawn。
 *   ③ 监狱内真 spawn(`it.skipIf` 本机无 OS 监狱;`HANDS_TEST_REQUIRE_JAIL=1` 则
 *      无监狱=整文件红,CI 用):**文件四工具也在这一层**——它们经监狱里的 node 小
 *      助手动手,hub 自己不碰工作区字节。写/读/列/删 round-trip、上限、根路径拒、
 *      穿越/绝对路径拒、符号链接四态、二进制/截断如实、配额、审计;文档 §六 M2
 *      验收门:`cat <space>/gotong.env` 双拒 / 写 `<space>/agents.json` 双拒且盘上
 *      字节不变 / 断网 vs net:true / 子进程环境从零拼(HOME、TMPDIR 指进工作区)/
 *      hub 用户 HOME 与点名文件藏起来 / 命令退出即收整个进程组 / 超时 / 超输出 /
 *      hub 级并发 1 / stdin 进审批标题与审计摘要 / 审计不存 stdout 正文。
 *
 * 教训沿用:测试里任何控制字节走 `String.fromCharCode`,不写转义字面量。
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { detectFsJail, isInsideRoots, type Logger } from '@gotong/core'
import { HANDS_LIMITS } from '@gotong/personal-butler'

import {
  AUDIT_MIN_ACTIONS,
  AUDIT_ROTATE_BYTES_FOR_TEST,
  HANDS_CONFIG_PATH_LIST_MAX,
  HANDS_ENV_MARKER,
  HANDS_MAX_WORKSPACE_ENTRIES,
  HANDS_OUTPUT_KILL_MULTIPLIER,
  HANDS_TMP_SUBDIR,
  HANDS_CACHE_SUBDIR,
  HANDS_DEFAULT_ALLOW_ROLES,
  HANDS_TOOL_NAMES,
  TailBuffer,
  armButlerHands,
  buildButlerHandsToolset,
  childEnv,
  jailShapeFor,
  loadHandsConfig,
  measureTree,
  proxyUrlHasUserinfo,
  type ButlerHandsHost,
  type HandsConfig,
  type JailShapeProbe,
} from '../src/personal-butler-hands.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

type LogRow = { level: string; msg: string; ctx?: Record<string, unknown> }
function captureLogger(): { logger: Logger; rows: LogRow[] } {
  const rows: LogRow[] = []
  const mk =
    (level: string) =>
    (msg: string, ctx?: Record<string, unknown>) => {
      rows.push({ level, msg, ...(ctx ? { ctx } : {}) })
    }
  return {
    rows,
    logger: {
      trace: mk('trace'),
      debug: mk('debug'),
      info: mk('info'),
      warn: mk('warn'),
      error: mk('error'),
      fatal: mk('fatal'),
    } as unknown as Logger,
  }
}

/** 归属查表的省缺答案:测试里绝大多数用例的主角就是 owner。 */
const OWNER = 'owner'

const DEFAULT_CFG: HandsConfig = {
  maxRunSec: HANDS_LIMITS.maxRunSec,
  maxOutputBytes: HANDS_LIMITS.maxOutputBytes,
  maxWorkspaceBytes: HANDS_LIMITS.maxWorkspaceBytes,
  allowRoles: ['owner', 'admin'],
}

const jailCap = await detectFsJail()
const HAS_JAIL = jailCap.kind !== 'none'
if (!HAS_JAIL && process.env.HANDS_TEST_REQUIRE_JAIL === '1') {
  throw new Error(`HANDS_TEST_REQUIRE_JAIL=1 but this box has no OS jail (${jailCap.reason ?? 'unknown'}) — the spawn doors would silently skip`)
}
const SECRET = 'HANDS_DOOR_SECRET_VALUE_9f2c'
const HOME_SECRET = 'HANDS_HOME_SECRET_VALUE_41aa'
const ENVFILE_SECRET = 'HANDS_ENVFILE_SECRET_VALUE_c07d'
const NODE = process.execPath

/**
 * A throwaway `<space>` with the two files the doc's door names, plus a member host.
 * The jail shape uses a **fake HOME** (a marker file inside) so the "hub user's home
 * is hidden" door is deterministic on any box; `<space>`, the fake HOME, and a fake
 * `gotong.env` outside both are what the spawn doors probe.
 */
function makeSpace(cfg: Partial<HandsConfig> = {}): {
  base: string
  space: string
  fakeHome: string
  fakeEnvFile: string
  host: ButlerHandsHost
  logs: LogRow[]
  memberRoot: string
  workspace: string
} {
  const base = mkdtempSync(join(tmpdir(), 'gotong-hands-'))
  const space = join(base, 'space')
  mkdirSync(space, { recursive: true })
  writeFileSync(join(space, 'gotong.env'), `MIMO_API_KEY=${SECRET}\n`)
  writeFileSync(join(space, 'agents.json'), '{"agents":[]}\n')
  const fakeHome = join(base, 'home')
  mkdirSync(join(fakeHome, '.ssh'), { recursive: true })
  writeFileSync(join(fakeHome, '.ssh', 'id_test'), `${HOME_SECRET}\n`)
  writeFileSync(join(fakeHome, '.netrc'), `password ${HOME_SECRET}\n`)
  const fakeEnvFile = join(base, 'etc', 'gotong.env')
  mkdirSync(dirname(fakeEnvFile), { recursive: true })
  writeFileSync(fakeEnvFile, `HUB_MASTER_KEY=${ENVFILE_SECRET}\n`)
  const { logger, rows } = captureLogger()
  const config: HandsConfig = { ...DEFAULT_CFG, ...cfg, hidden: [fakeEnvFile, ...(cfg.hidden ?? [])] }
  // ONE probe for both the boot-time shape and the per-spawn existence re-check —
  // exactly how `armButlerHands` wires it (a shape computed from a different view
  // of the filesystem than the one the jail re-asks would be a lie).
  const probe = { homedir: () => fakeHome, kind: realKind, execPath: NODE, pathEnv: process.env.PATH }
  const roles = new Map<string, string | null>([['u1', 'owner']])
  const host: ButlerHandsHost = {
    spaceRoot: space,
    handsRoot: join(space, 'butler', 'hands'),
    // Real kind when the box has one (spawn doors need it); a nominal kind
    // otherwise — the spawn-free doors never look at it.
    kind: HAS_JAIL ? (jailCap.kind as ButlerHandsHost['kind']) : 'sandbox-exec',
    config,
    shape: jailShapeFor(space, config, probe),
    probe,
    // 与 `armButlerHands` 同一份判据(角色查表 ∩ config.allowRoles);测试改
    // `roles` 就等于在 identity 里改归属。默认 u1 是 owner——绝大多数用例要验的
    // 不是这道门。
    allowed: (uid) => {
      const r = roles.get(uid)
      return typeof r === 'string' && config.allowRoles.includes(r)
    },
    logger,
  }
  const memberRoot = join(host.handsRoot, 'user', 'u1')
  return {
    base,
    space,
    fakeHome,
    fakeEnvFile,
    host,
    roles,
    logs: rows,
    memberRoot,
    workspace: join(memberRoot, 'workspace'),
    jailHome: join(memberRoot, 'home'),
  }
}

function realKind(p: string): 'dir' | 'file' | null {
  try {
    return statSync(p).isDirectory() ? 'dir' : 'file'
  } catch {
    return null
  }
}

const cleanups: string[] = []
afterAll(() => {
  for (const d of cleanups) rmSync(d, { recursive: true, force: true })
})

let S: ReturnType<typeof makeSpace>
beforeEach(() => {
  S = makeSpace()
  cleanups.push(S.base)
})
afterEach(() => {
  delete process.env.HANDS_TEST_SECRET
})

function toolset(cfg?: Partial<HandsConfig>) {
  const host = cfg ? { ...S.host, config: { ...S.host.config, ...cfg } } : S.host
  return buildButlerHandsToolset({ userId: 'u1', hands: host })
}

/** Gate like the butler does: classify first; run only what the policy allows. */
async function gated(ts: ReturnType<typeof toolset>, name: string, args: Record<string, unknown>) {
  const v = await ts.classify(name, args)
  if (v.decision !== 'allow') return { verdict: v, text: '', isError: true as const }
  const r = await ts.callTool(name, args)
  return { verdict: v, text: r.content.map((c) => c.text).join(''), isError: r.isError === true }
}

/** Approve-then-run (the human said yes) — the resume path, no gate. */
async function approved(ts: ReturnType<typeof toolset>, name: string, args: Record<string, unknown>) {
  const r = await ts.callTool(name, args)
  return { text: r.content.map((c) => c.text).join(''), isError: r.isError === true }
}

/**
 * 只要**结果**行(动作跑完那一行)。台账现在每次调用最多留三行:
 * `classify` 判决(带全 argv,兑现审批卡的「完整命令见审计台账」)、
 * `begin`(动手前的写得进去证据)、`execute` 结果。按 tool 名找会先撞上判决行。
 */
function execRows(): Array<Record<string, unknown>> {
  return auditRows().filter((r) => r.stage === 'execute')
}

function auditRows(file?: string): Array<Record<string, unknown>> {
  const p = file ?? join(S.memberRoot, 'audit.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ─── ① opt-in 三态 + arm fail-closed + jail shape ────────────────────────────

describe('HANDS-M2 ① loadHandsConfig 三态', () => {
  it('缺席 → undefined,静默(零日志)', () => {
    const { logger, rows } = captureLogger()
    rmSync(join(S.space, 'hands.json'), { force: true })
    expect(loadHandsConfig(S.space, logger)).toBeUndefined()
    expect(rows).toHaveLength(0)
  })

  it('enabled:true 无覆盖 → 默认三上限;区间内覆盖生效;hidden/readOnly 原样带出', () => {
    const { logger, rows } = captureLogger()
    writeFileSync(join(S.space, 'hands.json'), JSON.stringify({ enabled: true }))
    expect(loadHandsConfig(S.space, logger)).toEqual(DEFAULT_CFG)
    writeFileSync(join(S.space, 'hands.json'), JSON.stringify({ enabled: true, maxRunSec: 300, maxOutputBytes: 4096 }))
    expect(loadHandsConfig(S.space, logger)).toEqual({ ...DEFAULT_CFG, maxRunSec: 300, maxOutputBytes: 4096 })
    writeFileSync(join(S.space, 'hands.json'), JSON.stringify({ enabled: true, hidden: ['/etc/hub.env'], readOnly: ['/opt/toolchain'] }))
    expect(loadHandsConfig(S.space, logger)).toEqual({ ...DEFAULT_CFG, hidden: ['/etc/hub.env'], readOnly: ['/opt/toolchain'] })
    expect(rows.filter((r) => r.level === 'warn')).toHaveLength(0)
  })

  it('allowRoles 默认只 owner/admin;要给成员手,得在 hands.json 里把 member 写出来', () => {
    const { logger, rows } = captureLogger()
    writeFileSync(join(S.space, 'hands.json'), JSON.stringify({ enabled: true }))
    // 默认值不是「谁开了 hands.json 谁就有手」——与 `pack_backup` 同姿态收在 owner/admin。
    expect(loadHandsConfig(S.space, logger)?.allowRoles).toEqual(HANDS_DEFAULT_ALLOW_ROLES)
    writeFileSync(join(S.space, 'hands.json'), JSON.stringify({ enabled: true, allowRoles: ['owner', 'member'] }))
    expect(loadHandsConfig(S.space, logger)?.allowRoles).toEqual(['owner', 'member'])
    expect(rows.filter((r) => r.level === 'warn')).toHaveLength(0)
  })

  it('enabled:false → info + undefined(明确关着不算错)', () => {
    const { logger, rows } = captureLogger()
    writeFileSync(join(S.space, 'hands.json'), JSON.stringify({ enabled: false }))
    expect(loadHandsConfig(S.space, logger)).toBeUndefined()
    expect(rows.map((r) => r.level)).toEqual(['info'])
  })

  it.each([
    ['坏 JSON', '{not json'],
    ['非对象', '[1,2]'],
    ['缺 enabled', JSON.stringify({ maxRunSec: 10 })],
    ['enabled 非布尔', JSON.stringify({ enabled: 'yes' })],
    ['未知键(拼错的上限名)', JSON.stringify({ enabled: true, maxRunSecs: 300 })],
    ['越界 maxRunSec', JSON.stringify({ enabled: true, maxRunSec: 0 })],
    ['越界 maxOutputBytes(超上限)', JSON.stringify({ enabled: true, maxOutputBytes: 2 * 1024 * 1024 })],
    ['非整数', JSON.stringify({ enabled: true, maxRunSec: 1.5 })],
    ['字符串数字', JSON.stringify({ enabled: true, maxWorkspaceBytes: '1048576' })],
    ['hidden 不是数组', JSON.stringify({ enabled: true, hidden: '/etc/x' })],
    ['hidden 相对路径', JSON.stringify({ enabled: true, hidden: ['etc/x'] })],
    ['readOnly 非字符串项', JSON.stringify({ enabled: true, readOnly: [1] })],
    ['hidden 超过条数上限', JSON.stringify({ enabled: true, hidden: Array.from({ length: HANDS_CONFIG_PATH_LIST_MAX + 1 }, (_, i) => `/p${i}`) })],
    ['hidden 带控制字符', JSON.stringify({ enabled: true, hidden: [`/etc/x${String.fromCharCode(10)}y`] })],
    ['hidden 空串', JSON.stringify({ enabled: true, hidden: [''] })],
    ['allowRoles 不是数组', JSON.stringify({ enabled: true, allowRoles: 'owner' })],
    // 空数组长得像「开了」,实际是谁都没手——要关就 enabled:false,别用空清单表达。
    ['allowRoles 空数组', JSON.stringify({ enabled: true, allowRoles: [] })],
    // 拼错一个角色名是**静默收紧**:手看着装上了,每个人都被拒,而写的人以为自己刚把手交出去了。
    ['allowRoles 拼错的角色名', JSON.stringify({ enabled: true, allowRoles: ['owner', 'members'] })],
    ['allowRoles 大小写不对', JSON.stringify({ enabled: true, allowRoles: ['Admin'] })],
    ['allowRoles 非字符串项', JSON.stringify({ enabled: true, allowRoles: [1] })],
    ['allowRoles 重复项', JSON.stringify({ enabled: true, allowRoles: ['owner', 'owner'] })],
  ])('形状不对(%s) → warn + undefined,绝不 clamp 后静默装上', (_label, body) => {
    const { logger, rows } = captureLogger()
    writeFileSync(join(S.space, 'hands.json'), body)
    expect(loadHandsConfig(S.space, logger)).toBeUndefined()
    expect(rows.some((r) => r.level === 'warn' && r.msg.includes('hands stay OFF'))).toBe(true)
  })
})

describe('HANDS-M2 ① armButlerHands', () => {
  it('缺席:不装、不探监狱、不建目录、不打日志(零副作用 = 字节不变)', async () => {
    const { logger, rows } = captureLogger()
    let probed = 0
    const h = await armButlerHands({
      spaceRoot: S.space,
      logger,
      membershipRole: () => OWNER,
      detect: async () => {
        probed++
        return { kind: 'sandbox-exec' }
      },
    })
    expect(h.host).toBeUndefined()
    expect(h.status).toEqual({ armed: false, reason: '未开启(<space>/hands.json 缺席或未 enabled)' })
    expect(probed).toBe(0)
    expect(rows).toHaveLength(0)
    expect(existsSync(join(S.space, 'butler'))).toBe(false)
  })

  it('enabled 但监狱缺席 → warn 带安装提示 + 不装(fail-closed:手不装比裸跑强)', async () => {
    const { logger, rows } = captureLogger()
    writeFileSync(join(S.space, 'hands.json'), JSON.stringify({ enabled: true }))
    const h = await armButlerHands({ spaceRoot: S.space, logger, membershipRole: () => OWNER, detect: async () => ({ kind: 'none', reason: 'no bwrap on PATH' }) })
    expect(h.host).toBeUndefined()
    expect(h.status.armed).toBe(false)
    if (!h.status.armed) {
      expect(h.status.reason).toContain('监狱缺席:no bwrap on PATH')
      expect(h.status.reason).toContain('bubblewrap')
    }
    const w = rows.find((r) => r.level === 'warn')
    expect(w?.msg).toContain('hands NOT installed (fail-closed)')
    expect(String(w?.ctx?.hint)).toContain('sandbox-exec')
  })

  it('enabled + 监狱在 → host 就绪(kind/上限/路径/shape)+ info 披露行不含任何成员态', async () => {
    const { logger, rows } = captureLogger()
    writeFileSync(join(S.space, 'hands.json'), JSON.stringify({ enabled: true, maxRunSec: 30 }))
    const h = await armButlerHands({ spaceRoot: S.space, logger, membershipRole: () => OWNER, detect: async () => ({ kind: 'bwrap' }) })
    expect(h.status).toEqual({ armed: true, kind: 'bwrap' })
    expect(h.host?.kind).toBe('bwrap')
    expect(h.host?.config).toEqual({ ...DEFAULT_CFG, maxRunSec: 30 })
    expect(h.host?.spaceRoot).toBe(S.space)
    expect(h.host?.handsRoot).toBe(join(S.space, 'butler', 'hands'))
    // 真探针:<space> 与 hub 用户的 HOME 都在藏起来的清单里
    expect(h.host?.shape.hiddenDirs).toEqual(expect.arrayContaining([S.space, realpathSync(homedir())]))
    const armed = rows.find((r) => r.msg === 'hands: armed')?.ctx
    expect(armed).toMatchObject({ jail: 'bwrap', maxRunSec: 30 })
    expect(Array.isArray(armed?.hidden)).toBe(true)
    // arming alone still writes nothing under <space>/butler — workspaces are lazy per member.
    expect(existsSync(join(S.space, 'butler'))).toBe(false)
  })

  it('enabled 但查不到成员角色(identity 缺席)→ 不装(fail-closed:与监狱缺席同姿态)', async () => {
    // 「谁有手」这道门只在能问出角色的时候才成立。问不出来的时候有两条路:装上五个
    // 永远拒绝的工具,或者干脆不装。选后者——前者会在工具面上广告一双不存在的手。
    const { logger, rows } = captureLogger()
    writeFileSync(join(S.space, 'hands.json'), JSON.stringify({ enabled: true }))
    const h = await armButlerHands({ spaceRoot: S.space, logger, detect: async () => ({ kind: 'bwrap' }) })
    expect(h.host).toBeUndefined()
    expect(h.status.armed).toBe(false)
    if (!h.status.armed) expect(h.status.reason).toContain('owner/admin')
    const w = rows.find((r) => r.level === 'warn')
    expect(w?.msg).toContain('hands NOT installed (fail-closed)')
    expect(w?.ctx?.allowRoles).toEqual(HANDS_DEFAULT_ALLOW_ROLES)
  })

  it('allowed() = 角色查表 ∩ allowRoles;查表抛错 → 没有手(不把异常当放行)', async () => {
    const { logger, rows } = captureLogger()
    writeFileSync(join(S.space, 'hands.json'), JSON.stringify({ enabled: true }))
    const roles: Record<string, string | null> = { boss: 'owner', ops: 'admin', kid: 'member', guest: 'viewer', ghost: null }
    const h = await armButlerHands({
      spaceRoot: S.space,
      logger,
      membershipRole: (uid) => {
        if (uid === 'boom') throw new Error('identity down')
        return roles[uid]
      },
      detect: async () => ({ kind: 'bwrap' }),
    })
    expect(h.host?.allowed('boss')).toBe(true)
    expect(h.host?.allowed('ops')).toBe(true)
    expect(h.host?.allowed('kid')).toBe(false)
    expect(h.host?.allowed('guest')).toBe(false)
    // 不在册的人、归属为空的人:都不是「暂时查不到」,是没有手。
    expect(h.host?.allowed('nobody')).toBe(false)
    expect(h.host?.allowed('ghost')).toBe(false)
    // identity 挂了 ⇒ 拒,并留一行(静默 false 会让「谁都没手」看起来像配置写错了)。
    expect(h.host?.allowed('boom')).toBe(false)
    expect(rows.some((r) => r.level === 'warn' && r.msg.includes('membership lookup failed'))).toBe(true)
    // 披露行里能看见这台 hub 把手开给了谁。
    expect(rows.find((r) => r.msg === 'hands: armed')?.ctx?.allowRoles).toEqual(HANDS_DEFAULT_ALLOW_ROLES)
  })

  it('把 member 写进 allowRoles ⇒ 成员真有手(白名单是决定,不是摆设)', async () => {
    const { logger } = captureLogger()
    writeFileSync(join(S.space, 'hands.json'), JSON.stringify({ enabled: true, allowRoles: ['owner', 'member'] }))
    const h = await armButlerHands({ spaceRoot: S.space, logger, membershipRole: () => 'member', detect: async () => ({ kind: 'bwrap' }) })
    expect(h.host?.allowed('anyone')).toBe(true)
  })

  it('hidden/readOnly 里不存在的路径:arm 时 warn 一次并跳过(不装死、不假装盖住)', async () => {
    const { logger, rows } = captureLogger()
    writeFileSync(join(S.space, 'hands.json'), JSON.stringify({ enabled: true, hidden: [S.fakeEnvFile, '/nope/never/x'], readOnly: ['/nope/toolchain'] }))
    const h = await armButlerHands({ spaceRoot: S.space, logger, membershipRole: () => OWNER, detect: async () => ({ kind: 'bwrap' }) })
    expect(h.host?.shape.skipped).toEqual(['/nope/never/x', '/nope/toolchain'])
    expect(h.host?.shape.hiddenFiles).toContain(realpathSync(S.fakeEnvFile))
    const w = rows.find((r) => r.msg.includes('were skipped'))
    expect(w?.level).toBe('warn')
    expect(w?.ctx?.skipped).toEqual(['/nope/never/x', '/nope/toolchain'])
  })

  it('HOME 藏不了(解析成 / 或空)→ 不装(fail-closed):家目录里就有 gotong.env(Codex 三轮 H3)', async () => {
    // HOME 是**藏起来的东西里唯一不来自常量表的一条**——`jailShapeFor` 只在它是个真
    // 目录时 addDir,于是 `/` 会被静默跳过:hub 用户的家目录连同落在里面的凭证一起
    // 留在监狱里可读,而日志上一个字都不会少。这类「藏不了」必须与 `<space>` 是 `/`
    // 同罪,而不是装一双漏的手。
    for (const home of ['/', '']) {
      const { logger, rows } = captureLogger()
      writeFileSync(join(S.space, 'hands.json'), JSON.stringify({ enabled: true }))
      const h = await armButlerHands({
        spaceRoot: S.space,
        logger,
        membershipRole: () => OWNER,
        detect: async () => ({ kind: 'bwrap' }),
        probe: { homedir: () => home, kind: realKind, execPath: NODE, pathEnv: process.env.PATH },
      })
      expect(h.host, `home=${JSON.stringify(home)}`).toBeUndefined()
      expect(h.status.armed).toBe(false)
      expect((h.status as { reason: string }).reason).toContain('家目录')
      const w = rows.find((r) => r.msg.includes('defeat the jail'))
      expect(w?.level).toBe('warn')
      expect(String(w?.ctx?.problem)).toContain('凭证会留在监狱里')
    }
  })

  it('config 测试缝优先于文件(显式 undefined = 关)', async () => {
    const { logger } = captureLogger()
    writeFileSync(join(S.space, 'hands.json'), JSON.stringify({ enabled: true }))
    const h = await armButlerHands({ spaceRoot: S.space, logger, membershipRole: () => OWNER, config: undefined, detect: async () => ({ kind: 'bwrap' }) })
    expect(h.host).toBeUndefined()
  })
})

describe('HANDS-M2 ① jailShapeFor(假探针)', () => {
  const home = '/fake/home'
  const nodePrefix = `${home}/.nvm/versions/node/v20`
  function probe(over: Partial<JailShapeProbe> = {}): JailShapeProbe {
    const dirs = new Set([home, `${home}/.local/bin`, `${home}/.cargo`, nodePrefix, `${nodePrefix}/bin`, '/usr/bin', '/usr/local/bin', '/home', '/opt/tools'])
    const files = new Set(['/etc/gotong.env', '/var/run/docker.sock'])
    return {
      homedir: () => home,
      kind: (p) => (dirs.has(p) ? 'dir' : files.has(p) ? 'file' : null),
      execPath: `${nodePrefix}/bin/node`,
      pathEnv: `/usr/bin:${home}/.local/bin:${nodePrefix}/bin:relative/bin:/usr/bin:/usr/local/bin`,
      ...over,
    }
  }

  it('默认藏 <space>+HOME+/home;点名文件存在才盖;node 前缀落在 HOME 里就再放开只读', () => {
    const s = jailShapeFor('/srv/space', DEFAULT_CFG, probe())
    expect(s.hiddenDirs).toEqual(expect.arrayContaining(['/srv/space', home, '/home']))
    expect(s.hiddenDirs).not.toContain('/root') // 探针说不存在
    expect(s.hiddenFiles).toEqual(['/etc/gotong.env', '/var/run/docker.sock'])
    expect(s.readOnlyRoots).toEqual([nodePrefix])
    expect(s.skipped).toEqual([])
  })

  it('PATH:补 node bin 在最前、只留绝对路径、去重、剔掉藏起来的目录(再放开的除外)', () => {
    const s = jailShapeFor('/srv/space', DEFAULT_CFG, probe())
    expect(s.pathEnv.split(':')).toEqual([`${nodePrefix}/bin`, '/usr/bin', '/usr/local/bin'])
  })

  it('hands.json 追加:hidden 目录/文件各按存在性归类,不存在的进 skipped;readOnly 只认藏起来目录里的', () => {
    const s = jailShapeFor(
      '/srv/space',
      { ...DEFAULT_CFG, hidden: ['/opt/tools', '/etc/gotong.env', '/nope'], readOnly: [`${home}/.cargo`, '/opt/tools', '/nope2'] },
      probe(),
    )
    expect(s.hiddenDirs).toContain('/opt/tools')
    expect(s.hiddenFiles).toEqual(['/etc/gotong.env', '/var/run/docker.sock'])
    expect(s.skipped).toEqual(['/nope', '/nope2'])
    // /opt/tools 同时被藏又要放开只读 → 只读赢(在藏起来的目录里),.cargo 亦然
    expect(s.readOnlyRoots).toEqual(expect.arrayContaining([nodePrefix, `${home}/.cargo`, '/opt/tools']))
  })

  it('HOME=/ 或探不到 → 不把根藏起来(监狱焊死);node 前缀不在藏起来的目录里就不进 readOnly', () => {
    const s = jailShapeFor('/srv/space', DEFAULT_CFG, probe({ homedir: () => '/', execPath: '/usr/local/bin/node' }))
    expect(s.hiddenDirs).not.toContain('/')
    expect(s.hiddenDirs).not.toContain('')
    expect(s.readOnlyRoots).toEqual([])
    expect(s.pathEnv.split(':')[0]).toBe('/usr/local/bin')
  })
})

// ─── ② toolset 形状 + 纯件(零 spawn)──────────────────────────────────────────

describe('HANDS-M2 ② toolset 形状', () => {
  it('恰好五个工具、名字与 M1 常量同一份;构造零副作用(盘上无痕)', () => {
    const ts = toolset()
    expect(ts.listTools().map((t) => t.name)).toEqual([...HANDS_TOOL_NAMES])
    expect(existsSync(S.host.handsRoot)).toBe(false)
    // schema 上限文案跟 config 走(不是硬编码常量)
    const run = ts.listTools().find((t) => t.name === 'hands_run')!
    expect(JSON.stringify(run.inputSchema)).toContain('"maximum":120')
  })

  it('不认识的名字 → 拒(不是 throw)', async () => {
    const ts = toolset()
    const r = await ts.callTool('hands_sudo', {})
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toContain('unknown governed tool')
  })

  it('没有手的成员:五件全 refuse,连工作区目录都不建(拒因说清是权限,不是重试能解决的)', async () => {
    S.roles.set('u1', 'member') // 默认白名单只有 owner/admin
    const ts = toolset()
    const calls: Array<[string, Record<string, unknown>]> = [
      ['hands_run', { argv: ['ls'] }],
      ['hands_write', { path: 'a.txt', content: 'x' }],
      ['hands_read', { path: 'a.txt' }],
      ['hands_list', { path: '.' }],
      ['hands_rm', { path: 'a.txt' }],
    ]
    for (const [name, args] of calls) {
      const v = await ts.classify(name, args)
      expect(v.decision, name).toBe('refuse')
      if (v.decision === 'refuse') {
        expect(v.reason).toContain('没有动手的权限')
        expect(v.reason).toContain('owner/admin') // 拒因从 allowRoles 现算,改了白名单它跟着改
      }
    }
    // 连目录都不该长出来:不够格的人在这台 hub 上结构性没有工作区。
    expect(existsSync(S.memberRoot)).toBe(false)
  })

  it('park 挂着的几小时里被降权 ⇒ 批准也执行不了(execute 再问一遍,不复述 classify 的答案)', async () => {
    // 审批是对**那一刻够格的他**发的。批准兑现的时候他已经不是那个人了。
    const ts = toolset()
    expect((await ts.classify('hands_run', { argv: ['npm', 'install'] })).decision).toBe('approve')
    S.roles.set('u1', 'member')
    const r = await approved(ts, 'hands_run', { argv: ['npm', 'install'] })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('没有动手的权限')
    // 台账上留得下这一笔(这个成员先前有过工作区,台账在)。
    expect(execRows().some((x) => x.code === 'role')).toBe(true)
  })

  it('classify 走 M1 策略:文件动作 allow(tier 1)/联网命令 approve/系统级命令 refuse', async () => {
    const ts = toolset()
    expect(await ts.classify('hands_write', { path: 'a.txt', content: 'x' })).toEqual({ decision: 'allow' })
    expect(await ts.classify('hands_run', { argv: ['ls'] })).toEqual({ decision: 'allow' })
    const net = await ts.classify('hands_run', { argv: ['npm', 'install'] })
    expect(net.decision).toBe('approve')
    if (net.decision === 'approve') expect(net.reason).toContain('要联网')
    const sudo = await ts.classify('hands_run', { argv: ['sudo', 'ls'] })
    expect(sudo.decision).toBe('refuse')
    // classify 第一次触碰会建工作区(mode 0700)——之后才有痕迹
    expect(existsSync(S.workspace)).toBe(true)
  })

  it('穿越 / 绝对路径 / 空路径 → classify 当场 refuse(执行器根本不被叫),拒因不露 hub 绝对路径', async () => {
    const ts = toolset()
    for (const p of ['../x', '../../../../../gotong.env', '/etc/passwd', S.space, '', 'a/../../b']) {
      const v = await ts.classify('hands_read', { path: p })
      expect(v.decision, `path=${JSON.stringify(p)}`).toBe('refuse')
      if (v.decision === 'refuse') expect(v.reason).not.toContain(S.space)
    }
    // 拒绝也留痕:被注入的模型试着穿越出去这件**没发生**的事,恰恰是运维最想看见的。
    // 台账是 hub 用户独读的 0600 文件,里面留真路径;脱敏只对模型那一侧。
    const rows = auditRows()
    expect(rows).toHaveLength(6)
    expect(rows.every((r) => r.stage === 'classify' && r.ok === false && r.tool === 'hands_read')).toBe(true)
    expect(rows.some((r) => String(r.why).includes(S.space))).toBe(true)
  })

  it('分级/执行两级的拒绝各留一行:工作区不可用、配额、并发都进台账', async () => {
    const ts = toolset()
    // ① 工作区建不起来(拿一个文件当目录) → classify 当场 refuse 并记 workspace_unavailable
    rmSync(join(S.host.handsRoot, 'user', 'u1'), { recursive: true, force: true })
    mkdirSync(dirname(S.workspace), { recursive: true })
    writeFileSync(S.workspace, 'not a dir')
    const dead = buildButlerHandsToolset({ userId: 'u1', hands: S.host })
    const v = await dead.classify('hands_list', {})
    expect(v.decision).toBe('refuse')
    if (v.decision === 'refuse') expect(v.reason).not.toContain(S.space)
    expect(auditRows().map((r) => r.code)).toContain('workspace_unavailable')
    // ② 台账写不进去 = 不动手(fail-closed):留痕是四道防线之一,不留痕的执行不允许
    rmSync(S.workspace, { force: true })
    const ok = toolset()
    expect((await ok.classify('hands_list', {})).decision).toBe('allow')
    const auditFile = join(S.memberRoot, 'audit.jsonl')
    rmSync(auditFile, { force: true })
    mkdirSync(auditFile) // 换成目录 → append 必失败
    const blocked = await ok.classify('hands_list', {})
    expect(blocked.decision).toBe('refuse')
    if (blocked.decision === 'refuse') {
      expect(blocked.reason).toContain('审计台账写不进去')
      expect(blocked.reason).not.toContain(S.space)
    }
    const blockedExec = await ok.callTool('hands_list', {})
    expect(blockedExec.isError).toBe(true)
    expect(blockedExec.content[0]!.text).toContain('审计台账写不进去')
    rmSync(auditFile, { recursive: true, force: true })
  })

  it('每次动手三行:classify 判决(带全 argv)→ begin(动手前的写得进去证据)→ 结果', async () => {
    const ts = toolset()
    const nl = String.fromCharCode(10)
    // 分级那一行必须带**完整** argv:审批标题截断处说了「完整命令见审计台账」,
    // 台账要兑现得了这句话(Codex 三轮 H2)。且落的是**结构化向量**不是拼好的一行
    // (Codex 四轮 H2):`['printf','a b']` 与 `['printf','a','b']` 拼出来一模一样,
    // 事后要复原当时到底跑了什么,只有向量说得清。stdin 只留字节数 + sha256。
    await ts.classify('hands_run', { argv: ['sh', '-c', `echo ${'z'.repeat(900)}`], stdin: `secret${nl}body` })
    const v = auditRows().find((r) => r.stage === 'classify' && r.tool === 'hands_run')!
    expect(v.argv).toEqual(['sh', '-c', `echo ${'z'.repeat(900)}`])
    expect(v.argvTruncated).toBeUndefined()
    expect(v.stdinBytes).toBe(11)
    expect(typeof v.stdinSha256).toBe('string')
    expect(JSON.stringify(auditRows())).not.toContain('secret')
  })

  it('早退的失败也留痕:每趟一行都没记就补一行(不靠「每处记得写」)', async () => {
    const ts = toolset()
    // content 超上限 = `write()` 里一处早退,既没跑监狱也没走成功那条记账路径。
    // 兜底不在那七八处早退各补一行(下一个早退又会漏),而在动作回来那一刻数
    // (Codex 二轮 M6 / 三轮 M5)。
    const r = await gated(ts, 'hands_write', { path: 'big.txt', content: 'x'.repeat(HANDS_LIMITS.maxWriteBytes + 1) })
    expect(r.verdict.decision).toBe('allow') // 挡它的是执行器不是策略
    expect(r.isError).toBe(true)
    expect(r.text).toContain('内容太大')
    const rows = auditRows()
    expect(rows.map((x) => x.stage)).toEqual(['classify', 'begin', 'execute'])
    const done = rows.at(-1)!
    expect(done).toMatchObject({ tool: 'hands_write', ok: false })
    expect(String(done.why)).toContain('内容太大')
  })

  it('「这一趟记过没有」是**每次调用**自己的账,不是整个 toolset 共用一个计数器', async () => {
    // 旧写法用 toolset 作用域的计数器答「有没有人记过」,要问的却是「**我**记过没有」
    // (Codex 四轮 M4)。同一成员的两次调用能并发到同一份 toolset:第二次会被 BUSY 拒,
    // **而那次拒绝也写一行**——旧写法里那一行会把第一趟的兜底顶掉,于是第一趟那次
    // 早退一个字都不留。这里就照那个形状并发。
    const ts = toolset()
    const [ra, rb] = await Promise.all([
      // A:先进门(同步跑到 write 的第一个 await 才让出),内容超上限属早退,自己不记
      ts.callTool('hands_write', { path: 'big.txt', content: 'x'.repeat(HANDS_LIMITS.maxWriteBytes + 1) }),
      // B:撞上 A 的 BUSY,被拒——这条拒绝自己写一行
      ts.callTool('hands_write', { path: 'ok.txt', content: 'hi' }),
    ])
    expect(ra.isError).toBe(true)
    expect(rb.isError).toBe(true)
    const rows = auditRows()
    // A 的 begin / B 的 busy 拒绝 / A 的兜底结果——正是被顶掉的那一行必须还在
    expect(rows).toHaveLength(3)
    expect(rows[1]).toMatchObject({ tool: 'hands_write', ok: false, code: 'busy' })
    expect(rows.at(-1)).toMatchObject({ stage: 'execute', tool: 'hands_write', ok: false })
    expect(String(rows.at(-1)!.why)).toContain('内容太大')
  })

  it('HOME 在 arm 之后变成藏不住的样子 ⇒ 这一步停手,不装作藏好了(M5)', async () => {
    // arm 时判死的是 boot 那一刻的 HOME。每次 spawn 前重问一次的**意义**就在于它会变
    // (容器里换账号、家目录后建、HOME 被改成 `/`)。变成 `/` 时下面那个循环会静默跳过
    // 它——命令照跑而家目录没藏,恰好是 arm 时判死要避免的状态,只是晚了一步发生。
    // 停手前那一趟仍留痕:begin 一行 + 兜底一行,台账上看得见「开始了,没成」。
    for (const bad of ['/', '', 'relative/home']) {
      const S2 = makeSpace()
      cleanups.push(S2.base)
      let home = S2.fakeHome
      const hands = { ...S2.host, probe: { ...S2.host.probe, homedir: () => home } }
      const ts = buildButlerHandsToolset({ userId: 'u1', hands })
      home = bad // arm 之后才变
      const r = await gated(ts, 'hands_write', { path: 'a.txt', content: 'x' })
      expect(r.verdict.decision, `home=${JSON.stringify(bad)}`).toBe('allow') // 挡它的是执行器不是策略
      expect(r.isError).toBe(true)
      expect(r.text).toContain('家目录')
      const rows = auditRows(join(S2.host.handsRoot, 'user', 'u1', 'audit.jsonl'))
      expect(rows.map((x) => x.stage)).toEqual(['classify', 'begin', 'execute'])
      expect(String(rows.at(-1)!.why)).toContain('threw:')
      expect(existsSync(join(S2.memberRoot, 'workspace', 'a.txt'))).toBe(false)
    }
  })

  it('**最大的那条可批准命令**照样整条进台账,一个字不截(H2)', async () => {
    const ts = toolset()
    // 「审批卡说完整命令见审计台账」这句话的兑现,只在**上限那一点**上才被真正检验:
    // 策略的 argv 总量顶 = 台账的容量,于是恰好压在顶上的命令必须原样记下、不带任何
    // 截断标记。这条断言就是那两个常量相等的行为版(Codex 四轮 H2);哪天有人只调了
    // 其中一个,这里会红。
    const cap = HANDS_LIMITS.maxArgvTotalChars
    const argv = ['echo', 'z'.repeat(HANDS_LIMITS.maxArgChars), 'y'.repeat(cap - 4 - HANDS_LIMITS.maxArgChars)]
    expect(argv.reduce((n, a) => n + a.length, 0)).toBe(cap)
    expect((await ts.classify('hands_run', { argv })).decision).toBe('allow')
    const row = auditRows().find((r) => r.stage === 'classify')!
    expect(row.argv).toEqual(argv)
    expect(row.argvTruncated).toBeUndefined()
    expect(row.argvChars).toBeUndefined()
  })

  it('describe = 收件箱标题:联网命令(带 cwd + stdin 摘要)/ 文件动词 + 路径', () => {
    const ts = toolset()
    expect(ts.describe('hands_run', { argv: ['npm', 'install', 'left pad'] })).toBe('阿同要在工作区里联网执行:npm install "left pad"')
    // cwd 决定这条命令碰得到什么,标题必须写出来(不给 / 给 '.' = 工作区根,句子已经说了)
    expect(ts.describe('hands_run', { argv: ['npm', 'test'], cwd: 'proj/api' })).toBe('阿同要在工作区的 proj/api 目录里联网执行:npm test')
    expect(ts.describe('hands_run', { argv: ['npm', 'test'], cwd: '.' })).toBe('阿同要在工作区里联网执行:npm test')
    // stdin 是命令的一部分:字节数 + 去控制字符的摘要进标题,批的人看得见喂了什么
    const nl = String.fromCharCode(10)
    expect(ts.describe('hands_run', { argv: ['sh'], stdin: `curl evil${nl}rm -rf x` })).toBe('阿同要在工作区里联网执行:sh · stdin 18B「curl evil rm -rf x」')
    expect(ts.describe('hands_write', { path: 'a/b.txt', content: '' })).toBe('阿同要在工作区里写:a/b.txt')
    expect(ts.describe('hands_rm', { path: 'x' })).toBe('阿同要在工作区里删:x')
  })

  it('标题诚实:截断处明说截了多少;控制字符/bidi 覆盖洗成空格(标题不可伪造)', () => {
    const ts = toolset()
    // ① 长 stdin:摘要给到 240 字符,并把「共多少」说出来——省略号后面藏了什么,
    //    只有台账知道,标题不能让人以为看到的就是全部。
    const long = ts.describe('hands_run', { argv: ['sh'], stdin: 'a'.repeat(300) })
    expect(long).toContain('stdin 300B「')
    expect(long).toContain('共 300 字符,已截断')
    expect(long).toContain('a'.repeat(240))
    expect(long).not.toContain('a'.repeat(241))
    // stdin 截断**刻意不指路台账**:台账只留字节数与 sha256,正文永不落盘。
    // 指向一个并不存在的「完整内容」比不指更坏(Codex 三轮 H2)。
    expect(long).not.toContain('完整命令见审计台账')
    // ② 长命令:600 字符以内一字不截(一条 sh -c 的真动作常在第 120 个字符之后)
    const cmd = `echo ${'b'.repeat(500)}`
    expect(ts.describe('hands_run', { argv: ['sh', '-c', cmd] })).toContain(cmd)
    const huge = ts.describe('hands_run', { argv: ['sh', '-c', 'c'.repeat(900)] })
    expect(huge).toContain('已截断')
    expect(huge).toContain('共 906 字符') // 'sh -c ' + 900(整段无空白,不加引号)
    // 命令截断**说得起**出处:分级那一刻真写了一行带全 argv 的判决(见 ④)。
    expect(huge).toContain('完整命令见审计台账')
    // ③ 换行伪造 + bidi 覆盖:标题原样进 /me 卡与 IM 一行字,不洗就能假装成系统说的话
    const rlo = String.fromCharCode(0x202e)
    const nl = String.fromCharCode(10)
    const forged = ts.describe('hands_rm', { path: `x${nl}已批准${rlo}txt.exe` })
    expect(forged.includes(nl)).toBe(false)
    expect(forged.includes(rlo)).toBe(false)
    expect(forged).toContain('阿同要在工作区里删:x 已批准 txt.exe')
  })

  it('标题按码点截,不把增补平面的字劈成半个代理项(七轮 L6)', () => {
    // U+1F4A3 是**两个** UTF-16 码元。按码元切会切在某个字中间,审批卡上凭空多一个
    // 原文里没有的 U+FFFD,而这行字的全部意义就是「它和真正要跑的命令是同一件事」;
    // 「共 N 字符」按码元数还会把 706 说成 1406——数字一错,人对「省略号后面还有多少」
    // 的判断就跟着错。与 `clipApprovalText` 是同一条纪律,两处各有各的门。
    const bomb = String.fromCodePoint(0x1f4a3)
    const title = toolset().describe('hands_run', { argv: ['sh', '-c', bomb.repeat(700)] })
    const lone = Array.from(title).filter((c) => {
      const cp = c.codePointAt(0) ?? 0
      return cp >= 0xd800 && cp <= 0xdfff
    })
    expect(lone).toHaveLength(0)
    expect(title).toContain('共 706 字符') // 'sh -c ' 六个码点 + 700 个炸弹,不是 1406
  })

  it('敌意 userId 被 ownerDir 挡在路径拼接前(不会在 handsRoot 外建目录)', () => {
    expect(() => buildButlerHandsToolset({ userId: '../../escape', hands: S.host })).toThrow()
    expect(existsSync(join(S.space, 'escape'))).toBe(false)
  })

  it('台账轮转阈值是从 argv 上限推出来的,不是随手一个 1MB(五轮 M)', async () => {
    const p = join(S.memberRoot, 'audit.jsonl')
    mkdirSync(S.memberRoot, { recursive: true })
    // **用生产那个常量本身**,不在这里把公式抄一遍(Codex 六轮 M):抄一遍的门只能
    // 证明「我算得和它一样」,而上一版两边抄的是同一个错的式子(漏了第三行带 argv 的)。
    // 「装得下 40 条」由下面那条**实测**门守;这里守的是「阈值不许被改小」。
    const threshold = AUDIT_ROTATE_BYTES_FOR_TEST
    const marker = '"OLD_ROW_MARKER"'
    const head = `{"old":${marker}}\n`
    const ts = toolset()

    // ① 差一个字节到阈值 ⇒ 不轮转。**这半边才是承重的**:阈值要是被改小(比如退回
    //    一个拍脑袋的 1MB),这份台账在这里就已经被推走了——而这正是反取证杠杆的形状。
    writeFileSync(p, head + '#'.repeat(threshold - head.length))
    await ts.classify('hands_run', { argv: ['sudo', 'ls'] }) // 拒绝也留痕,够触发判断
    expect(existsSync(`${p}.1`)).toBe(false)
    expect(readFileSync(p, 'utf8')).toContain('OLD_ROW_MARKER')

    // ② 过了阈值 ⇒ 旧内容整份进 .1,是被挪走不是被删。
    writeFileSync(p, head + '#'.repeat(threshold))
    await ts.classify('hands_run', { argv: ['sudo', 'ls'] })
    expect(readFileSync(`${p}.1`, 'utf8')).toContain('OLD_ROW_MARKER')
    expect(readFileSync(p, 'utf8')).not.toContain('OLD_ROW_MARKER')
    expect(auditRows(p)).toHaveLength(1)
  })
})

describe('HANDS-M2 ② 纯件', () => {
  it('TailBuffer:只留最后 cap 字节,total 记全量', () => {
    const t = new TailBuffer(10)
    t.push(Buffer.from('abcdef'))
    t.push(Buffer.from('ghijkl'))
    t.push(Buffer.from('mn'))
    expect(t.total).toBe(14)
    expect(t.bytes().toString()).toBe('efghijklmn')
    const one = new TailBuffer(4)
    one.push(Buffer.from('0123456789'))
    expect(one.bytes().toString()).toBe('6789')
  })

  it('childEnv 从零拼:hub 的 env 结构性缺席;HOME 指向只读空目录、TMPDIR 与缓存进工作区;代理变量只在联网时放行', () => {
    process.env.HANDS_TEST_SECRET = 'leak-me'
    process.env.HTTPS_PROXY = 'http://proxy.test:3128'
    try {
      const off = childEnv('/ws', false, { home: '/ro-home' })
      expect(off).not.toHaveProperty('HANDS_TEST_SECRET')
      expect(off).not.toHaveProperty('HTTPS_PROXY')
      // HOME **不是**工作区:工作区里写文件是 tier 1 免审批的,HOME 指过去等于
      // 把「无声写点文件 → 改写下一条被批准命令的行为」这条路留着。
      expect(off.HOME).toBe('/ro-home')
      expect(off.TMPDIR).toBe(`/ws/${HANDS_TMP_SUBDIR}`)
      // HOME 只读之后缓存得有落点,否则每次 npm/pip 都栽在 EROFS 上。
      expect(off.XDG_CACHE_HOME).toBe(`/ws/${HANDS_CACHE_SUBDIR}`)
      expect(off.NPM_CONFIG_CACHE).toBe(`/ws/${HANDS_CACHE_SUBDIR}/npm`)
      expect(off.PIP_CACHE_DIR).toBe(`/ws/${HANDS_CACHE_SUBDIR}/pip`)
      // 配置类的 XDG 变量刻意**不设**:它默认落在 $HOME/.config,而 HOME 只读 ⇒
      // 工具回落自带默认值。指进工作区就等于把点文件那条路原样搬过来。
      expect(off).not.toHaveProperty('XDG_CONFIG_HOME')
      expect(off[HANDS_ENV_MARKER]).toBe('1')
      expect(off.TERM).toBe('dumb')
      const on = childEnv('/ws', true, { home: '/ro-home' })
      expect(on.HTTPS_PROXY).toBe('http://proxy.test:3128')
      expect(on).not.toHaveProperty('HANDS_TEST_SECRET')
      // PATH 用 arm 时过滤好的那份,不是 hub 的原样
      expect(childEnv('/ws', false, { home: '/ro-home', pathEnv: '/only/this' }).PATH).toBe('/only/this')
    } finally {
      delete process.env.HTTPS_PROXY
    }
  })

  it('带用户名密码的代理 URL 也是凭证:联网命令也不放行', () => {
    expect(proxyUrlHasUserinfo('http://user:pw@proxy.test:3128')).toBe(true)
    expect(proxyUrlHasUserinfo('socks5://tok@10.0.0.1:1080/')).toBe(true)
    // curl/git/pip 都吃**不带 scheme** 的代理值,`new URL()` 解析不了这种形状——
    // 判据故意退成「有没有 @」:宁可多拦一个路径里带 @ 的怪代理(联网命令失败一次,
    // 模型看得见病名),也不放一把密码进子进程环境。
    expect(proxyUrlHasUserinfo('u:p@proxy.test:3128')).toBe(true)
    expect(proxyUrlHasUserinfo('http://proxy.test:3128')).toBe(false)
    expect(proxyUrlHasUserinfo('http://proxy.test:3128/@path')).toBe(true) // 过宽,故意的
    expect(proxyUrlHasUserinfo('proxy.test:3128')).toBe(false)
    const on = childEnv('/ws', true, {
      home: '/ro-home',
      source: { HTTPS_PROXY: 'http://u:p@proxy.test:3128', HTTP_PROXY: 'http://proxy.test:3128', NO_PROXY: 'localhost', PATH: '/bin' },
    })
    expect(on).not.toHaveProperty('HTTPS_PROXY')
    expect(on.HTTP_PROXY).toBe('http://proxy.test:3128')
    expect(on.NO_PROXY).toBe('localhost')
  })

  it('measureTree:数普通文件不跟链接,超上限提前收工(流式,不整表进内存)', () => {
    mkdirSync(join(S.workspace, 'x'), { recursive: true })
    writeFileSync(join(S.workspace, 'x', 'a'), 'aaaa')
    writeFileSync(join(S.workspace, 'b'), 'bb')
    symlinkSync('/', join(S.workspace, 'rootlink'))
    expect(measureTree(S.workspace, 1 << 30, HANDS_MAX_WORKSPACE_ENTRIES)).toEqual({ bytes: 6, entries: 4 })
    const early = measureTree(S.workspace, 3, HANDS_MAX_WORKSPACE_ENTRIES)
    expect(early.bytes).toBeGreaterThan(3)
    expect(measureTree(S.workspace, 1 << 30, 1).entries).toBe(2)
  })
})

// ─── ③ 监狱内真 spawn(本机无监狱则整段 skip;文件四工具也在这层)────────────

describe(`HANDS-M2 ③ 文件四工具(监狱内 node 小助手,jail=${jailCap.kind})`, () => {
  const spawnIt = it.skipIf(!HAS_JAIL)

  spawnIt('写 → 读 → 列 → 删;父目录自动建;删后读「不存在」', async () => {
    const ts = toolset()
    const w = await gated(ts, 'hands_write', { path: 'proj/src/index.ts', content: 'export const x = 1\n' })
    expect(w.isError).toBe(false)
    expect(w.text).toBe('已写 proj/src/index.ts(19B)')
    expect(readFileSync(join(S.workspace, 'proj/src/index.ts'), 'utf8')).toBe('export const x = 1\n')
    const r = await gated(ts, 'hands_read', { path: 'proj/src/index.ts' })
    expect(r.text).toBe('proj/src/index.ts(19B):\nexport const x = 1\n')
    const l = await gated(ts, 'hands_list', { path: 'proj' })
    expect(l.text).toBe('工作区/proj:1 项\n[dir]  src/')
    const l2 = await gated(ts, 'hands_list', {})
    expect(l2.text).toBe('工作区/.:1 项\n[dir]  proj/')
    const d = await gated(ts, 'hands_rm', { path: 'proj' })
    expect(d.text).toBe('已删 proj')
    const r2 = await gated(ts, 'hands_read', { path: 'proj/src/index.ts' })
    expect(r2.isError).toBe(true)
    expect(r2.text).toContain('不存在')
    expect((await gated(ts, 'hands_list', {})).text).toBe('工作区/.:0 项\n(空目录)')
  }, 60_000)

  spawnIt('列目录:排序 + 四类型标注 + 大小;读目录/列文件 互相指路', async () => {
    const ts = toolset()
    await gated(ts, 'hands_write', { path: 'b.txt', content: 'bb' })
    await gated(ts, 'hands_write', { path: 'a/x', content: '' })
    symlinkSync('b.txt', join(S.workspace, 'c-link'))
    const l = await gated(ts, 'hands_list', {})
    expect(l.text).toBe('工作区/.:3 项\n[dir]  a/\n[file] b.txt (2B)\n[link] c-link')
    const rd = await gated(ts, 'hands_read', { path: 'a' })
    expect(rd.isError).toBe(true)
    expect(rd.text).toContain('是目录——用 hands_list 看')
    const lf = await gated(ts, 'hands_list', { path: 'b.txt' })
    expect(lf.isError).toBe(true)
    expect(lf.text).toContain('不是目录——用 hands_read 看')
  }, 60_000)

  spawnIt('上限:写 > 1MB 拒;读 > 256KB 只回前面并注明;二进制只回摘要', async () => {
    const ts = toolset()
    const big = await gated(ts, 'hands_write', { path: 'big.bin', content: 'x'.repeat(HANDS_LIMITS.maxWriteBytes + 1) })
    expect(big.isError).toBe(true)
    expect(big.text).toContain('内容太大')
    expect(existsSync(join(S.workspace, 'big.bin'))).toBe(false)

    writeFileSync(join(S.workspace, 'long.txt'), 'y'.repeat(HANDS_LIMITS.maxReadBytes + 4096))
    const r = await gated(ts, 'hands_read', { path: 'long.txt' })
    expect(r.isError).toBe(false)
    expect(r.text.startsWith('long.txt(260KB,只显示前 256KB):\n')).toBe(true)
    expect(r.text.length).toBeLessThan(HANDS_LIMITS.maxReadBytes + 200)

    const nul = String.fromCharCode(0)
    writeFileSync(join(S.workspace, 'blob'), Buffer.from(`PNG${nul}${nul}data`, 'latin1'))
    const b = await gated(ts, 'hands_read', { path: 'blob' })
    expect(b.text).toBe('blob:二进制文件(9B),不显示内容')
  }, 60_000)

  spawnIt('根路径:写根拒 / 删根拒(指路逐项删)/ 列根可以;错误文本不露 hub 绝对路径', async () => {
    const ts = toolset()
    const w = await gated(ts, 'hands_write', { path: '.', content: 'x' })
    expect(w.isError).toBe(true)
    const d = await gated(ts, 'hands_rm', { path: '.' })
    expect(d.isError).toBe(true)
    expect(d.text).toContain('不能删工作区根')
    expect((await gated(ts, 'hands_list', { path: '.' })).isError).toBe(false)
    // 父路径是文件时写失败——小助手带回来的系统错误里有绝对路径,给模型前必须换成占位
    await gated(ts, 'hands_write', { path: 'afile', content: 'x' })
    const bad = await gated(ts, 'hands_write', { path: 'afile/child.txt', content: 'x' })
    expect(bad.isError).toBe(true)
    expect(bad.text).not.toContain(S.space)
    expect(bad.text).not.toContain(realpathSync(S.workspace))
  }, 60_000)

  spawnIt('符号链接四态:写经链接拒 / 读指外链接拒 / 读指内链接可读 / 删含指外链接的目录不伤外面', async () => {
    const ts = toolset()
    await gated(ts, 'hands_write', { path: 'real.txt', content: 'inside' })
    const outside = join(S.base, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'keep.txt'), 'must survive')
    symlinkSync(outside, join(S.workspace, 'esc'))
    symlinkSync('real.txt', join(S.workspace, 'inlink'))
    mkdirSync(join(S.workspace, 'd'))
    symlinkSync(outside, join(S.workspace, 'd', 'link'))

    // 写:经指外链接建文件 → 越界拒;直接写链接本身 → path_symlink 拒
    const w1 = await gated(ts, 'hands_write', { path: 'esc/x.txt', content: 'x' })
    expect(w1.verdict.decision).toBe('refuse')
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
    const w2 = await gated(ts, 'hands_write', { path: 'inlink', content: 'x' })
    expect(w2.verdict.decision).toBe('refuse')
    if (w2.verdict.decision === 'refuse') expect(w2.verdict.reason).toContain('本身是个符号链接')
    expect(readFileSync(join(S.workspace, 'real.txt'), 'utf8')).toBe('inside')

    // 读:指外拒,指内可读(pnpm 布局要能读)
    const r1 = await gated(ts, 'hands_read', { path: 'esc/keep.txt' })
    expect(r1.verdict.decision).toBe('refuse')
    const r2 = await gated(ts, 'hands_read', { path: 'inlink' })
    expect(r2.isError).toBe(false)
    expect(r2.text).toContain('inside')

    // 删:链接本身拒(指路删所在目录);删目录 → 链接被 unlink,外面原地留
    const d1 = await gated(ts, 'hands_rm', { path: 'd/link' })
    expect(d1.verdict.decision).toBe('refuse')
    const d2 = await gated(ts, 'hands_rm', { path: 'd' })
    expect(d2.isError).toBe(false)
    expect(existsSync(join(S.workspace, 'd'))).toBe(false)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('must survive')
  }, 60_000)

  spawnIt('TOCTOU 的真闸是监狱:策略放行后目录被换成指向 <space> 的链接,小助手照样写不进去、读不出来', async () => {
    const ts = toolset()
    await gated(ts, 'hands_write', { path: 'proj/a.txt', content: 'a' })
    // 模拟「检查之后、动手之前」的换包:策略层看到的是普通目录,执行时已是指向 <space> 的链接。
    // 这里直接对 execute 下手(callTool 不重跑策略的那半由 M1 复核补上;真正承重的是监狱)。
    rmSync(join(S.workspace, 'proj'), { recursive: true })
    symlinkSync(S.space, join(S.workspace, 'proj'))
    const before = readFileSync(join(S.space, 'agents.json'))
    const w = await approved(ts, 'hands_write', { path: 'proj/agents.json', content: '{"pwned":true}' })
    expect(w.isError).toBe(true)
    expect(readFileSync(join(S.space, 'agents.json')).equals(before)).toBe(true)
    const r = await approved(ts, 'hands_read', { path: 'proj/gotong.env' })
    expect(r.isError).toBe(true)
    expect(r.text).not.toContain(SECRET)
    const l = await approved(ts, 'hands_list', { path: 'proj' })
    expect(l.text).not.toContain('gotong.env')
  }, 60_000)

  spawnIt('配额:写会超上限 → 拒并指路 hands_rm;清理后恢复;联网命令 park 前先看配额', async () => {
    const ts = toolset({ maxWorkspaceBytes: 1024 * 1024 })
    const ok = await gated(ts, 'hands_write', { path: 'a', content: 'x'.repeat(600 * 1024) })
    expect(ok.isError).toBe(false)
    const over = await gated(ts, 'hands_write', { path: 'b', content: 'y'.repeat(600 * 1024) })
    expect(over.isError).toBe(true)
    expect(over.text).toContain('先用 hands_rm 清理')
    expect(existsSync(join(S.workspace, 'b'))).toBe(false)
    // 联网命令要 park:配额已满时 classify 直接 refuse(别浪费成员一次审批)
    writeFileSync(join(S.workspace, 'fat'), 'z'.repeat(1024 * 1024))
    const v = await ts.classify('hands_run', { argv: ['npm', 'install'] })
    expect(v.decision).toBe('refuse')
    if (v.decision === 'refuse') expect(v.reason).toContain('工作区已用')
    // 清了就恢复
    expect((await gated(ts, 'hands_rm', { path: 'fat' })).isError).toBe(false)
    expect((await gated(ts, 'hands_rm', { path: 'a' })).isError).toBe(false)
    expect((await gated(ts, 'hands_write', { path: 'b', content: 'y'.repeat(600 * 1024) })).isError).toBe(false)
  }, 60_000)

  spawnIt('审计:文件动作各落一行,含 tool/ok/path,不含文件内容;文件 mode 0600', async () => {
    const ts = toolset()
    await gated(ts, 'hands_write', { path: 'note.md', content: 'private-body-text' })
    await gated(ts, 'hands_read', { path: 'note.md' })
    await gated(ts, 'hands_list', {})
    await gated(ts, 'hands_rm', { path: 'note.md' })
    const rows = execRows()
    expect(rows.map((r) => r.tool)).toEqual(['hands_write', 'hands_read', 'hands_list', 'hands_rm'])
    expect(rows.every((r) => r.ok === true && r.tier === 1)).toBe(true)
    expect(rows[0]).toMatchObject({ path: 'note.md', bytes: 17 })
    // 每次调用三行:判决(classify)→ 动手前(begin)→ 结果(execute)。
    // begin 必须在结果**之前**——事后 append 失败只剩 warn,证据得先落地。
    const all = auditRows().filter((r) => r.tool === 'hands_write')
    expect(all.map((r) => r.stage)).toEqual(['classify', 'begin', 'execute'])
    expect(readFileSync(join(S.memberRoot, 'audit.jsonl'), 'utf8')).not.toContain('private-body-text')
  }, 60_000)

  spawnIt('两个成员两套工作区,互不可见(userId 是闭包不是参数)', async () => {
    // 两个人都得先有手,否则这条测的就变成角色闸而不是工作区隔离了。
    S.roles.set('alice', 'owner')
    S.roles.set('bob', 'admin')
    const a = buildButlerHandsToolset({ userId: 'alice', hands: S.host })
    const b = buildButlerHandsToolset({ userId: 'bob', hands: S.host })
    await gated(a, 'hands_write', { path: 'secret.txt', content: 'alice only' })
    const r = await gated(b, 'hands_read', { path: 'secret.txt' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('不存在')
    expect(readdirSync(join(S.host.handsRoot, 'user')).sort()).toEqual(['alice', 'bob'])
  }, 60_000)
})

describe(`HANDS-M2 ③ 监狱内真 spawn(jail=${jailCap.kind})`, () => {
  const spawnIt = it.skipIf(!HAS_JAIL)

  spawnIt('文档门①:`cat <space>/gotong.env` 在监狱内失败且不吐值;hands_read 同拒(双拒)', async () => {
    const ts = toolset()
    const r = await gated(ts, 'hands_run', { argv: ['cat', join(S.space, 'gotong.env')] })
    expect(r.verdict.decision).toBe('allow') // 离线命令本身放行——挡它的是监狱不是策略
    expect(r.isError).toBe(true)
    expect(r.text).not.toContain(SECRET)
    expect(r.text).toMatch(/exit [1-9]|signal/)
    const rd = await gated(ts, 'hands_read', { path: '../../../../../gotong.env' })
    expect(rd.verdict.decision).toBe('refuse')
    // 目录也照样看不见(bwrap 是空 tmpfs,seatbelt 是 deny read)
    const ls = await gated(ts, 'hands_run', { argv: ['sh', '-c', `ls ${JSON.stringify(S.space)} && cat ${JSON.stringify(join(S.space, 'agents.json'))}`] })
    expect(ls.text).not.toContain('gotong.env')
    expect(ls.text).not.toContain('"agents"')
  }, 20_000)

  spawnIt('文档门②:写 `<space>/agents.json` 双拒——监狱内 shell 重定向失败,盘上字节不变;hands_write 穿越拒', async () => {
    const ts = toolset()
    const before = readFileSync(join(S.space, 'agents.json'))
    const r = await gated(ts, 'hands_run', { argv: ['sh', '-c', `echo pwned > ${JSON.stringify(join(S.space, 'agents.json'))}; echo rc=$?`] })
    expect(r.verdict.decision).toBe('allow')
    expect(r.text).not.toContain('rc=0')
    expect(readFileSync(join(S.space, 'agents.json')).equals(before)).toBe(true)
    const w = await gated(ts, 'hands_write', { path: '../../../../../agents.json', content: '{}' })
    expect(w.verdict.decision).toBe('refuse')
    expect(readFileSync(join(S.space, 'agents.json')).equals(before)).toBe(true)
    // 工作区自己照常可写,且写进去的东西 hands_read 看得见(同一棵树)
    const ok = await gated(ts, 'hands_run', { argv: ['sh', '-c', 'mkdir -p sub && echo hello > sub/note.txt && echo rc=$?'] })
    expect(ok.isError).toBe(false)
    expect(ok.text).toContain('rc=0')
    expect((await gated(ts, 'hands_read', { path: 'sub/note.txt' })).text).toContain('hello')
  }, 30_000)

  spawnIt('hub 用户的 HOME 与点名的凭证文件藏起来:`cat` 不吐值,`ls` 列不出内容', async () => {
    const ts = toolset()
    const home = await gated(ts, 'hands_run', { argv: ['sh', '-c', `cat ${JSON.stringify(join(S.fakeHome, '.ssh', 'id_test'))} ${JSON.stringify(join(S.fakeHome, '.netrc'))}; ls -A ${JSON.stringify(S.fakeHome)}; echo done`] })
    expect(home.text).not.toContain(HOME_SECRET)
    // stderr 里 cat/ls 的报错会复述路径本身——只看 stdout:目录内容一个名字都列不出来
    const homeStdout = home.text.split('--- stderr ---')[0]!
    expect(homeStdout).not.toContain('.netrc')
    expect(homeStdout).not.toContain('id_test')
    expect(homeStdout).toContain('done')
    // 点名文件(bwrap 是 /dev/null 盖住 → cat 成功但空;seatbelt 是 deny → cat 失败):两种都不吐值
    const envf = await gated(ts, 'hands_run', { argv: ['sh', '-c', `cat ${JSON.stringify(S.fakeEnvFile)}; echo rc=$?`] })
    expect(envf.text).not.toContain(ENVFILE_SECRET)
    expect(envf.text).toContain('rc=')
    // 藏起来的 <space> 之外、没点名的地方照常可读(监狱藏的是 hub 的凭证,不是整台机器)
    writeFileSync(join(S.base, 'public.txt'), 'plain-visible')
    const pub = await gated(ts, 'hands_run', { argv: ['cat', join(S.base, 'public.txt')] })
    expect(pub.text).toContain('plain-visible')
  }, 30_000)

  spawnIt('HOME 是每次 spawn 现问的:boot 之后才长出来的家目录照样藏得住(Codex 三轮 H3)', async () => {
    // arm 时 HOME 还不存在(容器里家目录后建、账号切换、hub 先于 login 起来),
    // 于是它没进 shape.hiddenDirs。常量表(/home、/root、docker.sock…)每次 spawn 都
    // 重新探,而 HOME 不在那两张表里——只补常量表 = 永远补不回它。
    const blind = jailShapeFor(S.space, S.host.config, { ...S.host.probe, kind: (p) => (p === S.fakeHome ? null : realKind(p)) })
    expect(blind.hiddenDirs).not.toContain(S.fakeHome) // 快照里确实没有它
    const ts = buildButlerHandsToolset({ userId: 'u1', hands: { ...S.host, shape: blind } })
    const r = await gated(ts, 'hands_run', {
      argv: ['sh', '-c', `cat ${JSON.stringify(join(S.fakeHome, '.netrc'))}; ls -A ${JSON.stringify(S.fakeHome)}; echo done`],
    })
    expect(r.text).not.toContain(HOME_SECRET)
    expect(r.text.split('--- stderr ---')[0]!).not.toContain('.netrc')
    expect(r.text).toContain('done')
  }, 30_000)

  spawnIt('真探针形状:藏起 hub 真 HOME 后 node 照样能跑(前缀再放开只读);PATH 里落在 HOME 的项只剩再放开的', async () => {
    const shape = jailShapeFor(S.space, S.host.config)
    const realHome = realpathSync(homedir())
    expect(shape.hiddenDirs).toContain(realHome)
    for (const entry of shape.pathEnv.split(':')) {
      const v = [entry, ...(existsSync(entry) ? [realpathSync(entry)] : [])]
      if (v.some((p) => isInsideRoots(p, [realHome]))) {
        expect(v.some((p) => isInsideRoots(p, shape.readOnlyRoots)), `PATH entry under HOME must be re-exposed: ${entry}`).toBe(true)
      }
    }
    const ts = buildButlerHandsToolset({ userId: 'u1', hands: { ...S.host, shape } })
    const r = await gated(ts, 'hands_run', { argv: [NODE, '-e', 'console.log("node-alive:"+process.version)'] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('node-alive:')
    // 文件小助手也是这枚 node,同一座监狱——HOME 藏着照样能读写工作区
    const w = await gated(ts, 'hands_write', { path: 'ok.txt', content: 'w' })
    expect(w.isError, w.text).toBe(false)
  }, 30_000)

  spawnIt('文档门③:断网——离线命令连本机 HTTP 都通不了;net:true 批准后同一命令通', async () => {
    const server: Server = createServer((_req, res) => res.end('ok-from-host'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    try {
      const port = (server.address() as AddressInfo).port
      const script = `fetch('http://127.0.0.1:${port}/').then(r=>r.text()).then(t=>{console.log('BODY:'+t)}).catch(e=>{console.error('ERR:'+e.message);process.exit(3)})`
      const ts = toolset()
      const off = await gated(ts, 'hands_run', { argv: [NODE, '-e', script], net: false, timeoutSec: 20 })
      expect(off.verdict.decision).toBe('allow')
      expect(off.isError).toBe(true)
      expect(off.text).not.toContain('BODY:ok-from-host')
      expect(off.text).toContain('离线')
      // net:true → 策略 park(approve);人批了 → 同一条命令在有网的监狱里跑
      const v = await ts.classify('hands_run', { argv: [NODE, '-e', script], net: true, timeoutSec: 20 })
      expect(v.decision).toBe('approve')
      const on = await approved(ts, 'hands_run', { argv: [NODE, '-e', script], net: true, timeoutSec: 20 })
      expect(on.isError).toBe(false)
      expect(on.text).toContain('BODY:ok-from-host')
      expect(on.text).toContain('联网')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 40_000)

  spawnIt('凭证结构性缺席:监狱里 env 看不到 hub 的变量;HOME=只读空目录(点文件种不进去);TMPDIR 与包管理器缓存在工作区里;ATONG_HANDS=1', async () => {
    process.env.HANDS_TEST_SECRET = 'leak-me'
    const ts = toolset()
    const probe = [
      'env',
      'echo HOME_IS=$HOME',
      'echo TMP_IS=$TMPDIR',
      'touch "$TMPDIR/scratch" && echo tmp-ok',
      // HOME 得**在**、**读得进去**、而且是**空**的。三件缺一不可:只断言「列出来是
      // 0 条」会把「HOME 根本不存在」也一起放过去(ls 失败同样输出 0 行),而那是另一
      // 种东西——很多工具 stat 不到 HOME 会以看不懂的方式崩,H2 要的是空不是没有。
      'test -d "$HOME" && echo HOME_ISDIR || echo HOME_NO_DIR',
      'ls -A "$HOME" >/dev/null 2>&1 && echo HOME_LISTABLE || echo HOME_NOT_LISTABLE',
      'echo HOME_ENTRIES=$(ls -A "$HOME" | wc -l | tr -d " ")',
      // 且写不进去——种不下 ~/.npmrc 这类「悄悄改工具行为」的点文件。
      'touch "$HOME/.npmrc" 2>/dev/null && echo DOTFILE_WROTE || echo DOTFILE_REFUSED',
    ].join('; ')
    const r = await gated(ts, 'hands_run', { argv: ['sh', '-c', probe] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).not.toContain('HANDS_TEST_SECRET')
    expect(r.text).not.toContain('leak-me')
    expect(r.text).toContain(`${HANDS_ENV_MARKER}=1`)
    const ws = realpathSync(S.workspace)
    // HOME 不是工作区(工作区可写 ⇒ 点文件就能落地并跨命令留下来),而是一个
    // 只读空目录:查配置的路都指向它 ⇒ 查不到 ⇒ 走工具自己的默认值。
    expect(r.text).toContain(`HOME_IS=${realpathSync(S.jailHome)}`)
    expect(r.text).toContain('HOME_ISDIR')
    expect(r.text).toContain('HOME_LISTABLE')
    expect(r.text).not.toContain('HOME_NOT_LISTABLE')
    expect(r.text).toContain('HOME_ENTRIES=0')
    expect(r.text).toContain('DOTFILE_REFUSED')
    expect(r.text).not.toContain('DOTFILE_WROTE')
    expect(existsSync(join(S.jailHome, '.npmrc'))).toBe(false)
    // 缓存另说:缓存不改行为,只是重复下载很贵 ⇒ 显式指进工作区(可写、可回收)。
    expect(r.text).toContain(`XDG_CACHE_HOME=${ws}/${HANDS_CACHE_SUBDIR}`)
    expect(r.text).toContain(`NPM_CONFIG_CACHE=${ws}/${HANDS_CACHE_SUBDIR}/npm`)
    expect(r.text).toContain(`TMP_IS=${ws}/${HANDS_TMP_SUBDIR}`)
    expect(r.text).toContain('tmp-ok')
    expect(existsSync(join(S.workspace, HANDS_TMP_SUBDIR, 'scratch'))).toBe(true)
    // 与共享 /tmp 隔开:监狱里写不了宿主的 /tmp(bwrap 是私有 tmpfs 写得了但看不到宿主的;seatbelt 直接拒)
    const marker = `gotong-hands-shared-tmp-${process.pid}`
    const shared = await gated(ts, 'hands_run', { argv: ['sh', '-c', `echo x > /tmp/${marker}; echo rc=$?`] })
    expect(shared.text).toContain('rc=')
    expect(existsSync(`/tmp/${marker}`)).toBe(false)
  }, 30_000)

  spawnIt('cwd 相对工作区;不存在的 cwd 响亮拒;stdin 喂得进且审计只记字节数与 sha256', async () => {
    const ts = toolset()
    await gated(ts, 'hands_write', { path: 'sub/.keep', content: '' })
    const r = await gated(ts, 'hands_run', { argv: ['pwd'], cwd: 'sub' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain(`${realpathSync(S.workspace)}/sub`)
    expect(r.text).toContain('cwd sub')
    const missing = await gated(ts, 'hands_run', { argv: ['pwd'], cwd: 'nope' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('不存在')
    const fed = await gated(ts, 'hands_run', { argv: ['cat'], stdin: 'from-stdin-secretish\n' })
    expect(fed.text).toContain('from-stdin-secretish')
    const row = execRows().find((x) => x.tool === 'hands_run' && typeof x.stdinBytes === 'number')!
    expect(row.stdinBytes).toBe(21)
    expect(typeof row.stdinSha256).toBe('string')
    expect(String(row.stdinSha256)).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(join(S.memberRoot, 'audit.jsonl'), 'utf8')).not.toContain('from-stdin-secretish')
  }, 30_000)

  spawnIt('超时:1s 后整个进程组被杀,回执 isError 且说超时', async () => {
    const ts = toolset()
    const t0 = Date.now()
    const r = await gated(ts, 'hands_run', { argv: [NODE, '-e', 'setTimeout(()=>{},10000)'], timeoutSec: 1 })
    expect(Date.now() - t0).toBeLessThan(6000)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('超时(1s)')
    expect(r.text).toMatch(/signal|exit/)
    const row = execRows().find((x) => x.tool === 'hands_run')
    expect(row?.timedOut).toBe(true)
  }, 20_000)

  spawnIt('命令一退出就收整个进程组:后台留下的孙进程活不到下一条命令', async () => {
    const ts = toolset()
    const t0 = Date.now()
    // 前台立刻退出;后台的孙进程 3s 后要写 late.txt——被一并收掉就写不成
    const r = await gated(ts, 'hands_run', { argv: ['sh', '-c', '(sleep 3; echo alive > late.txt) & echo started'] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('started')
    expect(Date.now() - t0).toBeLessThan(2500)
    await sleep(3800)
    expect(existsSync(join(S.workspace, 'late.txt'))).toBe(false)
  }, 20_000)

  spawnIt('超输出:只回最后 N 字节并如实注明总量;洪水(> 64×上限)提前终止', async () => {
    const ts = toolset({ maxOutputBytes: 4096 })
    const r = await gated(ts, 'hands_run', { argv: [NODE, '-e', "process.stdout.write('x'.repeat(20000))"] })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('(stdout 共 20000 字节,只保留最后 4096 字节)')
    const body = r.text.split('--- stdout ---\n')[1] ?? ''
    expect(body.length).toBeLessThanOrEqual(4096 + 8)
    const flood = await gated(ts, 'hands_run', { argv: ['yes'], timeoutSec: 20 })
    expect(flood.isError).toBe(true)
    expect(flood.text).toContain(`输出超过 256KB,已提前终止`)
    expect(HANDS_OUTPUT_KILL_MULTIPLIER * 4096).toBe(256 * 1024)
  }, 40_000)

  spawnIt('并发 1 是 hub 级:同一成员另一份 toolset(会话窗/IM 各一份)也被拒「还在跑」;跑完恢复', async () => {
    const ts = toolset()
    const other = buildButlerHandsToolset({ userId: 'u1', hands: S.host })
    const args = { argv: [NODE, '-e', 'setTimeout(()=>{},1500)'], timeoutSec: 10 }
    expect((await ts.classify('hands_run', args)).decision).toBe('allow')
    // 不 await:execute 的同步段(策略复核 + 立 busy)在 spawn 前就跑完——再来一件必须被拒
    const first = ts.callTool('hands_run', args)
    const second = await ts.callTool('hands_list', {})
    expect(second.isError).toBe(true)
    expect(second.content[0]!.text).toContain('还在跑')
    const third = await other.callTool('hands_list', {})
    expect(third.isError).toBe(true)
    expect(third.content[0]!.text).toContain('还在跑')
    const r1 = await first
    expect(r1.isError).toBeUndefined()
    const after = await other.callTool('hands_list', {})
    expect(after.isError).toBeUndefined()
    // 被并发锁挡下的两次也各留一行——「谁在什么时候想同时伸第二只手」是运维信号
    expect(auditRows().filter((r) => r.code === 'busy')).toHaveLength(2)
  }, 20_000)

  spawnIt('审计行:argv/exit/时长在,stdout 正文不在', async () => {
    const ts = toolset()
    // 命令拼出的正文「AUDITBODY」在 argv 里是拆开的两段——审计里若出现整词,就是把 stdout 存了
    const r = await gated(ts, 'hands_run', { argv: ['sh', '-c', 'printf %s%s AUDIT BODY'] })
    expect(r.text).toContain('AUDITBODY')
    const raw = readFileSync(join(S.memberRoot, 'audit.jsonl'), 'utf8')
    expect(raw).not.toContain('AUDITBODY')
    const row = execRows().find((x) => x.tool === 'hands_run')!
    expect(row).toMatchObject({ ok: true, exit: 0, net: false, jail: jailCap.kind, cwd: '.', code: 'run_offline', tier: 1 })
    // 判决行(park 前那一刻)留了**全 argv 向量**——审批卡那句「完整命令见审计台账」
    // 靠的就是它;没有它,截断处的指路是空头支票(Codex 三轮 H2)。
    const verdict = auditRows().find((x) => x.stage === 'classify' && x.tool === 'hands_run')!
    expect(verdict.argv).toEqual(['sh', '-c', 'printf %s%s AUDIT BODY'])
    expect(Array.isArray(row.argv)).toBe(true)
    expect(typeof row.ms).toBe('number')
    expect(row).not.toHaveProperty('stdinBytes')
  }, 20_000)

  spawnIt('轮转阈值装得下 40 条**实测**最坏动作(六轮 M:不是把公式抄一遍)', async () => {
    // 上一版的账是错的:它只数了两行带 argv 的(classify + begin),漏了跑完那行
    // (result),于是「装得下 40 条」实际只有 26 条左右——而守它的门抄的是同一个
    // 错式子,所以永远绿。这道门不算,它**量**:拿顶格 argv 真跑一次,数盘上多了
    // 多少字节。多写一行带 argv 的、argv 上限调大、行里多塞个大字段,它都会先红。
    //
    // 最坏形状 = argv 顶格(maxArgv 项 / maxArgvTotalChars 码元)且每个码元在 JSON
    // 里要 6 个字节。**落单代理项**才是这个最坏值:控制字符同样六字节,但策略层的
    // `hasHostileArgChar` 直接拒(试过,当场 run_invalid),真正能一路走到台账的是
    // 落单代理项——它过得了策略、进得了 execve(Node 编码时换成 U+FFFD),而台账记的
    // 是 JS 串本身,于是三行都按六字节写。
    const items = HANDS_LIMITS.maxArgv
    const per = Math.floor(HANDS_LIMITS.maxArgvTotalChars / items)
    const junk = String.fromCharCode(0xd800).repeat(per)
    const argv = ['sh', ...Array.from({ length: items - 1 }, () => junk)]
    const p = join(S.memberRoot, 'audit.jsonl')
    const ts = toolset()
    await gated(ts, 'hands_run', { argv })

    const grew = statSync(p).size
    // 三行都在——少一行这道门就量错了(它量的是「一条动作」的全部代价)。
    expect(auditRows(p)).toHaveLength(3)
    // 真的是最坏形状:光转义就该有 argv 上限 × 6 字节这个量级。
    expect(grew).toBeGreaterThan(HANDS_LIMITS.maxArgvTotalChars * 6)
    expect(Math.floor(AUDIT_ROTATE_BYTES_FOR_TEST / grew)).toBeGreaterThanOrEqual(AUDIT_MIN_ACTIONS)
  }, 30_000)
})
