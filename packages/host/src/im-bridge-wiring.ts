/**
 * im-bridge-wiring.ts — main.ts 的 IM 装配块整体外迁。
 *
 * 为什么存在:CARE-M2 要往 IM 装配里加断供接线,而 main.ts 行数棘轮只剩
 * 3 行余量——按 PUB·KIT·CARE 计划的前置腾挪惯例(同 LIFE 的
 * `armButlerSweeps` / FDE 的三抽取),把 setting-ops M5 当年的装配块原样
 * 搬进来,新增量在这里长,main.ts 净减。
 *
 * 语义逐字保留自 main.ts:
 * - IM `/setting` 复用与 web 总览同一个 live `adminHealth`,IM `status`
 *   永不与总览面板打架;
 * - IM caller 恒为 surface='im' + allowConfigWrite=false——config-write 与
 *   destructive-offline 在 ops-core 的 chokepoint 被拒(列出但指去 web/CLI);
 * - 入口闸是 admin bar(owner OR admin),按绑定的 Gotong userId 判,绝不
 *   按裸 IM handle;
 * - 平台仍逐个 env/vault 门控:什么都没配时 handle 惰性(hotStart 让首启
 *   向导写完 token 能热启,零桥零消费)。
 *
 * CARE-M2 新增(此文件的存在理由):llmOutage 接线——断供状态文件
 * `<space>/runtime/llm-outage.json`、语言随 host defaultLang、边沿播报骑
 * BE-M5 已同意成员(butler memory 根下枚举)。
 */

import { join } from 'node:path'

import type { Hub } from '@gotong/core'
import type { IdentityStore } from '@gotong/identity'
import { ButlerSessionWindow } from '@gotong/personal-butler'

import type { AdminHealthSurface } from './admin-health.js'
import type { ButlerPushResult } from './butler-reachable.js'
import type { FailureLang } from './failure-translator.js'
import {
  ImApprovalService,
  loadOrCreateShortCodeKey,
  type ImApprovalServiceOptions,
} from './im-approval-service.js'
import { startImBridges, type ImBridgesHandle, type ImLogger } from './im-bridge.js'
import { ImCredentialsService, type ImCredentialsSpace } from './im-credentials-service.js'
import { SetKeyLinkStore, setKeyLinkBaseUrl } from './setkey-link-store.js'
import { listOpsCommands, runOpsCommand } from './ops-core.js'

export interface ImBridgeWiringDeps {
  hub: Hub
  identity: IdentityStore
  log: ImLogger
  /** Workspace 根(GOTONG_SPACE)。reachable / runtime / butler 路径都从它长。 */
  spaceRoot: string
  /**
   * Env keys this host injected at boot from the managed env file. `/setting
   * config` subtracts them so the hub's own file is not reported as an
   * environment override. See `EffectiveConfigDeps.envInjectedKeys`.
   */
  envInjectedKeys?: readonly string[]
  /** 与 web 总览同一个 live 体检面——IM `status` 不许有第二个真相。 */
  health: AdminHealthSurface
  /** host 已解析的 GOTONG_DEFAULT_LANG——断供文案随它,不二次读 env。 */
  defaultLang: FailureLang
  /**
   * CARE-M5 — 只读活体探针(可选)。给了它,断供期间就按节律主动探 provider
   * 恢复并立刻播报,不必等下一条用户消息。宿主复用 onboarding key check 的解析
   * 链(lazy 读 ref),缺省 → 恢复仍只走反应式。
   */
  probeLiveness?: () => Promise<boolean>
  /**
   * IMA-M2 — 审批面双依赖(读=InboxStore.listPending,写=HostInboxService.resolve)。
   * 给了它,三个审批动词(/inbox /approve /deny)在绑定成员的 IM 里生效——只对
   * 写入时标了 `imApprovable` 白名单的 hub 内动作;缺省 → 动词回「未启用」,
   * 其余分支字节不变。风险裁决在写入方与 resolve 权威点,这里只是装配。
   */
  /**
   * 审批面的两条腿(读=store,写=HostInboxService)。短码密钥**不在这里**——它由
   * 装配层自己从 `spaceRoot` 取(Codex 八轮 M2),调用方不必也不该经手。
   */
  approvals?: Omit<ImApprovalServiceOptions, 'shortCodeKey'>
  /**
   * VOICE-M3 — opt-in TTS 语音回复(main.ts 构造 `butlerVoiceFromEnv()`)。
   * 给了它,自由文本的 OK 回复附带 opus 语音条(飞书腿播放,其余桥退文本);
   * 缺省 → 发送逐字节不变。
   */
  voice?: ImBridgeVoiceSynth
  /**
   * ASR-M3 — opt-in 语音收听(main.ts 构造 `butlerHearingFromEnv()`)。
   * 给了它,飞书语音消息在派发前下载+转写成文字(转写≠授权,后续管道同打字);
   * 缺省 → 入站处理逐字节不变(语音消息保持空文本)。
   */
  hearing?: ImBridgeHearing
  /**
   * VIS-M3 — opt-in 图片识别(main.ts 构造 `butlerSeeingFromEnv()`)。
   * 给了它,飞书图片/表情在派发前下载+识别成文字(看≠授权,后续管道同打字);
   * 缺省 → 入站处理逐字节不变(图片消息保持空文本)。
   */
  seeing?: ImBridgeSeeing
  /**
   * PUSH-M3 — opt-in Web Push 补位腿(main.ts 构造 `buildWebPushService()`)。
   * 给了它,reachable 判「成员从没绑过 IM」时退而发一记低信息 tap 叫醒 /me
   * (签名不收 text=正文结构性上不了通知);绑了 IM 的成员行为字节不变;
   * 缺省 → 回落链不存在,与今天逐字节一致。
   */
  webPushFallback?: (userId: string) => Promise<ButlerPushResult>
  /**
   * HANDS-M3a — opt-in 手机配置 key 面(`/setkey` + `/keys`)。给了它,owner/admin
   * 能从手机换一把过期的 provider key;缺省 → 两个动词回「未启用」,其余字节不变。
   *
   * **刻意只收 space 与重启腿**:`identity` 用装配层自己那份,`allowed` 由这里
   * 拿 `imIsOperator` 拼——调用方连传一个不同的角色判据的机会都没有。这是
   * HANDS-M2 那条「闸放在忘不掉的地方」的同一姿态。
   */
  credentials?: {
    space: ImCredentialsSpace
    /** 存完 key 后重启会用到它的 agent(= admin 面写完 key 调的那同一个
     *  `lifecycle.start`)。缺省 → 如实回「存好了但还没生效」。 */
    restartAgents?: (agentIds: string[]) => Promise<{ restarted: string[]; failed: string[] }>
  }
}

