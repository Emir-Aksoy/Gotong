/**
 * HEAL-M2 — 看门狗脚本可测门(spawn 真 deploy/gotong-watchdog.mjs)。
 *
 * PATH 垫片 stub 掉 systemctl/journalctl(调用记录落文件逐条断言),healthz
 * 用测试内真 http 服务。承重断言:K=3 连败才重启、健康即清零(中断不算连续)、
 * 每小时限流打满只记一条 throttled、unit 非 active 不数不重启、journalctl
 * 缺席照样重启。跨写入方契约:看门狗写的台账行必须能被 hub 的
 * parseSelfHealLines 读、被 renderRestartHistory 渲染——两个写入方共写一册,
 * 契约就钉在这两条断言上。
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { renderRestartHistory } from '../src/personal-butler-hub-sense.js'
import { parseSelfHealLines } from '../src/self-heal-log.js'

const SCRIPT = fileURLToPath(new URL('../../../deploy/gotong-watchdog.mjs', import.meta.url))

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'watchdog-'))
}

/** stub systemctl(+可选 journalctl)进一个 PATH 垫片目录;调用记录追加进 calls.log。 */
function makeStubs(opts: { journalctl?: boolean; isActiveExit?: number } = {}): {
  dir: string
  calls: () => string
} {
  const dir = tmp()
  const callsFile = join(dir, 'calls.log')
  writeFileSync(callsFile, '')
  writeFileSync(
    join(dir, 'systemctl'),
    `#!/bin/sh\necho "systemctl $@" >> "${callsFile}"\ncase "$1" in is-active) exit ${opts.isActiveExit ?? 0};; esac\nexit 0\n`,
  )
  chmodSync(join(dir, 'systemctl'), 0o755)
  if (opts.journalctl !== false) {
    writeFileSync(
      join(dir, 'journalctl'),
      `#!/bin/sh\necho "journalctl $@" >> "${callsFile}"\nprintf 'boom line1\\nboom line2\\n'\n`,
    )
    chmodSync(join(dir, 'journalctl'), 0o755)
  }
  return { dir, calls: () => readFileSync(callsFile, 'utf8') }
}

function tick(space: string, stubDir: string, url: string, extra: string[] = []): Promise<void> {
  // 必须异步 spawn:spawnSync 会阻塞本进程事件循环,而 healthz 假服务就活在
  // 本进程里——子进程的探针会被饿死成超时,活服务被判成死(真死锁,踩过)。
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SCRIPT, '--url', url, '--space', space, '--timeout-ms', '400', ...extra],
      { stdio: 'ignore', env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ''}` } },
    )
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`watchdog tick exit ${code}`)),
    )
  })
}

const stateOf = (space: string) =>
  JSON.parse(readFileSync(join(space, 'runtime', 'self-heal-watchdog-state.json'), 'utf8')) as {
    fails: number
    restarts: number[]
    throttled: boolean
  }

const ledgerOf = (space: string) => {
  const file = join(space, 'runtime', 'self-heal-log.jsonl')
  return existsSync(file) ? parseSelfHealLines(readFileSync(file, 'utf8')) : []
}

function seedState(space: string, state: { fails: number; restarts: number[]; throttled: boolean }) {
  mkdirSync(join(space, 'runtime'), { recursive: true })
  writeFileSync(join(space, 'runtime', 'self-heal-watchdog-state.json'), JSON.stringify(state))
}

// 一个活的 healthz(可切换 200/500)+ 一个刚释放的端口当「拒连」地址。
let server: Server
let okUrl: string
let healthy = true
let deadUrl: string

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(healthy ? 200 : 500, { 'content-type': 'text/plain' })
    res.end(healthy ? 'ok' : 'nope')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  okUrl = `http://127.0.0.1:${port}/healthz`
  // 拿一个真被占过又立刻释放的端口 → 探它必 ECONNREFUSED(不吃超时等待)。
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const deadPort = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  deadUrl = `http://127.0.0.1:${deadPort}/healthz`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('gotong-watchdog — 重启判据', () => {
  it('K=3 连败才动手;台账行过 hub 真解析器 + 真渲染器(跨写入方契约)', async () => {
    const space = tmp()
    const stubs = makeStubs()
    await tick(space, stubs.dir, deadUrl)
    expect(stateOf(space).fails).toBe(1)
    expect(stubs.calls()).not.toContain('systemctl restart')
    await tick(space, stubs.dir, deadUrl)
    expect(stateOf(space).fails).toBe(2)
    await tick(space, stubs.dir, deadUrl)
    expect(stubs.calls()).toContain('systemctl restart gotong.service')
    const st = stateOf(space)
    expect(st.fails).toBe(0)
    expect(st.restarts.length).toBe(1)
    // 跨写入方契约:hub 的解析器读得懂,渲染器画得出。
    const rows = ledgerOf(space)
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ kind: 'watchdog-restart', reason: 'healthz-fail', fails: 3 })
    expect(String(rows[0]!.journalTail)).toContain('boom line1')
    const rendered = renderRestartHistory(rows)
    expect(rendered).toContain('watchdog-restart:healthz-fail')
    expect(rendered).toContain('当时日志尾巴')
  })

  it('健康一次即清零 — 中断的失败不算连续', async () => {
    const space = tmp()
    const stubs = makeStubs()
    seedState(space, { fails: 2, restarts: [], throttled: false })
    await tick(space, stubs.dir, okUrl)
    expect(stateOf(space).fails).toBe(0)
    // 再败两次也到不了线(3 是「连续」不是「累计」)。
    await tick(space, stubs.dir, deadUrl)
    await tick(space, stubs.dir, deadUrl)
    expect(stubs.calls()).not.toContain('systemctl restart')
    expect(stateOf(space).fails).toBe(2)
  })

  it('非 200 也是失败(healthz 只认 200)', async () => {
    const space = tmp()
    const stubs = makeStubs()
    healthy = false
    try {
      await tick(space, stubs.dir, okUrl)
    } finally {
      healthy = true
    }
    expect(stateOf(space).fails).toBe(1)
  })
})

