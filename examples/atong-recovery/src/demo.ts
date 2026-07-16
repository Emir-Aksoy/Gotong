/**
 * atong-recovery — 零中央节点,恢复兜底是你手里的三份档案.
 *
 * 阿同框架及恢复能力 track(AFR)腿 C 的 capstone。Gotong 没有中央身份锚点:
 * 没有「找回账号」的客服,也没有替你保管钥匙的云——**用户自持档案是唯一兜底**。
 * 腿 C 把它做成三档(M6 分档打包)+ 阿同层看板/代打包/提醒(M7),缺的是把
 * 「打包 → 灾难 → 新家恢复」整条链在一个脚本里证死——就是这个 demo。
 *
 * 全程确定性、零网络、零 API key、零 LLM。底下是真的框架件:
 *   - 真 node:crypto ES256 签名钥(kid = RFC 7638 指纹,与 STD-M1 同算法);
 *   - 真 @gotong/identity 金库(openIdentityStore + addPeer:peer 令牌真信封加密);
 *   - 真 @gotong/cli `backup()` 三档打包 + `restore()` 校验清单后原子落位;
 *   - 真 M7「上次备份」事实文件(每打一档,阿同 backup_status 看的事实就刷新)。
 *
 * 这个 demo 端到端证的事(腿 C 的边界全部看得见):
 *
 *   [幕1] 身份档 = 「我还是我」:恢复进全新目录,从恢复出的钥字节**独立复算**
 *         RFC 7638 指纹 === 原 kid(钉过你 kid 的 peer 照认);同时解出的**每个
 *         字节**扫不到主钥/任何 peer 令牌——子集档结构性无密,不是「恰好没带」。
 *   [幕2] 关系档 = 「认识谁」不是「连得上」:peers 非密投影行还在(endpoint /
 *         pinned_kid / trust_tier),诚实边界 note 印在**档案本体**里(令牌在
 *         金库,重连要对端 re-mint);投影全文照样扫不到令牌明文与 vault 指针。
 *   [幕3] 搬家档 = 全量开机:恢复进新家后,用**恢复出来的**主钥真开金库、
 *         listPeers 两行俱在、getPeerToken 真解出令牌明文——boot 级证明,
 *         不是「文件都在」的表面功夫。
 *   [幕4] M7 事实闭环:三次打包每次都刷新 runtime/last-backup.json,最后一档
 *         如实记 tier=full + includesMasterKey=true——阿同 backup_status /
 *         陈旧提醒 sweeper 看的就是这份事实,谁打的都算数。
 *
 * Run:  pnpm demo:atong-recovery
 */

import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  backup,
  restore,
  parseLastBackupFact,
  LAST_BACKUP_FACT_NAME,
  PEERS_PROJECTION_NAME,
  type LastBackupFact,
  type PeersProjection,
} from '@gotong/cli'
import { loadOrCreateMasterKey, openIdentityStore } from '@gotong/identity'

// ── 小工具 ───────────────────────────────────────────────────────────────────

/** RFC 7638 EC 公钥指纹(kid):固定成员序 {crv,kty,x,y} → sha256 → base64url。 */
function kidOfPem(pkcs8Pem: string): string {
  const jwk = createPublicKey(pkcs8Pem).export({ format: 'jwk' }) as {
    crv?: string
    kty?: string
    x?: string
    y?: string
  }
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
  return createHash('sha256').update(canonical, 'utf8').digest('base64url')
}

/** 递归列出 root 下全部文件的相对路径(POSIX 分隔),排好序。 */
function walk(root: string, rel = ''): string[] {
  const acc: string[] = []
  for (const ent of readdirSync(rel === '' ? root : join(root, rel), { withFileTypes: true })) {
    const childRel = rel === '' ? ent.name : `${rel}/${ent.name}`
    if (ent.isDirectory()) acc.push(...walk(root, childRel))
    else acc.push(childRel)
  }
  return acc.sort()
}

/** 静音 io:backup/restore 的进度行收进数组,demo 只打自己的叙事。 */
function collectIo(): { out: (l: string) => void; err: (l: string) => void; lines: string[] } {
  const lines: string[] = []
  return { out: (l) => lines.push(l), err: (l) => lines.push(l), lines }
}

let passed = 0
function assert(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`  ✗ ${label}`)
    process.exit(1)
  }
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ── 布景:一个「有身份、有关系、有秘密」的 hub 的家 ──────────────────────────

const root = mkdtempSync(join(tmpdir(), 'gotong-atong-recovery-'))
const space = join(root, 'space')
const archives = join(root, 'archives')
mkdirSync(space, { recursive: true })

console.log('━━ atong-recovery — 零中央节点,恢复兜底是你手里的三份档案 ━━\n')
console.log('布景:造一个真 hub 空间(真 ES256 签名钥 + 真金库 + 两个 peer)…')

// 密码学身份:真 ES256 钥对,kid 即 RFC 7638 指纹(STD-M1 同算法)。
const me = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const myKeyPem = me.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
writeFileSync(join(space, 'agent-card-signing.key'), myKeyPem, { mode: 0o600 })
const myKid = kidOfPem(myKeyPem)

