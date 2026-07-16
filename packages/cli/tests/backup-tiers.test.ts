/**
 * AFR-M6 防腐门 — 分档打包(身份 / 身份+关系 / 搬家):
 *
 *   1. **三档内容清单钉死**:identity 档 = 白名单三文件;relations 档 = + 非密
 *      投影;搬家档 = 既有 --include-master-key(其警示由 backup-restore.test
 *      已钉,这里钉「不可与 --tier 组合」)。
 *   2. **子集档绝不含金库·主钥字节**:解出的每个文件逐一扫哨兵串(主钥两代 /
 *      vault 指针 / 金库密文 / 会话 sid),一个都不许出现;identity.sqlite
 *      整个文件不许在成员表里。
 *   3. **诚实边界印进档案**:投影文件自身的 note 写明「令牌在金库,恢复的是
 *      认识谁不是连得上,重连要对端 re-mint」。
 *   4. 读取阶梯诚实:driver 挂 → CLI 顶上;全挂 → exit 3 响亮失败,绝不静默
 *      降成身份档;库根本不存在 = 真·零 peer,如实空投影。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MANIFEST_NAME,
  PEERS_PROJECTION_NAME,
  buildPeersProjection,
  parseManifest,
  shouldSkipForStaging,
  type PeersProjection,
} from '../src/commands/backup-core.js'
import { backup } from '../src/commands/backup.js'
import { restore } from '../src/commands/restore.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gotong-afr-m6-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 哨兵串:子集档解出的任何文件里出现任何一个 = 门红。 */
const SENTINELS = [
  'v3-master-key-bytes',
  'v4-kek-bytes',
  'VAULT-CIPHERTEXT',
  'vault-entry-TOKEN-POINTER',
  'stale-session-sid',
] as const

/** 全料 workspace:两代主钥 + 金库密文 + 会话 + 身份三件 + 带 peers 的真 sqlite。 */
function makeSpace(dir: string, opts: { signingKey?: boolean; db?: boolean } = {}): void {
  mkdirSync(join(dir, 'runtime'), { recursive: true })
  writeFileSync(join(dir, 'space.json'), JSON.stringify({ name: 'tier-space' }), 'utf8')
  writeFileSync(join(dir, 'transcript.jsonl'), '{"seq":1}\n', 'utf8')
  writeFileSync(join(dir, 'runtime', 'config.json'), '{"webPort":3000}\n', 'utf8')
  writeFileSync(join(dir, 'runtime', 'secret.key'), 'v3-master-key-bytes', 'utf8')
  writeFileSync(join(dir, 'identity-master.key'), 'v4-kek-bytes', 'utf8')
  writeFileSync(join(dir, 'secrets.enc.json'), '{"blob":"VAULT-CIPHERTEXT"}', 'utf8')
  writeFileSync(join(dir, 'runtime', 'admin-sessions.json'), '{"sid":"stale-session-sid"}', 'utf8')
  if (opts.signingKey !== false) {
    writeFileSync(join(dir, 'agent-card-signing.key'), 'FAKE-PKCS8-SIGNING-KEY', 'utf8')
  }
  writeFileSync(join(dir, 'agent-card.json'), '{"name":"my hub"}', 'utf8')
  if (opts.db !== false) {
    const db = new Database(join(dir, 'identity.sqlite'))
    db.prepare(
      `CREATE TABLE peers (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, endpoint_url TEXT NOT NULL,
        label TEXT, enabled INTEGER NOT NULL DEFAULT 1, vault_entry_id TEXT NOT NULL,
        outbound_caps_json TEXT, pinned_kid TEXT, trust_tier TEXT)`,
    ).run()
    db.prepare(
      `INSERT INTO peers VALUES
        ('r1','hub-b','wss://b.example:7777','Hub B',1,'vault-entry-TOKEN-POINTER','["research.v1"]','kid-abc','trusted'),
        ('r2','hub-a','wss://a.example:7777',NULL,0,'vault-entry-TOKEN-POINTER','not-json',NULL,NULL)`,
    ).run()
    db.close()
  }
}

interface RunResult {
  code: number
  out: string[]
  err: string[]
  tgz: string
}

async function runBackup(space: string, flags: string[], deps: Parameters<typeof backup>[1] = {}): Promise<RunResult> {
  const bk = mkdtempSync(join(root, 'bk-'))
  const out: string[] = []
  const err: string[] = []
  const code = await backup([space, bk, ...flags], { out: (l) => out.push(l), err: (l) => err.push(l), ...deps })
  const tgz = readdirSync(bk).filter((f) => f.endsWith('.tar.gz')).map((f) => join(bk, f))[0] ?? ''
  return { code, out, err, tgz }
}

