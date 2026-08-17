/**
 * personal-butler-config.ts — HANDS-M3c: 把 `setting` 的 config-write 这一档
 * 搬上手机,走**类型化 governed 动作**,不是把命令行搬过去。
 *
 * ## 为什么是一个工具,不是让 IM 命令台放行
 *
 * `SETTING-OPS-CONSOLE` 当年把 config-write 在 IM 上标 ✗,理由只有一条:那一面
 * **单步无确认**——一行打错的 `config-set` 直接落盘。理由不是「手机不配改配置」。
 *
 * 那条理由今天仍然对**命令台本身**成立,而且是结构性的:命令台是一个确定性的
 * 行执行器,**没有任务可挂起**,而收件箱那条路认的是「被挂起的任务 id」
 * (`InboxItem.itemId` 就是那个 id)。要让命令台 park,就得再造第二套 resolve
 * 权威——正是这个项目一直拒绝的东西。
 *
 * 所以两步确认落在**另一条路**上:成员对阿同说想改什么 → 阿同调这个类型化动作
 * → `classify` 判 approve → park 进 `/inbox` → `/approve <短码>` → 恢复的那一轮
 * 才真写。命令台照旧 ✗,但它的指路改成这条路(`ops-core.ts` 的
 * `IM_CONFIG_WRITE_HINT`)。这就是 ATONG-HANDS 四档表里 tier 2 那句「走**类型化
 * 动作**」的字面兑现。
 *
 * ## 三条承重边界
 *
 * 1. **写只有一处**:`execute` 调的是 `runOpsCommand('config-set', …)`,与网页
 *    owner / CLI 完全同一个咽喉、同一套校验器、同一份审计。这里不重写任何一条
 *    规则——第二份规则迟早会和第一份不一样,而那天没有人会被通知。
 * 2. **classify 是那套规则的预检,不是第二套策略**:顺序逐字镜像
 *    `applyEnvKnob`(密钥名 → 白名单 → 值校验),于是「批准了」蕴含「真的会落
 *    盘」。两边若分叉,人就会为一件根本执行不了的事花掉一次审批。
 * 3. **参数空间由白名单封死**:四个具名旋钮,值是枚举/端口号。整个动作在手机上
 *    一行读得全**不是因为文案短**,是因为它**长不出来**——这与 `hands_*` 的
 *    argv 正相反,那才是它能进 IM 可批名单而手部动作不能的真正理由。
 *
 * 凭证不走这里(`isSecretKey` 当场拒并指 `/setkey`),`config-price` 也不走这里:
 * 五个浮点数在手机上逐个敲,一个数字打错就静默写坏成本表——手机适合做**决定**,
 * 不适合做数据录入。它仍在网页/CLI。
 */

import type { Logger } from '@gotong/core'
import { AUDIT_ACTIONS } from '@gotong/identity'
import { GovernedActionToolset } from '@gotong/personal-butler'

import { ENV_KNOBS, isSecretKey, runOpsCommand, type OpsDeps } from './ops-core.js'
import type { SettingAuditSink } from './setting-ops-service.js'

/** 一个旋钮的当前状态投影(read-tier `config` 的一行,只为审批卡上的「现在是 X」)。 */
export interface ButlerConfigKnobView {
  key: string
  summary: string
  default: string
  /** 托管 env 文件里的值(null = 没写过)。这一项才是本动作要改的东西。 */
  fileValue: string | null
  /** 进程真正在用的值(null = 没设)。文件改了但没重启时两者会不同——如实两个都报。 */
  envValue: string | null
}

/** classify / execute 共用的一份 ops——owner/admin 判定钉在这,服务端权威。 */
export interface ButlerConfigOps {
  /** owner/admin 才能改 hub 配置(与 pack_backup 同姿态)。 */
  privileged(userId: string): boolean
  /** 当前旋钮投影;读不到 = 空数组(审批卡少一句「现在是 X」,绝不因此拒绝)。 */
  knobs(): Promise<ButlerConfigKnobView[]>
  /** 真写:走 ops-core `runOpsCommand('config-set')` 咽喉。 */
  set(input: { key: string; value: string; userId: string }): Promise<{ lines: string[] }>
}

/** identity 里那点窄切片 + 审计沉降口(都可缺席)。 */
export interface ButlerConfigOpsDeps {
  /** ops-core 的 deps(spaceDir 必填),与网页 setting 台同源。 */
  ops: OpsDeps
  /** identity 窄切片:成员角色(null/undefined = 无 membership)。 */
  membershipRole: (userId: string) => string | null | undefined
  /**
   * 审计沉降口——**复用 setting 台那个类型**(IdentityStore 结构性满足它),不另声明
   * 一个更松的:松的那个会把 `actorSource` 的闭集丢掉,而写审计的枚举收窄过一次就
   * 不能在第二个入口悄悄放开。缺席 = 照写不记账(与 CLI 离线路径同姿态)。
   */
  audit?: SettingAuditSink
  logger?: Pick<Logger, 'warn'>
}

