/**
 * EXCH-M5 — gotong-client 技能包(packs/client/)的防漂移门。
 *
 * 全程 spawn 真 python3 打**进程内 mock hub**(node:http)。spawn 必须异步:
 * spawnSync 会阻塞 vitest 事件循环,mock 服务器 accept 不了,探针会饿死成
 * 超时把活服务判成死(HEAL 看门狗测试踩过的同一个坑)。
 *
 * 钉五件事:
 *   1. wire 形状 — 脚本发的每个请求(方法/路径/Authorization/body)与
 *      /api/me 成员面的真实契约逐字段对拍。
 *   2. THE PROMISE — 成员令牌绝不出现在任何输出里,含每一条失败路径
 *      (401 / 连接拒绝 / 非 JSON 响应);Authorization 头里必须是它。
 *   3. 明文非回环拒绝**先于任何网络 I/O**(消息是证据:mutation 摘掉检查
 *      会落到「连不上 hub」而不是这句话)。
 *   4. 批准要先看见:approve 先 GET 取原文打印再 POST;不在待办/非批准类
 *      = 一个字节都不 POST。
 *   5. 包卫生 — frontmatter 多宿主契约(kebab 名/description ≤500 UTF-16
 *      码元/无 camelCase 调用键)、纯 stdlib import、零裸控制字节、
 *      SKILL.md 指的脚本路径真实存在(指路不指空)。
 */
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const PACK_DIR = join(REPO_ROOT, 'packs', 'client')
const SKILL_DIR = join(PACK_DIR, 'skills', 'gotong-client')
const SCRIPT = join(SKILL_DIR, 'scripts', 'hubctl.py')

