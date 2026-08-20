/**
 * atong-hands — HANDS track 的 capstone。
 *
 * 这个 track 给阿同装了一双手,而整条线上唯一值得反复证明的事情不是「它能跑
 * 命令」,是**它跑命令的时候够不到什么**。威胁模型只有一句话:一次成功的
 * prompt injection 就是一次远程代码执行,所以每一条能力都必须能指着一道结构性
 * 的墙说「这里过不去」——而不是指着一段 prompt 说「我们叮嘱过它别这么做」。
 *
 * 四幕,每幕一个断言簇,全部跑真件:
 *
 *   幕 0(布景) 监狱缺席 ⇒ 手**结构性不装**。fail-closed 不是降级路径,是这套
 *              设计的地板,所以它是被断言的第一件事,不是「没有监狱时的兜底」。
 *   幕 1      被注入的阿同想改 hub 自己的配置。**两层各拒一次**:工具面走
 *              四档策略当场 refuse;shell 那条策略刻意放行的路(tier 1)撞在
 *              监狱上 —— agents.json 逐字节不变。
 *   幕 2      联网命令 = tier 2:classify 判 approve → 批准前**零执行** →
 *              批准后在监狱里真跑完。
 *   幕 3      工作区是它的自留地:直写脚本(tier 1,不 park)、监狱里真跑出
 *              TESTS PASS;同一座监狱读不到 `<space>` 里那把 key。
 *   幕 4      手机上换 key:真 `parseImCommand` → 真 `ImCredentialsService` →
 *              真 `@gotong/identity` 金库 → **生产那一份渲染器**。断言秘密只
 *              到金库,而且连「顺序打反了」那次失手也不回显一个字节。
 *
 * 幕 4 用的是 host 导出的 `renderSetKeyOutcome` 而不是在这里手抄一份看起来
 * 一样的话 —— M3b 的教训:一条缝,如果它的测试全都自己手搭对面那一半,那它
 * 就是没测过。
 *
 * 零网络、零 API key、零 LLM。跑:`pnpm demo:atong-hands`(exit 0 即通过)。
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectFsJail, type AgentRecord, type Logger } from '@gotong/core'
import {
  armButlerHands,
  buildButlerHandsToolset,
  jailShapeFor,
  type ButlerHandsHost,
  type HandsConfig,
  type JailShapeProbe,
} from '@gotong/host/butler-hands'
import {
  DELETE_YOUR_MESSAGE,
  ImCredentialsService,
  SETKEY_USAGE,
  renderSetKeyOutcome,
  type ImCredentialsIdentity,
  type ImCredentialsSpace,
} from '@gotong/host/im-credentials'
import { loadOrCreateMasterKey, openIdentityStore } from '@gotong/identity'
import { parseImCommand } from '@gotong/im-adapter'
import { HANDS_LIMITS } from '@gotong/personal-butler'

// ── 小工具 ───────────────────────────────────────────────────────────────────

let passed = 0
function assert(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`  ✗ ${label}`)
    process.exit(1)
  }
  passed += 1
  console.log(`  ✓ ${label}`)
}

/** 静音 logger:demo 只打自己的叙事,hub 的结构化日志收进数组备查。 */
function quietLogger(): { logger: Logger; rows: Array<{ level: string; msg: string }> } {
  const rows: Array<{ level: string; msg: string }> = []
  const mk = (level: string) => (msg: string) => {
    rows.push({ level, msg })
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

/** 递归收集 root 下每一个文件的字节(用来证明某个串一处也没落盘)。 */
function allBytes(root: string): string {
  const acc: string[] = []
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile()) acc.push(readFileSync(p, 'latin1'))
    }
  }
  walk(root)
  return acc.join(' ')
}

/** 工具结果里的正文。`content` 在契约里是 `unknown[]`(刻意不让 llm 层认识块类型)。 */
function textOf(r: { content: ReadonlyArray<unknown> }): string {
  return (r.content as ReadonlyArray<{ text?: string }>).map((c) => c.text ?? '').join('')
}

/** 像阿同那样过闸:先 classify,只有 allow 才真调。 */
async function gated(
  ts: ReturnType<typeof buildButlerHandsToolset>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ decision: string; text: string; isError: boolean }> {
  const v = await ts.classify(name, args)
  if (v.decision !== 'allow') return { decision: v.decision, text: '', isError: true }
  const r = await ts.callTool(name, args)
  return { decision: v.decision, text: textOf(r), isError: r.isError === true }
}

