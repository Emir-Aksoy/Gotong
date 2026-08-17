/**
 * personal-butler-environment.ts — HANDS-M4. 「这台机器什么样、够不够用、有什么
 * 该改」的一张只读卡(benign)+ 一组方案提案。
 *
 * 成员(和阿同自己)今天问「这台服务器撑不撑得住 / 为什么语音条不出来 / 手怎么
 * 没装上」,答案散在四处:机器事实根本没人报过,工具链在不在只有用到那一刻才
 * 以失败的形式暴露,监狱结论躺在 boot 日志里,待生效的配置改动要开网页才看得
 * 见。这张卡把它们折成一次只读调用,再按 RES 的老形状(只读探测 → 人批准应用)
 * 给出提案。
 *
 * ── 五条承重判断 ────────────────────────────────────────────────────────────
 *
 * ① **探针零 LLM 且不 spawn**。工具链在不在,只看 PATH 上那个文件存不存在
 *    (`existsSync`),**绝不跑 `--version`** —— 与 resource-inventory 同一条纪律:
 *    一个能被注入的模型触发的进程,不该因为「想知道版本号」而存在。机器事实
 *    走 node:os 与 statfs,都是纯读。
 *
 * ② **监狱不重探,直接复用 boot 那次的结论**。`detectFsJail` 是**功能**探针
 *    (真 spawn 一次试着关进去),而「PATH 上有 bwrap」≠「这台机器上能用」
 *    ——Ubuntu 23.10+ 的非特权 userns 可能被 AppArmor 关掉,那正是威胁模型里
 *    如实写着的残余。所以别处可以用 PATH 查、这一行不行:它读 `ButlerHandsStatus`
 *    (boot 时定的 hub 级事实),自己一个字也不判。
 *
 * ③ **出网不主动探**。一个模型能触发的出站请求,本身就是一个新的出网面
 *    (WSE/LSA 一路守下来的边界)。所以这里读的是 CARE 已经从**真实流量**折出来
 *    的断供投影,并在卡上写明它是被动的——「没人报过错」不等于「探过是通的」。
 *
 * ④ **可应用 ≠ 新写入口**。`applicable:true` 的提案只指向 HANDS-M3c 那件
 *    `set_hub_config`(它自带 owner/admin 闸 + 每次 park + 白名单校验);判别联合
 *    让「不可应用」的那一支**结构性**带不上 apply 动作 —— 一条本来只该指路的
 *    建议,想混进一个能落盘的动作也没有字段可放。这也是它为什么不复用 RES 的
 *    `AdaptationProposal`:那个联合的 apply 路径写死在「agent 编辑 → agents.json」,
 *    环境类提案送进去只会拿到 400 `not_applicable`,那是在说谎。
 *
 * ⑤ **只收不敏感的事实**。绝对路径 / 主机名 / 用户名 / 任何 env 的**值**一律
 *    **不采集**(而不是采了再脱敏)——渲染器想泄露也拿不到。磁盘只报剩余字节,
 *    不报它是哪个分区。
 *
 * benign 且**不按角色门控**:读环境与 `hub_health` / `my_status` / `backup_status`
 * 同族(看是开的,动手才收窄)。它指向的 `set_hub_config` 自己带闸,不够格的人
 * 会被那道闸当面拒——那句拒绝比「一件工具凭空不存在」诚实。
 */

import * as nodeFs from 'node:fs'
import * as os from 'node:os'
import { delimiter, join } from 'node:path'

import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'

import type { ButlerConfigKnobView, ButlerConfigOps } from './personal-butler-config.js'
import type { ButlerHandsStatus } from './personal-butler-hands.js'
import { outageHeadline } from './personal-butler-hub-sense.js'

// ─── 采集面 ──────────────────────────────────────────────────────────────────

/** 机器事实。全是量级,没有一个字段能定位到这台机器是谁的。 */
export interface HubEnvMachine {
  cpus: number
  totalMemBytes: number
  freeMemBytes: number
  /** 空间所在分区剩余字节;探不动 = null(不是 0——0 是「真的满了」)。 */
  diskFreeBytes: number | null
  nodeVersion: string
  /** `linux/x64` 这种;刻意不含主机名。 */
  platform: string
}

/** 一件外部工具在不在。`found` 是唯一的探测结果,版本号刻意不取(见判断①)。 */
export interface HubEnvTool {
  command: string
  found: boolean
}

/** 体检面的最小切片:这张卡只读 `llmOutage` 一格(与 my_status 同款窄声明)。 */
export interface HubEnvHealthSlice {
  snapshot(): Promise<{ llmOutage?: { kind: string; since: number } | null }>
}

