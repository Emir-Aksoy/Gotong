/**
 * KIT-M1 — `gotong backup / restore` 验收门(计划逐条 + 拒绝面):
 *
 *   1. 备份→篡改→restore 拒绝(sha256 不符),目标目录一字不动;
 *   2. 活写中备份(WAL 有未 checkpoint 帧)→ 恢复后 PRAGMA
 *      integrity_check ok 且行数一条不少;
 *   3. 默认包内**无 master key**(两个世代 + 会话文件)+ 提示语断言;
 *   4. `--include-master-key` 才有钥匙,且大声密级提示;会话文件仍排除;
 *   5. WAL 阶梯全断 → 原样拷贝 + 大声警告(诚实降级不静默);
 *   6. 旧 .sh 归档(无清单)→ 拒绝并指路 restore.sh;
 *   7. 非空目标拒绝,--force 在验证通过后才替换。
 */

import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  backupFileName,
  parseManifest,
  shouldSkipForStaging,
  verifyManifest,
} from '../src/commands/backup-core.js'
import { backup } from '../src/commands/backup.js'
import { restore } from '../src/commands/restore.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gotong-kit-m1-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一个带两代钥匙、会话文件、transcript 的最小 workspace。 */
function makeSpace(dir: string): void {
  mkdirSync(join(dir, 'runtime'), { recursive: true })
  mkdirSync(join(dir, 'workflows', 'definitions'), { recursive: true })
  writeFileSync(join(dir, 'space.json'), JSON.stringify({ name: 'test-space' }), 'utf8')
  writeFileSync(join(dir, 'transcript.jsonl'), '{"seq":1}\n{"seq":2}\n', 'utf8')
  writeFileSync(join(dir, 'runtime', 'config.json'), '{"webPort":3000}\n', 'utf8')
  writeFileSync(join(dir, 'runtime', 'secret.key'), 'v3-master-key-bytes', 'utf8')
  writeFileSync(join(dir, 'identity-master.key'), 'v4-kek-bytes', 'utf8')
  writeFileSync(join(dir, 'identity-master.key.next'), 'v4-kek-rotation-staging', 'utf8')
  writeFileSync(join(dir, 'runtime', 'admin-sessions.json'), '{"sid":"stale"}', 'utf8')
  writeFileSync(join(dir, 'runtime', 'worker-sessions.json'), '{"sid":"stale2"}', 'utf8')
  writeFileSync(join(dir, 'workflows', 'definitions', 'demo.yaml'), 'id: demo\n', 'utf8')
}

/** WAL 模式建库、插 rows 行、关掉 autocheckpoint 让帧留在 -wal 里;connection 保持打开。 */
function openLiveDb(dir: string, rows: number): InstanceType<typeof Database> {
  const db = new Database(join(dir, 'identity.sqlite'))
  db.pragma('journal_mode = WAL')
  db.pragma('wal_autocheckpoint = 0')
  db.prepare('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)').run()
  const ins = db.prepare('INSERT INTO users (name) VALUES (?)')
  for (let i = 0; i < rows; i++) ins.run(`user-${i}`)
  return db
}

interface RunResult {
  code: number
  out: string[]
  err: string[]
}

async function runBackup(spaceDir: string, backupDir: string, flags: string[] = [], deps: Parameters<typeof backup>[1] = {}): Promise<RunResult & { tgz: string }> {
  const out: string[] = []
  const err: string[] = []
  const code = await backup([spaceDir, backupDir, ...flags], { out: (l) => out.push(l), err: (l) => err.push(l), ...deps })
  const tgz = existsSync(backupDir) ? readdirSync(backupDir).filter((f) => f.endsWith('.tar.gz')).map((f) => join(backupDir, f))[0] ?? '' : ''
  return { code, out, err, tgz }
}