/** 人点了头之后的那一步——resume 路径,不再过闸。 */
async function approved(
  ts: ReturnType<typeof buildButlerHandsToolset>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const r = await ts.callTool(name, args)
  return { text: textOf(r), isError: r.isError === true }
}

// ── 布景 ─────────────────────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'gotong-atong-hands-'))
const space = join(root, 'space')
mkdirSync(space, { recursive: true })

/** `<space>` 里那把真 key —— 幕 1/幕 3 要证明监狱里够不到它。 */
const SPACE_SECRET = 'MIMO_KEY_THAT_MUST_STAY_IN_THE_SPACE_9f2c'
const AGENTS_JSON = `${JSON.stringify({ agents: [] })}\n`
writeFileSync(join(space, 'gotong.env'), `MIMO_API_KEY=${SPACE_SECRET}\n`)
writeFileSync(join(space, 'agents.json'), AGENTS_JSON)

const jailCap = await detectFsJail()
const HAS_JAIL = jailCap.kind !== 'none'
const USER = 'u-owner'

console.log('━━ atong-hands — 一双手,和它够不到的每一样东西 ━━\n')
console.log(`布景:一个真 <space>(里面有 agents.json 和一把 key),监狱=${jailCap.kind}`)
console.log(`  家在 ${space}\n`)

// ── 幕 0:监狱缺席 ⇒ 手结构性不装 ─────────────────────────────────────────────

console.log('━━━ 幕 0 · fail-closed:没有监狱就没有手 ━━━')
{
  const { logger } = quietLogger()
  const cfg: HandsConfig = {
    maxRunSec: HANDS_LIMITS.maxRunSec,
    maxOutputBytes: HANDS_LIMITS.maxOutputBytes,
    maxWorkspaceBytes: HANDS_LIMITS.maxWorkspaceBytes,
    allowRoles: ['owner', 'admin'],
  }
  // hands.json 明明开着、角色也查得到 —— 只差一座监狱。
  const noJail = await armButlerHands({
    spaceRoot: space,
    logger,
    membershipRole: () => 'owner',
    config: cfg,
    detect: async () => ({ kind: 'none', reason: '本机没有 bubblewrap/sandbox-exec(演示用的假探针)' }),
  })
  assert(noJail.host === undefined, '监狱缺席 ⇒ 根本没有 host,五个工具一件也造不出来')
  assert(noJail.status.armed === false, 'my_status 那一行如实说「没装」')
  assert(
    noJail.status.armed === false && noJail.status.reason.includes('监狱缺席'),
    '  而且说清为什么,不是一句「未知错误」',
  )

  // 归属查不到时同样不装:手只开给 owner/admin,查不出角色就答不出「够不够格」。
  const noIdentity = await armButlerHands({ spaceRoot: space, logger, config: cfg })
  assert(noIdentity.host === undefined, '查不到成员角色 ⇒ 同样不装(不是「先装上再每次拒」)')
}
console.log('  → 「开了开关」不等于「有了手」。地板在这里,不在 prompt 里。\n')

// ── 建一双真手(本机有监狱才有下面三幕的执行半) ───────────────────────────────

const { logger: handsLogger } = quietLogger()
const handsCfg: HandsConfig = {
  maxRunSec: HANDS_LIMITS.maxRunSec,
  maxOutputBytes: HANDS_LIMITS.maxOutputBytes,
  maxWorkspaceBytes: HANDS_LIMITS.maxWorkspaceBytes,
  allowRoles: ['owner', 'admin'],
}
const fakeHome = join(root, 'fake-home')
mkdirSync(fakeHome, { recursive: true })
// 一个探针同时喂 boot 时算的围墙形状与每次 spawn 前的存在性复查 —— 用两份
// 不同的文件系统视图算出来的形状,本身就是一句谎。
const probe: JailShapeProbe = {
  homedir: () => fakeHome,
  kind: (p) => {
    try {
      return statSync(p).isDirectory() ? 'dir' : 'file'
    } catch {
      return null
    }
  },
  execPath: process.execPath,
  pathEnv: process.env.PATH,
}
const hands: ButlerHandsHost = {
  spaceRoot: space,
  handsRoot: join(space, 'butler', 'hands'),
  kind: (HAS_JAIL ? jailCap.kind : 'sandbox-exec') as ButlerHandsHost['kind'],
  config: handsCfg,
  shape: jailShapeFor(space, handsCfg, probe),
  probe,
  allowed: (uid) => uid === USER,
  logger: handsLogger,
}
const ts = buildButlerHandsToolset({ userId: USER, hands })
const workspace = join(hands.handsRoot, 'user', USER, 'workspace')

