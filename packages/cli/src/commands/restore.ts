/**
 * `gotong restore <backup.tar.gz> --space <dir> [--force]` — 先验后落盘。
 *
 * 与 `setting restore`(shell 出 restore.sh,服务器姿态)不同,这条是
 * TS 原生、跨平台,且**只认带清单的归档**(`gotong backup` 产物):
 *
 *   ① 解压到目标同级的临时目录(同一文件系统,rename 原子生效);
 *   ② 读归档根部 gotong-backup-manifest.json,逐文件核 sha256 + 尺寸
 *      + 文件集双向比对——任何一条不符就整体拒绝,**目标目录一字不动**;
 *   ③ 全绿才移入目标。已存在的非空目标必须 `--force`,且旧内容在新
 *      内容验证通过之后才被替换(先移开、后删除,中途失败可回滚);
 *   ④ 恢复完自动跑 `@gotong/host/check` 的定义校验(lazy 解析,host
 *      缺席则提示跳过)——check 红只警告不改判,恢复本身已完成。
 *
 * 旧 .sh 归档没有清单:拒绝并指路 scripts/backup/restore.sh,不做
 * 「跳过校验」开关——无清单恢复的口子一开,篡改检测就名存实亡。
 *
 * 退出码:0 成功 / 1 用法错 / 2 目标目录拒绝 / 3 归档不存在或解压失败
 * / 4 清单缺失或校验不符。
 */

import { createHash } from 'node:crypto'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import * as tar from 'tar'

import { MANIFEST_NAME, parseManifest, verifyManifest } from './backup-core.js'
import { resolveModule } from './start.js'

const HOST_PKG = '@gotong/host'
// 变量而非字面量:tsc 只在字面量 import() 上做构建期解析——同 check.ts 的招。
const CHECK_PKG = '@gotong/host/check'

interface CheckModule {
  runCheckCli: (deps?: {
    argv?: readonly string[]
    env?: Record<string, string | undefined>
  }) => Promise<number>
}

export interface RestoreDeps {
  out?: (line: string) => void
  err?: (line: string) => void
  resolveHost?: () => string | null
  importCheck?: () => Promise<CheckModule>
}

const USAGE = `Usage: gotong restore <backup.tar.gz> --space <dir> [--force]

Arguments:
  <backup.tar.gz>   A backup produced by \`gotong backup\` (must contain
                    ${MANIFEST_NAME}; for legacy .sh backups use
                    scripts/backup/restore.sh).

Flags:
  --space <dir>     Target workspace directory to restore into (required).
  --force           Replace a non-empty target. The old content is only
                    removed AFTER the archive verifies clean.
`