/** 探针原语。全部可注入 —— 默认实现见 `defaultHubEnvProbe`。 */
export interface HubEnvProbe {
  cpuCount(): number
  totalMem(): number
  freeMem(): number
  nodeVersion(): string
  platform(): string
  /** 空间所在分区剩余字节;探不动回 null。 */
  diskFree(): number | null
  /** PATH 上的目录列表(顺序无关,只判存在)。 */
  pathDirs(): readonly string[]
  exists(path: string): boolean
}

/** 真实探针。`spaceDir` 只用来 statfs,**永不进任何输出**。 */
export function defaultHubEnvProbe(spaceDir?: string): HubEnvProbe {
  return {
    cpuCount: () => os.cpus().length,
    totalMem: () => os.totalmem(),
    freeMem: () => os.freemem(),
    nodeVersion: () => process.version,
    platform: () => `${os.platform()}/${os.arch()}`,
    diskFree: () => {
      // statfsSync 是 Node 18.15+ 才有的;老运行时上诚实回 null 而不是崩。
      const fs = nodeFs as unknown as { statfsSync?: (p: string) => { bsize: number; bavail: number } }
      if (!spaceDir || typeof fs.statfsSync !== 'function') return null
      try {
        const st = fs.statfsSync(spaceDir)
        return st.bsize * st.bavail
      } catch {
        return null
      }
    },
    pathDirs: () => (process.env.PATH ?? '').split(delimiter).filter((d) => d.length > 0),
    exists: (p) => nodeFs.existsSync(p),
  }
}

/**
 * 要查的外部工具(封闭常量表)。`impact` 说的是**缺了会怎样**,`howTo` 说的是
 * 人该做什么;`propose` 决定缺了要不要出提案 —— docker 只是事实(hub 自己跑起来
 * 并不需要它),没必要因为它不在就催人装。
 */
const TOOL_PROBES: ReadonlyArray<{
  command: string
  impact: string
  howTo: string
  propose: boolean
}> = [
  {
    command: 'ffmpeg',
    impact: '语音条(出站 TTS)和语音消息转写(入站 ASR)两条腿都要它:没有它这两件会在用到的那一刻诚实失败,别的一切照常。',
    howTo: 'Linux:apt install ffmpeg;macOS:brew install ffmpeg。装好后重启 hub。',
    propose: true,
  },
  {
    command: 'git',
    impact: '记忆树快照(那道「后悔药」)靠它;没有它快照会静默跳过,记忆本身照常写。',
    howTo: 'Linux:apt install git;macOS:xcode-select --install。',
    propose: true,
  },
  {
    command: 'docker',
    impact: 'compose 那套一键部署要它;hub 自己跑起来不需要——没有它不影响任何已经在跑的东西。',
    howTo: '',
    propose: false,
  },
]

/** 一次采集的全部结果。每块独立可缺(null = 那块读不动/未接)。 */
export interface HubEnvironment {
  machine: HubEnvMachine | null
  tools: readonly HubEnvTool[] | null
  /** boot 时定的手/监狱事实;undefined = host 太老没接。 */
  hands: ButlerHandsStatus | undefined
  /** 旋钮投影(M3c 同源);null = 未接或读不动。 */
  knobs: readonly ButlerConfigKnobView[] | null
  /** 被动出网信号:'not_wired' 未接体检 / 'unknown' 读不动 / null 无断供 / 行。 */
  outage: 'not_wired' | 'unknown' | null | { kind: string; since: number }
}

export interface ButlerEnvironmentDeps {
  probe?: HubEnvProbe
  hands?: ButlerHandsStatus
  /** M3c 已经构造好的那份 ops,只借 `knobs()` —— 读写两半看的是同一个投影。 */
  config?: Pick<ButlerConfigOps, 'knobs'>
  health?: () => HubEnvHealthSlice | undefined
  now?: () => number
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }
}