async function runRestore(archive: string, target: string, flags: string[] = [], deps: Parameters<typeof restore>[1] = {}): Promise<RunResult> {
  const out: string[] = []
  const err: string[] = []
  const code = await restore([archive, '--space', target, ...flags], {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    resolveHost: () => null, // 后置体检有专门用例;其余用例免得依赖 host 是否在 node_modules
    ...deps,
  })
  return { code, out, err }
}

/** 解开归档,返回内部全部文件路径(归档相对,POSIX)。 */
async function archiveMembers(tgz: string): Promise<string[]> {
  const dir = mkdtempSync(join(root, 'x-'))
  await tar.extract({ file: tgz, cwd: dir })
  const acc: string[] = []
  const visit = (rel: string): void => {
    for (const ent of readdirSync(rel === '' ? dir : join(dir, rel), { withFileTypes: true })) {
      const childRel = rel === '' ? ent.name : `${rel}/${ent.name}`
      if (ent.isDirectory()) visit(childRel)
      else acc.push(childRel)
    }
  }
  visit('')
  return acc.sort()
}

describe('KIT-M1 backup — 排除规则与提示语', () => {
  it('默认包内无 master key(两代)与会话文件;有清单;提示语明说钥匙没带', async () => {
    const space = join(root, 'space')
    makeSpace(space)
    const { code, out, tgz } = await runBackup(space, join(root, 'bk'))
    expect(code).toBe(0)
    const members = await archiveMembers(tgz)
    expect(members).toContain(`${MANIFEST_NAME}`)
    expect(members).toContain('space/space.json')
    expect(members).toContain('space/transcript.jsonl')
    // 计划验收:默认包内无 master key 断言。
    expect(members).not.toContain('space/runtime/secret.key')
    expect(members.some((m) => m.includes('identity-master.key'))).toBe(false)
    expect(members).not.toContain('space/runtime/admin-sessions.json')
    expect(members).not.toContain('space/runtime/worker-sessions.json')
    // 提示语断言(与 backup.sh 收尾措辞同源)。
    expect(out.join('\n')).toContain('intentionally NOT included')
    // 清单形状可解析且 includesMasterKey=false。
    const dir = mkdtempSync(join(root, 'm-'))
    await tar.extract({ file: tgz, cwd: dir })
    const manifest = parseManifest(readFileSync(join(dir, MANIFEST_NAME), 'utf8'))
    expect(manifest).not.toBeNull()
    expect(manifest!.includesMasterKey).toBe(false)
    expect(manifest!.label).toBe('space')
  })

  it('--include-master-key 才带钥匙 + 大声密级提示;会话文件仍然排除', async () => {
    const space = join(root, 'space')
    makeSpace(space)
    const { code, out, tgz } = await runBackup(space, join(root, 'bk'), ['--include-master-key'])
    expect(code).toBe(0)
    const members = await archiveMembers(tgz)
    expect(members).toContain('space/runtime/secret.key')
    expect(members).toContain('space/identity-master.key')
    expect(members).toContain('space/identity-master.key.next')
    // 会话文件没有开关——永远不进包。
    expect(members).not.toContain('space/runtime/admin-sessions.json')
    expect(members).not.toContain('space/runtime/worker-sessions.json')
    expect(out.join('\n')).toContain('密级备份')
    expect(out.join('\n')).toContain('INCLUDES the master keys')
  })

  it('不是 workspace(无 space.json)→ 退出码 2', async () => {
    const notSpace = join(root, 'plain')
    mkdirSync(notSpace, { recursive: true })
    const { code, err } = await runBackup(notSpace, join(root, 'bk'))
    expect(code).toBe(2)
    expect(err.join('\n')).toContain('space.json')
  })
})

