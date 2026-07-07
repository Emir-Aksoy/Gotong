/**
 * CARE-M2 — LlmOutageTracker 的边沿语义回归。
 *
 * 载荷断言:断供只播一次(含跨重启,状态在文件里)、恢复只播一次、
 * kind 漂移不再吵、文件损坏当空(诚实降级,大不了多播一次,绝不崩)。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  LlmOutageTracker,
  checkOutageRecovery,
  llmOutageAnnouncement,
  llmRecoveryAnnouncement,
} from '../src/llm-outage.js'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gotong-llm-outage-'))
  file = join(dir, 'runtime', 'llm-outage.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('LlmOutageTracker', () => {
  it('首次失败 announce 恰一次,后续同断供 quiet', async () => {
    const t = new LlmOutageTracker(file, () => 1000)
    expect(await t.onProviderFailure('auth')).toBe('announce')
    expect(await t.onProviderFailure('auth')).toBe('quiet')
    expect(await t.onProviderFailure('auth')).toBe('quiet')
    const persisted = JSON.parse(readFileSync(file, 'utf8'))
    expect(persisted).toEqual({ kind: 'auth', since: 1000, announced: true })
  })

  it('kind 漂移只更新事实不重播(一次断供播一次)', async () => {
    const t = new LlmOutageTracker(file, () => 1000)
    await t.onProviderFailure('auth')
    expect(await t.onProviderFailure('network')).toBe('quiet')
    const persisted = JSON.parse(readFileSync(file, 'utf8'))
    expect(persisted.kind).toBe('network')
    expect(persisted.since).toBe(1000) // 起点不动——还是同一场断供
  })

  it('跨重启 dedup:新实例读同一文件,已播不重播', async () => {
    const t1 = new LlmOutageTracker(file, () => 1000)
    await t1.onProviderFailure('timeout')
    const t2 = new LlmOutageTracker(file, () => 2000) // 重启后的新 tracker
    expect(await t2.onProviderFailure('timeout')).toBe('quiet')
  })

  it('恢复边沿 announce_recovery 恰一次并清文件;平时成功 quiet', async () => {
    const t = new LlmOutageTracker(file, () => 1000)
    expect(await t.onProviderSuccess()).toBe('quiet') // 没病谈不上康复
    await t.onProviderFailure('quota')
    expect(await t.onProviderSuccess()).toBe('announce_recovery')
    expect(existsSync(file)).toBe(false)
    expect(await t.onProviderSuccess()).toBe('quiet') // 不重复报平安
  })

  it('恢复后再断供 = 新断供,重新 announce', async () => {
    const t = new LlmOutageTracker(file, () => 1000)
    await t.onProviderFailure('auth')
    await t.onProviderSuccess()
    expect(await t.onProviderFailure('network')).toBe('announce')
  })

  it('文件损坏当空:垃圾 JSON / 形状不对都视为无断供', async () => {
    mkdirSync(join(dir, 'runtime'), { recursive: true })
    writeFileSync(file, 'not json at all', 'utf8')
    const t = new LlmOutageTracker(file, () => 1000)
    expect(await t.snapshot()).toBe(null)
    expect(await t.onProviderFailure('auth')).toBe('announce') // 当空 → 视作首播
    writeFileSync(file, JSON.stringify({ kind: 'made-up-kind', since: 'x', announced: 'yes' }), 'utf8')
    const t2 = new LlmOutageTracker(file, () => 1000)
    expect(await t2.snapshot()).toBe(null)
  })
})

describe('播报文案(零 LLM,来自 CARE-M1 翻译表)', () => {
  it('断供播报带病名文案与命令面提示,双语', () => {
    const zh = llmOutageAnnouncement('auth', 'zh')
    expect(zh).toContain('管家大脑')
    expect(zh).toContain('API key')
    expect(zh).toContain('/help')
    const en = llmOutageAnnouncement('auth', 'en')
    expect(en).toContain("butler's brain")
    expect(en.toLowerCase()).toContain('api key')
  })

  it('恢复播报双语', () => {
    expect(llmRecoveryAnnouncement('zh')).toContain('恢复')
    expect(llmRecoveryAnnouncement('en')).toContain('back')
  })
})

describe('checkOutageRecovery (CARE-M5 主动恢复探活)', () => {
  const silentLog = { warn: () => {} }
  /** 收播报的 spy + 可配的探针 + 探针调用计数。 */
  function harness(opts: { live: boolean | (() => Promise<boolean>) }) {
    const announced: string[] = []
    let probeCalls = 0
    const probeLiveness = async () => {
      probeCalls++
      return typeof opts.live === 'function' ? opts.live() : opts.live
    }
    return {
      announced,
      probeCalls: () => probeCalls,
      announce: async (text: string) => {
        announced.push(text)
      },
      probeLiveness,
    }
  }

  it('无断供 → idle,根本不探(健康时零 provider 调用)', async () => {
    const t = new LlmOutageTracker(file, () => 1000)
    const h = harness({ live: true })
    const out = await checkOutageRecovery({ tracker: t, ...h, lang: 'zh', log: silentLog })
    expect(out).toBe('idle')
    expect(h.probeCalls()).toBe(0) // 没病就不探——省 provider 一次握手
    expect(h.announced).toEqual([])
  })

  it('quota 断供 → skipped_kind,探针证伪不了配额,不探不播,tracker 仍断供', async () => {
    const t = new LlmOutageTracker(file, () => 1000)
    await t.onProviderFailure('quota')
    const h = harness({ live: true })
    const out = await checkOutageRecovery({ tracker: t, ...h, lang: 'zh', log: silentLog })
    expect(out).toBe('skipped_kind')
    expect(h.probeCalls()).toBe(0)
    expect(h.announced).toEqual([])
    expect(await t.snapshot()).not.toBe(null) // 交给反应式,主动路径不动它
  })

  it('rate_limited / model_not_found 同样 skipped_kind(只读探针证伪不了)', async () => {
    for (const kind of ['rate_limited', 'model_not_found'] as const) {
      const t = new LlmOutageTracker(file, () => 1000)
      await t.onProviderFailure(kind)
      const h = harness({ live: true })
      const out = await checkOutageRecovery({ tracker: t, ...h, lang: 'zh', log: silentLog })
      expect(out).toBe('skipped_kind')
      expect(h.probeCalls()).toBe(0)
      rmSync(file, { force: true }) // 复用同一 file 路径,清掉进下一轮
    }
  })

  it('network 断供 + 探针通 → recovered,播恢复恰一次并清文件', async () => {
    const t = new LlmOutageTracker(file, () => 1000)
    await t.onProviderFailure('network')
    const h = harness({ live: true })
    const out = await checkOutageRecovery({ tracker: t, ...h, lang: 'zh', log: silentLog })
    expect(out).toBe('recovered')
    expect(h.probeCalls()).toBe(1)
    expect(h.announced).toEqual([llmRecoveryAnnouncement('zh')])
    expect(existsSync(file)).toBe(false)
    expect(await t.snapshot()).toBe(null)
  })

  it('auth / timeout 断供也可探针证伪(key 又有效 / provider 又响应)', async () => {
    for (const kind of ['auth', 'timeout'] as const) {
      const t = new LlmOutageTracker(file, () => 1000)
      await t.onProviderFailure(kind)
      const h = harness({ live: true })
      const out = await checkOutageRecovery({ tracker: t, ...h, lang: 'en', log: silentLog })
      expect(out).toBe('recovered')
      expect(h.announced).toEqual([llmRecoveryAnnouncement('en')])
      rmSync(file, { force: true })
    }
  })

  it('断供 + 探针没通 → still_down,静默,tracker 仍断供', async () => {
    const t = new LlmOutageTracker(file, () => 1000)
    await t.onProviderFailure('network')
    const h = harness({ live: false })
    const out = await checkOutageRecovery({ tracker: t, ...h, lang: 'zh', log: silentLog })
    expect(out).toBe('still_down')
    expect(h.probeCalls()).toBe(1)
    expect(h.announced).toEqual([])
    expect(await t.snapshot()).not.toBe(null) // 还没好,继续断供
  })

  it('探针抛错 → still_down,不崩不播,tracker 保持断供', async () => {
    const t = new LlmOutageTracker(file, () => 1000)
    await t.onProviderFailure('timeout')
    const warns: string[] = []
    const h = harness({
      live: async () => {
        throw new Error('socket hang up')
      },
    })
    const out = await checkOutageRecovery({
      tracker: t,
      ...h,
      lang: 'zh',
      log: { warn: (m) => warns.push(m) },
    })
    expect(out).toBe('still_down')
    expect(h.announced).toEqual([])
    expect(warns.length).toBe(1)
    expect(await t.snapshot()).not.toBe(null)
  })

  it('单实例 tracker:探通清空后再探为 idle,恢复只播一次(不与反应式重复)', async () => {
    const t = new LlmOutageTracker(file, () => 1000)
    await t.onProviderFailure('network')
    const h = harness({ live: true })
    const deps = { tracker: t, ...h, lang: 'zh' as const, log: silentLog }
    expect(await checkOutageRecovery(deps)).toBe('recovered')
    expect(await checkOutageRecovery(deps)).toBe('idle') // 已清,第二次不再探不再播
    expect(h.announced).toEqual([llmRecoveryAnnouncement('zh')]) // 恰一次
    expect(h.probeCalls()).toBe(1) // 第二次 idle 早退,没探
  })
})