/** 解开归档:成员相对路径(排序)+ 每个文件的原始内容。 */
async function extractAll(tgz: string): Promise<{ members: string[]; contents: Map<string, string> }> {
  const dir = mkdtempSync(join(root, 'x-'))
  await tar.extract({ file: tgz, cwd: dir })
  const members: string[] = []
  const contents = new Map<string, string>()
  const visit = (rel: string): void => {
    for (const ent of readdirSync(rel === '' ? dir : join(dir, rel), { withFileTypes: true })) {
      const childRel = rel === '' ? ent.name : `${rel}/${ent.name}`
      if (ent.isDirectory()) visit(childRel)
      else {
        members.push(childRel)
        contents.set(childRel, readFileSync(join(dir, childRel), 'utf8'))
      }
    }
  }
  visit('')
  return { members: members.sort(), contents }
}

function expectNoSentinelBytes(contents: Map<string, string>): void {
  for (const [path, text] of contents) {
    for (const s of SENTINELS) {
      expect(text.includes(s), `子集档文件 ${path} 含哨兵字节 ${s}`).toBe(false)
    }
  }
}

describe('AFR-M6 — 身份档(--tier=identity)', () => {
  it('内容清单钉死:恰好三个白名单文件 + 清单;零金库·主钥·会话·数据字节', async () => {
    const space = join(root, 'space')
    makeSpace(space)
    const { code, tgz, out } = await runBackup(space, ['--tier=identity'])
    expect(code).toBe(0)
    const { members, contents } = await extractAll(tgz)
    expect(members).toEqual([
      MANIFEST_NAME,
      'space/agent-card-signing.key',
      'space/agent-card.json',
      'space/space.json',
    ])
    expectNoSentinelBytes(contents)
    const manifest = parseManifest(contents.get(MANIFEST_NAME)!)
    expect(manifest?.tier).toBe('identity')
    expect(manifest?.includesMasterKey).toBe(false)
    expect(out.join('\n')).toContain('Subset archive (tier: identity)')
  })

  it('没有签名钥的空间:照打包但响亮说明「没有密码学身份」', async () => {
    const space = join(root, 'space')
    makeSpace(space, { signingKey: false })
    const { code, err, tgz } = await runBackup(space, ['--tier=identity'])
    expect(code).toBe(0)
    expect(err.join('\n')).toContain('no agent-card-signing.key')
    const { members } = await extractAll(tgz)
    expect(members).toEqual([MANIFEST_NAME, 'space/agent-card.json', 'space/space.json'])
  })

  it('--tier 与 --include-master-key 不可组合;未知档位拒绝', async () => {
    const space = join(root, 'space')
    makeSpace(space)
    const both = await runBackup(space, ['--tier=identity', '--include-master-key'])
    expect(both.code).toBe(1)
    expect(both.err.join('\n')).toContain('cannot be combined')
    const bogus = await runBackup(space, ['--tier=bogus'])
    expect(bogus.code).toBe(1)
    expect(bogus.err.join('\n')).toContain('invalid --tier value')
  })
})