describe('gotong-watchdog — 限流与守卫', () => {
  it('每小时打满 → 不再重启,只记一条 watchdog-throttled(响亮不刷屏)', async () => {
    const space = tmp()
    const stubs = makeStubs()
    const now = Date.now()
    seedState(space, {
      fails: 2,
      restarts: [now - 60_000, now - 120_000, now - 180_000],
      throttled: false,
    })
    await tick(space, stubs.dir, deadUrl) // fails→3,该重启但额度打满
    expect(stubs.calls()).not.toContain('systemctl restart')
    let rows = ledgerOf(space)
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ kind: 'watchdog-throttled', reason: 'restart-cap', restartsInLastHour: 3 })
    // 同一段故障第二轮:不再追加第二条(episode 只响一次)。
    await tick(space, stubs.dir, deadUrl)
    rows = ledgerOf(space)
    expect(rows.length).toBe(1)
    // 恢复即整段清零,下段故障还能再响。
    await tick(space, stubs.dir, okUrl)
    const st = stateOf(space)
    expect(st.fails).toBe(0)
    expect(st.throttled).toBe(false)
  })

  it('unit 非 active(维护停机)→ 不数失败不重启,已有计数清零', async () => {
    const space = tmp()
    const stubs = makeStubs({ isActiveExit: 3 })
    seedState(space, { fails: 2, restarts: [], throttled: false })
    await tick(space, stubs.dir, deadUrl)
    expect(stateOf(space).fails).toBe(0)
    expect(stubs.calls()).not.toContain('systemctl restart')
    expect(ledgerOf(space).length).toBe(0)
  })

  it('journalctl 缺席 → 照样重启,行里诚实没有 journalTail', async () => {
    const space = tmp()
    const stubs = makeStubs({ journalctl: false })
    seedState(space, { fails: 2, restarts: [], throttled: false })
    await tick(space, stubs.dir, deadUrl)
    expect(stubs.calls()).toContain('systemctl restart')
    const rows = ledgerOf(space)
    expect(rows.length).toBe(1)
    expect('journalTail' in rows[0]!).toBe(false)
  })

  it('坏参数 → usage + exit 2(装错当场响,不静默空转)', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--space', '/tmp/x'], { encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--url')
  })
})