/** 递归收集 root 下全部普通文件(POSIX 相对路径)→ {size, sha256}。 */
function hashTree(root: string): Map<string, { size: number; sha256: string }> {
  const acc = new Map<string, { size: number; sha256: string }>()
  const visit = (rel: string): void => {
    const abs = rel === '' ? root : join(root, rel)
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? ent.name : `${rel}/${ent.name}`
      if (ent.isDirectory()) visit(childRel)
      else if (ent.isFile()) {
        const bytes = readFileSync(join(root, childRel))
        acc.set(childRel, { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
      }
    }
  }
  visit('')
  return acc
}

export async function restore(args: readonly string[], deps: RestoreDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => { console.log(l) })
  const err = deps.err ?? ((l: string) => { console.error(l) })
  const resolveHost = deps.resolveHost ?? (() => resolveModule(HOST_PKG))
  const importCheck = deps.importCheck ?? (() => import(CHECK_PKG) as Promise<CheckModule>)

  let archive = ''
  let space = ''
  let force = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--force') force = true
    else if (a === '--space') {
      space = args[++i] ?? ''
    } else if (a.startsWith('--space=')) {
      space = a.slice('--space='.length)
    } else if (a === '-h' || a === '--help') {
      out(USAGE)
      return 0
    } else if (a.startsWith('-')) {
      err(`unknown flag: ${a}`)
      err(USAGE)
      return 1
    } else if (!archive) archive = a
    else {
      err(`unexpected extra argument: ${a}`)
      err(USAGE)
      return 1
    }
  }
  if (!archive || !space) {
    err(USAGE)
    return 1
  }

  const archiveAbs = resolve(archive)
  if (!existsSync(archiveAbs) || !statSync(archiveAbs).isFile()) {
    err(`✖ backup archive not found: ${archive}`)
    return 3
  }
  const targetAbs = resolve(space)
  const targetNonEmpty = existsSync(targetAbs) && readdirSync(targetAbs).length > 0
  if (targetNonEmpty && !force) {
    err(`✖ target is not empty: ${space}`)
    err('  refusing to overwrite an existing workspace — pass --force to replace it')
    err('  (the old content is only removed after the archive verifies clean).')
    return 2
  }

  const parent = dirname(targetAbs)
  mkdirSync(parent, { recursive: true })
  // 临时目录放目标同级:同一文件系统,最后的 rename 是原子移动而非拷贝。
  const tmp = mkdtempSync(join(parent, `.gotong-restore-${randomBytes(4).toString('hex')}-`))
  try {
    try {
      await tar.extract({ file: archiveAbs, cwd: tmp })
    } catch (e) {
      err(`✖ extract failed: ${e instanceof Error ? e.message : String(e)}`)
      return 3
    }

    const manifestPath = join(tmp, MANIFEST_NAME)
    if (!existsSync(manifestPath)) {
      err(`✖ no ${MANIFEST_NAME} in the archive.`)
      err('  This looks like a legacy backup made by scripts/backup/backup.sh —')
      err('  restore it with scripts/backup/restore.sh (it knows that format).')
      err('  `gotong restore` only accepts verifiable archives from `gotong backup`.')
      return 4
    }
    const manifest = parseManifest(readFileSync(manifestPath, 'utf8'))
    if (!manifest) {
      err(`✖ ${MANIFEST_NAME} is corrupt or has an unknown format — refusing to restore.`)
      return 4
    }
    const leaf = join(tmp, manifest.label)
    if (!existsSync(leaf) || !statSync(leaf).isDirectory()) {
      err(`✖ archive is missing its workspace directory '${manifest.label}' — refusing to restore.`)
      return 4
    }

    const problems = verifyManifest(manifest, hashTree(leaf))
    if (problems.length > 0) {
      err(`✖ archive failed verification (${problems.length} problem${problems.length === 1 ? '' : 's'}) — target untouched:`)
      for (const p of problems) err(`  ✗ ${p}`)
      return 4
    }
    out(`✓ manifest verified: ${manifest.files.length} files, sha256 all match`)

    // 全绿,才动目标:先把旧目标移开,新内容就位后再删——中途失败可手工回滚。
    let aside: string | null = null
    if (existsSync(targetAbs)) {
      aside = join(parent, `.gotong-restore-old-${randomBytes(4).toString('hex')}`)
      renameSync(targetAbs, aside)
    }
    try {
      renameSync(leaf, targetAbs)
    } catch (e) {
      if (aside) renameSync(aside, targetAbs)
      err(`✖ failed to move restored workspace into place: ${e instanceof Error ? e.message : String(e)}`)
      return 3
    }
    if (aside) rmSync(aside, { recursive: true, force: true })
    out(`✓ restored → ${targetAbs}`)

    if (!manifest.includesMasterKey) {
      out('')
      out('Reminder: this backup does NOT contain the master key. Put back')
      out('identity-master.key (the unified root key — since B① the LLM-key')
      out('store derives from it too; pre-unification backups may also need')
      out('runtime/secret.key) or the host cannot decrypt the vault /')
      out('secrets.enc.json. See docs/OPERATIONS.md.')
    }

    // 恢复完自动体检(计划验收:恢复完自动跑 doctor 定义校验)。
    // 只警告不改判:恢复已经完成,配置问题是备份里带来的既有状态。
    if (!resolveHost()) {
      out('')
      out('note: @gotong/host is not installed — skipping the post-restore check.')
      out('      run `gotong check` after installing the host to validate the workspace.')
    } else {
      out('')
      out('→ post-restore check (gotong check):')
      const mod = await importCheck()
      const code = await mod.runCheckCli({ argv: [], env: { ...process.env, GOTONG_SPACE: targetAbs } })
      if (code !== 0) out('⚠ the check reported problems (above) — the restore itself is complete.')
    }
    return 0
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
