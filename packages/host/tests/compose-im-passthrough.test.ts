/**
 * HANDS-M6 — 一键镜像:IM 通道 / provider key 的部署期 env 透传。
 *
 * M6 的验收是「`compose up` → IM 在 → 网页一次触碰 → 手机接着配」。前半句
 * 是一件**部署文件**的事:host 侧读 env 的能力早就在了(DEPLOY-B1),缺的只是
 * 两份 compose 从来没把那些变量端进容器。本门钉住的就是那道缝,分两半:
 *
 *   ① **文本半** —— 变量名从 `im-bridge.ts` 的**源码**里扒出来(不是手抄一份
 *      清单),再断言两份 compose 都声明了它们。将来接第七座桥、多读一个变量,
 *      compose 没跟上这道门就红。手抄的清单只会跟源码漂移。
 *   ② **行为半** —— 拿**真** `startImBridges` 跑一遍装配层。这是 M3b 那条
 *      教训的直接产物:一条缝,如果它的测试全都自己手搭对面那一半,那它就是
 *      没测过。桥本身用 `makeBridge` 注入假件(真 TelegramBridge 一启动就去
 *      长轮询线上 API),但**解析 → 起桥 → status 投影**走的是生产那条路。
 *
 * 两条承重不变量:
 *
 *   - **空串 == 没设**。compose 的空值键(`KEY:` 后面什么都没有)在未设时干脆
 *     不把变量放进容器;但别的写法(`"${VAR:-}"`)会塞一个空串。host 侧一律
 *     trim 后按真值判断,所以空串照样回落金库——这条**必须由代码跑出来**,不
 *     能靠读文档相信,否则一个空串就能把成员在手机上配好的凭证悄悄盖掉。
 *   - **值不在文件里**。凡名字看起来像凭证的键,值只能是空或纯 `${VAR}` 插值,
 *     绝不能是字面量。判据复用 `isSecretKey`——也就是手机上 `set_hub_config`
 *     用来拒绝写秘密的**同一个**谓词,一份定义两处执法,不会各说各话。
 */

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, type Logger } from '@gotong/core'
import { MASTER_KEY_LEN_BYTES, openIdentityStore, type IdentityStore } from '@gotong/identity'
import type { ImAttachment, ImBridge, ImMessage, ImUser } from '@gotong/im-adapter'

import { resolveImCreds, startImBridges, type ResolvedImCreds } from '../src/im-bridge.js'
import { selectLlmApiKey } from '../src/local-agent-pool.js'
import { isSecretKey } from '../src/ops-config-write.js'

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
}

class FakeBridge implements ImBridge {
  started = false
  constructor(
    readonly platform: string,
    readonly creds: ResolvedImCreds,
  ) {}
  async start(): Promise<void> {
    this.started = true
  }
  async stop(): Promise<void> {
    this.started = false
  }
  async sendMessage(_to: ImUser, _text: string, _o?: { attachments?: ImAttachment[] }): Promise<void> {}
  onMessage(): () => void {
    return () => {}
  }
}

// ───────────────────────────────────────────────────────────────────────────
// compose 扫描器 —— 只认这两份文件里实际用到的那点语法(块序列 + `KEY: value`)。
// 刻意不引 YAML 库:host 没有这个依赖,而为一道防腐门加一个生产依赖不值当。
// ───────────────────────────────────────────────────────────────────────────

interface ComposeService {
  /** `environment:` 下的键 → 原始值文本;空值键(`KEY:`)记 null。 */
  env: Map<string, string | null>
  /** `ports:` 下的每条映射(原始文本,去引号)。 */
  ports: string[]
}

/** 切出某个服务的块:从 `  <name>:` 到下一个同缩进(2 空格)的键。 */
function sliceService(text: string, name: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === `  ${name}:`)
  if (start < 0) throw new Error(`compose service not found: ${name}`)
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (l.trim() !== '' && /^ {0,2}\S/.test(l)) break
    out.push(l)
  }
  return out
}

