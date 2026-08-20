/**
 * HANDS-M2b 承重门 — 手 B(外驱 coding CLI,`personal-butler-coder.ts`)。
 *
 * 三层:
 *
 *   ① 配置形状 —— `parseHandsCoder` 逐条拒绝(未知键 / 缺必填 / 坏 agentId /
 *      passEnv 粘了值而不是名字 / 越界),以及**看不懂 ⇒ 整份 hands.json 不装**
 *      (与其余每个键同一条规矩,别让操作者以为只是手 B 没配上)。
 *   ② 五道 fail-closed 装配闸 —— 手 A 没装 / 没有 coder 块 / 成员不够格 /
 *      agentId 撞上别人的行 / 工作区建不起来,一律不装且**零副作用**(不够格的
 *      成员连目录都不该被建出来)。装上时:名册行 + owner 授权都在(阿同的
 *      `escalate_to_expert` 那道 fail-closed 检查认的就是这两样)。
 *   ③ 围墙 —— 手 B 用的是**手 A 那一圈**:每次 spawn 现算(长活的参与者 + 定死的
 *      围墙 = 悄悄变弱的围墙)、`passEnv` 只能补充永远盖不掉 HOME/PATH/TMPDIR、
 *      真 spawn 里 hub 的凭证藏得住(`it.skipIf` 本机无 OS 监狱)。
 *   ④ 里程碑验收门(真监狱)——**阿同写需求 → 手 B 改文件 → 阿同 `hands_run`
 *      跑测试**:两只手共用同一个工作区,这正是手 B 存在的理由。
 *
 * 教训沿用:测试里任何控制字节走 `String.fromCharCode`,不写转义字面量。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectFsJail, type AgentRecord, type Logger, type Participant, type Task, type TaskId } from '@gotong/core'
import type { Principal } from '@gotong/identity'
import { afterEach, describe, expect, it } from 'vitest'

import {
  HANDS_CODER_CAPABILITY,
  armButlerCoder,
  type CoderGrantDeps,
} from '../src/personal-butler-coder.js'
import {
  HANDS_CODER_DEFAULT_ID,
  buildButlerHandsToolset,
  jailShapeFor,
  loadHandsConfig,
  parseHandsCoder,
  type ButlerHands,
  type ButlerHandsHost,
  type HandsConfig,
  type HandsCoderConfig,
} from '../src/personal-butler-hands.js'

const NODE = process.execPath
const jailCap = await detectFsJail()
const HAS_JAIL = jailCap.kind !== 'none'
const HOME_SECRET = 'CODER_HOME_SECRET_VALUE_7b31'

type LogRow = { level: string; msg: string; ctx?: Record<string, unknown> }

/** 真文件系统的探针(与手 A 测试同一份):`jailShapeFor` 靠它决定藏什么。 */
function realKind(p: string): 'dir' | 'file' | null {
  try {
    const st = statSync(p)
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null
  } catch {
    return null
  }
}

const bases: string[] = []
afterEach(() => {
  while (bases.length) rmSync(bases.pop()!, { recursive: true, force: true })
})

/** 一个能跑的 coder 块:命令是本机 node,`{prompt}` 落在 argv 上。 */
function coderCfg(over: Partial<HandsCoderConfig> = {}): Record<string, unknown> {
  return { userId: 'u1', command: NODE, args: ['-e', 'process.stdout.write("ok")'], ...over }
}

