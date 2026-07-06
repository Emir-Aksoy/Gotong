/**
 * `gotong migrate <scan|apply> <space-dir> [--brand]` — 改名残留医生。
 *
 * scan 只读:报告四类 AipeHub 时代残留(service 包名 / 格式 id /
 * 品牌串 / env 前缀忠告),一个字节不写。apply 白名单替换:
 *
 *   - 逐文件「读 → 内存里改 → 内存里验 → 落 `.premigrate` 原件副本 →
 *     写回」。验证不过的文件**根本不会被碰**(改前先验,无需回滚);
 *   - `.premigrate` 只在不存在时写——重跑 apply 不会用中间态覆盖原件;
 *   - revisions 快照结构化迁移(contentHash 重算)并同步 lifecycle
 *     记录里的 meta 副本,见 migrate-core.ts 文件头;
 *   - 品牌串(space.json / agents.json 的展示文案)要 `--brand` 才动;
 *   - transcript / secrets / sqlite / master key 永不入白名单,外加
 *     isForbiddenTarget 写前拦截兜底。
 *
 * 退出码:scan 0=干净 / 1=有残留 / 2=用法或目录不合法;
 *         apply 0=全部完成(或无事可做)/ 1=有文件失败 / 2=同上。
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { parseWorkflow } from '@gotong/workflow'

import {
  ENV_ADVISORY,
  brandRe,
  countMatches,
  formatIdRe,
  isForbiddenTarget,
  migrateRevisionText,
  replaceBrand,
  replaceServicePkgs,
  replaceFormatIds,
  servicePkgRe,
  syncLifecycleHashes,
} from './migrate-core.js'

export interface MigrateDeps {
  out?: (line: string) => void
  err?: (line: string) => void
}

const USAGE = `Usage: gotong migrate <scan|apply> <space-dir> [--brand]

  scan    Read-only: report legacy (AipeHub-era) identifiers in the workspace.
  apply   Whitelist rewrite: fix what scan reports. Every touched file first
          gets a *.premigrate copy of the original next to it.

Flags:
  --brand      Also rewrite the brand string AipeHub → Gotong in space.json /
               agents.json display text (scan always reports it; apply skips
               it without this flag — the name is the user's, not ours).
  --help / -h  Show this message.
`

interface Target {
  rel: string
  category: 'service-package' | 'format-id' | 'brand'
  count: number
  detail: string
}

/** 列出目录下匹配后缀的文件名(不递归;目录缺席 = 空)。 */
function listFiles(dir: string, suffixes: readonly string[]): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && suffixes.some((s) => e.name.endsWith(s)))
    .map((e) => e.name)
    .sort()
}

function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/** 全部白名单候选文件(存在的),带各自类别与残留计数。 */
function discover(space: string): Target[] {
  const targets: Target[] = []
  const push = (rel: string, category: Target['category'], count: number, detail: string): void => {
    if (count > 0) targets.push({ rel, category, count, detail })
  }

  const plugins = 'services/plugins.json'
  if (existsSync(join(space, plugins))) {
    const text = readFileSync(join(space, plugins), 'utf8')
    push(plugins, 'service-package', countMatches(text, servicePkgRe()), '@aipehub/* → @gotong/*')
  }

  for (const f of listFiles(join(space, 'workflows', 'definitions'), ['.yaml', '.yml', '.json'])) {
    const rel = `workflows/definitions/${f}`
    const text = readFileSync(join(space, rel), 'utf8')
    push(rel, 'format-id', countMatches(text, formatIdRe()), 'aipehub.*/vN → gotong.*/vN')
  }

  for (const dir of listDirs(join(space, 'workflows', 'revisions'))) {
    for (const f of listFiles(join(space, 'workflows', 'revisions', dir), ['.json'])) {
      const rel = `workflows/revisions/${dir}/${f}`
      const text = readFileSync(join(space, rel), 'utf8')
      push(rel, 'format-id', countMatches(text, formatIdRe()), '+ contentHash re-derive + lifecycle sync')
    }
  }

  for (const f of ['space.json', 'agents.json']) {
    if (existsSync(join(space, f))) {
      const text = readFileSync(join(space, f), 'utf8')
      push(f, 'brand', countMatches(text, brandRe()), 'AipeHub → Gotong (apply only with --brand)')
    }
  }
  return targets
}

