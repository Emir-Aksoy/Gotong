/**
 * NET-M5 — `gotong peer-card <url>` discovery preflight. Covers the pure
 * halves (URL normalization, defensive card rendering) and the full
 * command loop with an injected fetch: card present / absent (404 is a
 * NORMAL answer, exit 0) / invalid / unreachable. The card is remote,
 * untrusted input — the renderer must degrade, never throw.
 */

import { describe, expect, it } from 'vitest'

import {
  peerCard,
  renderNextSteps,
  renderPeerCard,
  resolveCardUrl,
} from '../src/commands/peer-card.js'

const CARD_URL = 'https://hub-b.example.com/.well-known/agent-card.json'

describe('resolveCardUrl', () => {
  it('appends the well-known path to a bare base, trailing slashes stripped', () => {
    expect(resolveCardUrl('https://hub-b.example.com')).toBe(CARD_URL)
    expect(resolveCardUrl('https://hub-b.example.com///')).toBe(CARD_URL)
    expect(resolveCardUrl('http://127.0.0.1:3000')).toBe(
      'http://127.0.0.1:3000/.well-known/agent-card.json',
    )
  })

  it('accepts the full well-known URL verbatim — never double-appends', () => {
    expect(resolveCardUrl(CARD_URL)).toBe(CARD_URL)
  })

  it('rejects non-http(s) input', () => {
    expect(resolveCardUrl('hub-b.example.com')).toBeNull()
    expect(resolveCardUrl('wss://hub-b.example.com:4000')).toBeNull()
    expect(resolveCardUrl('file:///etc/passwd')).toBeNull()
  })
})

describe('renderPeerCard (defensive, remote input)', () => {
  it('renders a full v1.0 card as human-readable lines', () => {
    const text = renderPeerCard(
      {
        name: '爸爸的 hub',
        description: '家里的常驻 hub',
        version: '3.1.0',
        supportedInterfaces: [
          { url: 'https://hub-b.example.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '0.2' },
        ],
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
        skills: [
          { id: 'dad-chat', name: '爸爸聊天', description: '跟爸爸的管家说句话' },
          { id: 'research' },
        ],
      },
      CARD_URL,
    )
    expect(text).toContain('爸爸的 hub')
    expect(text).toContain('家里的常驻 hub')
    expect(text).toContain('https://hub-b.example.com/a2a(JSONRPC, A2A 0.2)')
    expect(text).toContain('bearer(http bearer)')
    expect(text).toContain('dad-chat — 爸爸聊天:跟爸爸的管家说句话')
    expect(text).toContain('- research') // 缺 name/description 也照列,不加戏
  })

  it('empty object → every field degrades to 未声明, never throws', () => {
    const text = renderPeerCard({}, CARD_URL)
    expect(text).toContain('名字      (未声明)')
    expect(text).toContain('端点      (未声明)')
    expect(text).toContain('认证      (未声明)')
    expect(text).toContain('开放能力  (未声明)')
  })

  it('mistyped fields (numbers / arrays where strings belong) degrade, never throw', () => {
    const text = renderPeerCard(
      { name: 42, supportedInterfaces: 'nope', securitySchemes: ['x'], skills: [null, { id: 7 }] },
      CARD_URL,
    )
    expect(text).toContain('名字      (未声明)')
    expect(text).toContain('(无 id)')
  })

  it('skills: [] → 缺省沉默 wording (curated silence ≠ no abilities)', () => {
    expect(renderPeerCard({ skills: [] }, CARD_URL)).toContain('缺省沉默')
  })

  it('falls back to 0.2.x top-level url when supportedInterfaces is absent', () => {
    const text = renderPeerCard(
      { url: 'https://old.example.com', protocolVersion: '0.2.5' },
      CARD_URL,
    )
    expect(text).toContain('https://old.example.com(A2A 0.2.5)')
  })
})

/** Drive the whole command with an injected fetch + captured streams. */
async function run(
  args: string[],
  responder: () => Promise<Response> | Response,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const outLines: string[] = []
  const errLines: string[] = []
  const code = await peerCard(args, {
    fetchImpl: (async () => responder()) as typeof fetch,
    out: (l) => outLines.push(l),
    err: (l) => errLines.push(l),
  })
  return { code, stdout: outLines.join('\n'), stderr: errLines.join('\n') }
}

describe('peerCard command', () => {
  it('200 + valid card → prints the card AND the token-onboarding next steps, exit 0', async () => {
    const r = await run(['https://hub-b.example.com'], () =>
      Response.json({ name: 'Hub B', skills: [{ id: 'chat', name: 'chat' }] }),
    )
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Hub B')
    // 发现 ≠ 信任:下一步永远指回既有 onboarding,名片永不自动建边。
    expect(r.stdout).toContain('mint-peer-token')
    expect(r.stdout).toContain('永不自动建边')
  })

  it('404 → normal answer (no card), next steps still printed, exit 0', async () => {
    const r = await run(['https://hub-b.example.com'], () =>
      new Response('not found', { status: 404 }),
    )
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('没挂名片')
    expect(r.stdout).toContain('mint-peer-token') // 名片是增强不是前置
  })

  it('200 + non-JSON body → invalid card, exit 1', async () => {
    const r = await run(['https://hub-b.example.com'], () =>
      new Response('<html>oops</html>', { status: 200 }),
    )
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('不是 JSON')
  })

  it('200 + JSON array → not a card object, exit 1', async () => {
    const r = await run(['https://hub-b.example.com'], () => Response.json([1, 2]))
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('不是名片对象')
  })

  it('HTTP 500 → inconclusive, exit 1', async () => {
    const r = await run(['https://hub-b.example.com'], () =>
      new Response('boom', { status: 500 }),
    )
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('HTTP 500')
  })

  it('network failure → honest message, exit 1', async () => {
    const r = await run(['https://hub-b.example.com'], () => {
      throw new Error('ECONNREFUSED 1.2.3.4:443')
    })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('连不上')
    expect(r.stderr).toContain('ECONNREFUSED')
  })

  it('usage errors: missing url / non-http url / extra positional / unknown flag → exit 2', async () => {
    const never = () => {
      throw new Error('fetch must not be called on usage errors')
    }
    expect((await run([], never)).code).toBe(2)
    expect((await run(['hub-b.example.com'], never)).code).toBe(2)
    expect((await run(['https://a.com', 'https://b.com'], never)).code).toBe(2)
    expect((await run(['--nope', 'https://a.com'], never)).code).toBe(2)
  })

  it('normalizes what the user typed before fetching (trailing slash, full well-known URL)', async () => {
    const seen: string[] = []
    const impl = (async (url: RequestInfo | URL) => {
      seen.push(String(url))
      return Response.json({ name: 'x' })
    }) as typeof fetch
    await peerCard(['https://hub-b.example.com/'], { fetchImpl: impl, out: () => {}, err: () => {} })
    await peerCard([CARD_URL], { fetchImpl: impl, out: () => {}, err: () => {} })
    expect(seen).toEqual([CARD_URL, CARD_URL])
  })

  it('next-steps block names both onboarding halves (mint + register)', () => {
    const text = renderNextSteps()
    expect(text).toContain('mint-peer-token')
    expect(text).toContain('/api/admin/identity/peers')
    expect(text).toContain('FEDERATION-RUNBOOK')
  })
})
