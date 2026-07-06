/**
 * `gotong backup <space-dir> <backup-dir> [--include-master-key]` —
 * TS 原生备份,Windows / 便携包也能跑(.sh 版原样保留给服务器 cron)。
 *
 * 语义逐字对齐 `scripts/backup/backup.sh`(排除规则见 backup-core.ts
 * 文件头),两点实现差异都是为了「恢复前可验证」:
 *
 *   - **stage-while-hashing**:每个文件只读一次,同一份字节既算
 *     sha256 又落 staging 目录,tar 打的是 staging——即使源目录里
 *     transcript 正在追加,归档字节也严格等于清单里的 hash。直接
 *     对着活目录打 tar 就做不到这一点(读两次之间文件变了)。
 *   - 归档根部多一份 `gotong-backup-manifest.json`;restore 靠它先
 *     验后落盘。
 *
 * identity.sqlite 是 WAL 模式,原样拷贝在活写下会撕裂。诚实阶梯:
 *   ① better-sqlite3(cli 的 optionalDependency,装不上不报错)
 *      → SQLite online backup API,WAL 安全;
 *   ② sqlite3 CLI `.backup`(与 .sh 同一招);
 *   ③ 原样拷贝 db/-wal/-shm 三件 + 大声警告——绝不静默降级。
 *
 * 空目录不进清单(清单以文件为单位);host 启动时自愈目录结构
 * (`gotong setting fix-dirs` 亦可),不为它们发明清单条目。
 *
 * 退出码与 .sh 对齐:0 成功 / 1 用法错 / 2 源目录不合法 / 3 归档失败。
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import * as tar from 'tar'

import {
  MANIFEST_NAME,
  MANIFEST_FORMAT,
  backupFileName,
  shouldSkipForStaging,
  type BackupManifest,
  type ManifestFile,
} from './backup-core.js'

const execFileP = promisify(execFile)

/** better-sqlite3 的最小鸭子面——optionalDependency,装不上时 import 会 throw。 */
interface SqliteDriverModule {
  default: new (
    path: string,
    opts?: { readonly?: boolean; fileMustExist?: boolean },
  ) => { backup(dest: string): Promise<unknown>; close(): void }
}

/** Injectable seams:测试用来强迫阶梯逐级失败,验证诚实降级的措辞。 */
export interface BackupDeps {
  out?: (line: string) => void
  err?: (line: string) => void
  now?: () => Date
  /** 阶梯①:加载 better-sqlite3(默认动态 import,缺席即 throw)。 */
  loadDriver?: () => Promise<SqliteDriverModule>
  /** 阶梯②:sqlite3 CLI `.backup`,cwd 定在快照目录,目标名固定免引号地狱。 */
  runSqlite3?: (srcAbs: string, destCwd: string) => Promise<void>
}

/** 递归收集 root 下全部普通文件的 leaf 相对路径(POSIX 分隔),排好序。 */
function walkFiles(root: string, warn: (line: string) => void): string[] {
  const acc: string[] = []
  const visit = (rel: string): void => {
    const abs = rel === '' ? root : join(root, rel)
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? ent.name : `${rel}/${ent.name}`
      if (ent.isDirectory()) visit(childRel)
      else if (ent.isFile()) acc.push(childRel)
      else warn(`⚠ skipped non-regular file (symlink/socket): ${childRel}`)
    }
  }
  visit('')
  return acc.sort()
}

