/**
 * STOR-M4 空间提案卡:`space_report` 之上长一节确定性「建议」。
 *
 * 形状承重(HANDS-M4 环境提案判别联合同款):
 *   - `applicable: true` 才有 `apply` 字段,且 apply **只指向 governed
 *     `set_retention` 的既有参数空间**(key ∈ RETENTION_KEYS、days 落在
 *     [RETENTION_MIN_DAYS, RETENTION_MAX_DAYS] 内)——提案不是新写入口,
 *     真落盘仍走那一条会 park 的路,批准闸一道不少。
 *   - `applicable: false` 那支**结构性没有 `apply`**:说得准「该做什么」
 *     但 hub 做不了/不该做的事(跑一次全量备份),连一个可执行字段都不长。
 *
 * 判定全是固定阈值 + 盘上事实,零 LLM 零墙钟(输入齐了输出就定了):
 *   P2(根因先说,排最前):上一轮保留阶梯有 skippedNoNet(翻篇内容没进
 *      备份安全网被跳过)且没有比那一轮更新的全量备份 ⇒ 建议人跑一次
 *      `gotong backup`。抑制只认**全量备份**时刻,刻意不查 git 侧新鲜度:
 *      per-user git 走树是阶梯自己的活,这里重算一遍就是第二份实现;state
 *      下一轮自会自愈,而备份侧恰是常见路——howTo 让人去跑备份,刚照做完
 *      还被同一张卡念叨最惹人烦。
 *   P1(逐键):该键保留期还没生效(策略整份缺席/坏形状折 null,或该键
 *      缺席——两种都如实是「没生效」,绝不说成「没设过」)且对应账本桶
 *      ≥ 阈值 ⇒ 建议设保留期。`truncated: true` 的账本是**下界**:桶已
 *      过线则真值只会更大,照常提案——截断要防的是「说小了」不是「说大了」。
 *   只有这两类。blockedAudit/failed 归巡检黄牌(一场事一张牌),根部
 *   `.bak-` 族归 M2 清扫器自动轮转,增长速率算不出(账本是单份覆写快照)。
 */

import type { Logger } from '@gotong/core'

import { fmtBytes, type SpaceLedgerFile } from './space-ledger.js'
import {
  loadRetentionPolicy,
  readFullBackupAt,
  readRetentionState,
  RETENTION_KEYS,
  type RetentionKey,
  type RetentionPolicy,
  type RetentionState,
} from './space-retention.js'

/** 一条建议。判别联合:`applicable: false` 那支结构性没有 `apply` 字段。 */
export type StorageProposal =
  | {
      readonly id: string
      readonly title: string
      readonly detail: string
      readonly applicable: true
      /** 唯一合法去处:governed `set_retention` 的既有参数空间。 */
      readonly apply: {
        readonly tool: 'set_retention'
        readonly key: RetentionKey
        readonly days: number
      }
    }
  | {
      readonly id: string
      readonly title: string
      readonly detail: string
      readonly applicable: false
      /** 该由人做的那一步,说准而不动手。 */
      readonly howTo: string
    }

/** 提案阈值:对应账本桶 ≥ 256 MiB 才开口(小空间不值得占一次人的注意力)。 */
export const PROPOSE_BUCKET_MIN_BYTES = 256 * 1024 * 1024

/** 每键的建议天数(全部落在 set_retention 的 [30, 3650] 合法区间内)。 */
export const PROPOSED_DAYS: Record<RetentionKey, number> = {
  memory_archive_days: 365,
  dossier_days: 180,
  departed_session_days: 90,
}

/**
 * 键 → 账本桶 id(space-ledger 对 butler/ 只展开一层的那套名字)。桶比阶梯
 * 视野粗:butler/memory 一桶里活跃记忆与 archive/ 混着——detail 里如实说清
 * 「保留期只清翻篇那一层」,绝不拿整桶体积冒充可回收体积。
 */
const KEY_BUCKET: Record<RetentionKey, string> = {
  memory_archive_days: 'butler/memory',
  dossier_days: 'butler/longrun',
  departed_session_days: 'butler/sessions',
}

/**
 * 人话键名。措辞镜像 set_retention 工具面(personal-butler-retention 的
 * KEY_LABEL,那份未导出且属治理层,这里不反向依赖)——纯展示不是执法点,
 * 两边说的是同一个闭集,漂移了也只是措辞不是语义。
 */
const KEY_LABEL: Record<RetentionKey, string> = {
  memory_archive_days: '知识库归档层',
  dossier_days: '长任务翻篇档案',
  departed_session_days: '离场成员会话窗',
}