function makeHands(opts: { coder?: unknown; role?: string | null; allowRoles?: string[] } = {}): {
  base: string
  space: string
  fakeHome: string
  hands: ButlerHands
  host: ButlerHandsHost
  logs: LogRow[]
  memberRoot: string
  workspace: string
} {
  const base = mkdtempSync(join(tmpdir(), 'gotong-coder-'))
  bases.push(base)
  const space = join(base, 'space')
  mkdirSync(space, { recursive: true })
  writeFileSync(join(space, 'gotong.env'), 'MIMO_API_KEY=nope\n')
  const fakeHome = join(base, 'home')
  mkdirSync(join(fakeHome, '.ssh'), { recursive: true })
  writeFileSync(join(fakeHome, '.ssh', 'id_test'), `${HOME_SECRET}\n`)

  const logs: LogRow[] = []
  const mk = (level: string) => (msg: string, ctx?: Record<string, unknown>) => {
    logs.push({ level, msg, ...(ctx ? { ctx } : {}) })
  }
  const logger = { trace: mk('trace'), debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), fatal: mk('fatal') } as unknown as Logger

  const allowRoles = opts.allowRoles ?? ['owner', 'admin']
  const parsed = opts.coder === undefined ? undefined : parseHandsCoder(opts.coder)
  if (typeof parsed === 'string') throw new Error(`fixture coder block rejected: ${parsed}`)
  const config: HandsConfig = {
    maxRunSec: 60,
    maxOutputBytes: 32 * 1024,
    maxWorkspaceBytes: 64 * 1024 * 1024,
    allowRoles,
    ...(parsed ? { coder: parsed } : {}),
  }
  const probe = { homedir: () => fakeHome, kind: realKind, execPath: NODE, pathEnv: process.env.PATH }
  const role = opts.role === undefined ? 'owner' : opts.role
  const host: ButlerHandsHost = {
    spaceRoot: space,
    handsRoot: join(space, 'butler', 'hands'),
    kind: HAS_JAIL ? (jailCap.kind as ButlerHandsHost['kind']) : 'sandbox-exec',
    config,
    shape: jailShapeFor(space, config, probe),
    probe,
    allowed: (uid) => uid === 'u1' && typeof role === 'string' && allowRoles.includes(role),
    logger,
  }
  const memberRoot = join(host.handsRoot, 'user', 'u1')
  return {
    base,
    space,
    fakeHome,
    host,
    hands: { host, status: 'armed' } as ButlerHands,
    logs,
    memberRoot,
    workspace: join(memberRoot, 'workspace'),
  }
}

type FakeGrant = { principal: Principal; perm: string }

/**
 * 名册假件:记下注册进来的参与者、写进 agents.json 的行、发出去的授权。
 *
 * 授权那半是一张**真的**表(有行、能读、能删)而不是一个 push 数组——手 B 的归属
 * 不变量是「这台 coder 恰好一个 owner」,而 upsert 顶不掉旧行正是它会破的方式,
 * 只记「发过哪些」的假件对这条不变量什么也证明不了。
 */
function fakeRoster(
  seed: AgentRecord[] = [],
  opts: { grants?: FakeGrant[]; listThrows?: boolean } = {},
) {
  const registered: Participant[] = []
  const rows: AgentRecord[] = [...seed]
  const grants: Array<Record<string, unknown>> = []
  const grantRows: FakeGrant[] = [...(opts.grants ?? [])]
  const chunks: Array<Record<string, unknown>> = []
  return {
    registered,
    rows,
    grants,
    grantRows,
    chunks,
    hub: {
      register: (p: Participant) => registered.push(p),
      transcript: { emitEphemeral: (e: { data?: unknown }) => chunks.push(e.data as Record<string, unknown>) },
    },
    space: {
      agents: async () => rows,
      upsertAgent: async (rec: Omit<AgentRecord, 'createdAt'> & { createdAt?: string }) => {
        const full = { createdAt: new Date().toISOString(), ...rec } as AgentRecord
        const at = rows.findIndex((r) => r.id === full.id)
        if (at >= 0) rows[at] = full
        else rows.push(full)
        return full
      },
    },
    grantsDep: {
      setResourceGrant: (i: Parameters<CoderGrantDeps['setResourceGrant']>[0]) => {
        grants.push(i as unknown as Record<string, unknown>)
        const at = grantRows.findIndex(
          (g) => g.principal.kind === i.principal.kind && g.principal.id === i.principal.id,
        )
        const row: FakeGrant = { principal: i.principal, perm: i.perm }
        if (at >= 0) grantRows[at] = row
        else grantRows.push(row)
      },
      listResourceGrants: () => {
        if (opts.listThrows) throw new Error('grant table unreadable')
        return grantRows.map((g) => ({ principal: g.principal, perm: g.perm }))
      },
      removeResourceGrant: (_k: 'agent', _id: string, principal: Principal) => {
        const at = grantRows.findIndex(
          (g) => g.principal.kind === principal.kind && g.principal.id === principal.id,
        )
        if (at >= 0) grantRows.splice(at, 1)
      },
    } as CoderGrantDeps,
  }
}

async function arm(fx: ReturnType<typeof makeHands>, r = fakeRoster()) {
  const res = await armButlerCoder({ hands: fx.hands, hub: r.hub, space: r.space, grants: r.grantsDep, logger: fx.host.logger })
  return { res, r }
}

