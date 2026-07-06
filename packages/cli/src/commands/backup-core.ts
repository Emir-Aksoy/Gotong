/**
 * KIT-M1 — `gotong backup / restore` 的纯函数核:排除规则、清单
 * (manifest)构建与校验、文件名。零 I/O,零依赖,单测直打。
 *
 * 语义**逐字对齐** `scripts/backup/backup.sh`(.sh 原样保留给服务器):
 *
 *   - master key 两个世代默认排除——`runtime/secret.key`(v3 SpaceSecrets)
 *     与根级 `identity-master.key*` 家族(v4 vault KEK + 轮换暂存
 *     `.next`)。钥匙和它解开的密文放同一个包里,拿到备份就拿到一切,
 *     at-rest 加密对这份拷贝形同虚设。`--include-master-key` 是搬家
 *     场景的显式例外,带就大声提示落盘即密级。
 *   - 会话文件**永远**排除(`runtime/{admin,worker}-sessions.json`):
 *     恢复它们等于复活旧 cookie sid,备份泄露即可重放;重新登录只花
 *     5 秒,换一道真实安全边界。没有开关——这不是偏好,是纪律。
 *   - identity.sqlite 家族在正常收集阶段跳过,由 WAL 安全快照阶梯
 *     单独处理(better-sqlite3 backup API → sqlite3 CLI → 原样拷贝
 *     + 大声警告)。
 *
 * 比 .sh 多出的一层:归档根部多一份 `gotong-backup-manifest.json`
 * (文件清单 + sha256),restore 先验清单再落盘——篡改/截断的包在
 * 碰到目标目录之前就被拒绝。
 */

/** 归档根部清单文件名(与 workspace 内容平级,恢复时不进目标目录)。 */
export const MANIFEST_NAME = 'gotong-backup-manifest.json'

export const MANIFEST_FORMAT = 'gotong.backup/v1'

export interface ManifestFile {
  /** leaf 相对路径,POSIX 分隔符(如 `runtime/config.json`)。 */
  path: string
  size: number
  sha256: string
}

export interface BackupManifest {
  format: typeof MANIFEST_FORMAT
  createdAt: string
  /** workspace leaf 目录名——归档内的顶级目录名,恢复时据此定位。 */
  label: string
  includesMasterKey: boolean
  files: ManifestFile[]
}

/** 会话文件:永远排除,无开关(见文件头)。 */
export function isSessionPath(rel: string): boolean {
  return rel === 'runtime/admin-sessions.json' || rel === 'runtime/worker-sessions.json'
}

/**
 * master key 两个世代。`identity-master.key*` 只认**根级**——
 * .sh 的排除模式 `$LEAF/identity-master.key*` 锚在 leaf 根,照抄。
 */
export function isMasterKeyPath(rel: string): boolean {
  return rel === 'runtime/secret.key' || rel.startsWith('identity-master.key')
}

/** identity.sqlite 家族(db + WAL 伴生),由快照阶梯单独处理。 */
export function isIdentitySqlitePath(rel: string): boolean {
  return rel === 'identity.sqlite' || rel === 'identity.sqlite-wal' || rel === 'identity.sqlite-shm'
}

/**
 * 正常收集阶段该不该跳过这个文件。sqlite 家族的「跳过」不等于「不进
 * 归档」——快照阶梯会以一致性拷贝的形式把它放回去。
 */
export function shouldSkipForStaging(rel: string, includeMasterKey: boolean): boolean {
  if (isSessionPath(rel)) return true
  if (!includeMasterKey && isMasterKeyPath(rel)) return true
  if (isIdentitySqlitePath(rel)) return true
  return false
}

/** `gotong-<label>-<YYYYMMDDTHHMMSSZ>.tar.gz` — 与 .sh 同构,UTC、无冒号、可字典序排。 */
export function backupFileName(label: string, now: Date): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `gotong-${label}-${ts}.tar.gz`
}

/** 解析 + 形状校验;认不出(旧 .sh 归档没有清单、或字段损坏)返回 null。 */
export function parseManifest(raw: string): BackupManifest | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const m = v as Record<string, unknown>
  if (m.format !== MANIFEST_FORMAT) return null
  if (typeof m.label !== 'string' || m.label.length === 0) return null
  if (typeof m.createdAt !== 'string') return null
  if (typeof m.includesMasterKey !== 'boolean') return null
  if (!Array.isArray(m.files)) return null
  for (const f of m.files) {
    if (!f || typeof f !== 'object') return null
    const ff = f as Record<string, unknown>
    if (typeof ff.path !== 'string' || typeof ff.size !== 'number' || typeof ff.sha256 !== 'string') return null
  }
  return m as unknown as BackupManifest
}

/**
 * 清单 vs 实际解出的文件集,双向比对。返回问题清单(空 = 通过);
 * restore 在任何一条问题面前都拒绝落盘,目标目录一字不动。
 */
export function verifyManifest(
  manifest: BackupManifest,
  actual: ReadonlyMap<string, { size: number; sha256: string }>,
): string[] {
  const problems: string[] = []
  const listed = new Set<string>()
  for (const f of manifest.files) {
    listed.add(f.path)
    const got = actual.get(f.path)
    if (!got) {
      problems.push(`missing from archive: ${f.path}`)
      continue
    }
    if (got.size !== f.size) {
      problems.push(`size mismatch: ${f.path} (manifest ${f.size}, archive ${got.size})`)
    } else if (got.sha256 !== f.sha256) {
      problems.push(`sha256 mismatch: ${f.path}`)
    }
  }
  for (const path of actual.keys()) {
    if (!listed.has(path)) problems.push(`not in manifest: ${path}`)
  }
  return problems.sort()
}
