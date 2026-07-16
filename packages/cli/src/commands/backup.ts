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
  PEERS_PROJECTION_NAME,
  backupFileName,
  buildPeersProjection,
  shouldSkipForStaging,
  type BackupManifest,
  type BackupTier,
  type ManifestFile,
} from './backup-core.js'

const execFileP = promisify(execFile)

/** better-sqlite3 的最小鸭子面——optionalDependency,装不上时 import 会 throw。
 *  prepare 可选:既有测试的假 driver 只实现 backup/close,缺 prepare 时
 *  relations 档的读取阶梯自动落到 sqlite3 CLI 一级。 */
interface SqliteDriverModule {
  default: new (
    path: string,
    opts?: { readonly?: boolean; fileMustExist?: boolean },
  ) => {
    backup(dest: string): Promise<unknown>
    prepare?(sql: string): { all(): unknown[] }
    close(): void
  }
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
  /** relations 档阶梯②:sqlite3 CLI `-json` 只读查询,返回 stdout。 */
  runSqlite3Query?: (dbAbs: string, sql: string) => Promise<string>
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

/**
 * AFR-M6 relations 档:只读读出 peers 原始行。诚实阶梯(镜像快照阶梯):
 * ① better-sqlite3 readonly 查询 → ② sqlite3 CLI `-json` → ③ **响亮失败**
 * (throw,调用方 exit 3)——投影是这一档的主要载荷,静默降成身份档就是
 * 说谎。peers 表不存在(极老库)= 真·零 peer,如实空投影,不算失败。
 */
async function readPeerRows(
  dbAbs: string,
  loadDriver: () => Promise<SqliteDriverModule>,
  runSqlite3Query: (dbAbs: string, sql: string) => Promise<string>,
): Promise<unknown[]> {
  const EXISTS_SQL = "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='peers'"
  const SELECT_SQL = 'SELECT * FROM peers ORDER BY peer_id'
  try {
    const mod = await loadDriver()
    const db = new mod.default(dbAbs, { readonly: true, fileMustExist: true })
    try {
      if (!db.prepare) throw new Error('driver lacks prepare()')
      const n = (db.prepare(EXISTS_SQL).all()[0] as { n?: number } | undefined)?.n ?? 0
      return n === 0 ? [] : db.prepare(SELECT_SQL).all()
    } finally {
      db.close()
    }
  } catch {
    // 落 CLI 一级;这级再失败就往上抛,不静默。
  }
  const existsOut = (await runSqlite3Query(dbAbs, EXISTS_SQL)).trim()
  const n = ((JSON.parse(existsOut || '[]') as { n?: number }[])[0]?.n ?? 0) as number
  if (n === 0) return []
  const rowsOut = (await runSqlite3Query(dbAbs, SELECT_SQL)).trim()
  return JSON.parse(rowsOut || '[]') as unknown[]
}

const USAGE = `Usage: gotong backup <space-dir> <backup-dir> [--tier=identity|relations] [--include-master-key]

Arguments:
  <space-dir>    Path to the .gotong/ workspace directory.
  <backup-dir>   Where to write the .tar.gz. Created if missing.

Flags:
  --tier=identity        Identity-only subset: the card-signing key (your kid)
                         ± the public agent card ± space.json. Tiny — printable.
                         NEVER contains the vault, master keys, or member data.
  --tier=relations       Identity subset PLUS a non-secret projection of your
                         peers (who you know: endpoint / pinned kid / trust
                         tier). Peer TOKENS stay in the vault — restoring this
                         recovers "who I know", not "can connect"; reconnecting
                         needs the other side to re-mint a token.
  --include-master-key   Moving-house mode (full archive only): ALSO archive
                         runtime/secret.key and the identity-master.key* family.
                         The archive can then decrypt everything — treat it as
                         a credential. Cannot be combined with --tier.

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
  let tier: BackupTier | undefined
  const argv = [...args]
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--include-master-key') includeMasterKey = true
    else if (a === '--tier' || a.startsWith('--tier=')) {
      const v = a === '--tier' ? argv[++i] : a.slice('--tier='.length)
      if (v !== 'identity' && v !== 'relations') {
        err(`invalid --tier value: ${v ?? '(missing)'} (expected identity | relations)`)
        err(USAGE)
        return 1
      }
      tier = v
    } else if (a === '-h' || a === '--help') {
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
  if (tier && includeMasterKey) {
    // 子集档的全部意义就是「绝不含金库·主钥字节」——这不是能组合的偏好。
    err('✖ --tier and --include-master-key cannot be combined: subset tiers NEVER carry master keys.')
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
      if (shouldSkipForStaging(rel, includeMasterKey, tier)) continue
      files.push(stageFile(join(spaceAbs, rel), join(stagingLeaf, rel), rel))
    }

    // AFR-M6 身份档诚实提示:没启用过名片签名的空间没有签名钥文件,
    // 档案只剩公开名片/space.json——如实说,不假装打包了密码学身份。
    if (tier && !existsSync(join(spaceAbs, 'agent-card-signing.key'))) {
      err('⚠ no agent-card-signing.key in this space (card signing never enabled) —')
      err('  the identity tier carries no cryptographic identity, only the public')
      err('  card / space marker. Enable GOTONG_A2A_SIGN_CARD to mint one.')
    }

    // AFR-M6 relations 档:peers 非密投影。令牌在金库,投影结构性无令牌
    // 字段(见 backup-core.buildPeersProjection);读取失败响亮退出,绝不
    // 静默降成身份档。
    if (tier === 'relations') {
      const dbAbs = join(spaceAbs, 'identity.sqlite')
      let rows: unknown[] = []
      if (existsSync(dbAbs)) {
        const runQuery =
          deps.runSqlite3Query ??
          (async (db: string, sql: string) => (await execFileP('sqlite3', ['-json', db, sql])).stdout)
        try {
          rows = await readPeerRows(dbAbs, loadDriver, runQuery)
        } catch (e) {
          err('✖ relations tier needs to read peers from identity.sqlite, but neither')
          err('  better-sqlite3 nor the sqlite3 CLI is available — install one and retry.')
          err(`  (${e instanceof Error ? e.message : String(e)})`)
          return 3
        }
      } else {
        out('→ no identity.sqlite in this space — zero peers, projection will be empty (honest).')
      }
      const projection = buildPeersProjection(rows, now().toISOString())
      const projAbs = join(stagingLeaf, PEERS_PROJECTION_NAME)
      writeFileSync(projAbs, `${JSON.stringify(projection, null, 2)}\n`, 'utf8')
      files.push(manifestEntryOf(projAbs, PEERS_PROJECTION_NAME))
      out(`→ peers projection: ${projection.peers.length} peer(s), tokens NOT included (they live in the vault)`)
    }

    // identity.sqlite 快照阶梯(见文件头);快照落定后文件已静止,补 hash 安全。
    // 分档时整个不跑:金库密文在 sqlite 里,子集档结构性不含它。
    const dbAbs = join(spaceAbs, 'identity.sqlite')
    if (!tier && existsSync(dbAbs)) {
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
      ...(tier ? { tier } : {}), // 全空间档不写 tier 字段,旧清单字节形状不变
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
    if (tier) {
      out(`Subset archive (tier: ${tier}) — NO vault, NO master keys, NO member data.`)
      if (tier === 'identity') {
        out('Restoring the signing key keeps your kid stable: peers who pinned it')
        out('still recognize you. Small enough to print / stash offline.')
      } else {
        out('Peer tokens live in the vault and are NOT here: restoring recovers')
        out('"who I know" (endpoint / pinned kid / trust tier), not "can connect" —')
        out('reconnecting needs the other side to re-mint (gotong mint-peer-token).')
      }
      out('Restore into a FRESH directory; never --force it over a full workspace.')
    } else if (includeMasterKey) {
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