describe('KIT-M1 backup — WAL 安全快照阶梯', () => {
  it('活写中备份(WAL 未 checkpoint)→ 恢复后 integrity_check ok 且行数全在', async () => {
    const space = join(root, 'space')
    makeSpace(space)
    const db = openLiveDb(space, 50)
    try {
      // -wal 里确实有未落盘的帧——这正是原样拷贝会丢数据的局面。
      expect(existsSync(join(space, 'identity.sqlite-wal'))).toBe(true)
      const { code, out, tgz } = await runBackup(space, join(root, 'bk'))
      expect(code).toBe(0)
      expect(out.join('\n')).toContain('WAL-safe')

      const target = join(root, 'restored')
      const r = await runRestore(tgz, target)
      expect(r.code).toBe(0)
      // 快照自足:恢复目录里只有 db,没有 -wal / -shm 尾巴。
      expect(existsSync(join(target, 'identity.sqlite'))).toBe(true)
      expect(existsSync(join(target, 'identity.sqlite-wal'))).toBe(false)

      const restored = new Database(join(target, 'identity.sqlite'), { readonly: true })
      try {
        const integrity = restored.pragma('integrity_check', { simple: true })
        expect(integrity).toBe('ok')
        const n = restored.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
        expect(n.n).toBe(50)
      } finally {
        restored.close()
      }
    } finally {
      db.close()
    }
  })

  it('阶梯全断(driver + sqlite3 CLI 都不可用)→ 原样拷贝三件 + 大声警告', async () => {
    const space = join(root, 'space')
    makeSpace(space)
    const db = openLiveDb(space, 5)
    try {
      const { code, err, tgz } = await runBackup(space, join(root, 'bk'), [], {
        loadDriver: () => Promise.reject(new Error('not installed')),
        runSqlite3: () => Promise.reject(new Error('no sqlite3 on PATH')),
      })
      expect(code).toBe(0) // 降级不是失败——但必须大声。
      const noise = err.join('\n')
      expect(noise).toContain('no WAL-safe copier')
      expect(noise).toContain('tear the copy')
      const members = await archiveMembers(tgz)
      expect(members).toContain('space/identity.sqlite')
      expect(members).toContain('space/identity.sqlite-wal') // 原样模式连 WAL 一起搬
    } finally {
      db.close()
    }
  })
})