function makeTask(payload: unknown, id: TaskId = 't-1'): Task {
  return { id, from: 'u1', strategy: { kind: 'explicit', to: HANDS_CODER_DEFAULT_ID }, payload }
}

// ─── ① 配置形状 ──────────────────────────────────────────────────────────────

describe('HANDS-M2b coder config', () => {
  it('fills the defaults an operator should not have to spell out', () => {
    const c = parseHandsCoder(coderCfg())
    expect(typeof c).not.toBe('string')
    expect(c).toMatchObject({ agentId: HANDS_CODER_DEFAULT_ID, promptVia: 'stdin', passEnv: [], maxTurns: 1 })
  })

  it.each([
    ['unknown key', { ...coderCfg(), oops: 1 }, /unknown keys/],
    ['missing userId', { command: NODE }, /coder\.userId/],
    ['missing command', { userId: 'u1' }, /coder\.command/],
    ['bad agentId', coderCfg({ agentId: '../escape' as string }), /coder\.agentId/],
    ['bad promptVia', { ...coderCfg(), promptVia: 'pipe' }, /promptVia/],
    ['timeout out of range', coderCfg({ timeoutSec: 0 }), /timeoutSec/],
    ['maxTurns out of range', coderCfg({ maxTurns: 99 }), /maxTurns/],
    ['not an object', ['nope'], /must be a JSON object/],
  ])('refuses %s', (_name, block, re) => {
    expect(parseHandsCoder(block)).toMatch(re as RegExp)
  })

  it('refuses a passEnv entry that is a secret VALUE instead of a NAME', () => {
    // 配置文件里永远只有变量名(MCP `${NAME}` / MR-M6 apiKeyEnv 同一条纪律)。
    expect(parseHandsCoder(coderCfg({ passEnv: ['sk-live-abcdef'] }))).toMatch(/NAMES, not values/)
    expect(parseHandsCoder(coderCfg({ passEnv: ['ANTHROPIC_API_KEY'] }))).toMatchObject({ passEnv: ['ANTHROPIC_API_KEY'] })
  })

  it('refuses control characters in the label (no escaped literals in this file)', () => {
    const nl = String.fromCharCode(10)
    expect(parseHandsCoder(coderCfg({ label: `a${nl}b` }))).toMatch(/coder\.label/)
  })

  it('a bad coder block takes the WHOLE hands.json down (uniform with every other key)', () => {
    const base = mkdtempSync(join(tmpdir(), 'gotong-coder-cfg-'))
    bases.push(base)
    const logs: LogRow[] = []
    const logger = {
      info: (msg: string, ctx?: Record<string, unknown>) => logs.push({ level: 'info', msg, ...(ctx ? { ctx } : {}) }),
      warn: (msg: string, ctx?: Record<string, unknown>) => logs.push({ level: 'warn', msg, ...(ctx ? { ctx } : {}) }),
    }
    writeFileSync(join(base, 'hands.json'), JSON.stringify({ enabled: true, coder: { userId: 'u1' } }))
    expect(loadHandsConfig(base, logger)).toBeUndefined()
    expect(logs.some((l) => l.level === 'warn' && String(l.ctx?.problem).includes('coder.command'))).toBe(true)
  })

  it('a good coder block rides along inside hands.json', () => {
    const base = mkdtempSync(join(tmpdir(), 'gotong-coder-cfg2-'))
    bases.push(base)
    writeFileSync(join(base, 'hands.json'), JSON.stringify({ enabled: true, coder: coderCfg({ agentId: 'mycoder' }) }))
    const cfg = loadHandsConfig(base, { info: () => {}, warn: () => {} })
    expect(cfg?.coder).toMatchObject({ agentId: 'mycoder', userId: 'u1' })
  })
})

// ─── ② 五道装配闸 ────────────────────────────────────────────────────────────