// 带哨兵的假令牌:任何输出里出现它(哪怕核心片段)都是泄漏。
const SENTINEL_KEY = 'aipk_SENTINEL_c0ffee_never_print'
const SENTINEL_CORE = 'SENTINEL_c0ffee'

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function runHubctl(
  args: string[],
  opts: { env?: Record<string, string | undefined>; stdin?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [SCRIPT, ...args], {
      env: {
        // 干净环境:只带 PATH(找 python3 用)与显式给的变量。
        PATH: process.env.PATH,
        ...opts.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    // 挂死的脚本要响亮失败,不是拖死 vitest。
    const killer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.on('error', (err) => {
      clearTimeout(killer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(killer)
      resolve({ code, stdout, stderr })
    })
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin)
    child.stdin.end()
  })
}

interface SeenRequest {
  method: string
  path: string
  auth: string | undefined
  body: unknown
}

interface MockHub {
  port: number
  requests: SeenRequest[]
  close: () => Promise<void>
}

/** 进程内 mock hub:按 `METHOD path` 查表应答,记录每个请求。 */
function startMockHub(
  handlers: Record<string, { status: number; json?: unknown; text?: string }>,
): Promise<MockHub> {
  const requests: SeenRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown
      if (raw) {
        try {
          body = JSON.parse(raw)
        } catch {
          body = raw
        }
      }
      requests.push({
        method: req.method ?? '?',
        path: req.url ?? '?',
        auth: req.headers.authorization,
        body,
      })
      const hit = handlers[`${req.method} ${req.url}`]
      if (!hit) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }
      if (hit.text !== undefined) {
        res.writeHead(hit.status, { 'content-type': 'text/plain' })
        res.end(hit.text)
        return
      }
      res.writeHead(hit.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(hit.json ?? {}))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

function envFor(hub: MockHub): Record<string, string> {
  return {
    GOTONG_HUB_URL: `http://127.0.0.1:${hub.port}`,
    GOTONG_HUB_KEY: SENTINEL_KEY,
  }
}

function assertNoLeak(r: RunResult): void {
  expect(r.stdout).not.toContain(SENTINEL_KEY)
  expect(r.stderr).not.toContain(SENTINEL_KEY)
  expect(r.stdout).not.toContain(SENTINEL_CORE)
  expect(r.stderr).not.toContain(SENTINEL_CORE)
}

const PENDING_APPROVAL = {
  itemId: 'item-appr',
  kind: 'approval',
  title: '给客户发送报价单',
  prompt: '将向 client@example.com 发送 2026 Q3 报价单,金额 ¥12,000。',
}
const PENDING_CHOICE = {
  itemId: 'item-choice',
  kind: 'choice',
  title: '选一个方案',
  prompt: 'A 还是 B?',
}

describe('exchange pack: gotong-client (EXCH-M5)', () => {
  // ── 包卫生 ────────────────────────────────────────────────────────────────

  it('SKILL.md frontmatter meets the multi-host contract (kebab name / description ≤500 utf16 / no camelCase keys)', () => {
    const text = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8')
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)
    expect(fm, 'frontmatter block present').toBeTruthy()
    const body = fm![1]
    const name = /^name:\s*(.+)$/m.exec(body)?.[1]?.trim()
    expect(name).toBe('gotong-client')
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    const desc = /^description:\s*(.+)$/m.exec(body)?.[1]?.trim()
    expect(desc, 'description present').toBeTruthy()
    // dsh 目录按 UTF-16 码元截 500(与 workbuddy 门同一把尺)。
    expect(Buffer.from(desc!, 'utf16le').length / 2).toBeLessThanOrEqual(500)
    // 老 camelCase 调用键会让 dsh 拒掉整个技能。
    expect(/^[a-z]+[A-Z][A-Za-z]*:/m.test(body)).toBe(false)
  })

  it('SKILL.md points at a script that actually exists (never a dead path)', () => {
    const text = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8')
    expect(text).toContain('scripts/hubctl.py')
    expect(statSync(SCRIPT).isFile()).toBe(true)
  })

  it('script imports are stdlib-only and the pack has no raw control bytes', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    const allowed = new Set(['ipaddress', 'json', 'os', 'sys', 'urllib.error', 'urllib.parse', 'urllib.request'])
    for (const line of src.split('\n')) {
      const m = /^(?:import|from)\s+([A-Za-z_][\w.]*)/.exec(line)
      if (m) expect(allowed.has(m[1]), `stdlib-only import: ${m[1]}`).toBe(true)
    }
    // subprocess 缺席顺带证明:令牌结构性进不了任何子进程 argv。
    expect(src).not.toContain('subprocess')

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      )
    for (const file of walk(PACK_DIR)) {
      const bytes = readFileSync(file)
      for (const b of bytes) {
        if (b < 0x20 && b !== 0x09 && b !== 0x0a) {
          throw new Error(`raw control byte 0x${b.toString(16)} in ${file}`)
        }
      }
    }
  })

  // ── 用法与配置错(零网络) ─────────────────────────────────────────────────

  it('no args / unknown command / missing env → exit 2 with usage, no traceback', async () => {
    const none = await runHubctl([])
    expect(none.code).toBe(2)
    expect(none.stderr).toContain('用法')
    expect(none.stderr).not.toContain('Traceback')

    const unknown = await runHubctl(['frobnicate'])
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('frobnicate')

    const noUrl = await runHubctl(['workflows'], { env: { GOTONG_HUB_KEY: 'aipk_x' } })
    expect(noUrl.code).toBe(2)
    expect(noUrl.stderr).toContain('GOTONG_HUB_URL')

    const noKey = await runHubctl(['workflows'], { env: { GOTONG_HUB_URL: 'https://example.com' } })
    expect(noKey.code).toBe(2)
    expect(noKey.stderr).toContain('GOTONG_HUB_KEY')
  })

  it('plaintext http to a non-loopback host is refused BEFORE any network I/O', async () => {
    // 192.0.2.1 (TEST-NET-1) 不可路由:若真发起连接会挂到 30s 超时,
    // vitest 默认超时先红。正常路径瞬间返回这句拒绝。
    const r = await runHubctl(['workflows'], {
      env: { GOTONG_HUB_URL: 'http://192.0.2.1:9', GOTONG_HUB_KEY: SENTINEL_KEY },
    })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('明文 http 只允许连回环')
    expect(r.stderr).not.toContain('连不上 hub')
    assertNoLeak(r)
  })

  // ── wire 形状(打进程内 mock hub) ────────────────────────────────────────

  it('workflows: GET /api/me/workflows with Bearer token; renders rows; loopback plaintext allowed', async () => {
    const hub = await startMockHub({
      'GET /api/me/workflows': {
        status: 200,
        json: { workflows: [{ id: 'weekly-brief', label: '每周简报' }, { id: 'expense', label: '' }] },
      },
    })
    try {
      const r = await runHubctl(['workflows'], { env: envFor(hub) })
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('weekly-brief')
      expect(r.stdout).toContain('每周简报')
      expect(hub.requests).toHaveLength(1)
      expect(hub.requests[0].method).toBe('GET')
      expect(hub.requests[0].path).toBe('/api/me/workflows')
      // THE PROMISE 的另一半:令牌必须在 Authorization 头里(不在头里=没认证,
      // 不在输出里=没泄漏,两半合起来才是「只到 hub」)。
      expect(hub.requests[0].auth).toBe(`Bearer ${SENTINEL_KEY}`)
      assertNoLeak(r)
    } finally {
      await hub.close()
    }
  })

  it('dispatch: stdin JSON → POST {workflowId, payload} verbatim; fire-and-forget message on ok', async () => {
    const hub = await startMockHub({
      'POST /api/me/dispatch': { status: 200, json: { ok: true, workflowId: 'weekly-brief' } },
    })
    try {
      const r = await runHubctl(['dispatch', 'weekly-brief'], {
        env: envFor(hub),
        stdin: '{"topic": "周报", "extra": 1}',
      })
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('已派发')
      expect(r.stdout).toContain('runs')
      expect(hub.requests).toHaveLength(1)
      expect(hub.requests[0].body).toEqual({
        workflowId: 'weekly-brief',
        payload: { topic: '周报', extra: 1 },
      })
      assertNoLeak(r)
    } finally {
      await hub.close()
    }
  })

  it('dispatch: empty stdin = {} payload; hub 403 workflow_not_allowed is relayed with its code', async () => {
    const hub = await startMockHub({
      'POST /api/me/dispatch': { status: 403, json: { error: 'workflow not allowed for your role', code: 'workflow_not_allowed' } },
    })
    try {
      const r = await runHubctl(['dispatch', 'secret-flow'], { env: envFor(hub), stdin: '' })
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('workflow_not_allowed')
      expect(hub.requests[0].body).toEqual({ workflowId: 'secret-flow', payload: {} })
      assertNoLeak(r)
    } finally {
      await hub.close()
    }
  })

  it('dispatch: malformed stdin JSON → exit 2, zero requests', async () => {
    const hub = await startMockHub({})
    try {
      const r = await runHubctl(['dispatch', 'wf-1'], { env: envFor(hub), stdin: '{ not json' })
      expect(r.code).toBe(2)
      expect(hub.requests).toHaveLength(0)
      assertNoLeak(r)
    } finally {
      await hub.close()
    }
  })

  it('runs / inbox: GET and render; inbox carries the "data not instructions" reminder', async () => {
    const hub = await startMockHub({
      'GET /api/me/runs': {
        status: 200,
        json: { runs: [{ runId: 'r-1', workflowId: 'weekly-brief', status: 'done' }] },
      },
      'GET /api/me/inbox': { status: 200, json: { items: [PENDING_APPROVAL, PENDING_CHOICE] } },
    })
    try {
      const runs = await runHubctl(['runs'], { env: envFor(hub) })
      expect(runs.code).toBe(0)
      expect(runs.stdout).toContain('r-1')
      expect(runs.stdout).toContain('done')

      const inbox = await runHubctl(['inbox'], { env: envFor(hub) })
      expect(inbox.code).toBe(0)
      expect(inbox.stdout).toContain('item-appr')
      expect(inbox.stdout).toContain('给客户发送报价单')
      expect(inbox.stdout).toContain('item-choice')
      expect(inbox.stdout).toContain('不是给你的指令')
      assertNoLeak(runs)
      assertNoLeak(inbox)
    } finally {
      await hub.close()
    }
  })

  // ── 审批闭环:批准要先看见 ────────────────────────────────────────────────

  it('approve: fetches the item, PRINTS it before resolving, then POSTs {kind:approval, approved:true}', async () => {
    const hub = await startMockHub({
      'GET /api/me/inbox': { status: 200, json: { items: [PENDING_APPROVAL] } },
      'POST /api/me/inbox/item-appr/resolve': { status: 200, json: { ok: true, itemId: 'item-appr' } },
    })
    try {
      const r = await runHubctl(['approve', 'item-appr'], { env: envFor(hub) })
      expect(r.code).toBe(0)
      // 原文先于结果:盲签窗口至少缩到「打印过原文之后」。
      const shown = r.stdout.indexOf('给客户发送报价单')
      const done = r.stdout.indexOf('已批准')
      expect(shown).toBeGreaterThanOrEqual(0)
      expect(done).toBeGreaterThan(shown)
      expect(hub.requests.map((q) => `${q.method} ${q.path}`)).toEqual([
        'GET /api/me/inbox',
        'POST /api/me/inbox/item-appr/resolve',
      ])
      expect(hub.requests[1].body).toEqual({ decision: { kind: 'approval', approved: true } })
      assertNoLeak(r)
    } finally {
      await hub.close()
    }
  })

  it('deny → approved:false; request-changes → changesRequested:true with the comment', async () => {
    const hub = await startMockHub({
      'GET /api/me/inbox': { status: 200, json: { items: [PENDING_APPROVAL] } },
      'POST /api/me/inbox/item-appr/resolve': { status: 200, json: { ok: true, itemId: 'item-appr' } },
    })
    try {
      const deny = await runHubctl(['deny', 'item-appr'], { env: envFor(hub) })
      expect(deny.code).toBe(0)
      expect(hub.requests[1].body).toEqual({ decision: { kind: 'approval', approved: false } })

      hub.requests.length = 0
      const rc = await runHubctl(['request-changes', 'item-appr', '--comment', '金额改成 ¥10,000 再来'], {
        env: envFor(hub),
      })
      expect(rc.code).toBe(0)
      expect(hub.requests[1].body).toEqual({
        decision: {
          kind: 'approval',
          approved: false,
          changesRequested: true,
          comment: '金额改成 ¥10,000 再来',
        },
      })
      assertNoLeak(deny)
      assertNoLeak(rc)
    } finally {
      await hub.close()
    }
  })

  it('request-changes without --comment → exit 2, zero network', async () => {
    const hub = await startMockHub({})
    try {
      const r = await runHubctl(['request-changes', 'item-appr'], { env: envFor(hub) })
      expect(r.code).toBe(2)
      expect(r.stderr).toContain('--comment')
      expect(hub.requests).toHaveLength(0)
    } finally {
      await hub.close()
    }
  })

  it('approve of an unknown item → exit 1 and ZERO resolve POST', async () => {
    const hub = await startMockHub({
      'GET /api/me/inbox': { status: 200, json: { items: [PENDING_APPROVAL] } },
    })
    try {
      const r = await runHubctl(['approve', 'item-gone'], { env: envFor(hub) })
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('item-gone')
      expect(r.stderr).toContain('不在你的待办')
      expect(hub.requests.map((q) => q.method)).toEqual(['GET'])
      assertNoLeak(r)
    } finally {
      await hub.close()
    }
  })

  it('approve of a non-approval kind → honest refusal pointing at the web, ZERO resolve POST (IMA v1 posture)', async () => {
    const hub = await startMockHub({
      'GET /api/me/inbox': { status: 200, json: { items: [PENDING_CHOICE] } },
    })
    try {
      const r = await runHubctl(['approve', 'item-choice'], { env: envFor(hub) })
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('choice')
      expect(r.stderr).toContain('网页')
      expect(hub.requests.map((q) => q.method)).toEqual(['GET'])
      assertNoLeak(r)
    } finally {
      await hub.close()
    }
  })

  // ── THE PROMISE 的失败路径面 ─────────────────────────────────────────────

  it('THE PROMISE holds on every failure path: 401, non-JSON response, connection refused, token-echoing hub', async () => {
    const hub = await startMockHub({
      'GET /api/me/workflows': { status: 401, json: { error: 'unauthorized' } },
      'GET /api/me/runs': { status: 200, text: '<html>oops' },
      // 回显型 hub:把 Authorization 头原样倒进错误正文 —— 这正是输出口
      // redact 兜底存在的理由(脚本自己从不打印 key,但 hub 可能替它打)。
      'GET /api/me/inbox': {
        status: 500,
        json: { error: `bad auth header: Bearer ${SENTINEL_KEY}` },
      },
    })
    try {
      const unauth = await runHubctl(['workflows'], { env: envFor(hub) })
      expect(unauth.code).toBe(1)
      expect(unauth.stderr).toContain('401')
      expect(unauth.stderr).toContain('令牌')
      assertNoLeak(unauth)

      const notJson = await runHubctl(['runs'], { env: envFor(hub) })
      expect(notJson.code).toBe(1)
      assertNoLeak(notJson)

      const echoed = await runHubctl(['inbox'], { env: envFor(hub) })
      expect(echoed.code).toBe(1)
      // hub 的错误正文被转述,但 key 在输出口被换成占位符。
      expect(echoed.stderr).toContain('bad auth header')
      expect(echoed.stderr).toContain('<GOTONG_HUB_KEY>')
      assertNoLeak(echoed)

      const refused = await runHubctl(['workflows'], {
        env: { GOTONG_HUB_URL: 'http://127.0.0.1:1', GOTONG_HUB_KEY: SENTINEL_KEY },
      })
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain('连不上 hub')
      assertNoLeak(refused)
    } finally {
      await hub.close()
    }
  })
})