/** 收一个 4 空格缩进的块(`    environment:` / `    ports:`)下的所有行。 */
function blockOf(serviceLines: string[], key: string): string[] {
  const start = serviceLines.findIndex((l) => l === `    ${key}:`)
  if (start < 0) return []
  const out: string[] = []
  for (let i = start + 1; i < serviceLines.length; i++) {
    const l = serviceLines[i]!
    if (l.trim() !== '' && !/^ {6}/.test(l)) break
    out.push(l)
  }
  return out
}

function parseCompose(file: string, service: string): ComposeService {
  const text = readFileSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url)), 'utf8')
  const svc = sliceService(text, service)
  const env = new Map<string, string | null>()
  for (const raw of blockOf(svc, 'environment')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line)
    if (!m) continue
    const value = m[2]!.trim()
    env.set(m[1]!, value === '' ? null : value)
  }
  const ports: string[] = []
  for (const raw of blockOf(svc, 'ports')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^-\s*(.*)$/.exec(line)
    if (m) ports.push(m[1]!.replace(/^["\']|["\']$/g, ''))
  }
  return { env, ports }
}

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.prod.yml'] as const

/**
 * 变量名的真相源 = `im-bridge.ts` 的源码本身。手抄一份清单迟早跟它漂移,而
 * 漂移的后果恰好是最难看的那种:部署文件看起来齐全,某座桥就是起不来。
 */
function imBridgeEnvKnobs(): string[] {
  const src = readFileSync(fileURLToPath(new URL('../src/im-bridge.ts', import.meta.url)), 'utf8')
  const hits = new Set<string>()
  for (const m of src.matchAll(/process\.env\.(GOTONG_[A-Z0-9_]+)/g)) hits.add(m[1]!)
  return [...hits].sort()
}

describe('compose 透传 — 文本半:变量名从源码扒出来,两份 compose 都得有', () => {
  it('im-bridge.ts 真的读了一批 GOTONG_ 变量(源码扫描不是空跑)', () => {
    const knobs = imBridgeEnvKnobs()
    // 五座桥 + 一个能力名。数字本身不承重(接新桥会变),但「一个都没扫到」
    // 说明正则失效了,那时下面每一条断言都会空洞地真。
    expect(knobs.length).toBeGreaterThanOrEqual(12)
    expect(knobs).toContain('GOTONG_TELEGRAM_BOT_TOKEN')
    expect(knobs).toContain('GOTONG_LARK_APP_SECRET')
    expect(knobs).toContain('GOTONG_WECHAT_BOT_TOKEN')
  })

  for (const file of COMPOSE_FILES) {
    it(`${file} 声明了 im-bridge.ts 读的每一个变量`, () => {
      const { env } = parseCompose(file, 'gotong')
      const missing = imBridgeEnvKnobs().filter((k) => !env.has(k))
      expect(missing).toEqual([])
    })

    it(`${file}:凡像凭证的键,值只能是空或插值,绝不是字面量`, () => {
      const { env } = parseCompose(file, 'gotong')
      const literals: string[] = []
      for (const [key, value] of env) {
        if (!isSecretKey(key)) continue
        if (value === null) continue
        if (/^"?\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}"?$/.test(value)) continue
        literals.push(`${key}=${value}`)
      }
      expect(literals).toEqual([])
    })

    it(`${file}:发布出去的端口与 GOTONG_WEB_PORT / _WS_PORT 对得上`, () => {
      // 两者住在同一份文件里,写岔了的后果是「容器里跑得好好的、外面连不上」,
      // 而健康检查读的正是 GOTONG_WEB_PORT ⇒ 它还会一直显示健康。
      const { env, ports } = parseCompose(file, 'gotong')
      const container = ports.map((p) => p.split(':').pop())
      expect(container).toContain(env.get('GOTONG_WEB_PORT')?.replace(/"/g, ''))
      expect(container).toContain(env.get('GOTONG_WS_PORT')?.replace(/"/g, ''))
    })
  }
})

// ───────────────────────────────────────────────────────────────────────────
// 行为半 —— 真 startImBridges
// ───────────────────────────────────────────────────────────────────────────

// 清掉 im-bridge.ts 读的每一个变量:开发机 shell 里导出的真 token 不能左右结论。
const KEYS = imBridgeEnvKnobs()
const saved: Record<string, string | undefined> = {}
let identity: IdentityStore

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  identity = openIdentityStore({ dbPath: ':memory:', masterKey: randomBytes(MASTER_KEY_LEN_BYTES) })
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  identity.close()
})

async function boot(): Promise<{ platforms: string[]; sources: string[]; stop: () => Promise<void> }> {
  const hub = Hub.inMemory()
  await hub.start()
  const handle = await startImBridges({
    hub,
    identity,
    log: silentLogger,
    makeBridge: (platform, creds) => new FakeBridge(platform, creds),
  })
  return {
    platforms: handle?.bridges.map((b) => b.platform) ?? [],
    sources: handle?.status().map((s) => s.source) ?? [],
    stop: async () => {
      await handle?.stop()
      await hub.stop()
    },
  }
}

describe('compose 透传 — 行为半:装配层真跑一遍', () => {
  it('把 token 从 compose 端进来,三座可金库的桥就起来了(source=env)', async () => {
    // 只驱动 telegram/lark/wechat:makeBridge 这个测试缝只覆盖它们,QQ/Slack
    // 会真的构造出会联网的桥。三座已经足够证明「compose 端进来的值到得了」。
    process.env.GOTONG_TELEGRAM_BOT_TOKEN = '123:from-compose'
    process.env.GOTONG_LARK_APP_ID = 'cli_from_compose'
    process.env.GOTONG_LARK_APP_SECRET = 'lark-secret'
    process.env.GOTONG_WECHAT_BOT_TOKEN = 'wechat-from-compose'
    const b = await boot()
    try {
      expect(b.platforms).toEqual(['telegram', 'lark', 'wechat'])
      expect(b.sources).toEqual(['env', 'env', 'env'])
    } finally {
      await b.stop()
    }
  })

  it('全部设成空串 == 一个都没设:桥一座不起', async () => {
    for (const k of KEYS) process.env[k] = ''
    const b = await boot()
    try {
      expect(b.platforms).toEqual([])
    } finally {
      await b.stop()
    }
  })

  it('空串永远盖不掉金库里的凭证(这条是承重的)', () => {
    // 首启向导/`gotong wechat-login`/手机上配好的那把,不能被一份「键在、值
    // 空」的 compose 悄悄顶掉——那会表现成「昨天还好好的,今天 IM 不响了」。
    const entry = identity.createVaultEntry({
      kind: 'im_bridge',
      ownerKind: 'org',
      ownerId: null,
      secret: 'vault-token',
      label: null,
      metadata: { platform: 'telegram', registeredBy: 'test' },
    })
    expect(entry.id).toBeTruthy()
    for (const k of KEYS) process.env[k] = ''
    expect(resolveImCreds('telegram', identity)).toEqual({
      source: 'vault',
      fields: { token: 'vault-token' },
    })
  })

  it('provider key:compose 里的空串同样等于没设', () => {
    expect(
      selectLlmApiKey({ provider: 'anthropic', perAgent: null, orgPool: null, workspace: null, env: '' }),
    ).toBeUndefined()
  })

  it('provider key:手机 `/setkey` 写的那把压得住 compose 里的', () => {
    // `/setkey` 落的是 per-agent 层,而 env 排在解析顺序最后 —— compose 里
    // 设了默认 key 也盖不掉成员在手机上贴的那把。compose 注释里的这句话由
    // 这一条钉住,不然它就只是一句注释。
    const hit = selectLlmApiKey({
      provider: 'anthropic',
      perAgent: 'from-phone',
      orgPool: null,
      workspace: null,
      env: 'from-compose',
    })
    expect(hit?.apiKey).toBe('from-phone')
    expect(hit?.source.kind).toBe('per-agent')
  })
})