if (!HAS_JAIL) {
  console.log('注:本机没有可用的 OS 监狱,下面三幕里「真 spawn」那一半按设计跳过')
  console.log('    (跳过的是执行,不是断言:幕 0 已经证过没有监狱时手根本不存在)。\n')
}

// ── 幕 1:被注入的阿同想改 hub 自己的配置 ─────────────────────────────────────

console.log('━━━ 幕 1 · 注入写配置:策略层拒一次,监狱层再拒一次 ━━━')
{
  // 层一:工具面。四档策略里 `<space>` 是第 3 档(凭证与自身基础设施),写它
  // 结构性不在参数空间内 —— 工作区外的路径当场 refuse,连 execute 都到不了。
  const escape = await gated(ts, 'hands_write', {
    path: '../../../agents.json',
    content: '{"agents":[{"id":"pwned"}]}',
  })
  assert(escape.decision === 'refuse', '层一:写工作区外的路径 → 策略层当场 refuse')
  assert(escape.text === '', '  拒了就是拒了,execute 一步没跑')

  // 层二:同一个念头换条路走。解释器/shell **刻意不 park**(argv 里塞得下任何
  // 东西,逐条分级只会给出安全错觉),它靠的是监狱兜底 —— 所以这条命令在策略
  // 层是 tier 1 allow,真正拦住它的是墙。
  const injected = { argv: ['sh', '-c', `echo pwned > ${join(space, 'agents.json')}`] }
  const shell = await ts.classify('hands_run', injected)
  assert(shell.decision === 'allow', '层二:同一个念头走 shell —— 策略层按设计放行(tier 1)')
  if (HAS_JAIL) {
    // 控制组先跑:同一条 shell 重定向写到**工作区里**是成功的。没有这一条,
    // 下面那句「写不进去」可能只是在说 sh 根本没跑起来 —— 一条通过了的控制
    // 断言,如果它守的门当时是关着的,它什么也没证明。
    const control = await approved(ts, 'hands_run', { argv: ['sh', '-c', 'echo ok > act1-control.txt'] })
    assert(!control.isError, '  控制组:同一条重定向写进工作区 → 成功(证明这条路本身通)')
    const ran = await approved(ts, 'hands_run', injected)
    assert(ran.isError || !ran.text.includes('退出码 0'), '  同一条重定向写 <space> → 失败')
  }
  assert(
    readFileSync(join(space, 'agents.json'), 'utf8') === AGENTS_JSON,
    '  agents.json 逐字节不变 —— 拦住它的是墙,不是叮嘱',
  )
}
console.log('  → 一层挡不住的,另一层挡得住;两层的理由不同,所以不会一起失效。\n')

// ── 幕 2:联网命令 = tier 2,先问人 ────────────────────────────────────────────

console.log('━━━ 幕 2 · 联网命令:park → 人点头 → 才跑 ━━━')
{
  const call = { argv: ['sh', '-c', 'echo fetched > act2-ran.txt'], net: true }
  const v = await ts.classify('hands_run', call)
  assert(v.decision === 'approve', 'net:true ⇒ tier 2:classify 判 approve,不是 allow')
  assert(
    'reason' in v && typeof v.reason === 'string' && v.reason.length > 0,
    '  审批卡带得上理由(人要读的是「为什么问我」)',
  )
  // 关键的一条:判决出来了,但**什么都还没发生**。
  assert(
    !readdirSync(workspace).includes('act2-ran.txt'),
    '  批准之前:盘上零痕迹(park 不是「先跑了再说」)',
  )

  if (HAS_JAIL) {
    const yes = await approved(ts, 'hands_run', call)
    assert(!yes.isError, '人点头之后:在监狱里真跑完')
    assert(readFileSync(join(workspace, 'act2-ran.txt'), 'utf8').trim() === 'fetched', '  产出落在工作区里')
  }
  // 诚实边界,写在断言旁边:分档读的是**声明的 net 与命令名**,不是这条命令
  // 到底连没连网。推错了的代价是一次多余的审批(或一次离线失败后重来),不是
  // 一次没被问过的出网。
  console.log('  注:tier 2 由「声明了 net / 命令名像联网」推出,不是真去嗅探流量。')
}
console.log('  → 会碰外面世界的那一类,每一次都先问人。\n')

