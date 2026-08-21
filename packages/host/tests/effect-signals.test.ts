/**
 * EFF-M3 — 效果信号只读投影的门。
 *
 * 钉四件事:
 *   1. 两源计数(inbox 已决审批项 + 转派事实行)的窗口过滤与三分法
 *      (打回优先于批/拒,镜像 inbox-service.outcomeOf)。
 *   2. 「读不到」≠「没发生」:目录 ENOENT = 诚实零(子块在场、计数为 0);
 *      读目录抛别的错 = 子块**缺席** + warn —— 两种「没数」绝不混同。
 *   3. 观察者永不隔离:坏文件/坏行跳过,证据原地留(readdir 仍看得见)。
 *   4. 分母(llmCalls)只认有限非负数;thunk 抛/回怪值 = 缺席,绝不冒充 0。
 */
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildEffectSignalsReader } from '../src/effect-signals.js'

const NOW = Date.parse('2026-08-20T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

async function makeSpace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'eff-signals-'))
}

async function seedInboxItem(space: string, name: string, obj: unknown): Promise<void> {
  await mkdir(join(space, 'inbox'), { recursive: true })
  await writeFile(join(space, 'inbox', `${name}.json`), JSON.stringify(obj), 'utf8')
}

async function seedEscalate(space: string, user: string, lines: string[]): Promise<void> {
  const dir = join(space, 'butler', 'escalate')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${user}.jsonl`), lines.join('\n') + '\n', 'utf8')
}

function collectWarns() {
  const warns: string[] = []
  return { warns, logger: { warn: (msg: string) => warns.push(msg) } }
}

describe('effect signals reader (EFF-M3)', () => {
  it('counts both sources with window filter; changes-requested outranks approved (outcomeOf mirror)', async () => {
    const space = await makeSpace()
    const inWin = NOW - 1 * DAY
    const outWin = NOW - 40 * DAY
    const approval = (resolvedAt: number, d: Record<string, unknown>) => ({
      status: 'resolved',
      resolvedAt,
      decision: { kind: 'approval', ...d },
    })
    await seedInboxItem(space, 'a1', approval(inWin, { approved: true }))
    await seedInboxItem(space, 'a2', approval(inWin, { approved: true }))
    await seedInboxItem(space, 'r1', approval(inWin, { approved: false }))
    await seedInboxItem(space, 'c1', approval(inWin, { approved: false, changesRequested: true }))
    // 打回优先:approved:true 同时 changesRequested:true 计入打回,不计批准。
    await seedInboxItem(space, 'c2', approval(inWin, { approved: true, changesRequested: true }))
    await seedInboxItem(space, 'old', approval(outWin, { approved: true })) // 窗外
    await seedInboxItem(space, 'pending', { status: 'pending', decision: null }) // 未决
    await seedInboxItem(space, 'choice', {
      status: 'resolved',
      resolvedAt: inWin,
      decision: { kind: 'choice', optionId: 'x' }, // choice/edit 不是效果信号
    })
    await seedInboxItem(space, 'no-ts', { status: 'resolved', decision: { kind: 'approval', approved: true } })
    await seedEscalate(space, 'u-alice', [
      JSON.stringify({ at: new Date(inWin).toISOString(), expert: 'coder', ok: true }),
      JSON.stringify({ at: new Date(inWin).toISOString(), expert: 'coder', ok: false }),
      JSON.stringify({ at: new Date(outWin).toISOString(), expert: 'coder', ok: true }), // 窗外
    ])
    await seedEscalate(space, 'u-bob', [
      JSON.stringify({ at: new Date(inWin).toISOString(), expert: 'expert', ok: true }),
    ])

    const row = await buildEffectSignalsReader({ spaceRoot: space, now: () => NOW })()
    expect(row.windowDays).toBe(30)
    expect(row.parks).toEqual({ approved: 2, rejected: 1, changesRequested: 2 })
    expect(row.escalations).toEqual({ total: 3, ok: 2 })
  })

  it('ENOENT dirs = honest zeros (blocks PRESENT with 0s — never happened, not unreadable)', async () => {
    const space = await makeSpace() // 空 space:inbox/ 与 butler/escalate/ 都不存在
    const { warns, logger } = collectWarns()
    const row = await buildEffectSignalsReader({ spaceRoot: space, now: () => NOW, logger })()
    expect(row.parks).toEqual({ approved: 0, rejected: 0, changesRequested: 0 })
    expect(row.escalations).toEqual({ total: 0, ok: 0 })
    expect(warns).toEqual([]) // 诚实零不是故障,不该 warn
  })

  it('non-ENOENT dir error = block ABSENT + warn (never conflated with zero); thunk still resolves', async () => {
    const space = await makeSpace()
    // 目录位上放文件 → readdir 抛 ENOTDIR(不是 ENOENT)。
    await writeFile(join(space, 'inbox'), 'not a dir', 'utf8')
    await mkdir(join(space, 'butler'), { recursive: true })
    await writeFile(join(space, 'butler', 'escalate'), 'not a dir', 'utf8')
    const { warns, logger } = collectWarns()
    const row = await buildEffectSignalsReader({ spaceRoot: space, now: () => NOW, logger })()
    expect('parks' in row).toBe(false)
    expect('escalations' in row).toBe(false)
    expect(warns.length).toBeGreaterThanOrEqual(2)
  })

  it('corrupt files/lines are skipped and left in place (observer never isolates)', async () => {
    const space = await makeSpace()
    const inWin = NOW - 1 * DAY
    await seedInboxItem(space, 'good', {
      status: 'resolved',
      resolvedAt: inWin,
      decision: { kind: 'approval', approved: true },
    })
    await writeFile(join(space, 'inbox', 'corrupt.json'), '{ not json', 'utf8')
    await writeFile(join(space, 'inbox', 'README.txt'), 'ignored — 非 .json', 'utf8')
    await seedEscalate(space, 'u-alice', [
      '{ broken line',
      JSON.stringify({ at: new Date(inWin).toISOString(), expert: 'coder', ok: true }),
      JSON.stringify({ at: 12345, expert: 'coder', ok: true }), // at 非 string → 跳过
      '',
    ])
    const row = await buildEffectSignalsReader({ spaceRoot: space, now: () => NOW })()
    expect(row.parks).toEqual({ approved: 1, rejected: 0, changesRequested: 0 })
    expect(row.escalations).toEqual({ total: 1, ok: 1 })
    // 证据原地留:坏文件没被挪走/改名。
    expect((await readdir(join(space, 'inbox'))).sort()).toEqual(['README.txt', 'corrupt.json', 'good.json'])
  })

  it('llmCalls: finite non-negative accepted; throw/NaN/negative/absent → field absent (never a fake 0)', async () => {
    const space = await makeSpace()
    const read = (countLlmCalls?: (since: number) => Promise<number> | number, logger?: { warn: (m: string) => void }) =>
      buildEffectSignalsReader({
        spaceRoot: space,
        now: () => NOW,
        ...(countLlmCalls ? { countLlmCalls } : {}),
        ...(logger ? { logger } : {}),
      })()

    expect((await read(() => 42)).llmCalls).toBe(42)
    expect((await read(() => 0)).llmCalls).toBe(0) // 真的零是合法值

    const { warns, logger } = collectWarns()
    expect('llmCalls' in (await read(() => Promise.reject(new Error('db gone')), logger))).toBe(false)
    expect(warns.length).toBe(1)
    expect('llmCalls' in (await read(() => Number.NaN))).toBe(false)
    expect('llmCalls' in (await read(() => -1))).toBe(false)
    expect('llmCalls' in (await read())).toBe(false)
  })

  it('window: default 30 days, configurable; the denominator thunk receives the same since', async () => {
    const space = await makeSpace()
    let seen: number | undefined
    const row = await buildEffectSignalsReader({
      spaceRoot: space,
      now: () => NOW,
      windowDays: 7,
      countLlmCalls: (since) => {
        seen = since
        return 5
      },
    })()
    expect(row.windowDays).toBe(7)
    expect(seen).toBe(NOW - 7 * DAY)
  })
})