/** 逐块 try/catch:一块读不动只让那一块是 null,绝不整卡失效(自检卡同纪律)。 */
export async function probeHubEnvironment(deps: ButlerEnvironmentDeps): Promise<HubEnvironment> {
  const probe = deps.probe ?? defaultHubEnvProbe()
  const warn = (part: string, err: unknown) =>
    deps.logger?.warn('butler environment: probe failed', { part, err })

  let machine: HubEnvMachine | null = null
  try {
    machine = {
      cpus: probe.cpuCount(),
      totalMemBytes: probe.totalMem(),
      freeMemBytes: probe.freeMem(),
      diskFreeBytes: probe.diskFree(),
      nodeVersion: probe.nodeVersion(),
      platform: probe.platform(),
    }
  } catch (err) {
    warn('machine', err)
  }

  let tools: readonly HubEnvTool[] | null = null
  try {
    const dirs = probe.pathDirs()
    tools = TOOL_PROBES.map((t) => ({
      command: t.command,
      found: dirs.some((dir) => probe.exists(join(dir, t.command))),
    }))
  } catch (err) {
    warn('tools', err)
  }

  let knobs: readonly ButlerConfigKnobView[] | null = null
  if (deps.config) {
    try {
      knobs = await deps.config.knobs()
    } catch (err) {
      warn('knobs', err)
    }
  }

  let outage: HubEnvironment['outage'] = 'not_wired'
  const health = deps.health?.()
  if (health) {
    try {
      const snap = await health.snapshot()
      outage = snap.llmOutage === undefined ? 'unknown' : snap.llmOutage
    } catch (err) {
      warn('health', err)
      outage = 'unknown'
    }
  }

  return { machine, tools, hands: deps.hands, knobs, outage }
}

// ─── 提案引擎(纯函数,零 LLM) ───────────────────────────────────────────────

const WEB_PORT_KEY = 'GOTONG_WEB_PORT'
const WS_PORT_KEY = 'GOTONG_WS_PORT'

/**
 * 一条提案。判别联合是承重的:`applicable:false` 那一支**没有 apply 字段**,
 * 一条只该指路的建议想夹带一个能落盘的动作,结构上没地方放(判断④)。
 */
export type HubEnvProposal =
  | {
      id: string
      title: string
      detail: string
      applicable: true
      /** 唯一的落盘出口 = HANDS-M3c 那件 governed 工具。 */
      apply: { tool: 'set_hub_config'; key: string; value: string }
    }
  | { id: string; title: string; detail: string; applicable: false; howTo: string }

const GIB = 1024 * 1024 * 1024
/** 内存下限:低于它就别再开后台维护(蒸馏/图书馆员/embedder)。 */
const LOW_MEM_BYTES = 2 * GIB
/** 磁盘下限:transcript / 审计 / 备份档都在这块盘上长。 */
const LOW_DISK_BYTES = 1 * GIB

/** 这个旋钮**下次重启**会用的值(文件里写了就是它,否则回落到当前生效/默认)。 */
function nextValueOf(k: ButlerConfigKnobView): string {
  return k.fileValue ?? k.envValue ?? k.default
}

/** 现在真正在用的值。 */
function liveValueOf(k: ButlerConfigKnobView): string {
  return k.envValue ?? k.default
}

function knobPortCollision(knobs: readonly ButlerConfigKnobView[]): HubEnvProposal | null {
  const web = knobs.find((k) => k.key === WEB_PORT_KEY)
  const ws = knobs.find((k) => k.key === WS_PORT_KEY)
  if (!web || !ws) return null
  const nextWeb = nextValueOf(web)
  const nextWs = nextValueOf(ws)
  if (nextWeb !== nextWs) return null
  const detail = `配置文件里网页端口和 agent WebSocket 端口都写成了 ${nextWeb},这台 hub 下次重启会起不来(现在跑着的还是旧值,所以你暂时没感觉)。`
  const revert = liveValueOf(ws)
  if (revert === nextWeb) {
    // 活着的值也一样(比如两边同时被改过)——我算不出一个确定不撞的值,
    // 就别假装能一键修:挑端口是人的决定。
    return {
      id: 'port-collision',
      title: '两个端口撞了,重启会起不来',
      detail,
      applicable: false,
      howTo: `给两者中的一个换一个没被占用的端口(1-65535),再重启。我这边算不出一个确定安全的值,得你定。`,
    }
  }
  return {
    id: 'port-collision',
    title: '两个端口撞了,重启会起不来',
    detail,
    applicable: true,
    apply: { tool: 'set_hub_config', key: WS_PORT_KEY, value: revert },
  }
}

function knobPendingRestart(knobs: readonly ButlerConfigKnobView[]): HubEnvProposal | null {
  const pending = knobs.filter((k) => k.fileValue !== null && k.fileValue !== liveValueOf(k))
  if (pending.length === 0) return null
  const list = pending.map((k) => `${k.key}(现在 ${liveValueOf(k)} → 重启后 ${k.fileValue})`).join('、')
  return {
    id: 'pending-restart',
    title: '有配置改动写进去了,但还没生效',
    detail: `${list}。`,
    applicable: false,
    // 阿同重启不了自己:那是 systemd / compose 的事,也刻意不给它这把手。
    howTo: '重启 hub 才会生效(服务器上 systemctl restart gotong,或 compose 重起)。我自己重启不了 hub。',
  }
}