describe('HANDS-M2b arming gates (fail-closed)', () => {
  it('hand A absent ⇒ hand B absent (it derives its whole perimeter from hand A)', async () => {
    const r = fakeRoster()
    const res = await armButlerCoder({
      hands: { status: 'off' } as ButlerHands,
      hub: r.hub,
      space: r.space,
      grants: r.grantsDep,
      logger: makeHands().host.logger,
    })
    expect(res.armed).toBe(false)
    expect(r.registered).toHaveLength(0)
  })

  it('no coder block ⇒ not armed, zero side effects (opt-in)', async () => {
    const fx = makeHands()
    const { res, r } = await arm(fx)
    expect(res.armed).toBe(false)
    expect(r.registered).toHaveLength(0)
    expect(r.rows).toHaveLength(0)
    expect(existsSync(fx.memberRoot)).toBe(false)
  })

  it('a member outside allowRoles gets no hand B — and no directory either', async () => {
    const fx = makeHands({ coder: coderCfg(), role: 'member' })
    const { res, r } = await arm(fx)
    expect(res.armed).toBe(false)
    expect(res.reason).toContain('allowRoles')
    // 顺序承重:不够格的人连工作区都不该被建出来(手 A 的 classify-before-
    // ensureWorkspace 同一条)。
    expect(existsSync(fx.memberRoot)).toBe(false)
    expect(r.registered).toHaveLength(0)
    expect(r.grants).toHaveLength(0)
    expect(fx.logs.some((l) => l.level === 'warn' && l.msg.includes('coder user not allowed'))).toBe(true)
  })

  it('refuses to squat on an agent id that is somebody else’s row', async () => {
    const foreign: AgentRecord = {
      id: HANDS_CODER_DEFAULT_ID,
      allowedCapabilities: ['chat'],
      managed: { kind: 'llm', provider: 'mock', system: 'hi' },
      createdAt: new Date().toISOString(),
    } as unknown as AgentRecord
    const fx = makeHands({ coder: coderCfg() })
    const { res, r } = await arm(fx, fakeRoster([foreign]))
    expect(res.armed).toBe(false)
    expect(res.reason).toContain(HANDS_CODER_DEFAULT_ID)
    expect(r.registered).toHaveLength(0)
    expect(r.rows[0]).toMatchObject({ allowedCapabilities: ['chat'] }) // 一个字节没动
  })

  it('re-arming over OUR OWN row is fine (restart is not a collision)', async () => {
    const fx = makeHands({ coder: coderCfg() })
    const r = fakeRoster()
    await arm(fx, r)
    const again = await arm(fx, r)
    expect(again.res.armed).toBe(true)
    expect(r.rows).toHaveLength(1)
  })

  it('arms: participant + agents.json row + owner grant (what escalate’s fail-closed check reads)', async () => {
    const fx = makeHands({ coder: coderCfg({ agentId: 'mycoder', label: '写代码的' }) })
    const { res, r } = await arm(fx)
    expect(res).toMatchObject({ armed: true, agentId: 'mycoder' })
    expect(r.registered.map((p) => p.id)).toEqual(['mycoder'])
    expect(r.registered[0]!.capabilities).toEqual([HANDS_CODER_CAPABILITY])
    expect(r.rows[0]).toMatchObject({ id: 'mycoder', displayName: '写代码的', allowedCapabilities: [HANDS_CODER_CAPABILITY] })
    // 名册行**没有** managed:它不是本地 LLM agent,pool 不该去 spawn 它。
    expect(r.rows[0]!.managed).toBeUndefined()
    expect(r.grants[0]).toMatchObject({ resourceKind: 'agent', resourceId: 'mycoder', perm: 'owner' })
  })

  it('the advertised capability is the deliberately specific one (advertising = authorizing)', () => {
    expect(HANDS_CODER_CAPABILITY).toBe('hands.coder')
  })

  it('re-binding to another member drops the previous OWNER row (upsert alone would not)', async () => {
    // grant 的主键含 principal ⇒ 只 upsert 新的,前任仍是 owner,而 owner 正是
    // `escalate_to_expert` 的 fail-closed 检查读的那张表 ⇒ 前任还能驱动这只手。
    const fx = makeHands({ coder: coderCfg({ agentId: 'mycoder' }) })
    const r = fakeRoster([], {
      grants: [
        { principal: { kind: 'user', id: 'u0-previous' }, perm: 'owner' },
        // 别人在 agent 面板上刻意给的读权限——不是这条配置线的事,不许连坐。
        { principal: { kind: 'user', id: 'u9-reader' }, perm: 'viewer' },
      ],
    })
    const { res } = await arm(fx, r)
    expect(res.armed).toBe(true)
    const owners = r.grantRows.filter((g) => g.perm === 'owner').map((g) => g.principal.id)
    expect(owners).toEqual(['u1'])
    expect(r.grantRows.some((g) => g.principal.id === 'u9-reader' && g.perm === 'viewer')).toBe(true)
    expect(fx.logs.some((l) => l.level === 'warn' && l.msg.includes('stale coder owner grant'))).toBe(true)
  })

  it('cannot read the old grant rows ⇒ hand B stays OFF (fail-closed)', async () => {
    // 读不到旧行 = 不知道清没清干净。一台「可能还有第二个 owner」的手 B,比没有
    // 手 B 更坏——与上面五道闸同姿态。
    const fx = makeHands({ coder: coderCfg() })
    const r = fakeRoster([], { listThrows: true })
    const { res } = await arm(fx, r)
    expect(res.armed).toBe(false)
    expect(res.reason).toContain('读不出来')
    expect(r.registered).toHaveLength(0)
    expect(r.grants).toHaveLength(0)
  })
})