describe('KIT-M1 restore — 先验后落盘', () => {
  it('篡改归档 → 拒绝(sha256 不符),目标目录一字不动', async () => {
    const space = join(root, 'space')
    makeSpace(space)
    const { tgz } = await runBackup(space, join(root, 'bk'))

    // 解开→翻转 transcript 一个字节→原结构重新打包(清单原封不动)。
    const work = mkdtempSync(join(root, 'tamper-'))
    await tar.extract({ file: tgz, cwd: work })
    const victim = join(work, 'space', 'transcript.jsonl')
    const bytes = readFileSync(victim)
    bytes[0] = bytes[0]! ^ 0xff
    writeFileSync(victim, bytes)
    const tampered = join(root, 'tampered.tar.gz')
    await tar.create({ gzip: true, cwd: work, file: tampered }, ['space', MANIFEST_NAME])

    const target = join(root, 'restored')
    const r = await runRestore(tampered, target)
    expect(r.code).toBe(4)
    expect(r.err.join('\n')).toContain('sha256 mismatch: transcript.jsonl')
    expect(r.err.join('\n')).toContain('target untouched')
    expect(existsSync(target)).toBe(false) // 拒绝时目标连目录都不产生
  })

  it('归档少了文件 / 多了文件都拒绝(文件集双向比对)', async () => {
    const space = join(root, 'space')
    makeSpace(space)
    const { tgz } = await runBackup(space, join(root, 'bk'))
    const work = mkdtempSync(join(root, 'edit-'))
    await tar.extract({ file: tgz, cwd: work })
    rmSync(join(work, 'space', 'runtime', 'config.json'))
    writeFileSync(join(work, 'space', 'sneaky.txt'), 'not in manifest', 'utf8')
    const edited = join(root, 'edited.tar.gz')
    await tar.create({ gzip: true, cwd: work, file: edited }, ['space', MANIFEST_NAME])

    const r = await runRestore(edited, join(root, 'restored'))
    expect(r.code).toBe(4)
    const noise = r.err.join('\n')
    expect(noise).toContain('missing from archive: runtime/config.json')
    expect(noise).toContain('not in manifest: sneaky.txt')
  })

  it('旧 .sh 归档(无清单)→ 拒绝并指路 restore.sh', async () => {
    const space = join(root, 'space')
    makeSpace(space)
    const legacy = join(root, 'legacy.tar.gz')
    await tar.create({ gzip: true, cwd: root, file: legacy }, ['space'])
    const r = await runRestore(legacy, join(root, 'restored'))
    expect(r.code).toBe(4)
    expect(r.err.join('\n')).toContain('scripts/backup/restore.sh')
    expect(existsSync(join(root, 'restored'))).toBe(false)
  })

  it('非空目标拒绝;--force 验证通过后替换,旧内容不残留', async () => {
    const space = join(root, 'space')
    makeSpace(space)
    const { tgz } = await runBackup(space, join(root, 'bk'))

    const target = join(root, 'occupied')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'precious.txt'), 'old life', 'utf8')

    const refused = await runRestore(tgz, target)
    expect(refused.code).toBe(2)
    expect(refused.err.join('\n')).toContain('--force')
    expect(readFileSync(join(target, 'precious.txt'), 'utf8')).toBe('old life') // 一字不动

    const forced = await runRestore(tgz, target, ['--force'])
    expect(forced.code).toBe(0)
    expect(existsSync(join(target, 'precious.txt'))).toBe(false)
    expect(existsSync(join(target, 'space.json'))).toBe(true)
    // 换名恢复也成立:目标名 ≠ 归档 label,内容照样就位。
    expect(JSON.parse(readFileSync(join(target, 'space.json'), 'utf8')).name).toBe('test-space')
  })

  it('恢复完自动跑 host 体检(GOTONG_SPACE 指向目标);host 缺席则提示跳过', async () => {
    const space = join(root, 'space')
    makeSpace(space)
    const { tgz } = await runBackup(space, join(root, 'bk'))

    // host 在场:runCheckCli 收到的 env.GOTONG_SPACE 必须是恢复目标。
    let seenSpace: string | undefined
    const target = join(root, 'checked')
    const withHost = await runRestore(tgz, target, [], {
      resolveHost: () => '/fake/host/index.js',
      importCheck: () =>
        Promise.resolve({
          runCheckCli: async (deps?: { argv?: readonly string[]; env?: Record<string, string | undefined> }) => {
            seenSpace = deps?.env?.GOTONG_SPACE
            return 0
          },
        }),
    })
    expect(withHost.code).toBe(0)
    expect(seenSpace).toBe(target)

    // host 缺席:提示跳过,不算失败。
    const bare = await runRestore(tgz, join(root, 'unchecked'))
    expect(bare.code).toBe(0)
    expect(bare.out.join('\n')).toContain('skipping the post-restore check')
  })

  it('默认(不带钥匙)的恢复提醒用户把 key 放回去', async () => {
    const space = join(root, 'space')
    makeSpace(space)
    const { tgz } = await runBackup(space, join(root, 'bk'))
    const r = await runRestore(tgz, join(root, 'restored'))
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('does NOT contain the master keys')
  })
})

