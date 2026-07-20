import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseButlerEnv } from '../src/butler-env.js'
import { BUTLER_MAINTENANCE_INTERVAL_MS } from '../src/personal-butler-maintenance.js'
import { BUTLER_PROACTIVE_INTERVAL_MS } from '../src/personal-butler-proactive.js'
import { BUTLER_RUN_BROADCAST_INTERVAL_MS } from '../src/personal-butler-run-broadcast.js'

const ROOT = '/tmp/space'
const parse = (env: NodeJS.ProcessEnv = {}) => parseButlerEnv(env, ROOT)

describe('parseButlerEnv — 默认形态', () => {
  it('空环境 = 管家全开、记忆类 opt-in 全关', () => {
    // 这是绝大多数部署实际跑的那一档,先把它钉住。
    expect(parse()).toEqual({
      memoryRoot: join(ROOT, 'butler', 'memory'),
      defaultOn: true,
      governedOn: true,
      maintenanceOn: true,
      proactiveOn: true,
      runBroadcastOn: true,
      memoryLinksOn: false,
      memoryGitOn: false,
      memoryReconcileOn: false,
      memoryLibrarianOn: false,
      maintenanceMs: BUTLER_MAINTENANCE_INTERVAL_MS,
      proactiveMs: BUTLER_PROACTIVE_INTERVAL_MS,
      runBroadcastMs: BUTLER_RUN_BROADCAST_INTERVAL_MS,
    })
  })

  it('记忆根永远挂在 <space>/butler/memory —— /me 隐私视图读的是同一份字节', () => {
    expect(parse().memoryRoot).toBe(join(ROOT, 'butler', 'memory'))
  })
})

describe('parseButlerEnv — 两种相反的开关方向', () => {
  it('opt-out 组:四种写法都关得掉,大小写和空格不影响', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', '  false  ']) {
      expect(parse({ GOTONG_BUTLER: v }).defaultOn).toBe(false)
    }
  })

  it('opt-out 组:写了别的值 = 仍然开(它是「除非明说关」)', () => {
    // 包括写反了的 `disabled` —— opt-out 组不认白名单,只认那四个关键词。
    for (const v of ['1', 'yes', 'disabled', '随便什么']) {
      expect(parse({ GOTONG_BUTLER: v }).defaultOn).toBe(true)
    }
  })

  it('opt-in 组:四种写法都开得了', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'ON', ' yes ']) {
      expect(parse({ GOTONG_BUTLER_MEMORY_LIBRARIAN: v }).memoryLibrarianOn).toBe(true)
    }
  })

  it('opt-in 组:不在白名单里的写法一律静默当没开', () => {
    // 这是真实的脚枪:`=enabled` 看起来像开了,其实什么也没发生,而且不报错。
    // 钉在这里,至少让改的人看得见这个边。
    for (const v of ['enabled', 'Y', '开', '2', '']) {
      expect(parse({ GOTONG_BUTLER_MEMORY_LIBRARIAN: v }).memoryLibrarianOn).toBe(false)
    }
  })
})

describe('parseButlerEnv — 级联闸', () => {
  it('管家关掉,连带关掉三扇后台扫描', () => {
    const cfg = parse({ GOTONG_BUTLER: 'off' })
    expect(cfg.maintenanceOn).toBe(false)
    expect(cfg.proactiveOn).toBe(false)
    expect(cfg.runBroadcastOn).toBe(false)
  })

  it('管家关掉时,显式写了 =1 的记忆 opt-in 也一起关', () => {
    // 承重:管家都不在了,它的后台活没有立场自己跑。显式开也不行。
    const cfg = parse({
      GOTONG_BUTLER: 'off',
      GOTONG_BUTLER_MEMORY_GIT: '1',
      GOTONG_BUTLER_MEMORY_RECONCILE: '1',
      GOTONG_BUTLER_MEMORY_LIBRARIAN: '1',
      GOTONG_BUTLER_MEMORY_LINKS: '1',
    })
    expect(cfg.memoryGitOn).toBe(false)
    expect(cfg.memoryReconcileOn).toBe(false)
    expect(cfg.memoryLibrarianOn).toBe(false)
    expect(cfg.memoryLinksOn).toBe(false)
  })

  it('只关维护:三个记忆 opt-in 跟着关,但召回扩一跳还在', () => {
    // memoryLinks 挂的是 defaultOn 不是 maintenanceOn —— 扩一跳发生在召回时,
    // 不需要 6h 扫描先跑过。三个写盘的活则确实要扫描在。
    const cfg = parse({
      GOTONG_BUTLER_MAINTENANCE: 'off',
      GOTONG_BUTLER_MEMORY_GIT: '1',
      GOTONG_BUTLER_MEMORY_RECONCILE: '1',
      GOTONG_BUTLER_MEMORY_LIBRARIAN: '1',
      GOTONG_BUTLER_MEMORY_LINKS: '1',
    })
    expect(cfg.memoryGitOn).toBe(false)
    expect(cfg.memoryReconcileOn).toBe(false)
    expect(cfg.memoryLibrarianOn).toBe(false)
    expect(cfg.memoryLinksOn).toBe(true)
  })

  it('governedOn 是唯一不级联的 —— 记录现状,不是背书', () => {
    // 邻居都带 `&& defaultOn`,就它没有。今天无害(管家关了 factory 根本不建
    // 管家,没人读这个值),但下次谁照邻居改之前得先看见这条。
    expect(parse({ GOTONG_BUTLER: 'off' }).governedOn).toBe(true)
    expect(parse({ GOTONG_BUTLER: 'off', GOTONG_BUTLER_GOVERNED: 'off' }).governedOn).toBe(false)
  })
})

describe('parseButlerEnv — 周期钳位', () => {
  it('钳进各自区间', () => {
    expect(parse({ GOTONG_BUTLER_MAINTENANCE_MS: '1' }).maintenanceMs).toBe(60_000)
    expect(parse({ GOTONG_BUTLER_MAINTENANCE_MS: String(99 * 24 * 3600_000) }).maintenanceMs).toBe(24 * 3600_000)
    expect(parse({ GOTONG_BUTLER_PROACTIVE_MS: '1' }).proactiveMs).toBe(5 * 60_000)
    expect(parse({ GOTONG_BUTLER_PROACTIVE_MS: '999999999' }).proactiveMs).toBe(3600_000)
    expect(parse({ GOTONG_BUTLER_RUN_BROADCAST_MS: '1' }).runBroadcastMs).toBe(60_000)
    expect(parse({ GOTONG_BUTLER_RUN_BROADCAST_MS: '999999999' }).runBroadcastMs).toBe(3600_000)
  })

  it('没设 / 写坏 / 显式 0,都回落默认值', () => {
    // `|| fallback` 挡的是 NaN,不是 0:`Math.max(60000, NaN)` 还是 NaN,
    // 拿 NaN 当 setInterval 延迟等于没有节流。0 其实会被下界救成 60s,
    // 但让它跟「没设」一样回落 6h 更符合直觉——写 0 不是想要每分钟扫一次。
    for (const bad of ['0', 'abc', '', '  ']) {
      expect(parse({ GOTONG_BUTLER_MAINTENANCE_MS: bad }).maintenanceMs).toBe(BUTLER_MAINTENANCE_INTERVAL_MS)
    }
    expect(Number.isFinite(parse().maintenanceMs)).toBe(true) // 没设也绝不是 NaN
  })

  it('区间内的值原样通过', () => {
    expect(parse({ GOTONG_BUTLER_MAINTENANCE_MS: '600000' }).maintenanceMs).toBe(600_000)
  })
})