// ── 幕 3:工作区是自留地,但墙还在 ────────────────────────────────────────────

console.log('━━━ 幕 3 · 工作区直写 + 监狱里跑脚本 ━━━')
{
  const script = [
    'const ok = (c, m) => { if (!c) { console.error("FAIL " + m); process.exit(1) } }',
    'ok(1 + 1 === 2, "arithmetic")',
    'console.log("TESTS PASS")',
  ].join('\n')
  const w = await gated(ts, 'hands_write', { path: 'test.js', content: script })
  assert(w.decision === 'allow', '写自己的工作区 = tier 1:不 park,直接写')
  assert(
    !w.isError && readFileSync(join(workspace, 'test.js'), 'utf8') === script,
    '  文件真落在工作区里',
  )

  if (HAS_JAIL) {
    const run = await gated(ts, 'hands_run', { argv: ['node', 'test.js'] })
    assert(run.decision === 'allow', '跑本地脚本 = tier 1(不联网,不 park)')
    assert(run.text.includes('TESTS PASS'), '  监狱里真跑出 TESTS PASS')

    // 同一座监狱,同一个成员 —— 自留地随便读,`<space>` 一个字节读不到。
    // 同样先跑控制组:`cat` 在这座监狱里确实能读出东西。
    const canRead = await approved(ts, 'hands_run', { argv: ['sh', '-c', 'cat test.js'] })
    assert(canRead.text.includes('TESTS PASS'), '控制组:同一个 cat 读工作区里的文件 → 读得出来')
    const peek = await approved(ts, 'hands_run', {
      argv: ['sh', '-c', `cat ${join(space, 'gotong.env')}`],
    })
    assert(!peek.text.includes(SPACE_SECRET), '同一个 cat 读 <space>/gotong.env → 读不到那把 key')
  }
}
console.log('  → 「有手」和「什么都能碰」是两件事。\n')

// ── 幕 4:手机上换 key ────────────────────────────────────────────────────────

