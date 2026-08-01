/**
 * HEAL-M1 — 自愈台账纯核门。
 *
 * 承重断言:开机三态分类(消费式停止标记 > 心跳 > 首跑)、downMs 来源、
 * 标记「用一次就没」(结构性消灭陈旧标记误判)、坏行宽容、剪枝滞回、
 * recent 新前排序、跨写入方行(看门狗形状)透传。时钟全注入,零真等待。
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  SELF_HEAL_LOG_FILE,
  SELF_HEAL_STOP_MARKER_FILE,
  parseSelfHealLines,
  startSelfHealLog,
  type SelfHealBootRecord,
} from '../src/self-heal-log.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'self-heal-'))
}

const noWarn = { warn: () => {} }

describe('startSelfHealLog — 开机分类', () => {
  it('首跑:无标记无心跳 → prev=none,无 downMs;心跳文件即刻落盘', async () => {
    const dir = tmp()
    const log = startSelfHealLog({ runtimeDir: dir, now: () => 1_000_000, logger: noWarn })
    const rec = (await log.ready) as SelfHealBootRecord
    log.stop()
    expect(rec.kind).toBe('boot')
    expect(rec.prev).toBe('none')
    expect(rec.downMs).toBeUndefined()
    // 心跳已写(下次崩溃分类的证据)。
    const hb = JSON.parse(readFileSync(join(dir, 'self-heal-heartbeat.json'), 'utf8'))
    expect(hb.at).toBe(1_000_000)
  })

  it('干净周期:markCleanStop → 下次开机 clean + downMs 按标记算,标记被消费', async () => {
    const dir = tmp()
    const a = startSelfHealLog({ runtimeDir: dir, now: () => 1_000_000, logger: noWarn })
    await a.ready
    a.stop()
    let t = 1_060_000
    const aStop = startSelfHealLog({ runtimeDir: dir, now: () => t, logger: noWarn })
    await aStop.ready // 这台自己也是一次开机;先让它落完账
    aStop.markCleanStop() // 停止标记 at=1_060_000
    aStop.stop()
    t = 1_360_000 // 5 分钟后重启
    const b = startSelfHealLog({ runtimeDir: dir, now: () => t, logger: noWarn })
    const rec = (await b.ready) as SelfHealBootRecord
    b.stop()
    expect(rec.prev).toBe('clean')
    expect(rec.downMs).toBe(300_000)
    // 消费式:标记文件已删——它救不了下一次崩溃的分类。
    expect(existsSync(join(dir, SELF_HEAL_STOP_MARKER_FILE))).toBe(false)
  })

  it('崩溃周期:无标记但心跳在 → prev=unclean,downMs 按最后心跳算', async () => {
    const dir = tmp()
    const a = startSelfHealLog({ runtimeDir: dir, now: () => 2_000_000, logger: noWarn })
    await a.ready
    a.stop() // 模拟崩溃:没 markCleanStop,心跳停在 2_000_000
    const b = startSelfHealLog({ runtimeDir: dir, now: () => 2_600_000, logger: noWarn })
    const rec = (await b.ready) as SelfHealBootRecord
    b.stop()
    expect(rec.prev).toBe('unclean')
    expect(rec.downMs).toBe(600_000)
  })

  it('标记只用一次:clean 开机之后再崩溃,分类回 unclean(陈旧标记结构性不存在)', async () => {
    const dir = tmp()
    const a = startSelfHealLog({ runtimeDir: dir, now: () => 3_000_000, logger: noWarn })
    await a.ready
    a.markCleanStop()
    a.stop()
    const b = startSelfHealLog({ runtimeDir: dir, now: () => 3_100_000, logger: noWarn })
    expect(((await b.ready) as SelfHealBootRecord).prev).toBe('clean')
    b.stop() // 又一次崩溃(没标记;b 的心跳停在 3_100_000)
    const c = startSelfHealLog({ runtimeDir: dir, now: () => 3_200_000, logger: noWarn })
    const rec = (await c.ready) as SelfHealBootRecord
    c.stop()
    expect(rec.prev).toBe('unclean')
    expect(rec.downMs).toBe(100_000)
  })

  it('runtimeDir 不可建(路径被文件占住)→ ready=null,绝不抛', async () => {
    const dir = tmp()
    const blocked = join(dir, 'not-a-dir')
    writeFileSync(blocked, 'x')
    const warns: unknown[] = []
    const log = startSelfHealLog({
      runtimeDir: join(blocked, 'runtime'),
      now: () => 1,
      logger: { warn: (msg) => warns.push(msg) },
    })
    expect(await log.ready).toBeNull()
    log.stop()
    expect(warns.length).toBe(1)
    // 台账残废时读者仍安全。
    expect(await log.recent()).toEqual([])
  })
})

describe('台账文件 — 宽容读者 + 剪枝 + 跨写入方', () => {
  it('parseSelfHealLines 跳过坏行/空行,只收 at+kind 齐全的对象行', () => {
    const text = [
      '{"at":"2026-07-31T00:00:00Z","kind":"boot","prev":"none"}',
      'garbage not json',
      '', // 空行
      '["array","row"]',
      '{"kind":"missing-at"}',
      '{"at":"2026-07-31T01:00:00Z","kind":"watchdog-restart","reason":"healthz-fail","fails":3,"journalTail":"line1\\nline2"}',
    ].join('\n')
    const rows = parseSelfHealLines(text)
    expect(rows.map((r) => r.kind)).toEqual(['boot', 'watchdog-restart'])
    // 看门狗行的自有键(hub 不认识的)原样透传——读者按需渲染。
    expect(rows[1]!.fails).toBe(3)
    expect(rows[1]!.journalTail).toBe('line1\nline2')
  })

  it('recent 新的在前 + limit;看门狗手写行与 hub 开机行同册可读', async () => {
    const dir = tmp()
    // 看门狗先落一笔(hub 死的时候只有它在写)。
    writeFileSync(
      join(dir, SELF_HEAL_LOG_FILE),
      '{"at":"2026-07-30T23:59:00Z","kind":"watchdog-restart","reason":"healthz-fail"}\n',
    )
    const log = startSelfHealLog({ runtimeDir: dir, now: () => 5_000_000, logger: noWarn })
    await log.ready
    const rows = await log.recent()
    log.stop()
    expect(rows.length).toBe(2)
    expect(rows[0]!.kind).toBe('boot') // 新的在前
    expect(rows[1]!.kind).toBe('watchdog-restart')
    expect((await log.recent(1)).map((r) => r.kind)).toEqual(['boot'])
  })

  it('剪枝滞回:>300 行才剪到 200,尾部保住刚写的开机行', async () => {
    const dir = tmp()
    const lines = Array.from({ length: 350 }, (_, i) =>
      JSON.stringify({ at: `t${i}`, kind: 'boot', prev: 'clean' }),
    )
    writeFileSync(join(dir, SELF_HEAL_LOG_FILE), lines.join('\n') + '\n')
    const log = startSelfHealLog({ runtimeDir: dir, now: () => 6_000_000, logger: noWarn })
    await log.ready
    log.stop()
    const kept = parseSelfHealLines(readFileSync(join(dir, SELF_HEAL_LOG_FILE), 'utf8'))
    expect(kept.length).toBe(200)
    // 最后一行是本次开机(剪的是头,不是刚发生的事)。
    expect(kept[kept.length - 1]!.kind).toBe('boot')
    expect((kept[kept.length - 1] as SelfHealBootRecord).prev).toBe('none')
    // 300 以下不重写(滞回:开机别每次都抄一遍文件)——再开机一次只追加。
    const log2 = startSelfHealLog({ runtimeDir: dir, now: () => 6_100_000, logger: noWarn })
    await log2.ready
    log2.stop()
    expect(
      parseSelfHealLines(readFileSync(join(dir, SELF_HEAL_LOG_FILE), 'utf8')).length,
    ).toBe(201)
  })
})