describe('KIT-M1 纯函数核', () => {
  it('排除谓词与 backup.sh 逐字对齐(根级锚定)', () => {
    // 会话文件:永远跳过,与钥匙开关无关。
    expect(shouldSkipForStaging('runtime/admin-sessions.json', true)).toBe(true)
    expect(shouldSkipForStaging('runtime/worker-sessions.json', true)).toBe(true)
    // 两代钥匙:默认跳过,--include-master-key 才收。
    expect(shouldSkipForStaging('runtime/secret.key', false)).toBe(true)
    expect(shouldSkipForStaging('runtime/secret.key', true)).toBe(false)
    expect(shouldSkipForStaging('identity-master.key', false)).toBe(true)
    expect(shouldSkipForStaging('identity-master.key.next', false)).toBe(true)
    expect(shouldSkipForStaging('identity-master.key', true)).toBe(false)
    // .sh 的排除模式锚在 leaf 根——子目录里的同名文件不匹配。
    expect(shouldSkipForStaging('nested/identity-master.key', false)).toBe(false)
    expect(shouldSkipForStaging('nested/runtime/secret.key', false)).toBe(false)
    // sqlite 家族在收集阶段跳过(快照阶梯单独放回)。
    expect(shouldSkipForStaging('identity.sqlite', false)).toBe(true)
    expect(shouldSkipForStaging('identity.sqlite-wal', false)).toBe(true)
    expect(shouldSkipForStaging('identity.sqlite-shm', false)).toBe(true)
    // 普通文件照收。
    expect(shouldSkipForStaging('transcript.jsonl', false)).toBe(false)
  })

  it('backupFileName 与 .sh 同构:UTC、无冒号、可字典序排', () => {
    expect(backupFileName('space', new Date('2026-07-06T01:02:03.456Z'))).toBe(
      'gotong-space-20260706T010203Z.tar.gz',
    )
  })

  it('verifyManifest 双向比对 + hash/尺寸区分报告', () => {
    const manifest = {
      format: 'gotong.backup/v1' as const,
      createdAt: 'x',
      label: 'space',
      includesMasterKey: false,
      files: [
        { path: 'a.txt', size: 2, sha256: createHash('sha256').update('ok').digest('hex') },
        { path: 'gone.txt', size: 1, sha256: 'f'.repeat(64) },
      ],
    }
    const actual = new Map([
      ['a.txt', { size: 2, sha256: createHash('sha256').update('no').digest('hex') }],
      ['extra.txt', { size: 3, sha256: 'a'.repeat(64) }],
    ])
    const problems = verifyManifest(manifest, actual)
    expect(problems).toEqual([
      'missing from archive: gone.txt',
      'not in manifest: extra.txt',
      'sha256 mismatch: a.txt',
    ])
  })

  it('parseManifest:旧格式 / 损坏 → null(拒绝而非硬猜)', () => {
    expect(parseManifest('not json')).toBeNull()
    expect(parseManifest('{}')).toBeNull()
    expect(parseManifest(JSON.stringify({ format: 'gotong.backup/v0', label: 'x' }))).toBeNull()
    expect(
      parseManifest(
        JSON.stringify({ format: 'gotong.backup/v1', createdAt: 'x', label: 'space', includesMasterKey: false, files: [{ path: 1 }] }),
      ),
    ).toBeNull()
  })
})

// 真 sqlite3 CLI 在场时,顺手把阶梯②也真跑一遍(缺席就跳过——诚实)。
const hasSqlite3 = (() => {
  try {
    execSync('sqlite3 -version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe.runIf(hasSqlite3)('KIT-M1 backup — 阶梯② sqlite3 CLI', () => {
  it('driver 被拔掉时走 sqlite3 .backup,快照行数一致', async () => {
    const space = join(root, 'space')
    makeSpace(space)
    const db = openLiveDb(space, 7)
    try {
      const { code, out, tgz } = await runBackup(space, join(root, 'bk'), [], {
        loadDriver: () => Promise.reject(new Error('not installed')),
      })
      expect(code).toBe(0)
      expect(out.join('\n')).toContain("sqlite3 .backup")
      const target = join(root, 'restored')
      const r = await runRestore(tgz, target)
      expect(r.code).toBe(0)
      const restored = new Database(join(target, 'identity.sqlite'), { readonly: true })
      try {
        const n = restored.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
        expect(n.n).toBe(7)
      } finally {
        restored.close()
      }
    } finally {
      db.close()
    }
  })
})