// ─── ③ 围墙 ──────────────────────────────────────────────────────────────────

describe('HANDS-M2b perimeter', () => {
  it('streams the CLI output into the transcript (observe seam)', async () => {
    const fx = makeHands({ coder: coderCfg({ args: ['-e', 'process.stdout.write("hello-from-coder")'] }) })
    const { r } = await arm(fx)
    await r.registered[0]!.onTask!(makeTask({ prompt: 'go' }, 'task-77'))
    const seen = r.chunks.find((c) => JSON.stringify((c as { chunk?: unknown }).chunk).includes('hello-from-coder'))
    expect(seen).toMatchObject({ taskId: 'task-77', agentId: HANDS_CODER_DEFAULT_ID })
  })

  it('passEnv can only ADD — it never overrides what the jail itself states', async () => {
    process.env.CODER_TEST_PASS = 'passed-through'
    process.env.HOME_HIJACK_ATTEMPT = '/etc'
    const fx = makeHands({
      coder: coderCfg({
        // HOME 是监狱定的;透传表里点它的名也盖不掉(展开顺序承重)。
        passEnv: ['CODER_TEST_PASS', 'HOME'],
        args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      }),
    })
    const { r } = await arm(fx)
    const out = await r.registered[0]!.onTask!(makeTask({ prompt: 'go' }))
    delete process.env.CODER_TEST_PASS
    delete process.env.HOME_HIJACK_ATTEMPT
    const env = JSON.parse((out as { output: { text: string } }).output.text) as Record<string, string>
    expect(env.CODER_TEST_PASS).toBe('passed-through')
    expect(env.HOME).toBe(realpathSync.native(join(fx.memberRoot, 'home')))
    expect(env.HOME).not.toBe(process.env.HOME)
    expect(env.HOME_HIJACK_ATTEMPT).toBeUndefined() // envMode replace:什么都不继承
    expect(fx.logs.some((l) => l.level === 'warn' && l.msg.includes('passEnv'))).toBe(true)
  })

  it('names credential-shaped passEnv entries out loud (a path, not a leak)', async () => {
    // 手 B 必须拿到自己的模型 key 才能开工 ⇒ passEnv **不可避免**是一条凭证通道。
    // 不拦,但也不许悄悄发生:名字进日志,值永远不进。
    process.env.CODER_TEST_API_KEY = 'sk-should-never-be-logged'
    const fx = makeHands({ coder: coderCfg({ passEnv: ['CODER_TEST_API_KEY', 'LANG'] }) })
    await arm(fx)
    delete process.env.CODER_TEST_API_KEY
    const row = fx.logs.find((l) => l.level === 'warn' && l.msg.includes('credential-shaped'))
    expect(row).toBeDefined()
    expect((row!.ctx as { names: string[] }).names).toEqual(['CODER_TEST_API_KEY'])
    // 值一个字节都不许出现在任何一行里。
    expect(JSON.stringify(fx.logs)).not.toContain('sk-should-never-be-logged')
  })

  it('the jail spec is computed per spawn, not frozen at arm time', async () => {
    // 长活的参与者 + 定死的围墙 = 悄悄变弱的围墙:装好之后才出现的东西(这里是
    // 一个新的套接字文件)必须在**下一次** spawn 时就被藏起来。
    const fx = makeHands({ coder: coderCfg() })
    const { r } = await arm(fx)
    const p = r.registered[0] as unknown as { fsJail: () => { hardening?: { hiddenPaths?: string[] } } }
    const before = p.fsJail().hardening?.hiddenPaths ?? []
    const late = join(fx.base, 'late-socket-dir')
    mkdirSync(late, { recursive: true })
    fx.host.config.hidden = [late]
    fx.host.shape = jailShapeFor(fx.space, fx.host.config, fx.host.probe)
    const after = p.fsJail().hardening?.hiddenPaths ?? []
    expect(before).not.toContain(late)
    expect(after).toContain(late)
  })

  it('authorization is re-asked per spawn — losing allowRoles stops hand B too', async () => {
    // arm 时问一次是不够的:participant 一旦注册就常驻,而 `allowRoles` 是会变的。
    // 手 A 会在**每次调用**重问(classify + execute 各一次),手 B 也必须——否则一个
    // 被降权的成员失去手 A、却留着一台能改同一个工作区的手 B。
    // 检查挂在围墙这条 thunk 上而不是另开一处:这条路本来就必须走,它抛错 = 这一
    // 轮不 spawn(闸放在忘不掉的地方)。
    const fx = makeHands({ coder: coderCfg() })
    const { r } = await arm(fx)
    const p = r.registered[0] as unknown as { fsJail: () => unknown }
    expect(() => p.fsJail()).not.toThrow()
    fx.host.allowed = () => false
    expect(() => p.fsJail()).toThrow(/allowRoles/)
  })
})

