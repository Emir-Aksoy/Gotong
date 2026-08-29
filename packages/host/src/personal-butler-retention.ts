/**
 * personal-butler-retention.ts — STOR-M3: governed `set_retention`,把「成员内容
 * 多久后自动删」这个策略决定搬上手机(说人话 → park → `/approve <短码>`)。
 *
 * 形状逐字镜像 `personal-butler-config.ts`(HANDS-M3c 先例),三条承重边界同源:
 *
 * 1. **写只有一处**:execute 走 `writeRetentionPolicy`(space-retention.ts 的
 *    per-space 写链 + 原子落盘 + 写前验),与将来任何别的写面同一个咽喉。
 * 2. **classify 是同一套规则的预检**:键闭集 / 值域 30..3650 / days⊕reset 互斥,
 *    与 writeRetentionPolicy 的写前验逐字一致——「批准了」蕴含「真的会落盘」。
 * 3. **参数空间封死**:key 是 `RETENTION_KEYS` 闭集 enum,值是有界整数天数或
 *    reset 布尔。整个动作一行读得全不是因为文案短,是因为它**长不出来**——
 *    这正是它能进 `IM_APPROVABLE_TOOLS` 列举名单的结构性理由(与 set_hub_config
 *    同一条论证)。
 *
 * 与 set_hub_config 的两处刻意不同:
 * - **生效路径不同**:这里写的是 retention.json,阶梯每轮维护**新读**它 ⇒ 批准
 *   后「下一轮维护生效(约 6h 内)」,不是「下次重启生效」。两句话别抄串。
 * - **无脱敏器**:所有文案零路径(成功句只提文件名 retention.json;写失败收窄成
 *   固定人话),没有需要换成 `<space>` 的字节。
 */

import type { Logger } from '@gotong/core'
import { AUDIT_ACTIONS } from '@gotong/identity'
import { GovernedActionToolset } from '@gotong/personal-butler'

import {
  loadRetentionPolicy,
  writeRetentionPolicy,
  RETENTION_FILE,
  RETENTION_KEYS,
  RETENTION_MIN_DAYS,
  RETENTION_MAX_DAYS,
  type RetentionKey,
  type RetentionPolicy,
} from './space-retention.js'
import type { SettingAuditSink } from './setting-ops-service.js'

/** 键的人话标签——审批卡上「改的是哪一类内容」必须一眼能读。 */
const KEY_LABEL: Record<RetentionKey, string> = {
  memory_archive_days: '知识库归档层(archive/ 里翻篇的旧知识)',
  dossier_days: '长任务翻篇档案(done/cancelled 的 dossier)',
  departed_session_days: '离场成员的会话窗',
}

/** classify / execute 共用的一份 ops——owner/admin 判定钉在这,服务端权威。 */
export interface ButlerRetentionOps {
  /** 改内容保留策略 = owner/admin(与 set_hub_config 同姿态)。 */
  privileged(userId: string): boolean
  /** 当前策略;读不到 = null(审批卡少一句「现在是 X」,绝不因此拒绝)。 */
  current(): Promise<RetentionPolicy | null>
  /** 真写:走 space-retention 的写链咽喉。 */
  write(input: { key: RetentionKey; days?: number; reset?: boolean; userId: string }): Promise<RetentionPolicy>
}

export interface ButlerRetentionOpsDeps {
  spaceDir: string
  /** identity 窄切片:成员角色(null/undefined = 无 membership)。 */
  membershipRole: (userId: string) => string | null | undefined
  /** 审计沉降口——复用 setting 台那个类型(闭集不在第二个入口放开),缺席 = 照写不记账。 */
  audit?: SettingAuditSink
  logger?: Pick<Logger, 'warn'>
}

