/**
 * Public surface of `@gotong/cli` — `runCli` plus the FDE-M3 `provision`
 * body (programmatic install+schedules+acceptance against a running hub;
 * its injectable out/err/fetch seams are what integration tests and
 * deploy scripts want). The rest of the package is internal; consumers
 * either invoke the bin directly or call these from code.
 */

export { runCli } from './main.js'
export { provision, type ProvisionDeps } from './commands/provision.js'
// AFR-M7 — 阿同恢复层直接调 CLI 的 backup()(host 本就依赖本包;同一份打包
// 代码,不 shell-out 不复制),并读 backup 成功后落的「上次备份」事实。
export { backup, type BackupDeps } from './commands/backup.js'
// AFR-M8 — capstone 走真 restore(),投影文件名同源不复刻。
export { restore, type RestoreDeps } from './commands/restore.js'
export {
  LAST_BACKUP_FACT_FORMAT,
  LAST_BACKUP_FACT_NAME,
  PEERS_PROJECTION_NAME,
  parseLastBackupFact,
  type LastBackupFact,
  type PeersProjection,
} from './commands/backup-core.js'
