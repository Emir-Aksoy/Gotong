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

// ─── AFR-M6 分档打包 ─────────────────────────────────────────────────────────
//
// 三档里只有两档是新的:搬家档 = 既有 `--include-master-key`(全空间+主钥,
// 档案即凭证)。新的两档是它下面的**子集档**,给「用户自持、零中央节点」的
// 恢复兜底用:
//
//   - identity  身份档:签名钥(kid 的来源,恢复「我还是我」)± 公开名片
//     ± space.json。小到可打印。泄露爆炸半径 = 可冒签名片,远小于主钥。
//   - relations 身份+关系档:身份档 + peers **非密投影**(认识谁/信到哪档/
//     允许什么)。诚实边界:peer 令牌在金库 —— 投影**结构性**没有令牌字段,
//     恢复的是「认识谁」不是「连得上」,重连要对端 re-mint。这条边界印在
//     投影文件自身的 note 里,不许含糊。
//
// 子集档**绝不含**金库·主钥字节:identity.sqlite(金库密文在里面)、
// secrets.enc.json、identity-master.key*、runtime/secret.key 全部结构性
// 出不了 isIdentityTierPath 的白名单 —— 白名单式过滤,新文件默认落保守侧。

/** 分档档位。undefined = 不分档(今天的全空间路径,逐字节不变)。 */
export type BackupTier = 'identity' | 'relations'

/** 身份档白名单:只有这三个 leaf 根文件可进子集档(fail-closed)。 */
export function isIdentityTierPath(rel: string): boolean {
  return rel === 'space.json' || rel === 'agent-card-signing.key' || rel === 'agent-card.json'
}

/** peers 非密投影文件名(relations 档在归档 leaf 根生成)。 */
export const PEERS_PROJECTION_NAME = 'gotong-peers-projection.json'

export const PEERS_PROJECTION_FORMAT = 'gotong.peers-projection/v1'

/** 投影里的一行:全部非密。结构性没有令牌/vault 指针字段。 */
export interface PeersProjectionRow {
  peerId: string
  endpointUrl: string
  label: string | null
  enabled: boolean
  pinnedKid: string | null
  trustTier: string | null
  outboundCaps: string[] | null
}

export interface PeersProjection {
  format: typeof PEERS_PROJECTION_FORMAT
  createdAt: string
  /** 诚实边界,印在档案里(不只印在终端):令牌在金库,恢复≠连得上。 */
  note: string
  peers: PeersProjectionRow[]
}

/** 投影文件自带的诚实边界(计划钉死「必须印在档案清单里,不许含糊」)。 */
export const PEERS_PROJECTION_NOTE =
  '非密投影:peer 令牌在金库,不在本档案。恢复的是「认识谁」,不是「连得上」——重连需对端重新签发令牌(gotong mint-peer-token)。'

/**
 * 把 `SELECT * FROM peers` 的原始行(snake_case,列随 schema 版本可缺)
 * 折成非密投影。**挑列不是滤列**:白名单式只取已知非密列,新加的列默认
 * 不进投影(与 isIdentityTierPath 同姿态);vault_entry_id 是非密指针但
 * 没有金库毫无意义,不进。坏 JSON(outbound_caps_json 手改坏)fail-soft
 * 成 null,绝不让一行坏数据毁掉整档备份。
 */
export function buildPeersProjection(rows: readonly unknown[], createdAt: string): PeersProjection {
  const peers: PeersProjectionRow[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.peer_id !== 'string' || typeof r.endpoint_url !== 'string') continue
    let outboundCaps: string[] | null = null
    if (typeof r.outbound_caps_json === 'string') {
      try {
        const v = JSON.parse(r.outbound_caps_json) as unknown
        if (Array.isArray(v) && v.every((x) => typeof x === 'string')) outboundCaps = v
      } catch {
        // fail-soft:坏列折 null,行照留
      }
    }
    peers.push({
      peerId: r.peer_id,
      endpointUrl: r.endpoint_url,
      label: typeof r.label === 'string' ? r.label : null,
      enabled: r.enabled === 1 || r.enabled === true,
      pinnedKid: typeof r.pinned_kid === 'string' ? r.pinned_kid : null,
      trustTier: typeof r.trust_tier === 'string' ? r.trust_tier : null,
      outboundCaps,
    })
  }
  peers.sort((a, b) => (a.peerId < b.peerId ? -1 : 1))
  return { format: PEERS_PROJECTION_FORMAT, createdAt, note: PEERS_PROJECTION_NOTE, peers }
}

// ─── AFR-M7 上次备份事实 ─────────────────────────────────────────────────────

/** 备份成功后落在 space 下的事实文件(阿同 backup_status 的数据源)。 */
export const LAST_BACKUP_FACT_NAME = 'runtime/last-backup.json'

export const LAST_BACKUP_FACT_FORMAT = 'gotong.last-backup/v1'

/**
 * 「上次备份」事实:全部非密(时间/档位/档案 basename)。谁跑的备份都写它
 * ——命令行打的档也让阿同如实报。写在归档**之后**:档案不含关于自己的事实。
 */
export interface LastBackupFact {
  format: typeof LAST_BACKUP_FACT_FORMAT
  /** epoch ms。 */
  at: number
  /** 子集档位;'full' = 全空间(含搬家档,含不含主钥看 includesMasterKey)。 */
  tier: BackupTier | 'full'
  includesMasterKey: boolean
  /** 档案文件名(basename,不带目录)。 */
  archive: string
}

/** 解析 + 形状校验;认不出返回 null(从未备份 / 手改坏 → 诚实「无记录」)。 */
export function parseLastBackupFact(raw: string): LastBackupFact | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const f = v as Record<string, unknown>
  if (f.format !== LAST_BACKUP_FACT_FORMAT) return null
  if (typeof f.at !== 'number' || !Number.isFinite(f.at)) return null
  if (f.tier !== 'identity' && f.tier !== 'relations' && f.tier !== 'full') return null
  if (typeof f.includesMasterKey !== 'boolean') return null
  if (typeof f.archive !== 'string' || f.archive.length === 0) return null
  return f as unknown as LastBackupFact
}

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
  /** AFR-M6:子集档自描述。缺席 = 全空间归档(旧档案天然合法)。 */
  tier?: BackupTier
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
 * AFR-M7 — `<space>/backups/` 是阿同 pack_backup 的落盘目录:永远不进归档。
 * 档案套档案会随每次备份滚雪球,而且旧档案本身不是「当前空间状态」。
 */
export function isBackupOutputPath(rel: string): boolean {
  return rel === 'backups' || rel.startsWith('backups/')
}

/**
 * 正常收集阶段该不该跳过这个文件。sqlite 家族的「跳过」不等于「不进
 * 归档」——快照阶梯会以一致性拷贝的形式把它放回去(**分档时例外**:
 * 子集档绝不含 sqlite,快照阶梯整个不跑,金库密文字节结构性进不来)。
 * tier 缺省 = 今天的全空间语义,逐字节不变。
 */
export function shouldSkipForStaging(rel: string, includeMasterKey: boolean, tier?: BackupTier): boolean {
  if (tier !== undefined) return !isIdentityTierPath(rel)
  if (isBackupOutputPath(rel)) return true
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
  if (m.tier !== undefined && m.tier !== 'identity' && m.tier !== 'relations') return null
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
