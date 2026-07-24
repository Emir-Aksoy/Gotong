/**
 * KIT-M2 — `gotong migrate` 的纯函数核:改名残留(AipeHub 时代标识符)
 * 的识别与白名单替换。零 I/O,单测直打。
 *
 * 白名单哲学:**只动 scan 认识的 file×pattern 组合**,别的一个字节
 * 不碰。四类残留(2026-07-05 生产迁移真实修过的):
 *
 *   ① service 包名   services/plugins.json 里 `@aipehub/…` → `@gotong/…`
 *   ② 格式 id        workflows/definitions/* 与 revisions 快照里
 *                    `aipehub.<name>/v<N>` → `gotong.<name>/v<N>`
 *   ③ 品牌串         space.json / agents.json 里 `AipeHub` → `Gotong`
 *                    (展示文案,`--brand` 才动——名字是用户的,不硬改)
 *   ④ env 前缀       `AIPE_*` → `GOTONG_*`(+ 一次性特例 AIPEHUB_URL →
 *                    GOTONG_URL)。**env 文件永不读**(生产凭证纪律),
 *                    scan 只打印一条让用户自己跑的 sed 命令。
 *
 * revisions 快照的特殊性:WorkflowRevision 是扁平的 RevisionMeta +
 * definition,meta.contentHash = 定义 canonical-JSON 的 sha256。改了
 * definition 里的格式 id 就必须重算 contentHash,并同步
 * workflows/lifecycle/<id>.json 里那份 meta 副本——否则 publish 去重
 * 与 rollback 的相等断言会拿着旧 hash 说胡话。这正是「白名单结构化
 * 替换」而不是「盲 sed」存在的理由。
 *
 * transcript / secrets / sqlite / master key **永不入白名单**;
 * isForbiddenTarget 是第二道保险,哪怕未来有人改坏了文件枚举,
 * 这些名字也会在写之前被拦下。
 */

import { hashDefinition, type WorkflowDefinition } from '@gotong/workflow'

/** 每次新建,避免共享 /g regex 的 lastIndex 状态坑。 */
export const formatIdRe = (): RegExp => /\baipehub\.([a-z][a-z0-9-]*\/v\d+)\b/g
export const servicePkgRe = (): RegExp => /@aipehub\//g
export const brandRe = (): RegExp => /AipeHub/g

export function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length
}

export const replaceFormatIds = (text: string): string => text.replace(formatIdRe(), 'gotong.$1')
export const replaceServicePkgs = (text: string): string => text.replace(servicePkgRe(), '@gotong/')
export const replaceBrand = (text: string): string => text.replace(brandRe(), 'Gotong')

/**
 * 第二道保险:这些文件无论如何不许被 migrate 写。transcript 是不可变
 * 审计日志;secrets / sqlite / key / 会话文件只由各自既有代码路径碰。
 */
export function isForbiddenTarget(rel: string): boolean {
  const base = rel.split('/').pop() ?? rel
  return (
    base === 'transcript.jsonl' ||
    base.startsWith('secrets.enc.json') || // 含 B① .pre-unify.bak / .next 回滚对
    base.startsWith('identity.sqlite') ||
    rel.startsWith('runtime/secret.key') || // 含 B① 退役改名件
    base.startsWith('identity-master.key') ||
    base.endsWith('-sessions.json')
  )
}

/** 深走所有字符串值替换格式 id;对象/数组结构原样保留。 */
export function replaceFormatIdsDeep(value: unknown): { value: unknown; changed: boolean } {
  let changed = false
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const next = replaceFormatIds(v)
      if (next !== v) changed = true
      return next
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val)
      return out
    }
    return v
  }
  return { value: walk(value), changed }
}

export type RevisionMigration =
  | { kind: 'changed'; text: string; revision: number; newHash: string }
  | { kind: 'unchanged' }
  | { kind: 'error'; message: string }

/**
 * revision 快照(workflows/revisions/<id>/<n>.json)的结构化迁移:
 * definition 内字符串值换格式 id → contentHash 重算。定义之外若还残留
 * 格式 id(不在白名单语义里)则整体拒绝,宁可让人来看。
 */
export function migrateRevisionText(raw: string): RevisionMigration {
  if (!formatIdRe().test(raw)) return { kind: 'unchanged' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'error', message: 'not valid JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'error', message: 'unrecognized revision shape (not an object)' }
  }
  const rev = parsed as Record<string, unknown>
  if (typeof rev.revision !== 'number' || typeof rev.contentHash !== 'string' || !rev.definition || typeof rev.definition !== 'object') {
    return {
      kind: 'error',
      message: 'unrecognized revision shape (expected flat WorkflowRevision: revision + contentHash + definition)',
    }
  }
  const { value, changed } = replaceFormatIdsDeep(rev.definition)
  if (changed) {
    rev.definition = value
    rev.contentHash = hashDefinition(value as WorkflowDefinition)
  }
  const text = `${JSON.stringify(rev, null, 2)}\n`
  if (formatIdRe().test(text)) {
    return { kind: 'error', message: 'legacy format ids remain OUTSIDE the frozen definition — not whitelisted, fix by hand' }
  }
  if (!changed) return { kind: 'unchanged' }
  return { kind: 'changed', text, revision: rev.revision, newHash: rev.contentHash as string }
}

export type LifecycleSync =
  | { kind: 'changed'; text: string; synced: number[] }
  | { kind: 'unchanged' }
  | { kind: 'error'; message: string }

/**
 * lifecycle 记录(workflows/lifecycle/<id>.json)只做一件事:把
 * revisions[] 里对应版本的 contentHash 换成快照重算后的值。历史
 * (history 审计日志)与其他字段一字不动。
 */
export function syncLifecycleHashes(raw: string, newHashByRevision: ReadonlyMap<number, string>): LifecycleSync {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'error', message: 'not valid JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'error', message: 'unrecognized lifecycle shape (not an object)' }
  }
  const rec = parsed as Record<string, unknown>
  if (!Array.isArray(rec.revisions)) {
    return { kind: 'error', message: 'unrecognized lifecycle shape (no revisions[])' }
  }
  const synced: number[] = []
  for (const m of rec.revisions) {
    if (!m || typeof m !== 'object') continue
    const meta = m as Record<string, unknown>
    if (typeof meta.revision !== 'number') continue
    const next = newHashByRevision.get(meta.revision)
    if (next && meta.contentHash !== next) {
      meta.contentHash = next
      synced.push(meta.revision)
    }
  }
  if (synced.length === 0) return { kind: 'unchanged' }
  return { kind: 'changed', text: `${JSON.stringify(rec, null, 2)}\n`, synced }
}

/**
 * env 前缀的忠告文案(scan / apply 尾部都印)。永远只是「给你一条
 * 命令自己跑」——migrate 连 env 文件的存在都不探测。
 */
export const ENV_ADVISORY: readonly string[] = [
  'note: env prefixes are NOT scanned or migrated — env files hold credentials',
  '      and are never read by this tool. If the deployment predates the rename,',
  '      run this yourself, then eyeball the diff before restarting:',
  "        sed -i.bak -e 's/AIPEHUB_URL/GOTONG_URL/g' -e 's/AIPE_/GOTONG_/g' /path/to/.env",
  "      (BSD/macOS sed: sed -i '' -e … ; remember systemd EnvironmentFile= copies too)",
]