writeFileSync(join(space, 'space.json'), JSON.stringify({ name: 'atong-home' }, null, 2))
writeFileSync(join(space, 'agent-card.json'), JSON.stringify({ name: '阿同的家' }, null, 2))
writeFileSync(join(space, 'transcript.jsonl'), '{"seq":1,"kind":"hello"}\n')
mkdirSync(join(space, 'runtime'), { recursive: true })
writeFileSync(join(space, 'runtime', 'config.json'), '{"webPort":3000}\n')

// 真金库:主钥落盘(镜像 main.ts 的 identity-master.key)+ 两个 peer,令牌真加密。
// hub-b 是 owner PIN 过签名钥的 T2 伙伴(pinned_kid = 对方钥的真 RFC 7638 指纹);
// hub-a 是刚握手的地板边(GT 的 fail-closed 默认)。
const masterKey = loadOrCreateMasterKey(join(space, 'identity-master.key'))
const TOKEN_B = 'peer-token-hub-b-0123456789abcdef'
const TOKEN_A = 'peer-token-hub-a-fedcba9876543210'
const hubBKid = kidOfPem(
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string,
)
const store = openIdentityStore({ dbPath: join(space, 'identity.sqlite'), masterKey })
const peerB = store.addPeer({
  peerId: 'hub-b',
  endpointUrl: 'wss://b.example:7777',
  label: 'Hub B(已 PIN)',
  peerToken: TOKEN_B,
})
store.updatePeer(peerB.id, { pinnedKid: hubBKid, trustTier: 'T2' })
const peerA = store.addPeer({
  peerId: 'hub-a',
  endpointUrl: 'wss://a.example:7777',
  peerToken: TOKEN_A,
})
store.close()
console.log(`  家在 ${space}`)
console.log(`  我的 kid = ${myKid.slice(0, 16)}… , peers = hub-b(T2, 已 PIN) + hub-a(地板)\n`)

/** 打一档,回读 M7 事实文件定位档案(阿同 backup_status 看的就是这份事实)。 */
async function pack(flag: string, expectTier: LastBackupFact['tier']): Promise<string> {
  const io = collectIo()
  const code = await backup([space, archives, flag], io)
  if (code !== 0) {
    console.error(io.lines.join('\n'))
    console.error(`  ✗ backup ${flag} exit ${code}`)
    process.exit(1)
  }
  const fact = parseLastBackupFact(
    readFileSync(join(space, ...LAST_BACKUP_FACT_NAME.split('/')), 'utf8'),
  )
  if (!fact || fact.tier !== expectTier) {
    console.error(`  ✗ 上次备份事实缺失或档位不符(${JSON.stringify(fact)})`)
    process.exit(1)
  }
  return join(archives, fact.archive)
}

/** 真 restore 进全新目录(跳过 post-restore check:demo 不装 host,显式注入)。 */
async function restoreTo(archive: string, target: string): Promise<void> {
  const io = collectIo()
  const code = await restore([archive, '--space', target], {
    out: io.out,
    err: io.err,
    resolveHost: () => null,
  })
  if (code !== 0) {
    console.error(io.lines.join('\n'))
    console.error(`  ✗ restore exit ${code}`)
    process.exit(1)
  }
}

/** 哨兵扫描:target 下每个文件的原始字节里,一个敏感串都不许出现。 */
function scanForSecrets(target: string): string[] {
  const sentinels: Array<[string, string]> = [
    ['主钥原始字节', masterKey.toString('latin1')],
    ['主钥 hex', masterKey.toString('hex')],
    ['hub-b 令牌明文', TOKEN_B],
    ['hub-a 令牌明文', TOKEN_A],
  ]
  const hits: string[] = []
  for (const rel of walk(target)) {
    const raw = readFileSync(join(target, rel)).toString('latin1')
    for (const [what, needle] of sentinels) {
      if (raw.includes(needle)) hits.push(`${rel} 含 ${what}`)
    }
  }
  return hits
}

const IDENTITY_TRIO = ['agent-card-signing.key', 'agent-card.json', 'space.json']

