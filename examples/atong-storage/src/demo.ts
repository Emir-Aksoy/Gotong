/**
 * atong-storage —— STOR track capstone:存储管家四件套端到端五幕自断言。
 *
 * 真件:@gotong/host 的 space-ledger / space-sweeper / space-retention /
 * space-proposals 全部经 `@gotong/host/space-steward` 子路径引入,零重写
 * (host 根入口 `import '@gotong/host'` 会把整台 host 跑起来,所以必须走
 * 子路径——AFR-M8 判例)。零 LLM 零网络零 key:提案是纯函数,阶梯的 git
 * 安全网注入恒失败的 stub,时钟全程注入,两次连跑同结果。
 *
 * 五幕:
 *   1. 空间账本    —— 有界丈量按顶层类目分桶,账本落盘可回读。
 *   2. 死物清扫    —— 孤儿 tmp 年龄门 / corrupt 保 5 / 根部 .bak 保 3;
 *                     视野是结构性的(butler/ 不进,目录不碰,runtime 无 bak),
 *                     类④凭证逐字节不动;先落账再动手。
 *   3. 无策略零删除 —— retention.json 缺席 ⇒ 阶梯 thunk 返回 null,
 *                     盘上连 runtime/ 都不建(不删是缺省,不是降级)。
 *   4. 岔口① 硬前置 —— 过期内容没进备份安全网 ⇒ 跳过+计数,一个字节不删;
 *                     全量备份落地后同一轮策略才真动手,每删一件先落账。
 *   5. 提案卡      —— 确定性阈值触发两类提案(P2 备份缺口在前=根因先说;
 *                     P1 带 apply 只指 set_retention 既有参数空间);
 *                     策略落地 P1 闭嘴,备份补上 P2 闭嘴,无话可说=空串。
 *
 * 运行:pnpm demo:atong-storage(exit 0 = 全部断言通过)。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SPACE_ACTIONS_FILE,
  PROPOSED_DAYS,
  buildRetentionLadder,
  loadRetentionPolicy,
  proposeStorageActions,
  readFullBackupAt,
  readRetentionState,
  readSpaceActions,
  retentionLadderOnce,
  spaceLedgerAt,
  storageProposalsAt,
  sweepSpaceOnce,
  writeRetentionPolicy,
} from '@gotong/host/space-steward'

// 注入时钟:所有年龄门/保留期/提案判定都从这一个 T 出发,demo 因此确定性。
const T = Date.UTC(2026, 7, 29)
const HOUR = 3_600_000
const DAY = 86_400_000
const now = () => T

let passed = 0
function assert(cond: unknown, label: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${label}`)
}

function touch(path: string, epochMs: number): void {
  utimesSync(path, new Date(epochMs), new Date(epochMs))
}

function seed(path: string, content: string, mtimeMs?: number): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  if (mtimeMs !== undefined) touch(path, mtimeMs)
}

const root = mkdtempSync(join(tmpdir(), 'atong-storage-'))

async function main(): Promise<void> {
  // ─────────────────────────────────────────────────────────────────────
  // 幕 1:空间账本 —— 丈量分桶 + 落盘回读
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n—— 幕 1:空间账本(先有尺后动刀) ——')
  const a1 = join(root, 'a1')
  seed(join(a1, 'transcript.jsonl'), 'x'.repeat(2048))
  seed(join(a1, 'transcript-archive', 'seg-000001.jsonl'), 'x'.repeat(1024))
  seed(join(a1, 'identity.sqlite'), 'x'.repeat(4096))
  seed(join(a1, 'butler', 'memory', 'user', 'u1', 'knowledge', 'archive', 'notes.md'), 'x'.repeat(512))
  seed(join(a1, 'butler', 'sessions', 'u1.json'), 'x'.repeat(256))
  seed(join(a1, 'agents.json.bak-20260801-000000'), 'x'.repeat(128))
  // 假 fixture(临时目录里的演示文件,不是真凭证):账本只量字节不读内容。
  seed(join(a1, 'gotong.env'), 'x'.repeat(64))

  const led1 = spaceLedgerAt(a1)
  const row1 = await led1.measure()
  assert(row1 !== null && row1.v === 1 && row1.truncated === false, '账本 v1 且未截断(预算内量完就说量完)')
  const cat = (id: string) => row1.categories.find((c) => c.id === id)
  assert(cat('transcript')?.bytes === 2048 + 1024, 'transcript.jsonl 与 transcript-archive/ 并入同一 transcript 桶')
  assert(cat('butler/memory') !== undefined && cat('butler/sessions') !== undefined, 'butler/ 恰好展开一层:butler/memory 与 butler/sessions 各自成桶')
  assert(cat('bak')?.bytes === 128 && row1.categories[0]?.id === 'identity', '.bak- 族归 bak 桶,排序按字节数降序(identity 4096 居首)')
  assert(cat('identity')?.bytes === 4096 && cat('other')?.bytes === 64, 'identity.sqlite 归 identity 桶,认不出的名字诚实落 other')
  const reread1 = await led1.read()
  assert(
    existsSync(led1.ledgerFile) &&
      reread1 !== null &&
      reread1.totalBytes === row1.totalBytes &&
      reread1.totalEntries === row1.totalEntries,
    '账本落盘 runtime/space-ledger.json 且读者回读同一份总数',
  )

  // ─────────────────────────────────────────────────────────────────────
  // 幕 2:死物清扫 —— 三谓词 + 结构性视野 + 类④零触碰 + 先落账再动手
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n—— 幕 2:死物清扫(删得掉,更删得有账) ——')
  const a2 = join(root, 'a2')
  seed(join(a2, 'runtime', 'orphan.tmp'), 'orphan', T - 25 * HOUR)
  seed(join(a2, 'runtime', 'fresh.tmp'), 'fresh', T - 1 * HOUR)
  for (let i = 1; i <= 6; i++) seed(join(a2, `state.json.corrupt-${i}`), `c${i}`, T - (10 - i) * HOUR)
  for (let i = 1; i <= 5; i++) seed(join(a2, `agents.json.bak-${i}`), `b${i}`, T - (10 - i) * HOUR)
  seed(join(a2, 'butler', 'sessions', 'stale.tmp'), 'outside', T - 48 * HOUR)
  seed(join(a2, 'config.bak-999', 'inner.txt'), 'dir-not-file')
  seed(join(a2, 'runtime', 'keep.bak-1'), 'runtime-bak', T - 48 * HOUR)
  const sentinels = {
    identity: 'IDENTITY-BYTES',
    env: 'ENV-FIXTURE',
    secrets: 'SECRETS-FIXTURE',
  }
  seed(join(a2, 'identity.sqlite'), sentinels.identity)
  seed(join(a2, 'gotong.env'), sentinels.env)
  seed(join(a2, 'secrets.enc.json'), sentinels.secrets)

  const actions2 = join(a2, 'runtime', SPACE_ACTIONS_FILE)
  const sweep = await sweepSpaceOnce({ spaceDir: a2, actionsFile: actions2, now })
  assert(
    sweep.deletedTmp === 1 && !existsSync(join(a2, 'runtime', 'orphan.tmp')) && existsSync(join(a2, 'runtime', 'fresh.tmp')),
    '孤儿 tmp 过 24h 年龄门才删(25h 删,1h 留)',
  )
  assert(
    sweep.deletedCorrupt === 1 &&
      !existsSync(join(a2, 'state.json.corrupt-1')) &&
      existsSync(join(a2, 'state.json.corrupt-2')) &&
      existsSync(join(a2, 'state.json.corrupt-6')),
    'corrupt 族每族保 5 代,只删最老那件',
  )
  assert(
    sweep.deletedBak === 2 &&
      !existsSync(join(a2, 'agents.json.bak-1')) &&
      !existsSync(join(a2, 'agents.json.bak-2')) &&
      existsSync(join(a2, 'agents.json.bak-3')) &&
      existsSync(join(a2, 'agents.json.bak-5')),
    '根部 .bak 族保 3 代,删最老两件',
  )
  assert(
    existsSync(join(a2, 'butler', 'sessions', 'stale.tmp')) &&
      existsSync(join(a2, 'config.bak-999', 'inner.txt')) &&
      existsSync(join(a2, 'runtime', 'keep.bak-1')),
    '视野是结构性的:butler/ 不进视野、.bak- 目录不碰、runtime 里的 bak 是独苗不轮转',
  )
  assert(
    readFileSync(join(a2, 'identity.sqlite'), 'utf8') === sentinels.identity &&
      readFileSync(join(a2, 'gotong.env'), 'utf8') === sentinels.env &&
      readFileSync(join(a2, 'secrets.enc.json'), 'utf8') === sentinels.secrets,
    '类④凭证/身份(identity.sqlite、gotong.env、secrets.enc.json)逐字节不动',
  )
  const rows2 = await readSpaceActions(actions2)
  const classCount = (cls: string) => rows2.filter((r) => r['class'] === cls).length
  assert(
    rows2.length === 4 &&
      rows2.every((r) => r.kind === 'delete' && typeof r['file'] === 'string' && !(r['file'] as string).includes('/')) &&
      classCount('tmp') === 1 &&
      classCount('corrupt') === 1 &&
      classCount('bak') === 2 &&
      sweep.failed === 0 &&
      sweep.auditBlocked === 0,
    '每件删除恰好一行台账(4 行,只落文件名不落路径),零失败零堵账',
  )

  // ─────────────────────────────────────────────────────────────────────
  // 幕 3:无策略零删除 —— 缺省即字节不变
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n—— 幕 3:无策略零删除(不删是缺省,不是降级) ——')
  const a3 = join(root, 'a3')
  seed(join(a3, 'butler', 'memory', 'user', 'u1', 'knowledge', 'archive', 'old.md'), 'old', T - 40 * DAY)
  seed(
    join(a3, 'butler', 'longrun', 'user', 'u1', 't1', 'dossier.json'),
    JSON.stringify({ taskId: 't1', status: 'done', updatedAt: T - 40 * DAY }),
  )
  seed(join(a3, 'butler', 'sessions', 'gone.json'), '{}', T - 40 * DAY)

  const ladderVerdict = await buildRetentionLadder({ spaceDir: a3 })()
  assert(ladderVerdict === null, 'retention.json 缺席 ⇒ 阶梯 thunk 返回 null(零模型零删除)')
  assert(
    existsSync(join(a3, 'butler', 'memory', 'user', 'u1', 'knowledge', 'archive', 'old.md')) &&
      existsSync(join(a3, 'butler', 'longrun', 'user', 'u1', 't1', 'dossier.json')) &&
      existsSync(join(a3, 'butler', 'sessions', 'gone.json')),
    '过期候选一件不少(策略人没定,执行就不跑)',
  )
  assert(!existsSync(join(a3, 'runtime')), '连 runtime/ 都没建:state 文件都不落,盘上零字节写入')

  // ─────────────────────────────────────────────────────────────────────
  // 幕 4:岔口① 硬前置 —— 没进安全网就不动剪刀
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n—— 幕 4:保留阶梯与备份安全网(岔口① 硬前置) ——')
  const a4 = join(root, 'a4')
  mkdirSync(join(a4, 'runtime'), { recursive: true })
  await writeRetentionPolicy(a4, () => ({ memory_archive_days: 30, dossier_days: 30, departed_session_days: 30 }))
  const policy4 = await loadRetentionPolicy(a4)
  assert(policy4 !== null && policy4.memory_archive_days === 30, '策略写入 retention.json 且读者认账(30 天三键)')

  seed(join(a4, 'butler', 'memory', 'user', 'u-live', 'knowledge', 'archive', 'notes', 'deep.md'), 'deep', T - 40 * DAY)
  seed(join(a4, 'butler', 'memory', 'user', 'u-live', 'knowledge', 'archive', 'fresh.md'), 'fresh', T - 1 * DAY)
  seed(
    join(a4, 'butler', 'longrun', 'user', 'u-live', 't-done', 'dossier.json'),
    JSON.stringify({ taskId: 't-done', status: 'done', updatedAt: T - 40 * DAY }),
  )
  seed(join(a4, 'butler', 'longrun', 'user', 'u-live', 't-done', 'journal.jsonl'), '{}\n')
  seed(
    join(a4, 'butler', 'longrun', 'user', 'u-live', 't-live', 'dossier.json'),
    JSON.stringify({ taskId: 't-live', status: 'active', updatedAt: T - 40 * DAY }),
  )
  seed(join(a4, 'butler', 'sessions', 'u-gone.json'), '{}', T - 40 * DAY)
  seed(join(a4, 'butler', 'sessions', 'u-live.json'), '{}', T - 40 * DAY)
  seed(join(a4, 'identity.sqlite'), sentinels.identity)

  const actions4 = join(a4, 'runtime', SPACE_ACTIONS_FILE)
  const ladderOpts = {
    spaceDir: a4,
    actionsFile: actions4,
    policy: policy4,
    liveUserIds: new Set(['u-live']),
    // git 安全网 stub:恒失败 ⇒ gitAt=null,安全网只剩全量备份(零真 git 依赖)。
    git: async () => ({ code: 1, stdout: '', stderr: '' }),
    now,
  }

  const r1 = await retentionLadderOnce(ladderOpts)
  assert(r1.skippedNoNet === 3 && r1.deleted === 0, '备份缺席 ⇒ 三个删除单元(归档件/翻篇档案/离场窗)全部跳过,零删除')
  assert(
    existsSync(join(a4, 'butler', 'memory', 'user', 'u-live', 'knowledge', 'archive', 'notes', 'deep.md')) &&
      existsSync(join(a4, 'butler', 'longrun', 'user', 'u-live', 't-done', 'dossier.json')) &&
      existsSync(join(a4, 'butler', 'sessions', 'u-gone.json')),
    '跳过=真没动手:过期候选一个字节没少',
  )
  const st1 = await readRetentionState(a4)
  assert(st1 !== null && st1.at === T && st1.skippedNoNet === 3, '阶梯自己落 state 文件:skippedNoNet=3 响亮记档(巡检黄牌的数据源)')

  // 全量备份落地(昨天),安全网升起 —— 同一份策略这回真动手。
  writeFileSync(
    join(a4, 'runtime', 'last-backup.json'),
    JSON.stringify({
      format: 'gotong.last-backup/v1',
      at: T - DAY,
      tier: 'full',
      includesMasterKey: false,
      archive: 'demo.tar.gz',
    }),
  )
  const r2 = await retentionLadderOnce(ladderOpts)
  assert((await readFullBackupAt(a4)) === T - DAY && r2.deleted === 4 && r2.skippedNoNet === 0, '备份落地 ⇒ 4 件真删(归档 1 + 档案 2 文件 + 会话窗 1),零跳过')
  assert(
    !existsSync(join(a4, 'butler', 'memory', 'user', 'u-live', 'knowledge', 'archive', 'notes', 'deep.md')) &&
      !existsSync(join(a4, 'butler', 'longrun', 'user', 'u-live', 't-done')) &&
      !existsSync(join(a4, 'butler', 'sessions', 'u-gone.json')),
    '删除侧:过期归档件没了,翻篇档案连目录一起收走,离场窗没了',
  )
  assert(
    existsSync(join(a4, 'butler', 'memory', 'user', 'u-live', 'knowledge', 'archive', 'fresh.md')) &&
      existsSync(join(a4, 'butler', 'longrun', 'user', 'u-live', 't-live', 'dossier.json')) &&
      existsSync(join(a4, 'butler', 'sessions', 'u-live.json')) &&
      readFileSync(join(a4, 'identity.sqlite'), 'utf8') === sentinels.identity,
    '幸存侧:没过期的、还活跃的、在住成员的、类④凭证全部原样',
  )
  const rows4 = await readSpaceActions(actions4)
  const retentionRows = rows4.filter((r) => r['class'] === 'retention')
  assert(
    retentionRows.length === 4 &&
      retentionRows.every((r) => r.kind === 'delete') &&
      new Set(retentionRows.map((r) => r['scope'])).size === 3,
    '先落账再动手:4 行 retention 台账横跨三个 scope(memory-archive/longrun/sessions)',
  )
  const st2 = await readRetentionState(a4)
  assert(st2 !== null && st2.deleted === 4 && st2.skippedNoNet === 0, 'state 文件随最新一轮翻新:deleted=4,skippedNoNet 清零')

  // ─────────────────────────────────────────────────────────────────────
  // 幕 5:提案卡 —— 阈值说话,apply 只指既有参数空间
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n—— 幕 5:提案卡(提案不是新写入口) ——')
  const a5 = join(root, 'a5')
  mkdirSync(join(a5, 'runtime'), { recursive: true })
  // 上一轮阶梯留下的 state:2 件因没进安全网被跳过(P2 的触发源)。
  writeFileSync(
    join(a5, 'runtime', 'retention-state.json'),
    JSON.stringify({ at: T - HOUR, deleted: 0, skippedNoNet: 2, blockedAudit: 0, failed: 0 }),
  )
  // 300 MiB 稀疏文件把 butler/memory 桶顶过 256 MiB 阈值(P1 的触发源)。
  mkdirSync(join(a5, 'butler', 'memory'), { recursive: true })
  const big = join(a5, 'butler', 'memory', 'big.bin')
  writeFileSync(big, '')
  truncateSync(big, 300 * 1024 * 1024)

  const led5 = spaceLedgerAt(a5)
  const row5 = await led5.measure()
  assert(row5 !== null, '幕 5 账本丈量成功(提案引擎的输入)')
  const propose = storageProposalsAt(a5, led5.read)

  const text1 = await propose()
  assert(
    text1.includes('【空间建议】') && text1.includes('没进备份安全网被跳过') && text1.includes('gotong backup'),
    'P2 备份缺口:提案点名跳过件数并给出确切修法(跑一次全量备份)',
  )
  assert(
    text1.includes('butler/memory') && text1.includes('「知识库归档层」的保留期还没生效') && text1.includes('保留期设为 365 天'),
    'P1 保留期缺席:点名超阈值的桶,apply 只指 set_retention 既有参数空间',
  )
  assert(text1.indexOf('没进备份安全网') < text1.indexOf('保留期还没生效'), 'P2 排在 P1 之前:根因(没有安全网)先说')

  const structural = proposeStorageActions({
    ledger: row5,
    policy: await loadRetentionPolicy(a5),
    state: await readRetentionState(a5),
    fullBackupAt: await readFullBackupAt(a5),
  })
  const p2 = structural.find((p) => p.id === 'backup:no-net')
  assert(p2 !== undefined, 'P2 提案在结构面上存在')
  assert(p2.applicable === false, 'P2 是 applicable:false(跑备份不是阿同的参数空间)')
  assert(
    !Object.prototype.hasOwnProperty.call(p2, 'apply') && typeof p2.howTo === 'string',
    'HANDS-M4 判别联合:applicable:false 那支结构上没有 apply 字段,只有 howTo',
  )
  const p1 = structural.find((p) => p.id === 'retention:memory_archive_days')
  assert(p1 !== undefined, 'P1 提案在结构面上存在')
  assert(p1.applicable === true, 'P1 是 applicable:true(阿同能帮着改)')
  assert(
    p1.apply.tool === 'set_retention' && p1.apply.key === 'memory_archive_days' && p1.apply.days === PROPOSED_DAYS.memory_archive_days,
    'apply 恰好落在 set_retention 的既有参数空间(key+days),没有第二条写路径',
  )

  // 成员按提案落策略(走真 writer)⇒ P1 闭嘴,P2 还在。
  await writeRetentionPolicy(a5, (cur) => ({ ...cur, [p1.apply.key]: p1.apply.days }))
  const text2 = await propose()
  assert(!text2.includes('还没生效') && text2.includes('没进备份安全网'), '策略落地 ⇒ P1 闭嘴(不对已定策略指手画脚),P2 还在')

  // 全量备份也补上(晚于 state.at)⇒ 无话可说,提案卡整个消失。
  writeFileSync(
    join(a5, 'runtime', 'last-backup.json'),
    JSON.stringify({
      format: 'gotong.last-backup/v1',
      at: T,
      tier: 'full',
      includesMasterKey: false,
      archive: 'demo.tar.gz',
    }),
  )
  const text3 = await propose()
  assert(text3 === '', '备份补上 ⇒ P2 也闭嘴:无话可说时提案卡是空串,不硬凑建议')

  console.log('\n—— 账本 ——')
  console.log('幕1 账本分桶诚实、幕2 清扫有账、幕3 无策略零字节、幕4 安全网硬前置、幕5 提案随事实闭嘴。')
  console.log(`\n✓ ${passed} 条断言全过`)
}

main()
  .catch((e) => {
    console.error('✗ demo 失败:', e)
    process.exitCode = 1
  })
  .finally(() => rmSync(root, { recursive: true, force: true }))