export async function migrate(args: readonly string[], deps: MigrateDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => { console.log(l) })
  const err = deps.err ?? ((l: string) => { console.error(l) })

  let sub = ''
  let spaceDir = ''
  let brand = false
  for (const a of args) {
    if (a === '--brand') brand = true
    else if (a === '-h' || a === '--help') {
      out(USAGE)
      return 0
    } else if (a.startsWith('-')) {
      err(`unknown flag: ${a}`)
      err(USAGE)
      return 2
    } else if (!sub) sub = a
    else if (!spaceDir) spaceDir = a
    else {
      err(`unexpected extra argument: ${a}`)
      err(USAGE)
      return 2
    }
  }
  if ((sub !== 'scan' && sub !== 'apply') || !spaceDir) {
    err(USAGE)
    return 2
  }
  const space = resolve(spaceDir)
  if (!existsSync(space) || !statSync(space).isDirectory() || !existsSync(join(space, 'space.json'))) {
    err(`✖ '${spaceDir}' does not look like a Gotong workspace (no space.json found)`)
    return 2
  }

  const targets = discover(space)

  if (sub === 'scan') {
    out(`→ scanning ${spaceDir} for legacy (AipeHub-era) identifiers…`)
    if (targets.length === 0) {
      out('✓ no legacy identifiers found in the whitelist surface.')
    } else {
      for (const t of targets) {
        out(`  ✗ ${t.rel}  ${t.category} ×${t.count}  (${t.detail})`)
      }
      out(`✗ ${targets.length} file(s) carry legacy identifiers.`)
      out(`  Fix: gotong migrate apply ${spaceDir}${targets.some((t) => t.category === 'brand') ? '  (add --brand to also rewrite brand strings)' : ''}`)
    }
    out('')
    for (const l of ENV_ADVISORY) out(l)
    return targets.length === 0 ? 0 : 1
  }

  // ---- apply ---------------------------------------------------------------
  out(`→ migrating ${spaceDir} (whitelist rewrite; originals kept as *.premigrate)…`)
  const failures: string[] = []
  let changed = 0
  let skippedBrand = 0
  // revisions 重算出的 hash,按 <revisions 子目录名> → (revision → newHash)
  // 聚合;lifecycle 文件名与子目录名同源(都是 sanitiseFileBase(workflowId))。
  const hashSync = new Map<string, Map<number, string>>()

  /** 改前先验,验过才碰盘:premigrate(仅首次)→ 写回。 */
  const commit = (rel: string, original: string, next: string): void => {
    if (isForbiddenTarget(rel)) throw new Error(`refusing to write forbidden target: ${rel}`)
    const abs = join(space, rel)
    const backup = `${abs}.premigrate`
    if (!existsSync(backup)) writeFileSync(backup, original, 'utf8')
    writeFileSync(abs, next, 'utf8')
    changed++
  }

  for (const t of targets) {
    const abs = join(space, t.rel)
    const original = readFileSync(abs, 'utf8')
    try {
      if (t.category === 'brand') {
        if (!brand) {
          skippedBrand++
          out(`  · skipped ${t.rel}  brand ×${t.count}  (pass --brand to rewrite brand strings)`)
          continue
        }
        const next = replaceBrand(original)
        JSON.parse(next) // space.json / agents.json 都是 JSON——改完必须仍可解析
        commit(t.rel, original, next)
        out(`  ✓ ${t.rel}  brand ×${t.count} fixed; JSON ok`)
      } else if (t.category === 'service-package') {
        const next = replaceServicePkgs(original)
        const parsed = JSON.parse(next) as { plugins?: unknown }
        if (!parsed || !Array.isArray(parsed.plugins)) throw new Error('plugins.json lost its { plugins: [] } shape')
        commit(t.rel, original, next)
        out(`  ✓ ${t.rel}  service-package ×${t.count} fixed; JSON ok`)
      } else if (t.rel.startsWith('workflows/definitions/')) {
        const next = replaceFormatIds(original)
        parseWorkflow(next) // 改完必须能过今天的解析器,过不了就别写
        commit(t.rel, original, next)
        out(`  ✓ ${t.rel}  format-id ×${t.count} fixed; parseWorkflow ok`)
      } else {
        // workflows/revisions/<dir>/<n>.json — 结构化迁移 + hash 重算
        const r = migrateRevisionText(original)
        if (r.kind === 'error') throw new Error(r.message)
        if (r.kind === 'unchanged') continue
        commit(t.rel, original, r.text)
        const dir = t.rel.split('/')[2]!
        if (!hashSync.has(dir)) hashSync.set(dir, new Map())
        hashSync.get(dir)!.set(r.revision, r.newHash)
        out(`  ✓ ${t.rel}  format-id ×${t.count} fixed; contentHash re-derived`)
      }
    } catch (e) {
      failures.push(`${t.rel}: ${e instanceof Error ? e.message : String(e)}`)
      err(`  ✖ ${t.rel}  left untouched — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // lifecycle 里的 meta 副本与快照同步(只动 contentHash,审计日志不碰)。
  for (const [dir, hashes] of hashSync) {
    const rel = `workflows/lifecycle/${dir}.json`
    const abs = join(space, rel)
    if (!existsSync(abs)) {
      out(`  · no lifecycle record for '${dir}' — snapshot migrated standalone`)
      continue
    }
    const original = readFileSync(abs, 'utf8')
    const s = syncLifecycleHashes(original, hashes)
    if (s.kind === 'error') {
      failures.push(`${rel}: ${s.message}`)
      err(`  ✖ ${rel}  left untouched — ${s.message}`)
    } else if (s.kind === 'changed') {
      try {
        commit(rel, original, s.text)
        out(`  ✓ ${rel}  contentHash synced for rev ${s.synced.join(', ')}`)
      } catch (e) {
        failures.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`)
        err(`  ✖ ${rel}  ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  if (changed === 0 && failures.length === 0 && skippedBrand === 0) {
    out('✓ nothing to migrate — the whitelist surface is already clean.')
  } else {
    out(`${failures.length > 0 ? '✖' : '✓'} ${changed} file(s) migrated, ${failures.length} failed${skippedBrand > 0 ? `, ${skippedBrand} brand file(s) skipped (no --brand)` : ''}.`)
    if (changed > 0) out('  Originals: *.premigrate next to each rewritten file.')
    out('  Verify: gotong check   (or just boot the host)')
  }
  out('')
  for (const l of ENV_ADVISORY) out(l)
  return failures.length > 0 ? 1 : 0
}