/** 纯函数:采集结果 → 提案清单。同一份输入永远同一份输出(可直测)。 */
export function proposeEnvironmentFixes(env: HubEnvironment): HubEnvProposal[] {
  const out: HubEnvProposal[] = []

  if (env.knobs) {
    const collision = knobPortCollision(env.knobs)
    if (collision) out.push(collision)
    const pending = knobPendingRestart(env.knobs)
    if (pending) out.push(pending)
  }

  if (env.hands && !env.hands.armed) {
    out.push({
      id: 'no-hands',
      title: '我在这台机器上没有手',
      detail: `${env.hands.reason}`,
      applicable: false,
      // 「装监狱」结构性不可能由阿同自己做:hub 是非特权跑的,apt/systemctl
      // 够不到——这是威胁模型里当特性写着的那条,不是缺陷。
      howTo: '上面那行就是原因。装监狱要包管理器权限,hub 是非特权跑的,我自己装不了——把这行给管理员看。',
    })
  }

  if (env.tools) {
    for (const spec of TOOL_PROBES) {
      if (!spec.propose) continue
      const hit = env.tools.find((t) => t.command === spec.command)
      if (!hit || hit.found) continue
      out.push({
        id: `no-${spec.command}`,
        title: `没装 ${spec.command}`,
        detail: spec.impact,
        applicable: false,
        howTo: spec.howTo,
      })
    }
  }

  if (env.machine) {
    if (env.machine.totalMemBytes > 0 && env.machine.totalMemBytes < LOW_MEM_BYTES) {
      out.push({
        id: 'low-memory',
        title: '内存偏小',
        detail: `总共 ${fmtBytes(env.machine.totalMemBytes)}。后台维护(记忆蒸馏 / 图书馆员 / 向量化)都在这台机器上跑,内存紧的时候它们最先出事。`,
        applicable: false,
        // 这几个开关不在「可改的设置项」白名单里(那里只有四个),所以只能指路。
        howTo: '这几个开关不在我能改的四个设置项里,要在服务器的 gotong.env 里关(记忆蒸馏 / 图书馆员 / embedder),再重启。',
      })
    }
    const disk = env.machine.diskFreeBytes
    if (disk !== null && disk < LOW_DISK_BYTES) {
      out.push({
        id: 'low-disk',
        title: '磁盘快满了',
        detail: `空间所在的盘只剩 ${fmtBytes(disk)}。transcript、审计、备份档都往这块盘上写,满了会先坏在写不进去。`,
        applicable: false,
        howTo: '清一清 <space>/backups 里的老档案,或把留存期(retention)调短。删东西这件事我不做。',
      })
    }
  }

  if (env.outage && typeof env.outage === 'object' && env.outage.kind === 'network') {
    out.push({
      id: 'no-egress',
      title: '出网现在是断的',
      detail: '最近的模型调用是网络类失败——这台机器多半出不去网。网页搜索、推送、模型调用都会跟着退化。',
      applicable: false,
      howTo: '查这台服务器的出网(防火墙 / 代理 / DNS)。这一条我只能看着,改不了。',
    })
  }

  return out
}

// ─── 渲染 ────────────────────────────────────────────────────────────────────

const NOT_WIRED = '(未接)'
const READ_FAILED = '(读取失败)'

function fmtBytes(n: number): string {
  if (n >= GIB) return `${(n / GIB).toFixed(1)} GB`
  const mib = 1024 * 1024
  if (n >= mib) return `${Math.round(n / mib)} MB`
  return `${n} B`
}

function machineLines(m: HubEnvMachine | null): string[] {
  if (!m) return [`- 机器:${READ_FAILED}`]
  const disk = m.diskFreeBytes === null ? '未知' : `剩 ${fmtBytes(m.diskFreeBytes)}`
  return [
    `- 机器:${m.cpus} 核,内存 ${fmtBytes(m.totalMemBytes)}(空闲 ${fmtBytes(m.freeMemBytes)}),磁盘${disk}`,
    `- 运行时:Node ${m.nodeVersion},${m.platform}`,
  ]
}

function toolsLine(tools: readonly HubEnvTool[] | null): string {
  if (!tools) return `- 工具链:${READ_FAILED}`
  const parts = tools.map((t) => `${t.command} ${t.found ? '有' : '没有'}`)
  return `- 工具链:${parts.join(',')}`
}

function handsLine(h: ButlerHandsStatus | undefined): string {
  if (!h) return `- 手(监狱工作区):${NOT_WIRED}`
  return h.armed ? `- 手(监狱工作区):${h.kind} 监狱,已装` : `- 手(监狱工作区):没装(${h.reason})`
}