console.log('━━━ 幕 4 · /setkey:秘密只到金库,回复里一个字节都没有 ━━━')
{
  const SECRET = 'sk-ant-hands-capstone-0123456789abcdef'
  const masterKey = loadOrCreateMasterKey(join(space, 'identity-master.key'))
  const store = openIdentityStore({ dbPath: join(space, 'identity.sqlite'), masterKey })

  const agents: AgentRecord[] = [
    {
      id: 'assistant',
      allowedCapabilities: ['chat'],
      createdAt: '2026-01-01T00:00:00.000Z',
      managed: { kind: 'llm', provider: 'anthropic', model: 'm' },
    } as unknown as AgentRecord,
  ]
  // 金库真收:per-agent 那条路走 `space.setAgentApiKey`,这里把它接到真
  // `createVaultEntry` 上,好让「秘密落进去了」是一件盘上可查的事。
  const vaultIds: string[] = []
  const credSpace: ImCredentialsSpace = {
    agents: async () => agents,
    listAgentApiKeys: async () => ({}),
    listProviderApiKeys: async () => ({}),
    setAgentApiKey: async (agentId, plaintext) => {
      const row = store.createVaultEntry({
        kind: 'llm_provider',
        ownerKind: 'org',
        ownerId: null,
        secret: plaintext,
        label: `agent:${agentId}`,
      })
      vaultIds.push(row.id)
    },
  }
  const audits: unknown[] = []
  const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = []
  const identity: ImCredentialsIdentity = {
    createVaultEntry: (input) => store.createVaultEntry(input),
    listVaultEntries: (q) => store.listVaultEntries(q),
    writeAuditLog: (input) => {
      audits.push(input)
      return undefined
    },
  }
  const svc = new ImCredentialsService({
    allowed: (uid) => uid === USER,
    space: credSpace,
    identity,
    log: {
      info: (msg, meta) => logs.push({ msg, ...(meta ? { meta } : {}) }),
      warn: (msg, meta) => logs.push({ msg, ...(meta ? { meta } : {}) }),
    },
  })

  // ① 解析器认领这个动词的**每一种**形状 —— 认不出就走 help,永远不落回自由
  //    文本(那条路会把原文记进会话窗、transcript 和长期记忆)。
  const parsed = parseImCommand(`/setkey assistant ${SECRET}`)
  assert(parsed.kind === 'setkey', '真解析器认出 /setkey(不落自由文本)')
  assert(
    parsed.kind === 'setkey' && parsed.mode === 'paste' && parsed.secret === SECRET,
    '  秘密作为一个字段被交出去,而不是留在一句话里',
  )

  // ② 真服务 → 真金库。
  const out = await svc.setKey({ userId: USER, target: 'assistant', secret: SECRET, via: 'im:lark' })
  assert(out.ok, '存进去了')
  assert(
    vaultIds.length === 1 && store.readVaultSecret(vaultIds[0]!) === SECRET,
    '  金库里解出来的就是那把 key(真加密,不是明文搬运)',
  )
  store.close()

  // ③ 盘上扫一遍:明文一处也没有 —— 但金库刚刚才解出来过。
  assert(!allBytes(space).includes(SECRET), '整个 <space> 逐字节扫:明文一处也不在(金库是密文)')

  // ④ 生产那一份渲染器 —— 回复里零回显。
  const reply = renderSetKeyOutcome(out, true)
  assert(!reply.includes(SECRET), '回复里没有秘密')
  assert(reply.includes('assistant'), '  但说得清改的是哪一个(串取自 hub 自己的记录)')
  assert(reply.includes(DELETE_YOUR_MESSAGE), '  每一条回复都带「请删掉你那条消息」')
  assert(reply.includes('/setkey link'), '  并且指出另一条路:key 可以根本不进聊天窗')

  // ⑤ 顺序打反 —— 着急的人最常犯的那一次。target 就是 key 本身,所以任何
  //    「不认识目标『…』」的体贴回显都会把活钥匙印进聊天记录。
  const slip = await svc.setKey({ userId: USER, target: SECRET, secret: 'assistant', via: 'im:lark' })
  assert(!slip.ok && slip.code === 'unknown_target', '顺序打反 → 不认识这个目标')
  const slipReply = renderSetKeyOutcome(slip, true)
  assert(!slipReply.includes(SECRET), '  失手那次的回复里,同样一个字节都不回显')
  assert(slipReply.includes('先目标后 key'), '  它只讲规则,不重复你打的字')

  // ⑥ 日志与审计同罪。
  assert(!JSON.stringify(logs).includes(SECRET), '日志里没有秘密')
  assert(
    audits.length > 0 && !JSON.stringify(audits).includes(SECRET),
    '审计行里没有秘密(但确实记了这次改动)',
  )

  // ⑦ 两条路的代价,写在用法里让人自己选。
  assert(
    SETKEY_USAGE.includes('/setkey link') && SETKEY_USAGE.includes('留在聊天平台的记录里'),
    '/setkey 的用法把两条路的代价都摆出来,不替人选',
  )
}
console.log('  → 唯一一件「载荷本身就是秘密」的事,被桥层在进模型之前就截走了。\n')

// ── 收官 ─────────────────────────────────────────────────────────────────────

console.log('━━ 收官 ━━')
console.log(`  ${passed} 条断言全过,零网络 / 零 key / 零 LLM。`)
console.log('')
console.log('  这四幕合起来是一句话:阿同的每一分能力,都配了一堵指得出来的墙。')
console.log('   · 没有监狱 ⇒ 没有手(不是「有手但小心点」)')
console.log('   · 改 hub 自己的东西 ⇒ 策略层拒,绕过去 ⇒ 监狱拒')
console.log('   · 碰外面的世界 ⇒ 每一次都先问人')
console.log('   · 凭证 ⇒ 结构性只到金库,连失手那次都不回显')
if (!HAS_JAIL) {
  console.log('')
  console.log('  (本机无 OS 监狱,「真 spawn」那一半跳过了;在 Linux 装 bubblewrap')
  console.log('   或在 macOS 上跑,这几行会变成真的进程。)')
}

rmSync(root, { recursive: true, force: true })