/** 每键一句「只清什么」的诚实边界(detail 的第一半)。 */
const KEY_SCOPE: Record<RetentionKey, string> = {
  memory_archive_days: '这一桶里活跃记忆与翻篇归档混在一起;保留期只清 archive/ 里翻篇的旧知识,活书架与记忆本体不碰',
  dossier_days: '保留期只清 done/cancelled 的翻篇档案,还在跑或被卡住的任务不碰',
  departed_session_days: '保留期只清已不在成员名册里的人的会话窗,在册成员的窗不碰',
}

/** 提案引擎的四个事实源。任何一个为 null 都有明确方向(见各字段注)。 */
export interface StorageProposalInput {
  /** 空间账本;null = 还没丈量过/读不到 ⇒ 不提任何 P1(没有尺不开口)。 */
  readonly ledger: SpaceLedgerFile | null
  /** 保留策略;null = 缺席或坏形状 ⇒ 每个键都算「还没生效」。 */
  readonly policy: RetentionPolicy | null
  /** 上一轮阶梯的结果;null = 阶梯从没跑过 ⇒ 不提 P2(没有事实不开口)。 */
  readonly state: RetentionState | null
  /** 最近一次**全量**备份时刻(epoch ms);null = 没有/读不出。 */
  readonly fullBackupAt: number | null
}

/** 纯函数:同一份输入永远同一份输出(不读盘不看钟)。 */
export function proposeStorageActions(input: StorageProposalInput): StorageProposal[] {
  const out: StorageProposal[] = []
  // P2 排最前:它挡住的是**已武装**的键(根因),P1 只是建议武装更多键。
  const st = input.state
  if (st && st.skippedNoNet > 0 && !(input.fullBackupAt !== null && input.fullBackupAt > st.at)) {
    out.push({
      id: 'backup:no-net',
      title: `上一轮清理有 ${st.skippedNoNet} 件翻篇内容因为没进备份安全网被跳过`,
      detail:
        '删除成员内容有一条硬前置:必须已进最近一次全量备份或 git 快照;没有安全网就只跳过、绝不删。',
      applicable: false,
      howTo: '跑一次全量备份(命令行 `gotong backup`);之后的下一轮维护(约 6h 内)会自动重试。',
    })
  }
  const row = input.ledger
  if (row) {
    for (const key of RETENTION_KEYS) {
      if (input.policy?.[key] !== undefined) continue // 人已定过这一档,不二次开口
      const bucket = row.categories.find((c) => c.id === KEY_BUCKET[key])
      if (!bucket || bucket.bytes < PROPOSE_BUCKET_MIN_BYTES) continue
      out.push({
        id: `retention:${key}`,
        title: `${KEY_BUCKET[key]} 占 ${fmtBytes(bucket.bytes)},「${KEY_LABEL[key]}」的保留期还没生效`,
        detail: `${KEY_SCOPE[key]};且每条删除都要先进最近一次全量备份或 git 快照,没进就跳过并响亮说。`,
        applicable: true,
        apply: { tool: 'set_retention', key, days: PROPOSED_DAYS[key] },
      })
    }
  }
  return out
}

/** 渲染成 `space_report` 尾部那一节;空清单 ⇒ 空串(报告一个字不多)。 */
export function renderStorageProposals(proposals: readonly StorageProposal[]): string {
  if (proposals.length === 0) return ''
  const applicable = proposals.filter((p) => p.applicable).length
  const lines: string[] = [
    `【空间建议】按固定阈值算出来的 ${proposals.length} 条(其中 ${applicable} 条我能帮你改,改之前会先送你批准):`,
  ]
  for (const p of proposals) {
    lines.push(`• ${p.title}`)
    lines.push(`  ${p.detail}`)
    if (p.applicable) {
      lines.push(
        `  → 对我说「把${KEY_LABEL[p.apply.key]}保留期设为 ${p.apply.days} 天」,我会走 set_retention 送你批准;生效在下一轮维护(约 6h 内)。`,
      )
    } else {
      lines.push(`  → ${p.howTo}`)
    }
  }
  return lines.join('\n')
}

/**
 * 装配缝:给 `space_report` 的可选 proposals thunk(返回渲染好的一节,
 * '' = 没建议)。四个事实源并行读;读者们各自把「读不动」折 null,引擎对
 * null 的方向都定好了(没账本不提 P1、没 state 不提 P2)。
 */
export function storageProposalsAt(
  spaceDir: string,
  ledger: () => Promise<SpaceLedgerFile | null>,
  logger?: Pick<Logger, 'warn'>,
): () => Promise<string> {
  return async () => {
    const [row, policy, state, fullBackupAt] = await Promise.all([
      ledger().catch(() => null),
      loadRetentionPolicy(spaceDir, logger),
      readRetentionState(spaceDir),
      readFullBackupAt(spaceDir),
    ])
    return renderStorageProposals(proposeStorageActions({ ledger: row, policy, state, fullBackupAt }))
  }
}