describe('AFR-M6 — 身份+关系档(--tier=relations)', () => {
  it('= 身份档 + 非密投影;投影字段齐、结构性无令牌指针、诚实边界印在档案里', async () => {
    const space = join(root, 'space')
    makeSpace(space)
    const { code, tgz, out } = await runBackup(space, ['--tier=relations'])
    expect(code).toBe(0)
    const { members, contents } = await extractAll(tgz)
    expect(members).toEqual([
      MANIFEST_NAME,
      'space/agent-card-signing.key',
      'space/agent-card.json',
      `space/${PEERS_PROJECTION_NAME}`,
      'space/space.json',
    ])
    expectNoSentinelBytes(contents)
    expect(parseManifest(contents.get(MANIFEST_NAME)!)?.tier).toBe('relations')

    const projText = contents.get(`space/${PEERS_PROJECTION_NAME}`)!
    // 结构性无令牌:连 vault 指针的字段名都不出现在投影里
    expect(projText).not.toContain('vault_entry_id')
    const proj = JSON.parse(projText) as PeersProjection
    expect(proj.format).toBe('gotong.peers-projection/v1')
    expect(proj.note).toContain('令牌在金库')
    expect(proj.note).toContain('mint-peer-token')
    expect(proj.peers).toEqual([
      // 按 peerId 排序;r2 行:label/pinned/tier 空、坏 outbound_caps_json fail-soft 成 null
      {
        peerId: 'hub-a',
        endpointUrl: 'wss://a.example:7777',
        label: null,
        enabled: false,
        pinnedKid: null,
        trustTier: null,
        outboundCaps: null,
      },
      {
        peerId: 'hub-b',
        endpointUrl: 'wss://b.example:7777',
        label: 'Hub B',
        enabled: true,
        pinnedKid: 'kid-abc',
        trustTier: 'trusted',
        outboundCaps: ['research.v1'],
      },
    ])
    expect(out.join('\n')).toContain('tokens NOT included')
  })

  it('读取阶梯:driver 挂 → sqlite3 CLI -json 顶上;全挂 → exit 3 响亮失败不静默', async () => {
    const space = join(root, 'space')
    makeSpace(space)
    const noDriver = () => Promise.reject(new Error('module not found'))
    const cliRows = [
      { id: 'r1', peer_id: 'hub-c', endpoint_url: 'wss://c.example', enabled: 1 },
    ]
    const viaCli = await runBackup(space, ['--tier=relations'], {
      loadDriver: noDriver,
      runSqlite3Query: async (_db, sql) =>
        sql.includes('sqlite_master') ? '[{"n":1}]' : JSON.stringify(cliRows),
    })
    expect(viaCli.code).toBe(0)
    const { contents } = await extractAll(viaCli.tgz)
    const proj = JSON.parse(contents.get(`space/${PEERS_PROJECTION_NAME}`)!) as PeersProjection
    expect(proj.peers.map((p) => p.peerId)).toEqual(['hub-c'])

    const exhausted = await runBackup(space, ['--tier=relations'], {
      loadDriver: noDriver,
      runSqlite3Query: () => Promise.reject(new Error('sqlite3 not on PATH')),
    })
    expect(exhausted.code).toBe(3)
    expect(exhausted.err.join('\n')).toContain('neither')
    expect(exhausted.tgz).toBe('') // 响亮失败 = 不留半截归档
  })

  it('没有 identity.sqlite 的空间:真·零 peer,如实空投影不算失败', async () => {
    const space = join(root, 'space')
    makeSpace(space, { db: false })
    const { code, tgz, out } = await runBackup(space, ['--tier=relations'])
    expect(code).toBe(0)
    expect(out.join('\n')).toContain('zero peers')
    const { contents } = await extractAll(tgz)
    const proj = JSON.parse(contents.get(`space/${PEERS_PROJECTION_NAME}`)!) as PeersProjection
    expect(proj.peers).toEqual([])
  })

  it('子集档可被 restore 验证落到全新目录(清单闭环)', async () => {
    const space = join(root, 'space')
    makeSpace(space)
    const { tgz } = await runBackup(space, ['--tier=relations'])
    const target = join(root, 'fresh')
    const out: string[] = []
    const err: string[] = []
    const code = await restore([tgz, '--space', target], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      resolveHost: () => null,
    })
    expect(code).toBe(0)
    expect(existsSync(join(target, PEERS_PROJECTION_NAME))).toBe(true)
    expect(existsSync(join(target, 'agent-card-signing.key'))).toBe(true)
    expect(existsSync(join(target, 'identity.sqlite'))).toBe(false)
  })
})

describe('AFR-M6 — 纯核直测', () => {
  it('shouldSkipForStaging:tier 缺省=既有语义;给了 tier=白名单外全跳过', () => {
    expect(shouldSkipForStaging('transcript.jsonl', false)).toBe(false)
    expect(shouldSkipForStaging('transcript.jsonl', false, 'identity')).toBe(true)
    expect(shouldSkipForStaging('space.json', false, 'identity')).toBe(false)
    expect(shouldSkipForStaging('agent-card-signing.key', false, 'relations')).toBe(false)
    // 主钥即便在(不可能通过 CLI 到达的)tier+includeMasterKey 组合下也进不来
    expect(shouldSkipForStaging('identity-master.key', true, 'identity')).toBe(true)
    expect(shouldSkipForStaging('identity.sqlite', true, 'relations')).toBe(true)
  })

  it('buildPeersProjection:老库缺列 → null(不炸);行排序稳定;非对象行剔除', () => {
    const proj = buildPeersProjection(
      [
        { peer_id: 'z-hub', endpoint_url: 'wss://z' }, // 老库:无 pinned/tier/caps 列
        { peer_id: 'a-hub', endpoint_url: 'wss://a', enabled: 1 },
        null,
        'garbage',
        { endpoint_url: 'wss://no-id' }, // 缺 peer_id → 剔除
      ],
      '2026-07-16T00:00:00.000Z',
    )
    expect(proj.peers.map((p) => p.peerId)).toEqual(['a-hub', 'z-hub'])
    expect(proj.peers[1]).toEqual({
      peerId: 'z-hub',
      endpointUrl: 'wss://z',
      label: null,
      enabled: false,
      pinnedKid: null,
      trustTier: null,
      outboundCaps: null,
    })
  })

  it('parseManifest:tier 合法值/缺席过,非法值拒', () => {
    const base = { format: 'gotong.backup/v1', createdAt: 'x', label: 'l', includesMasterKey: false, files: [] }
    expect(parseManifest(JSON.stringify(base))).not.toBe(null)
    expect(parseManifest(JSON.stringify({ ...base, tier: 'identity' }))?.tier).toBe('identity')
    expect(parseManifest(JSON.stringify({ ...base, tier: 'relations' }))?.tier).toBe('relations')
    expect(parseManifest(JSON.stringify({ ...base, tier: 'everything' }))).toBe(null)
  })
})
