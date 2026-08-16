/**
 * HANDS-M2b 手 B —— 外驱 coding CLI,住进手 A 那座监狱。
 *
 * 手 A(`personal-butler-hands.ts`)给的是「一条命令、一次文件操作」;手 B 给的是
 * 「把这件事交出去,让一个专门写代码的 CLI 去改」。两只手**共用同一个工作区**:
 * 阿同写下需求 → 手 B 改文件 → 阿同用 `hands_run` 跑测试看结果。这正是它存在的
 * 理由,也是它必须住进同一座监狱的理由。
 *
 * **手 B 不是第二座监狱,是同一座监狱换个住客。** 围墙、藏起来的东西、只读的空
 * HOME、过滤过的 PATH、工作区的位置、谁有手——全部从手 A 的 `ButlerHandsHost`
 * 上取,一处也不重新推导。第二份推导迟早和第一份不一样,而不一样的那天不会有人
 * 收到通知;真到那天,手 B 就成了通往同一栋房子的一扇更弱的门。
 *
 * 五道 fail-closed 闸,顺序是刻意的:
 *   1. 手 A 没装(没有监狱 / 没有 identity / 总开关关着)⇒ 手 B 不装。
 *   2. `hands.json` 里没有 `coder` 块 ⇒ 不装(opt-in,缺席=字节不变)。
 *   3. 配好的那个成员不在 `allowRoles` 里 ⇒ 不装(手 B 的权限 ⊆ 手 A 的权限)。
 *   4. `agentId` 撞上一行不是我们的 agent ⇒ 不装(绝不覆盖操作者的东西)。
 *   5. 工作区建不起来 ⇒ 不装。
 *
 * **诚实残余**:手 B 结构性联网(它得连自己的模型)。监狱护的是 hub 自己的凭证
 * 与配置(藏起来的 `<space>`/HOME/套接字),**不是**「工作区里的内容不会被发出去」
 * ——把一份代码交给一个云端模型改,就是把它发出去。要的是别的东西,就别给它这
 * 份工作区。
 */

import { CliParticipant } from '@gotong/cli-agent'
import type { AgentRecord, FsJailSpec, Logger, Participant, TranscriptEntry } from '@gotong/core'
import { userPrincipal } from '@gotong/identity'

import {
  childEnv,
  ensureHandsDirs,
  handsHardening,
  handsPaths,
  type ButlerHands,
  type ButlerHandsHost,
  type HandsCoderConfig,
} from './personal-butler-hands.js'

/**
 * 手 B 广告的能力——**刻意写死、刻意不通用**。
 *
 * 广告一个能力就是授权它(G-M1):任何人派发这个 cap 都会落到这里,而这里是一个
 * 能改文件的 CLI。叫 `code` / `coding` 那种通名,别处一次无心的派发就会撞进来。
 */
export const HANDS_CODER_CAPABILITY = 'hands.coder'

// ─── 装配 ─────────────────────────────────────────────────────────────────────

/** hub 的窄切片:注册参与者 + 把实时输出播出去(观察缝)。 */
export interface CoderHubDeps {
  register(p: Participant): void
  transcript: { emitEphemeral(entry: Omit<TranscriptEntry, 'seq'>): unknown }
}

/** agents.json 的窄切片(`Space` 正好是这个形状)。 */
export interface CoderSpaceDeps {
  agents(): Promise<AgentRecord[]>
  upsertAgent(rec: Omit<AgentRecord, 'createdAt'> & { createdAt?: string }): Promise<AgentRecord>
}

/** identity 的窄切片——`escalate_to_expert` 的 fail-closed 检查认的就是这张表。 */
export interface CoderGrantDeps {
  setResourceGrant(input: {
    resourceKind: 'agent'
    resourceId: string
    principal: ReturnType<typeof userPrincipal>
    perm: 'owner'
    grantedBy?: string | null
  }): unknown
}

export interface ArmButlerCoderOptions {
  /** 手 A 的结果 —— 手 B 的**全部**围墙都从这里取。 */
  hands: ButlerHands
  hub: CoderHubDeps
  space: CoderSpaceDeps
  grants: CoderGrantDeps
  logger: Logger
}

export interface ButlerCoderArm {
  armed: boolean
  /** 没装时**说人话**的原因(装上时是 undefined)。 */
  reason?: string
  agentId?: string
}

