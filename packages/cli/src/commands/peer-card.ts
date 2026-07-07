/**
 * `gotong peer-card <url>` — NET-M5 发现 preflight:建边(换 token)之前,
 * 先取对方 hub 的 A2A agent card(`/.well-known/agent-card.json`),把
 * 「对方是谁 / 怎么认证 / 登了什么能力」翻成人话打出来,末尾指回既有的
 * token onboarding 流。
 *
 * 立场(NET 边界 2:发现 ≠ 信任):
 *   - 这条命令**只读不写**——看名片永不建边、不碰 identity 状态、不存任何
 *     东西。信任仍然只能走 mint-peer-token + 双边登记(runbook Step 1-3)。
 *   - 名片是**增强不是前置**:对端没挂名片(404)是规范内的正常答案,如实
 *     说没有,下一步指引照给——直连流程一个字不变。
 *   - 名片是**对端给的不可信输入**:字段缺/类型错不炸,能读多少读多少,
 *     读不出的标「(未声明)」;但整体不是 JSON 对象就如实报无效。
 *
 * STD-M2a 验签:名片若带 A2A §8.4 签名,就按 `jku`(或回落到本源
 *   `/.well-known/jwks.json`)取 JWKS 验一遍,打 ✓/✗。**边界照旧**——✓ 只
 *   证明名片没被篡改、与自报公钥一致,**不代表签发者就是对方本人**;身份仍
 *   靠 onboarding 时带外锚定公钥(STD-M2b)。**签名裁决是 advisory**:它不改
 *   出码——出码只反映 preflight 有没有完成(取到卡即算完成),不当信任判决。
 *
 * STD-M2b `--expect-kid <kid>`:owner 带外记下的锚定公钥,拿来复验「对方现在
 *   的签名钥还是不是我锚定的那把」。**这是显式断言**——不符就当失败(出码 3),
 *   好让脚本 `peer-card <url> --expect-kid <k> && 重连` 卡在钥变了的时候。pin
 *   绑的是**验签密钥的真实指纹**(verifyCardKidMatches),不认 header 里可伪造
 *   的 kid 标签。
 *
 * 出码(脚本可依赖):
 *   0 = preflight 得到明确答案(有名片,或明确没有名片;带 --expect-kid 时=一致)
 *   1 = 没得出结论(网络不通 / 超时 / 对端回错误码 / 名片无效)
 *   2 = 用法错误
 *   3 = --expect-kid 断言失败(锚定公钥不符 / 对方没签名或验不出,无法确认)
 */

import { readCardSignatureHeader, verifyAgentCardSignature, verifyCardKidMatches, type SignedCard } from '@gotong/a2a'

import { printHelp } from './help.js'

/** Injectable seams so tests drive the full command without real sockets. */
export interface PeerCardDeps {
  fetchImpl?: typeof fetch
  out?: (line: string) => void
  err?: (line: string) => void
}

/** 常量非旋钮:preflight 是人在终端前等的一次 GET,10s 足够诚实。 */
const FETCH_TIMEOUT_MS = 10_000

const WELL_KNOWN_PATH = '/.well-known/agent-card.json'

/**
 * Normalize what the user typed into the card URL. Accepts a bare base
 * (`https://hub-b.example.com`, trailing slashes ok) or the full
 * well-known URL pasted verbatim — never double-appends the path.
 * Returns null for anything that is not http(s).
 */