function egressLine(outage: HubEnvironment['outage'], now: number): string {
  // 措辞承重:这是**被动**信号。「没人报过错」不等于「探过是通的」,
  // 而主动探一次就等于给模型开一个新的出网面(判断③)。
  if (outage === 'not_wired') return `- 出网(被动看,不主动探):${NOT_WIRED}`
  if (outage === 'unknown') return `- 出网(被动看,不主动探):${READ_FAILED}`
  if (outage === null) return '- 出网(被动看,不主动探):最近的模型调用没报过错'
  const mins = Math.max(0, Math.round((now - outage.since) / 60_000))
  return `- 出网(被动看,不主动探):断供中约 ${mins} 分钟(${outageHeadline(outage.kind, 'zh')})`
}

function knobLines(knobs: readonly ButlerConfigKnobView[] | null): string[] {
  if (!knobs) return [`- 基础设置:${NOT_WIRED}`]
  if (knobs.length === 0) return ['- 基础设置:读不到当前值']
  return [
    '- 基础设置(下次重启会用的值):',
    ...knobs.map((k) => {
      const next = nextValueOf(k)
      const live = liveValueOf(k)
      const tail = next === live ? '' : `(现在还是 ${live})`
      return `  · ${k.key} = ${next}${tail}`
    }),
  ]
}

/** 一条提案渲染成三行(与 diagnose_my_agents 同形状:标题 / 事实 / 下一步)。 */
function proposalLines(p: HubEnvProposal): string {
  const next = p.applicable
    ? `我可以帮你改:把 ${p.apply.key} 设成 ${p.apply.value}(用 set_hub_config,会先送 /me 等你批准,下次重启生效)。`
    : p.howTo
  return `• ${p.title}\n  ${p.detail}\n  → ${next}`
}

/** 纯渲染(零 LLM 决策)。导出给测试直打。 */
export function renderHubEnvironment(env: HubEnvironment, now: number): string {
  const proposals = proposeEnvironmentFixes(env)
  const head = [
    '这台 hub 的环境:',
    ...machineLines(env.machine),
    toolsLine(env.tools),
    handsLine(env.hands),
    egressLine(env.outage, now),
    ...knobLines(env.knobs),
  ]
  if (proposals.length === 0) {
    return [...head, '', '没发现需要处理的地方。'].join('\n')
  }
  const enactable = proposals.filter((p) => p.applicable).length
  const summary =
    enactable > 0
      ? `发现 ${proposals.length} 处该处理的,其中 ${enactable} 处我能帮你改(要你在 /me 批准):`
      : `发现 ${proposals.length} 处该处理的,都得你或管理员动手:`
  return [...head, '', summary, ...proposals.map(proposalLines)].join('\n')
}

// ─── benign 工具 ─────────────────────────────────────────────────────────────

const ENVIRONMENT_TOOL: LlmToolDefinition = {
  name: 'hub_environment',
  description:
    '看这台 hub 所在机器的环境:几核多少内存多少磁盘、Node 版本、ffmpeg/git/docker 装没装、手(监狱工作区)能不能用、出网通不通、四个基础设置项当前值,以及据此给出的处理建议。回答「这台服务器撑得住吗」「为什么语音条不出来」「怎么没有手」「我改的设置生效了吗」这类问题时用它。只读探测,不跑任何命令、不发任何网络请求;要真改设置得用 set_hub_config(会先送你批准)。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

class ButlerEnvironmentToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerEnvironmentDeps) {}

  listTools(): LlmToolDefinition[] {
    return [ENVIRONMENT_TOOL]
  }

  async callTool(name: string): Promise<LlmToolCallResult> {
    if (name !== 'hub_environment') return text(`未知工具:${name}`, true)
    try {
      const env = await probeHubEnvironment(this.deps)
      return text(renderHubEnvironment(env, this.deps.now?.() ?? Date.now()))
    } catch (err) {
      // 逐块 catch 已兜住采集失败;这层只防注入的 now/logger 本身出错。
      this.deps.logger?.warn('butler environment: render failed', { err })
      return text('暂时看不到这台机器的环境,稍后再试。', true)
    }
  }
}

/**
 * 组一张环境卡。所有 dep 可选——缺哪块哪行「(未接)」,工具本身无条件装
 * (机器事实这一块永远探得到)。
 */
export function buildButlerEnvironmentToolset(deps: ButlerEnvironmentDeps): LlmAgentToolset {
  return new ButlerEnvironmentToolset(deps)
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] }
}