export async function armButlerCoder(opts: ArmButlerCoderOptions): Promise<ButlerCoderArm> {
  const log = opts.logger
  const host = opts.hands.host
  if (!host) return { armed: false, reason: '手 A 没装(没有监狱 / 没有 identity / 总开关关着)——手 B 跟着不装' }
  const cfg = host.config.coder
  if (!cfg) return { armed: false, reason: 'hands.json 里没有 coder 块——手 B 是 opt-in 的' }

  // 顺序刻意:不够格的成员连目录都不该被建出来(镜像手 A 的 classify 在
  // ensureWorkspace 之前)。手 B 的权限**是手 A 权限的子集**,不另开一道门。
  if (!host.allowed(cfg.userId)) {
    const reason = `coder.userId「${cfg.userId}」不在 allowRoles(${host.config.allowRoles.join('/')})里——手 B 不装`
    log.warn('hands: coder user not allowed — hand B stays OFF', { userId: cfg.userId, allowRoles: host.config.allowRoles })
    return { armed: false, reason }
  }

  const existing = (await opts.space.agents()).find((a) => a.id === cfg.agentId)
  if (existing && !looksLikeOurs(existing)) {
    const reason = `agents.json 里「${cfg.agentId}」已经是别的东西了——换个 coder.agentId,或先把那行删掉`
    log.warn('hands: coder agent id already taken — hand B stays OFF', { agentId: cfg.agentId })
    return { armed: false, reason }
  }

  const paths = handsPaths(host.handsRoot, cfg.userId)
  let dirs: { workspace: string; home: string }
  try {
    dirs = ensureHandsDirs(paths)
  } catch (err) {
    log.warn('hands: coder workspace unavailable — hand B stays OFF', { userId: cfg.userId, err: String(err) })
    return { armed: false, reason: `工作区建不起来:${String(err)}` }
  }

  // 名字撞车的那些**说出来**:静默丢弃会让操作者以为 passEnv 生效了。判据是把
  // 两个真对象的键比一比,不是一张迟早过期的保留字表(childEnv 后来多定一个键,
  // 这里自动跟上)。
  const collided = cfg.passEnv.filter((n) => n in coderEnvBase(host, dirs))
  if (collided.length > 0) {
    log.warn('hands: coder passEnv names are set by the jail itself — not passed through', { names: collided })
  }

  const participant = new CliParticipant({
    id: cfg.agentId,
    capabilities: [HANDS_CODER_CAPABILITY],
    command: cfg.command,
    args: cfg.args,
    promptVia: cfg.promptVia,
    cwd: dirs.workspace,
    // 从零拼,什么都不继承:hub 进程的 env 里有 IM token、模型 key、全部旋钮。
    envMode: 'replace',
    env: () => coderEnv(host, cfg, dirs),
    timeoutMs: cfg.timeoutSec * 1000,
    maxTurns: cfg.maxTurns,
    // thunk:围墙**每次 spawn 现算**(见 PerSpawn)。抛错 = 这一轮失败,不 spawn。
    fsJail: (): FsJailSpec => ({
      allowedRoots: [dirs.workspace],
      kind: host.kind,
      hardening: handsHardening({ hands: host, net: true, homeRaw: paths.homeRaw, homeReal: dirs.home }),
    }),
    // 观察缝:CLI 的每一段输出即时播成 transcript 事件(admin 面板已经在消费
    // `llm_stream_chunk`),人能看着它干活——而不是等十五分钟看一个结论。
    onChunk: (taskId, c) => {
      try {
        opts.hub.transcript.emitEphemeral({
          ts: Date.now(),
          kind: 'llm_stream_chunk',
          // `chunk` 是 unknown:流别塞在里面,不去挤 data 那张闭集表。
          data: { taskId, agentId: cfg.agentId, chunk: { type: 'text', text: c.text, stream: c.stream } },
        })
      } catch (err) {
        log.warn('hands: coder chunk emit failed', { err: String(err) })
      }
    },
  })

  opts.hub.register(participant)
  // 名册行 + 授权:两样都在,`escalate_to_expert` 的 fail-closed 检查
  // (`roster.listOwned(userId)` 必须含 escalateTo)才过得去。**行是故意露出来的**
  // ——一个能改文件的参与者不该藏在名册外面。
  await opts.space.upsertAgent({
    id: cfg.agentId,
    allowedCapabilities: [HANDS_CODER_CAPABILITY],
    displayName: cfg.label,
  })
  opts.grants.setResourceGrant({
    resourceKind: 'agent',
    resourceId: cfg.agentId,
    principal: userPrincipal(cfg.userId),
    perm: 'owner',
    grantedBy: cfg.userId,
  })
  log.info('hands: hand B armed', {
    agentId: cfg.agentId,
    userId: cfg.userId,
    command: cfg.command,
    jail: host.kind,
    workspace: '<workspace>',
  })
  return { armed: true, agentId: cfg.agentId }
}

/** 只认「我们自己建的那种行」:无 managed、能力恰好是手 B 那一个。 */
function looksLikeOurs(rec: AgentRecord): boolean {
  return rec.managed === undefined && rec.allowedCapabilities.length === 1 && rec.allowedCapabilities[0] === HANDS_CODER_CAPABILITY
}

/** 监狱自己定的那份环境(手 A 同一个 `childEnv`)。 */
function coderEnvBase(host: ButlerHandsHost, dirs: { workspace: string; home: string }): Record<string, string> {
  return childEnv(dirs.workspace, true, { home: dirs.home, pathEnv: host.shape.pathEnv })
}

/**
 * 手 B 的子进程环境 = 监狱自己那份 + 点名透传的几个。
 *
 * 展开顺序承重:**监狱那份在后**,所以 `passEnv` 只能补充、永远盖不掉 HOME /
 * PATH / TMPDIR / 代理过滤。少一张需要维护的保留字表,也少一个「表忘了更新」的
 * 那天(与手 A 的代理 userinfo 过滤同一条:能被盖掉的过滤等于没有过滤)。
 */
function coderEnv(host: ButlerHandsHost, cfg: HandsCoderConfig, dirs: { workspace: string; home: string }): Record<string, string> {
  const passed: Record<string, string> = {}
  for (const name of cfg.passEnv) {
    const v = process.env[name]
    if (v !== undefined) passed[name] = v
  }
  return { ...passed, ...coderEnvBase(host, dirs) }
}