export function buildButlerRetentionOps(deps: ButlerRetentionOpsDeps): ButlerRetentionOps {
  return {
    privileged(userId) {
      const role = deps.membershipRole(userId)
      return role === 'owner' || role === 'admin'
    },
    async current() {
      return loadRetentionPolicy(deps.spaceDir, deps.logger)
    },
    async write({ key, days, reset, userId }) {
      const updated = await writeRetentionPolicy(
        deps.spaceDir,
        (current) => {
          const next: Record<string, number> = { ...current }
          if (reset) delete next[key]
          else next[key] = days as number
          return next as RetentionPolicy
        },
        deps.logger,
      )
      try {
        deps.audit?.writeAuditLog?.({
          action: AUDIT_ACTIONS.SETTING_CONFIG_WRITE,
          actorSource: 'v4-session',
          actorUserId: userId,
          metadata: { kind: 'retention', key, ...(reset ? { reset: true } : { days }) },
          success: true,
        })
      } catch {
        // best-effort — 字节已经落盘了,审计打嗝绝不能变成写失败。
      }
      return updated
    },
  }
}

// ─── governed set_retention ──────────────────────────────────────────────────

const REFUSE_ROLE = '改内容保留策略只对 owner/admin 开放。'

const WRITE_FAILED = '写不进去(磁盘或权限的问题)。这一项没有改动。详细原因在服务器日志里。'

function normKey(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function isRetentionKey(v: string): v is RetentionKey {
  return (RETENTION_KEYS as readonly string[]).includes(v)
}

/**
 * 天数归一:整数、或长得像整数的字符串(模型很容易吐 `"90"`)。范围与
 * writeRetentionPolicy 的写前验逐字一致——分叉 = 人为一件落不了盘的事花掉审批。
 */
function normDays(v: unknown): number | null {
  let n: number
  if (typeof v === 'number') n = v
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v.trim())
  else return null
  if (!Number.isInteger(n) || n < RETENTION_MIN_DAYS || n > RETENTION_MAX_DAYS) return null
  return n
}

export interface ButlerRetentionToolsetDeps {
  /** 这位成员——owner/admin 判定按它查(服务端权威,绝不信模型自报)。 */
  userId: string
  ops: ButlerRetentionOps
  logger?: Pick<Logger, 'warn'>
}

/**
 * governed 保留策略闸。verdict 永远 approve(每次 park,无 blanket grant——
 * 会删成员内容的策略比端口更配得上这个姿态),owner/admin 之外与坏参数一律在
 * park **之前** refuse。
 */