/** 读一次字节 → 同一份既算 hash 又落 staging(stage-while-hashing 的最小单元)。 */
function stageFile(srcAbs: string, destAbs: string, rel: string): ManifestFile {
  const bytes = readFileSync(srcAbs)
  mkdirSync(join(destAbs, '..'), { recursive: true })
  writeFileSync(destAbs, bytes)
  return { path: rel, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** 已在 staging 里躺平的文件(快照产物),补算清单条目。 */
function manifestEntryOf(stagedAbs: string, rel: string): ManifestFile {
  const bytes = readFileSync(stagedAbs)
  return { path: rel, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

const USAGE = `Usage: gotong backup <space-dir> <backup-dir> [--include-master-key]

Arguments:
  <space-dir>    Path to the .gotong/ workspace directory.
  <backup-dir>   Where to write the .tar.gz. Created if missing.

Flags:
  --include-master-key   Moving-house mode: ALSO archive runtime/secret.key and
                         the identity-master.key* family. The archive can then
                         decrypt everything — treat it as a credential.

Always excluded (no flag): runtime/admin-sessions.json, runtime/worker-sessions.json.
`

export async function backup(args: readonly string[], deps: BackupDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => { console.log(l) })
  const err = deps.err ?? ((l: string) => { console.error(l) })
  const now = deps.now ?? (() => new Date())
  const loadDriver = deps.loadDriver ?? (() => import('better-sqlite3') as unknown as Promise<SqliteDriverModule>)
  const runSqlite3 =
    deps.runSqlite3 ??
    (async (srcAbs: string, destCwd: string) => {
      await execFileP('sqlite3', [srcAbs, ".backup 'identity.sqlite'"], { cwd: destCwd })
    })

  let spaceDir = ''
  let backupDir = ''
  let includeMasterKey = false
  for (const a of args) {
    if (a === '--include-master-key') includeMasterKey = true
    else if (a === '-h' || a === '--help') {
      out(USAGE)
      return 0
    } else if (a.startsWith('-')) {
      err(`unknown flag: ${a}`)
      err(USAGE)
      return 1
    } else if (!spaceDir) spaceDir = a
    else if (!backupDir) backupDir = a
    else {
      err(`unexpected extra argument: ${a}`)
      err(USAGE)
      return 1
    }
  }
  if (!spaceDir || !backupDir) {
    err(USAGE)
    return 1
  }

  const spaceAbs = resolve(spaceDir)
  if (!existsSync(spaceAbs) || !statSync(spaceAbs).isDirectory()) {
    err(`✖ space dir does not exist: ${spaceDir}`)
    return 2
  }
  if (!existsSync(join(spaceAbs, 'space.json'))) {
    err(`✖ '${spaceDir}' does not look like a Gotong workspace (no space.json found)`)
    return 2
  }

  const label = basename(spaceAbs) || 'space'
  const outDir = resolve(backupDir)
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, backupFileName(label, now()))

  const staging = mkdtempSync(join(tmpdir(), 'gotong-backup-'))
  const stagingLeaf = join(staging, label)
  mkdirSync(stagingLeaf, { recursive: true })
  try {
    const files: ManifestFile[] = []
    for (const rel of walkFiles(spaceAbs, err)) {
      if (shouldSkipForStaging(rel, includeMasterKey)) continue
      files.push(stageFile(join(spaceAbs, rel), join(stagingLeaf, rel), rel))
    }

    // identity.sqlite 快照阶梯(见文件头);快照落定后文件已静止,补 hash 安全。
    const dbAbs = join(spaceAbs, 'identity.sqlite')
    if (existsSync(dbAbs)) {
      const snapAbs = join(stagingLeaf, 'identity.sqlite')
      let rung: 'driver' | 'cli' | 'raw' = 'raw'
      try {
        const mod = await loadDriver()
        const db = new mod.default(dbAbs, { readonly: true, fileMustExist: true })
        try {
          await db.backup(snapAbs)
        } finally {
          db.close()
        }
        rung = 'driver'
      } catch {
        try {
          await runSqlite3(dbAbs, stagingLeaf)
          if (!existsSync(snapAbs)) throw new Error('sqlite3 .backup produced no file')
          rung = 'cli'
        } catch {
          rung = 'raw'
        }
      }
      if (rung === 'raw') {
        err('⚠ identity.sqlite present but no WAL-safe copier (better-sqlite3 / sqlite3 CLI')
        err('  both unavailable) — archiving the raw WAL-mode files. A write racing the')
        err('  backup can tear the copy; install sqlite3 or stop the host for a consistent snapshot.')
        rmSync(snapAbs, { force: true })
        for (const suffix of ['', '-wal', '-shm']) {
          const raw = `${dbAbs}${suffix}`
          if (existsSync(raw)) {
            copyFileSync(raw, `${snapAbs}${suffix}`)
            files.push(manifestEntryOf(`${snapAbs}${suffix}`, `identity.sqlite${suffix}`))
          }
        }
      } else {
        out(`→ identity.sqlite: consistent snapshot via ${rung === 'driver' ? 'better-sqlite3 backup API' : "sqlite3 .backup"} (WAL-safe)`)
        files.push(manifestEntryOf(snapAbs, 'identity.sqlite'))
      }
    }

    files.sort((a, b) => (a.path < b.path ? -1 : 1))
    const manifest: BackupManifest = {
      format: MANIFEST_FORMAT,
      createdAt: now().toISOString(),
      label,
      includesMasterKey: includeMasterKey,
      files,
    }
    writeFileSync(join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    out(`→ archiving ${spaceDir} → ${outFile}`)
    try {
      await tar.create({ gzip: true, cwd: staging, file: outFile }, [label, MANIFEST_NAME])
    } catch (e) {
      rmSync(outFile, { force: true })
      err(`✖ tar failed: ${e instanceof Error ? e.message : String(e)}`)
      return 3
    }

    const size = statSync(outFile).size
    const human = size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)}M` : `${Math.max(1, Math.round(size / 1024))}K`
    out(`✓ backup written: ${outFile} (${human}, ${files.length} files)`)
    out('')
    if (includeMasterKey) {
      out('⚠ 密级备份: this archive INCLUDES the master keys (runtime/secret.key /')
      out('  identity-master.key*). Whoever can read it can decrypt EVERY secret in the')
      out('  workspace — treat the file itself as a credential: encrypt it in transit,')
      out('  store it like a password, delete intermediate copies after the move.')
    } else {
      out('Reminder: master keys were intentionally NOT included — neither')
      out('runtime/secret.key (v3) nor identity-master.key (v4 vault KEK).')
      out('Keep them safe and SEPARATE; each is required to decrypt its')
      out('ciphertext (secrets.enc.json / identity.sqlite) on restore.')
      out('See docs/OPERATIONS.md.')
    }
    return 0
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