export function resolveCardUrl(input: string): string | null {
  if (!/^https?:\/\//i.test(input)) return null
  const trimmed = input.replace(/\/+$/, '')
  return trimmed.endsWith(WELL_KNOWN_PATH) ? trimmed : `${trimmed}${WELL_KNOWN_PATH}`
}

const UNDECLARED = '(未声明)'

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

/**
 * Render a fetched card as a human-readable block. Pure + defensive: the
 * card is remote input, so every field is optional and mistyped values
 * degrade to UNDECLARED instead of throwing. Exported for direct tests.
 */
export function renderPeerCard(card: Record<string, unknown>, cardUrl: string): string {
  const lines: string[] = [`对方名片(${cardUrl}):`]
  lines.push(`  名字      ${str(card.name) ?? UNDECLARED}`)
  lines.push(`  介绍      ${str(card.description) ?? UNDECLARED}`)
  lines.push(`  版本      ${str(card.version) ?? UNDECLARED}`)

  // 端点:v1.0 supportedInterfaces 优先(首项=首选),回落 0.2.x 顶层字段。
  const ifaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : []
  const first = (ifaces[0] ?? null) as Record<string, unknown> | null
  const ifaceUrl = first ? str(first.url) : null
  if (ifaceUrl) {
    const binding = str(first!.protocolBinding)
    const ver = str(first!.protocolVersion)
    lines.push(`  端点      ${ifaceUrl}${binding || ver ? `(${[binding, ver ? `A2A ${ver}` : null].filter(Boolean).join(', ')})` : ''}`)
  } else if (str(card.url)) {
    const ver = str(card.protocolVersion)
    lines.push(`  端点      ${str(card.url)}${ver ? `(A2A ${ver})` : ''}`)
  } else {
    lines.push(`  端点      ${UNDECLARED}`)
  }

  // 认证:列 securitySchemes 的 kind,不翻译细节——拿凭证仍走对方管理员。
  const schemes = card.securitySchemes && typeof card.securitySchemes === 'object' && !Array.isArray(card.securitySchemes)
    ? Object.entries(card.securitySchemes as Record<string, unknown>)
    : []
  if (schemes.length > 0) {
    const parts = schemes.map(([k, v]) => {
      const o = (v ?? {}) as Record<string, unknown>
      const shape = [str(o.type), str(o.scheme)].filter(Boolean).join(' ')
      return shape ? `${k}(${shape})` : k
    })
    lines.push(`  认证      ${parts.join(', ')}`)
  } else {
    lines.push(`  认证      ${UNDECLARED}`)
  }

  const skills = Array.isArray(card.skills) ? card.skills : null
  if (!skills) {
    lines.push(`  开放能力  ${UNDECLARED}`)
  } else if (skills.length === 0) {
    lines.push('  开放能力  (一个都没登——主权 hub 缺省沉默,不代表对方没有能力)')
  } else {
    lines.push('  开放能力:')
    for (const entry of skills) {
      const s = (entry ?? {}) as Record<string, unknown>
      const id = str(s.id) ?? '(无 id)'
      const name = str(s.name)
      const desc = str(s.description)
      const label = name && name !== id ? `${id} — ${name}` : id
      lines.push(`    - ${label}${desc && desc !== id && desc !== name ? `:${desc}` : ''}`)
    }
  }
  return lines.join('\n')
}

/**
 * Where the card's public key lives. Prefer the signature's `jku`; if absent,
 * fall back to the conventional `<card-origin>/.well-known/jwks.json`. Returns
 * `crossOrigin` so the caller can note when the key is served elsewhere (an
 * honesty signal, not a rejection — integrity verification works either way).
 */
function resolveJwksUrl(header: Record<string, unknown>, cardUrl: string): { url: string | null; crossOrigin: boolean } {
  const jku = str(header.jku)
  if (jku) {
    if (!/^https?:\/\//i.test(jku)) return { url: null, crossOrigin: false }
    let cardOrigin: string | null = null
    try { cardOrigin = new URL(cardUrl).origin } catch { /* cardUrl was validated http(s) upstream */ }
    let jkuOrigin: string | null = null
    try { jkuOrigin = new URL(jku).origin } catch { return { url: null, crossOrigin: false } }
    return { url: jku, crossOrigin: !!cardOrigin && jkuOrigin !== cardOrigin }
  }
  try {
    return { url: `${new URL(cardUrl).origin}/.well-known/jwks.json`, crossOrigin: false }
  } catch {
    return { url: null, crossOrigin: false }
  }
}

/**
 * Render the `签名` line(s): verify the card's first signature against its
 * JWKS and report ✓/✗, or say it's unsigned. Fetches the JWKS (remote input,
 * so every failure degrades to "can't verify" — never throws). The honest
 * caveat is always attached to a ✓: integrity is not identity (发现≠信任).
 *
 * STD-M2b: when `expectKid` is given, additionally check the card's signing
 * key against the owner's out-of-band anchor and append a `锚定` line. That
 * check is a hard assertion — `expectFailed` flips true on anything but an
 * exact match (mismatch, unsigned, or unverifiable-so-can't-confirm), so the
 * caller can exit non-zero. The pin binds to the RECOMPUTED key thumbprint
 * (verifyCardKidMatches), never the forgeable header `kid` label.
 */
export async function verifyCardSignature(
  card: Record<string, unknown>,
  cardUrl: string,
  fetchImpl: typeof fetch,
  expectKid?: string,
): Promise<{ text: string; expectFailed: boolean }> {
  const expShort = expectKid ? `${expectKid.slice(0, 8)}…` : ''
  // 期望却没等到确认 = 断言失败。unsigned / 拿不到 JWKS 都算「无法确认锚定」。
  const cannotConfirm = (line: string): { text: string; expectFailed: boolean } =>
    expectKid
      ? { text: `${line}\n  锚定      ⚠ 你锚定了公钥(${expShort})但这张卡无法确认 —— 别急着信。`, expectFailed: true }
      : { text: line, expectFailed: false }

  const signed = card as unknown as SignedCard
  const header = readCardSignatureHeader(signed)
  if (!header) return cannotConfirm('  签名      (未签名 —— A2A 签名是可选的,不影响直连)')

  const kid = str(header.kid)
  const kidShort = kid ? `${kid.slice(0, 8)}…` : '(无 kid)'
  const { url: jwksUrl, crossOrigin } = resolveJwksUrl(header, cardUrl)
  if (!jwksUrl) {
    return cannotConfirm(`  签名      ⚠ 带签名(kid=${kidShort})但 jku 不是 http(s) URL —— 无法验证`)
  }

  let jwksText: string
  try {
    const res = await fetchImpl(jwksUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      return cannotConfirm(`  签名      ⚠ 带签名(kid=${kidShort})但 JWKS 拿不到(HTTP ${res.status} @ ${jwksUrl})—— 无法验证`)
    }
    jwksText = await res.text()
  } catch {
    return cannotConfirm(`  签名      ⚠ 带签名(kid=${kidShort})但连不上 JWKS(${jwksUrl})—— 无法验证`)
  }

  const result = verifyAgentCardSignature(signed, jwksText)
  const originNote = crossOrigin ? `\n            ⓘ JWKS 在另一个源:${jwksUrl}(留意)` : ''
  const lines: string[] = []
  if (result.ok) {
    lines.push(
      `  签名      ✓ 完整性已验证(ES256, kid=${kidShort})`,
      '            ⓘ 只证明名片没被篡改、与自报公钥一致 —— 不代表签发者就是对方本人。',
      `            身份仍靠 onboarding 时带外锚定这把公钥(建边前确认)。${originNote}`,
    )
  } else {
    lines.push(
      `  签名      ✗ 验证失败:${result.reason ?? '未知原因'}(kid=${kidShort})`,
      `            ⚠ 带签名却对不上公钥 —— 可能被篡改或对端换了钥,建边前务必核实。${originNote}`,
    )
  }

  // STD-M2b 锚定复验:pin 绑真实指纹(verifyCardKidMatches 内部重算),不认 header 标签。
  let expectFailed = false
  if (expectKid) {
    const pin = verifyCardKidMatches(signed, jwksText, expectKid)
    if (pin.status === 'match') {
      lines.push(`  锚定      ✓ 与你锚定的公钥一致(${expShort})`)
    } else {
      expectFailed = true
      const actual = pin.actualKid ? `${pin.actualKid.slice(0, 8)}…` : '(验不出)'
      lines.push(
        `  锚定      ⚠ 与锚定公钥不符:现在是 ${actual},你锚定的是 ${expShort}`,
        '            对端可能轮换了签名钥,也可能是冒充 —— 核实清楚再信,别急着建边。',
      )
    }
  }
  return { text: lines.join('\n'), expectFailed }
}

/** 尾部固定指引:发现之后的「下一步」永远是既有 token onboarding。 */
export function renderNextSteps(): string {
  return [
    '',
    '名片只是自我介绍——建边(信任)仍走既有 peer onboarding,名片永不自动建边:',
    '  1. gotong mint-peer-token --peer-id=<对方id> --endpoint=wss://<对方主机>:4000',
    '  2. 双边登记 peer:管理 UI「联邦」面板,或 POST /api/admin/identity/peers',
    '  详见 docs/zh/FEDERATION-RUNBOOK.md(Step 1-3)。',
  ].join('\n')
}

export async function peerCard(args: readonly string[], deps: PeerCardDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => { console.log(l) })
  const err = deps.err ?? ((l: string) => { console.error(l) })
  const fetchImpl = deps.fetchImpl ?? fetch

  let target: string | undefined
  let expectKid: string | undefined
  const EXPECT_PREFIX = '--expect-kid='
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--help' || a === '-h') {
      printHelp('peer-card')
      return 0
    }
    if (a === '--expect-kid') {
      const v = args[i + 1]
      if (v === undefined || v.startsWith('-')) {
        err('[peer-card] --expect-kid 需要一个 kid 值(带外记下的锚定公钥指纹)')
        return 2
      }
      expectKid = v
      i++
      continue
    }
    if (a.startsWith(EXPECT_PREFIX)) {
      const v = a.slice(EXPECT_PREFIX.length)
      if (!v) {
        err('[peer-card] --expect-kid 需要一个 kid 值(带外记下的锚定公钥指纹)')
        return 2
      }
      expectKid = v
      continue
    }
    if (a.startsWith('-')) {
      err(`[peer-card] 不认识的旗标: ${a}`)
      return 2
    }
    if (target) {
      err(`[peer-card] 只接受一个 URL,收到第二个: ${a}`)
      return 2
    }
    target = a
  }
  if (!target) {
    err('[peer-card] 缺对方 hub 地址,如 gotong peer-card https://hub-b.example.com')
    printHelp('peer-card')
    return 2
  }
  const cardUrl = resolveCardUrl(target)
  if (!cardUrl) {
    err(`[peer-card] 地址必须是 http(s) URL,收到: ${target}`)
    return 2
  }

  let res: Response
  try {
    res = await fetchImpl(cardUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (e) {
    err(`[peer-card] 连不上 ${cardUrl}: ${e instanceof Error ? e.message : String(e)}`)
    err('[peer-card] preflight 没完成——对方可能没起、地址不对、或网络不通。')
    return 1
  }

  if (res.status === 404) {
    out(`对方(${target})没挂名片(A2A agent card 是可选的)。`)
    out('看不到自我介绍,但不影响建边——照旧走 token onboarding 直连:')
    out(renderNextSteps())
    return 0
  }
  if (!res.ok) {
    err(`[peer-card] 对方回了 HTTP ${res.status}(${cardUrl})——名片状态不明。`)
    return 1
  }

  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    err(`[peer-card] 对方回了 200 但内容不是 JSON(${cardUrl})——不是有效名片。`)
    return 1
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    err(`[peer-card] 对方回的不是名片对象(${cardUrl})。`)
    return 1
  }

  const card = parsed as Record<string, unknown>
  out(renderPeerCard(card, cardUrl))
  const sig = await verifyCardSignature(card, cardUrl, fetchImpl, expectKid)
  out(sig.text)
  out(renderNextSteps())
  // --expect-kid 断言失败 = 出码 3(锚定不符),否则 preflight 完成即 0。
  return sig.expectFailed ? 3 : 0
}