/** 审计 action 名——与网页/CLI **同一个常量**,三面在一张表里查得到。 */
const AUDIT_ACTION = AUDIT_ACTIONS.SETTING_CONFIG_WRITE

export function buildButlerConfigOps(deps: ButlerConfigOpsDeps): ButlerConfigOps {
  return {
    privileged(userId) {
      const role = deps.membershipRole(userId)
      return role === 'owner' || role === 'admin'
    },
    async knobs() {
      try {
        // 走 read-tier 的同一个命令,而不是自己拼 env 文件路径:路径规则只有一处
        // (`envFileOf`),复制它就是给自己造一个将来会漂移的第二份真相。
        const r = await runOpsCommand('config', [], { surface: 'butler', allowConfigWrite: false }, deps.ops)
        const rows = (r.data as { knobs?: unknown } | undefined)?.knobs
        return Array.isArray(rows) ? (rows as ButlerConfigKnobView[]) : []
      } catch (err) {
        deps.logger?.warn('butler config: effective-config read failed', { err })
        return []
      }
    },
    async set({ key, value, userId }) {
      const sink = deps.audit
      const r = await runOpsCommand(
        'config-set',
        [key, value],
        // HANDS-M3c — surface='butler' 是**第四个面**,不是借用 'im':同一条 park
        // 既可能在手机批也可能在 /me 批,写死任何一个渠道名都有一半时候是假的。
        // 渠道那个事实由收件箱 resolve 自己那行审计的 `metadata.via` 记(IMA-M2)。
        { surface: 'butler', allowConfigWrite: true },
        {
          ...deps.ops,
          ...(sink?.writeAuditLog
            ? {
                audit: (metadata: Record<string, unknown>) => {
                  try {
                    // actorSource='v4-session' 的含义是「背后有一个真的 v4 用户行」
                    // (对照 v3 space-admin token → 'system'),不是「他从网页来」。
                    // 渠道细节在 metadata.surface='butler' 与那条 resolve 审计里。
                    sink.writeAuditLog!({
                      action: AUDIT_ACTION,
                      actorSource: 'v4-session',
                      actorUserId: userId,
                      metadata,
                      success: true,
                    })
                  } catch {
                    // best-effort — 字节已经落盘了,审计打嗝绝不能变成写失败。
                  }
                },
              }
            : {}),
        },
      )
      return { lines: r.lines }
    },
  }
}

// ─── governed set_hub_config ─────────────────────────────────────────────────

const REFUSE_ROLE = '改这台 hub 的基础设置只对 owner/admin 开放。'
const SECRET_HINT = '凭证不走这里——api key / bot token 用 `/setkey`(直贴或 `/setkey link` 出一次性网页表单),它们进金库,永远不进这个配置文件。'

/** 白名单里那四个;写在一处,工具 schema 的 enum 与 classify 都从它派生。 */
const KNOB_KEYS: readonly string[] = ENV_KNOBS.map((k) => k.key)

function knobOf(key: string) {
  return ENV_KNOBS.find((k) => k.key === key)
}