/** 窄鸭子:只要 synthesize 一面(butler-voice 的 ButlerVoice 天然满足)。 */
export interface ImBridgeVoiceSynth {
  synthesize(
    text: string,
  ): Promise<
    | { kind: 'clip'; bytes: Buffer }
    | { kind: 'skipped'; reason: string }
    | { kind: 'failed'; reason: string }
  >
}

/** 窄鸭子:只要 transcribe 一面(butler-hearing 的 ButlerHearing 天然满足)。 */
export interface ImBridgeHearing {
  transcribe(
    bytes: Buffer,
  ): Promise<
    | { kind: 'text'; text: string }
    | { kind: 'skipped'; reason: string }
    | { kind: 'failed'; reason: string }
  >
}

/** 窄鸭子:只要 describe 一面(butler-seeing 的 ButlerSeeing 天然满足)。 */
export interface ImBridgeSeeing {
  describe(
    bytes: Buffer,
    mime: string,
  ): Promise<
    | { kind: 'text'; text: string }
    | { kind: 'skipped'; reason: string }
    | { kind: 'failed'; reason: string }
  >
}

/** 装配并启动 IM 桥(语义=当年 main.ts 内联块 + CARE-M2 断供接线)。 */
export async function armImBridgeWiring(deps: ImBridgeWiringDeps): Promise<ImBridgesHandle | undefined> {
  const identityForIm = deps.identity
  const imIsOperator = (userId: string): boolean => {
    const role = identityForIm.getMembership(userId)?.role
    return role === 'owner' || role === 'admin'
  }
  // 「谁在命令模式」的旗子——handleImMessage 是无状态函数,状态在这持有,
  // host 生命周期一张 Map。
  const imSettingMode = new Map<string, boolean>()
  const imOpsCaller = { surface: 'im' as const, allowConfigWrite: false }
  const imOpsDeps = {
    spaceDir: deps.spaceRoot,
    env: process.env,
    health: deps.health,
    ...(deps.envInjectedKeys ? { envInjectedKeys: deps.envInjectedKeys } : {}),
  }
  // HANDS-M3b — `GOTONG_PUBLIC_URL` is knob #111, already the answer to "what
  // address do people reach this hub at". Reusing it keeps the count at 116 and,
  // more to the point, means a hub that is reachable has working links without
  // anyone configuring a second thing.
  const setKeyLinkBase = setKeyLinkBaseUrl(process.env.GOTONG_PUBLIC_URL)
  return startImBridges({
    hub: deps.hub,
    identity: deps.identity,
    log: deps.log,
    // DEPLOY-B1 — 始终持 handle,首启向导写完 vault token 能热启一座桥
    // (「粘完 token」与「bot 应答」之间零重启);什么都没配时 handle 惰性。
    hotStart: true,
    // F1 — 出站推送地基:绑定成员的每条入站消息都记下最新可达聊天,
    // 后续提醒 / 审批回推 / 播报走返回的 pushToMember。
    reachableDir: join(deps.spaceRoot, 'butler', 'reachable'),
    // 对话连续性 — 每成员滚动会话窗(「查一下 → 查什么?」修复):自由文本带上
    // 一小段最近轮次骑 payload.history,deliverToMember 的每次推送也记成
    // 「管家说过的话」。窗口 ≠ 记忆(长期仍走 episodic 蒸馏)、≠ 授权(governed
    // 照 park)。handle.sessions 再暴露给 web /me quick-chat——同一实例,IM 与
    // 网页是同一场对话。
    sessions: new ButlerSessionWindow({
      rootDir: join(deps.spaceRoot, 'butler', 'sessions'),
      logger: deps.log,
    }),
    // GRP — 群窗说话人标注用的成员名(identity 是同进程 SQLite,同步读)。
    memberName: (userId) => identityForIm.getUserById(userId)?.displayName ?? null,
    // IMA-M2 — /inbox /approve /deny 的审批面(有 inbox 才有)。
    ...(deps.approvals
      ? {
          approvals: new ImApprovalService({
            ...deps.approvals,
            // 短码是 HMAC,密钥在 `<space>/runtime/im-shortcode.key`(0600,缺了就
            // 生成、坏了就抛)。不带密钥的 8 位指纹是阿同自己能算出来的
            // ——而它现在有手(HANDS-M2 tier 1 免审批)。
            shortCodeKey: loadOrCreateShortCodeKey(deps.spaceRoot),
          }),
        }
      : {}),
    // HANDS-M3a — opt-in 手机配置 key 面。`allowed` 在这里拼(与 setting 台
    // 同一个 imIsOperator,不长第二份角色判据);不够格的成员拿到的与「没接」
    // 一模一样——凭证面说「你没权限」等于说「这里能配 key」。
    ...(deps.credentials
      ? {
          credentials: new ImCredentialsService({
            allowed: imIsOperator,
            space: deps.credentials.space,
            identity: deps.identity,
            ...(deps.credentials.restartAgents
              ? { restartAgents: deps.credentials.restartAgents }
              : {}),
            // HANDS-M3b — the other path. The store is unconditional (a
            // directory that stays empty costs nothing); what actually decides
            // whether links are offered is the base URL, and that comes from
            // the ONE existing knob for "how the outside world reaches this
            // hub". No fallback to host:port: a link a phone cannot open is
            // worse than saying we can't make one.
            links: new SetKeyLinkStore(deps.spaceRoot),
            ...(setKeyLinkBase ? { linkBaseUrl: setKeyLinkBase } : {}),
            log: deps.log,
          }),
        }
      : {}),
    // VOICE-M3 — opt-in 语音回复;未配 undefined = 发送逐字节不变。
    ...(deps.voice ? { voice: deps.voice } : {}),
    // ASR-M3 — opt-in 语音收听;未配 undefined = 入站逐字节不变。
    ...(deps.hearing ? { hearing: deps.hearing } : {}),
    // VIS-M3 — opt-in 图片识别;未配 undefined = 入站逐字节不变。
    ...(deps.seeing ? { seeing: deps.seeing } : {}),
    // PUSH-M3 — opt-in Web Push 补位腿;未配 undefined = 回落链不存在。
    ...(deps.webPushFallback ? { webPushFallback: deps.webPushFallback } : {}),
    // CARE-M8 — 投递失败入盘、成员可达时重投的每成员 outbox。给了它,
    // reachable push 的失败不再只是一行日志(短暂失联的成员不漏播报/提醒)。
    outboxDir: join(deps.spaceRoot, 'butler', 'outbox'),
    // CARE-M2 — 断供不失联:状态文件 + 语言 + BE-M5 同意面的根。
    // CARE-M5 — 有 probeLiveness 时 im-bridge 再 arm 主动恢复探活定时器。
    llmOutage: {
      file: join(deps.spaceRoot, 'runtime', 'llm-outage.json'),
      lang: deps.defaultLang,
      butlerMemoryRoot: join(deps.spaceRoot, 'butler', 'memory'),
      ...(deps.probeLiveness ? { probeLiveness: deps.probeLiveness } : {}),
    },
    setting: {
      isOperator: imIsOperator,
      mode: imSettingMode,
      ops: {
        list: () => listOpsCommands(imOpsCaller),
        run: async (id, args) => {
          const r = await runOpsCommand(id, args, imOpsCaller, imOpsDeps)
          return { lines: r.lines }
        },
      },
    },
  })
}