await (async () => {
  // ── 幕 1:身份档 —— 「我还是我」,且结构性无密 ─────────────────────────────
  console.log('[幕1] 身份档:打包 → 新目录恢复 → kid 复算 + 全字节扫密')
  const idArchive = await pack('--tier=identity', 'identity')
  const homeA = join(root, 'restore-identity')
  await restoreTo(idArchive, homeA)
  assert(
    JSON.stringify(walk(homeA)) === JSON.stringify(IDENTITY_TRIO),
    `恢复出的家恰好三件:${IDENTITY_TRIO.join(' / ')}(一个不多)`,
  )
  const restoredKid = kidOfPem(readFileSync(join(homeA, 'agent-card-signing.key'), 'utf8'))
  assert(restoredKid === myKid, 'kid 逐字节复算不变——「我还是我」,钉过我 kid 的 peer 照认')
  const hitsA = scanForSecrets(homeA)
  assert(hitsA.length === 0, `解出的每个字节扫不到主钥/令牌(哨兵 4 串 × ${walk(homeA).length} 文件全空)`)

  // ── 幕 2:关系档 —— 「认识谁」不是「连得上」 ─────────────────────────────
  console.log('\n[幕2] 关系档:投影行还在 + 诚实边界印在档案本体')
  const relArchive = await pack('--tier=relations', 'relations')
  const homeB = join(root, 'restore-relations')
  await restoreTo(relArchive, homeB)
  assert(
    JSON.stringify(walk(homeB)) === JSON.stringify([...IDENTITY_TRIO, PEERS_PROJECTION_NAME].sort()),
    `身份三件 + ${PEERS_PROJECTION_NAME},仍无金库/主钥文件`,
  )
  const projRaw = readFileSync(join(homeB, PEERS_PROJECTION_NAME), 'utf8')
  const proj = JSON.parse(projRaw) as PeersProjection
  const rowB = proj.peers.find((p) => p.peerId === 'hub-b')
  const rowA = proj.peers.find((p) => p.peerId === 'hub-a')
  assert(proj.peers.length === 2 && !!rowB && !!rowA, 'peers 两行俱在(hub-b + hub-a)')
  assert(
    rowB!.endpointUrl === 'wss://b.example:7777' && rowB!.pinnedKid === hubBKid && rowB!.trustTier === 'T2',
    'hub-b 行完整:endpoint + pinned_kid(对方钥真指纹)+ trust_tier=T2 全还原',
  )
  assert(
    proj.note.includes('认识谁') && proj.note.includes('mint-peer-token'),
    '诚实边界印在档案本体:令牌在金库,恢复≠连得上,重连走 mint-peer-token',
  )
  assert(
    !projRaw.includes(TOKEN_B) && !projRaw.includes(TOKEN_A) && !projRaw.includes('vaultEntryId'),
    '投影全文无令牌明文、无 vault 指针字段(挑列不是滤列)',
  )
  assert(scanForSecrets(homeB).length === 0, '关系档全字节扫密同样全空')

  // ── 幕 3:搬家档 —— 全量开机 ─────────────────────────────────────────────
  console.log('\n[幕3] 搬家档:新家用恢复出来的主钥真开金库')
  const fullArchive = await pack('--include-master-key', 'full')
  const homeC = join(root, 'restore-full')
  await restoreTo(fullArchive, homeC)
  const filesC = walk(homeC)
  assert(
    ['identity.sqlite', 'identity-master.key', 'transcript.jsonl', 'runtime/config.json'].every((f) =>
      filesC.includes(f),
    ),
    '全空间俱在:金库 + 主钥 + transcript + runtime 配置',
  )
  assert(
    !filesC.includes(LAST_BACKUP_FACT_NAME),
    '档案不含关于自己的事实(runtime/last-backup.json 不进档)',
  )
  const mk2 = loadOrCreateMasterKey(join(homeC, 'identity-master.key'))
  assert(mk2.equals(masterKey), '恢复出的主钥与原主钥逐字节一致')
  const store2 = openIdentityStore({ dbPath: join(homeC, 'identity.sqlite'), masterKey: mk2 })
  const peers2 = store2.listPeers().map((p) => p.peerId).sort()
  assert(JSON.stringify(peers2) === JSON.stringify(['hub-a', 'hub-b']), '新家 listPeers 两行俱在')
  assert(
    store2.getPeerToken(peerB.id) === TOKEN_B && store2.getPeerToken(peerA.id) === TOKEN_A,
    '金库在新家真解得开:两个 peer 令牌明文 round-trip——这才叫「开机」',
  )
  store2.close()

  // ── 幕 4:M7 事实闭环 ─────────────────────────────────────────────────────
  console.log('\n[幕4] M7 事实:三次打包每次刷新,阿同 backup_status 看的就是它')
  const fact = parseLastBackupFact(
    readFileSync(join(space, ...LAST_BACKUP_FACT_NAME.split('/')), 'utf8'),
  )
  assert(
    !!fact && fact.tier === 'full' && fact.includesMasterKey === true,
    '最后一档如实记 tier=full + includesMasterKey=true(含主钥=档案即凭证,警示有据)',
  )

  const size = (p: string): string => `${Math.max(1, Math.round(statSync(p).size / 1024))} KB`
  console.log('\n━━ 账本 ━━')
  console.log(`  身份档   ${size(idArchive)}(小到可打印/二维码;泄露爆炸半径最小)`)
  console.log(`  关系档   ${size(relArchive)}(+ 非密投影;令牌不随行)`)
  console.log(`  搬家档   ${size(fullArchive)}(全空间 + 主钥;档案即凭证,收好)`)
  console.log(`\n✓ ${passed} 条断言全过 — 三档恢复链条端到端成立,零中央节点,兜底在你手里。`)
})()
  .catch((e) => {
    console.error('✗ demo 失败:', e)
    process.exitCode = 1
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true })
  })