export function buildButlerRetentionToolset(deps: ButlerRetentionToolsetDeps): GovernedActionToolset {
  const { userId, ops } = deps
  return new GovernedActionToolset({
    tools: [
      {
        name: 'set_retention',
        description:
          '改成员内容的自动保留策略:三类翻篇内容(知识库归档层 / 已完结的长任务档案 / 离场成员的会话窗)各自多少天后自动删。会先把改动送进 /me 收件箱等你批准,批准后写进 retention.json,下一轮后台维护(约 6h 内)生效。硬前置:内容删除前必须已进最近一次全量备份或 git 快照,没有安全网的一律跳过并在体检里响亮说——不会静默删。仅 owner/admin;不设某个键 = 那一类永不自动删(默认全都不删)。',
        inputSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              enum: [...RETENTION_KEYS],
              description: '要改哪一类内容的保留天数',
            },
            days: {
              type: 'integer',
              description: `保留多少天(${RETENTION_MIN_DAYS}-${RETENTION_MAX_DAYS};下限是读者感知保护线)。与 reset 二选一。`,
            },
            reset: {
              type: 'boolean',
              description: '设 true = 移除这个键,回到「这一类永不自动删」。与 days 二选一。',
            },
          },
          required: ['key'],
          additionalProperties: false,
        },
        defaultVerdict: {
          decision: 'approve',
          reason: '会改成员内容的保留策略(决定哪些旧内容多久后自动删)——先请你确认',
        },
      },
    ],
    // 顺序:角色 → 键闭集 → days⊕reset 互斥 → 值域。与 writeRetentionPolicy 的
    // 写前验逐字一致——classify 是同一套规则的预检,不是第二套策略。
    classify: async (_name, args) => {
      if (!ops.privileged(userId)) return { decision: 'refuse', reason: REFUSE_ROLE }
      const key = normKey(args.key)
      if (!key) return { decision: 'refuse', reason: `要改哪一类?可改的只有:${RETENTION_KEYS.join('、')}。` }
      if (!isRetentionKey(key)) {
        return { decision: 'refuse', reason: `${key} 不是保留策略的键。可改的只有:${RETENTION_KEYS.join('、')}。` }
      }
      const reset = args.reset === true
      if (reset && args.days !== undefined) {
        return { decision: 'refuse', reason: '一次只做一件:要么给 days 设保留天数,要么 reset 移除这个键,别同时给。' }
      }
      let days: number | null = null
      if (!reset) {
        days = normDays(args.days)
        if (days === null) {
          return {
            decision: 'refuse',
            reason: `days 要是 ${RETENTION_MIN_DAYS}-${RETENTION_MAX_DAYS} 的整数天(下限 ${RETENTION_MIN_DAYS} 天是读者感知保护线),你给的是 ${JSON.stringify(args.days)}。要移除这个键用 reset: true。`,
          }
        }
      }
      // 卡面上的「现在是什么」——读不到就少说这一句,绝不因此拒绝一个合法改动。
      // catch 是**承重的**:`GovernedActionToolset.classify` 对分类器抛出的东西
      // 不设 catch(HANDS-M3c 同一条),装饰性读盘失败不许从闸里炸出去。
      let now: string | null = null
      try {
        const cur = await ops.current()
        const v = cur?.[key]
        now = v !== undefined ? `现在是 ${v} 天` : '现在没设(这一类不自动删)'
      } catch (err) {
        deps.logger?.warn('butler retention: current-policy lookup failed', { key, err })
      }
      const action = reset
        ? `会把「${KEY_LABEL[key]}」的自动保留移除——这一类从此不自动删`
        : `会把「${KEY_LABEL[key]}」设为保留 ${days} 天,更旧的翻篇内容在**已进最近一次全量备份或 git 快照**的前提下自动删(没进安全网的跳过并响亮说)`
      return {
        decision: 'approve',
        reason: `${action}${now ? `(${now})` : ''}。写进 retention.json,下一轮后台维护(约 6h 内)生效——先请你确认。`,
      }
    },
    // 一行读得全:键是闭集、值是有界整数,这句话长不出来。键不在闭集就打
    // '(未指定)'——比 config 先例更严:这一行会进人的聊天窗,零自由文本回显。
    describe: (_name, args) => {
      const raw = normKey(args.key)
      const key = isRetentionKey(raw) ? raw : '(未指定)'
      if (args.reset === true) return `移除内容保留策略 ${key}(这一类不再自动删)`
      const days = normDays(args.days)
      return `把内容保留策略 ${key} 设为 ${days ?? '(值不合法)'} 天`
    },
    execute: async (_name, args) => {
      // belt-and-suspenders:park→批准之间角色可能被降;批准补不回资格
      // (HANDS-M2 H1 同一条:classify 在 park 前问,execute 在批准后再问一遍)。
      if (!ops.privileged(userId)) {
        return { text: `你现在不是 owner/admin,没有执行。${REFUSE_ROLE}`, isError: true }
      }
      const key = normKey(args.key)
      if (!isRetentionKey(key)) {
        return { text: `没有改成:${key || '(空)'} 不是保留策略的键。`, isError: true }
      }
      const reset = args.reset === true
      const days = reset ? undefined : normDays(args.days)
      if (!reset && days === null) {
        return { text: `没有改成:days 不合法(要 ${RETENTION_MIN_DAYS}-${RETENTION_MAX_DAYS} 的整数天)。`, isError: true }
      }
      try {
        const updated = await ops.write({ key, days: days ?? undefined, reset, userId })
        const v = updated[key]
        const line = reset
          ? `已移除 ${key}——「${KEY_LABEL[key]}」从此不自动删。`
          : `已把 ${key} 设为 ${v} 天。更旧的翻篇内容会在进过备份/快照安全网后,由下一轮后台维护(约 6h 内)开始自动清理;没进安全网的会跳过并在体检里说。`
        return { text: `${line}(写进了 ${RETENTION_FILE})` }
      } catch (err) {
        deps.logger?.warn('butler retention: policy write failed', { key, err })
        return { text: `没有改成:${WRITE_FAILED}`, isError: true }
      }
    },
  })
}
