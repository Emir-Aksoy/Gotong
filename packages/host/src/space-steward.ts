/**
 * STOR 存储管家 —— 对外(examples/测试)的单入口 barrel。
 *
 * host 根入口只有 `import './main.js'`(import 即把整台 host 跑起来,AFR-M8 判例),
 * 所以 capstone 这类「引真件不复刻」的消费者必须走子路径导出;四个 space-* 文件
 * 各自的导出面在这里**逐名**列出——刻意不用 `export *`:两个来源一旦都长出同名
 * 导出,star 会把那个名字静默丢掉(ES 模块语义),而逐名清单让冲突在编译期响亮。
 */

export {
  SPACE_LEDGER_MAX_ENTRIES,
  readSpaceLedger,
  measureSpaceLedger,
  fmtBytes,
  renderSpaceReport,
  spaceSummaryLine,
  buildButlerSpaceReportToolset,
  spaceLedgerAt,
  type SpaceLedgerCategory,
  type SpaceLedgerFile,
  type MeasureSpaceLedgerOptions,
  type ButlerSpaceReportDeps,
} from './space-ledger.js'

export {
  TMP_ORPHAN_MIN_AGE_MS,
  CORRUPT_KEEP,
  BAK_KEEP,
  SPACE_ACTIONS_FILE,
  readSpaceActions,
  makeAuditAppender,
  sweepSpaceOnce,
  spaceUpkeepAt,
  type SpaceActionEntry,
  type SpaceSweepResult,
  type SpaceSweepOptions,
} from './space-sweeper.js'

export {
  RETENTION_FILE,
  RETENTION_KEYS,
  RETENTION_MIN_DAYS,
  RETENTION_MAX_DAYS,
  RETENTION_STATE_FILE,
  loadRetentionPolicy,
  writeRetentionPolicy,
  readFullBackupAt,
  gitHeadEpochMs,
  readRetentionState,
  retentionLadderOnce,
  buildRetentionLadder,
  type RetentionKey,
  type RetentionPolicy,
  type RetentionLadderResult,
  type RetentionLadderOptions,
  type RetentionLadderDeps,
  type RetentionState,
} from './space-retention.js'

export {
  PROPOSE_BUCKET_MIN_BYTES,
  PROPOSED_DAYS,
  proposeStorageActions,
  renderStorageProposals,
  storageProposalsAt,
  type StorageProposal,
  type StorageProposalInput,
} from './space-proposals.js'