// ─── ④ 里程碑验收门:两只手一个工作区 ─────────────────────────────────────────

describe.skipIf(!HAS_JAIL)(`HANDS-M2b shared workspace (${jailCap.kind})`, () => {
  it('阿同写需求 → 手 B 改文件 → 阿同 hands_run 跑测试', async () => {
    // 手 B = 一个假的 coding CLI:读需求,在 cwd(共享工作区)里写出实现和测试。
    const script = [
      "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{",
      "const fs=require('fs');",
      "fs.writeFileSync('impl.js','module.exports=(a,b)=>a+b');",
      "fs.writeFileSync('test.js',\"const s=require('./impl');if(s(2,3)!==5)throw new Error('bad');console.log('TESTS PASS')\");",
      "process.stdout.write('wrote impl.js + test.js for: '+d)})",
    ].join('')
    const fx = makeHands({ coder: coderCfg({ args: ['-e', script], promptVia: 'stdin' }) })
    const { r } = await arm(fx)

    const handed = await r.registered[0]!.onTask!(makeTask({ prompt: '写一个加法函数并配测试' }))
    expect(handed.kind).toBe('ok')
    expect((handed as { output: { text: string } }).output.text).toContain('wrote impl.js')
    // 文件真落在**手 A 的**工作区里 —— 这就是「共用工作区」的全部含义。
    expect(readdirSync(fx.workspace).sort()).toEqual(expect.arrayContaining(['impl.js', 'test.js']))

    // 阿同回来跑测试(手 A 的 hands_run,tier 1 免审批)。
    const ts = buildButlerHandsToolset({ userId: 'u1', hands: fx.host })
    const verdict = await ts.classify('hands_run', { argv: [NODE, 'test.js'] })
    expect(verdict.decision).toBe('allow')
    const out = await ts.callTool('hands_run', { argv: [NODE, 'test.js'] })
    const text = out.content.map((c) => c.text).join('')
    expect(out.isError, text).not.toBe(true)
    expect(text).toContain('TESTS PASS')
  })

  it('hand B is confined by hand A’s walls — the hub’s own credentials stay unreadable', async () => {
    const fx = makeHands({
      coder: coderCfg({
        args: [
          '-e',
          "const fs=require('fs');try{process.stdout.write('READ:'+fs.readFileSync(process.argv[1],'utf8'))}catch(e){process.stdout.write('DENIED')}",
          '{prompt}',
        ],
        promptVia: 'arg',
      }),
    })
    const { r } = await arm(fx)
    const secret = join(fx.fakeHome, '.ssh', 'id_test')
    const out = await r.registered[0]!.onTask!(makeTask({ prompt: secret }))
    const text = (out as { output?: { text?: string } }).output?.text ?? ''
    expect(text).not.toContain(HOME_SECRET)
    expect(text).toContain('DENIED')
  })
})