/** 键的规范化必须与 `applyEnvKnob` 逐字一致(它 trim),否则 classify 与真写会分叉。 */
function normKey(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function normValue(v: unknown): string {
  // applyEnvKnob 收 `input.value ?? ''` 后交给 spec.validate(它自己再 trim)。
  // 数字/布尔是模型很容易吐出来的形状,按字面转成字符串再交给同一个校验器。
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

export interface ButlerConfigToolsetDeps {
  /** 这位成员——owner/admin 判定按它查(服务端权威,绝不信模型自报)。 */
  userId: string
  ops: ButlerConfigOps
  logger?: Pick<Logger, 'warn'>
}

/**
 * governed 配置闸。verdict 永远 approve(每次 park——用户拍板的岔口 3「每次
 * park」,无 blanket grant),owner/admin 之外与坏参数一律在 park **之前** refuse。
 */
export function buildButlerConfigToolset(deps: ButlerConfigToolsetDeps): GovernedActionToolset {
  const { userId, ops } = deps
  return new GovernedActionToolset({
    tools: [
      {
        name: 'set_hub_config',
        description:
          '改这台 hub 的一个基础设置项(网页端口 / agent WebSocket 端口 / 个人-团队模式 / 首次启动是否自动开浏览器)。会先把改动送进 /me 收件箱等你批准,批准后写进服务器空间的 gotong.env,**下次重启生效**。仅 owner/admin。api key、bot token 这类凭证不走这里——用 /setkey。模型价格表也不走这里(五个数字在手机上敲容易打错),在网页或服务器命令行改。',
        inputSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              enum: [...KNOB_KEYS],
              description: '要改的设置项名',
            },
            value: {
              type: 'string',
              description: '新值。端口=1-65535 的整数;模式=personal 或 team;自动开浏览器=auto/always/never(1/0 亦可)',
            },
          },
          required: ['key', 'value'],
          additionalProperties: false,
        },
        defaultVerdict: {
          decision: 'approve',
          reason: '会改这台 hub 的基础设置(下次重启生效)——先请你确认',
        },
      },
    ],
    // 顺序逐字镜像 applyEnvKnob:密钥名 → 白名单 → 值校验。这不是巧合也不是抄写,
    // 是本文件顶注那条边界 ②——classify 是同一套规则的预检,不是第二套策略。
    classify: async (_name, args) => {
      if (!ops.privileged(userId)) return { decision: 'refuse', reason: REFUSE_ROLE }
      const key = normKey(args.key)
      if (!key) return { decision: 'refuse', reason: `要改哪一项?可改的只有:${KNOB_KEYS.join('、')}。` }
      // 密钥名先答,且答的是「凭证去哪」而不是「没这个旋钮」——后者会让人以为
      // 换个写法就能把 token 塞进配置文件。
      if (isSecretKey(key)) return { decision: 'refuse', reason: `${key} 看起来是凭证。${SECRET_HINT}` }
      const spec = knobOf(key)
      if (!spec) {
        return { decision: 'refuse', reason: `${key} 不是可改的设置项。可改的只有:${KNOB_KEYS.join('、')}。` }
      }
      const verdict = spec.validate(normValue(args.value))
      if (!verdict.ok) {
        return { decision: 'refuse', reason: `${key} 的值不合法:${verdict.reason}(你给的是 ${JSON.stringify(args.value)})。` }
      }
      // 卡面上的「现在是什么」——读不到就少说这一句,绝不因此拒绝一个合法改动。
      //
      // catch 在这里是**承重的**,不是防御性编程:`GovernedActionToolset.classify`
      // 对分类器抛出的东西不设 catch(读过源码),于是一次装饰性的读盘失败会从
      // 闸里炸出去。判决必须只由上面那几行规则决定;这一句是给人看的注解,它
      // 有没有读到,改变不了「这个改动该不该问人」。
      let view: ButlerConfigKnobView | undefined
      try {
        view = (await ops.knobs()).find((k) => k.key === key)
      } catch (err) {
        deps.logger?.warn('butler config: current-value lookup failed', { key, err })
      }
      const now = view
        ? view.fileValue !== null
          ? `现在配置文件里是 ${view.fileValue}`
          : `配置文件里还没写过(默认 ${view.default})`
        : null
      const live = view && view.envValue !== null && view.envValue !== verdict.value
        ? `,当前进程在用 ${view.envValue}`
        : ''
      return {
        decision: 'approve',
        reason:
          `会把这台 hub 的 ${key} 改成 ${verdict.value}` +
          (now ? `(${now}${live})` : '') +
          '。写进服务器空间的 gotong.env,**下次重启才生效**——先请你确认。',
      }
    },
    // 一行读得全:整个参数空间被白名单封死(四个具名键 + 枚举/端口值),所以这
    // 句话长不出屏幕。IM 可批名单收它正是因为这个结构性事实。
    describe: (_name, args) => {
      const key = normKey(args.key) || '(未指定)'
      const spec = knobOf(key)
      const raw = normValue(args.value)
      // 归一化过的值(`always` / `8080`)才是人要读的那个;值不合法就**原样回显**
      // ——这一行是卡面,不是第二道校验(真拒绝在 classify,人根本看不到这张卡)。
      const verdict = spec?.validate(raw)
      const v = verdict?.ok ? verdict.value : raw
      return `把 hub 设置 ${key} 改成 ${v || '(空)'}`
    },
    execute: async (_name, args) => {
      // belt-and-suspenders:park→批准之间角色可能被降;批准补不回资格
      // (HANDS-M2 H1 同一条:classify 在 park 前问,execute 在批准后再问一遍)。
      if (!ops.privileged(userId)) {
        return { text: `你现在不是 owner/admin,没有执行。${REFUSE_ROLE}`, isError: true }
      }
      const key = normKey(args.key)
      const value = normValue(args.value)
      try {
        const out = await ops.set({ key, value, userId })
        const body = out.lines.length > 0 ? out.lines.join('\n') : '(no output)'
        return { text: `${body}\n下次重启这台 hub 时生效。` }
      } catch (err) {
        // ops-core 抛的是带说明的类型化错误(密钥名/未知旋钮/值不合法),原文
        // 就是给人看的那句话——透传,别翻译成一句更含糊的「失败了」。
        const message = err instanceof Error ? err.message : String(err)
        deps.logger?.warn('butler config: config-set failed', { key, err })
        return { text: `没有改成:${message}`, isError: true }
      }
    },
  })
}
