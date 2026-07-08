/**
 * reallife-oauth — 「用 Google 登录」把日历接给你的 AI,令牌自动保鲜.
 *
 * 接入现实生活 track(C)的 capstone。北极星第 1 层「我的 AI 桌面:不写代码,
 * AI 帮我做实际的事」需要 agent 能碰你真实的日历 / 邮件。这条路(出站 OAuth,
 * C-M2)已整条落地:M1 纯核 → M2 vault 存储 → M3 连接流 → M4a 活令牌注入 →
 * M4b 自动刷新。每一环各有单测;缺的是一张把它们串成一个故事的图 —— 就是这个 demo。
 *
 * 全程确定性、零网络、零 API key。底下是真的 @gotong/identity:
 *
 *   - 真 M1 核:generatePkce / randomState / buildOutboundAuthorizationUrl /
 *     buildTokenExchangeBody / buildTokenRefreshBody / parseTokenResponse —— 授权
 *     URL 的 S256 PKCE、原生 scope 不塞 openid、access_type=offline 都是生产件。
 *   - 真 M2 存储:openIdentityStore 的 vault(信封加密)。令牌进磁盘前就在 JS 里
 *     加密了 —— demo 末尾把原始 DB 字节抓出来断言「明文令牌一个字节都不在盘上」。
 *
 * 只有三段薄编排是 host 内件的教学镜像(host 不是公共 API,同 butler-cross-hub
 * 镜像 personal-butler-ask-peer.ts 的先例):exchangeAndStore ← M3
 * `oauth-connect-service.ts`、oauthSecretSource ← M4a `oauth-secret-source.ts`、
 * refreshIfDue ← M4b `oauth-token-refresh.ts`。三者都只是「POST 一下 → parse →
 * 存回」,薄到不可能和 host 真件跑偏;host 真件另有自己的单测把关。唯一被 mock 的
 * 是那一个网络跳:一个假的 Google 令牌端点(fakeGoogleToken)。
 *
 * 这个 demo 端到端证的事:
 *
 *   [1] begin:授权 URL 用原生日历 scope、没有 openid、带 S256 PKCE 和
 *       access_type=offline(不给它 Google 不发 refresh_token,M4b 就没法保鲜)。
 *   [2] callback → 存:换码拿到令牌集,写进 vault —— 明文不落盘(信封加密)。
 *   [3] 注入:M4a 缝把固定 ref ${OAUTH_ACCESS_TOKEN} 解析成「喂 google_calendar
 *       这个 MCP server」的活令牌 —— 这正是流进远程 MCP `Authorization: Bearer`
 *       头的那串。别的 server 名 / 别的 ref 一律穿透到 base(per-server 隔离 +
 *       opt-in 透明:没连接器时注入层字节不变)。
 *   [4] 保鲜:时钟跳过到期,refresh_token grant 换来新令牌存回(旧 refresh_token
 *       前推),同一条缝现在吐的是新令牌 —— 连一次、永续、重生即新鲜。
 *
 * 三条不可破边界在这里都看得见:
 *   ① 全走 MCP 不存数据:hub 存的是一把令牌(钥匙),不是你的日程;搬走 .gotong/
 *      = 搬走全部,连接器不留数据尾巴。
 *   ② 凭证纪律:令牌进 vault 信封加密(末尾原始字节断言),注入用的是固定占位
 *      ${OAUTH_ACCESS_TOKEN} 而非明文令牌。
 *   ③ 接入 ≠ 授权行动:活令牌只让 agent 的 MCP 工具能「读 / 调」你的日历(触达);
 *      真发邀请 / 删事件这类高风险动作仍过 personal-butler 的 governed 审批闸
 *      (自主)。这条缝给的是 reach,不是 autonomy。
 *
 * Run:  pnpm demo:reallife-oauth
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MASTER_KEY_LEN_BYTES,
  buildOutboundAuthorizationUrl,
  buildTokenExchangeBody,
  buildTokenRefreshBody,
  generatePkce,
  openIdentityStore,
  parseTokenResponse,
  randomState,
  type IdentityStore,
  type OutboundOAuthProvider,
  type StoredOAuthTokenSet,
} from '@gotong/identity'

/**
 * The synchronous credential-resolver contract MCP config expansion uses (host
 * `mcp-config.ts`, not exported from @gotong/identity — restated here so the
 * demo needs only the one public package).
 */
type SecretSource = (name: string) => string | undefined

/** 固定注入占位 —— host `oauth-secret-source.ts` 的 OAUTH_ACCESS_TOKEN_REF 镜像。 */
const OAUTH_ACCESS_TOKEN_REF = 'OAUTH_ACCESS_TOKEN'

/** M4b 默认:令牌离到期 5 分钟内就刷。 */
const REFRESH_SKEW_MS = 5 * 60_000

/**
 * 一条 Google 日历连接器 —— 形状就是 M5b 内置预设
 * (packages/web/src/builtin-oauth-connectors.ts)那张卡:端点 / 原生 scope /
 * access_type=offline 都烤在预设里,成员只填自己注册的 OAuth 三件套。
 */
const CONNECTOR = {
  id: 'google-calendar',
  displayName: 'Google 日历',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  clientId: '1234567890-democlient.apps.googleusercontent.com',
  redirectUri: 'https://my-hub.example/api/oauth/callback',
  scope: 'https://www.googleapis.com/auth/calendar',
  extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  // 承重连接键:M4a 按 mcpServerName 把活令牌喂给这个 MCP server。
  mcpServerName: 'google_calendar',
  // 成员自己填的机密 —— 进 vault,页面不回显。用个扎眼的串,好在末尾断言它不落盘明文。
  clientSecret: 'GOCSPX-demo-secret-DO-NOT-LEAK',
} as const

// 令牌串故意扎眼,方便断言「注入的是这一串」+「明文不在原始 DB 字节里」。
const FIRST_ACCESS = 'ya29.FIRST-live-access-token'
const SECOND_ACCESS = 'ya29.SECOND-refreshed-access-token'
const REFRESH = '1//demo-refresh-token'

const T0 = 1_700_000_000_000 // 固定起点时钟(demo 自己推进,不碰 Date.now)

/**
 * 假 Google 令牌端点 —— 本 demo 唯一被 mock 的东西(那一个网络跳)。按 grant_type
 * 分流:authorization_code 首发 access+refresh;refresh_token 只发新 access(不带
 * 新 refresh → M4b 前推旧的,同 RFC 6749 §6)。记录每次调用好断言 body。
 */
function fakeGoogleToken(): {
  fn: typeof fetch
  calls: Array<{ url: string; grant: string; body: string }>
} {
  const calls: Array<{ url: string; grant: string; body: string }> = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '')
    const grant = new URLSearchParams(body).get('grant_type') ?? '(none)'
    calls.push({ url: String(url), grant, body })
    const json =
      grant === 'refresh_token'
        ? { access_token: SECOND_ACCESS, expires_in: 3600, token_type: 'Bearer', scope: CONNECTOR.scope }
        : {
            access_token: FIRST_ACCESS,
            refresh_token: REFRESH,
            expires_in: 3600,
            token_type: 'Bearer',
            scope: CONNECTOR.scope,
          }
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fn, calls }
}

/** 连接器行 + 揭示的 client secret → M1 核吃的纯 provider(host toProvider 镜像)。 */
function toProvider(store: IdentityStore, id: string): OutboundOAuthProvider {
  const c = store.getOAuthConnector(id)
  if (!c) throw new Error(`connector ${id} vanished`)
  const secret = store.readOAuthClientSecret(id)
  return {
    authorizationEndpoint: c.authorizationEndpoint,
    tokenEndpoint: c.tokenEndpoint,
    clientId: c.clientId,
    ...(secret ? { clientSecret: secret } : {}),
    redirectUri: c.redirectUri,
    scope: c.scope,
    ...(c.extraAuthParams ? { extraAuthParams: c.extraAuthParams } : {}),
  }
}

/**
 * M3 `OAuthConnectService.complete` 的薄镜像:换码 → parse → 盖绝对到期 → 存回
 * vault。真件多的是 state 校验 / 单次用 / 各种 throw,这里只留承重的那一跳。
 */
async function exchangeAndStore(
  store: IdentityStore,
  provider: OutboundOAuthProvider,
  code: string,
  codeVerifier: string,
  doFetch: typeof fetch,
  now: () => number,
): Promise<void> {
  const res = await doFetch(provider.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: buildTokenExchangeBody(provider, code, codeVerifier),
  })
  const parsed = parseTokenResponse(await res.json())
  const tokenSet: StoredOAuthTokenSet = {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken ?? null,
    tokenType: parsed.tokenType ?? null,
    scope: parsed.scope ?? null,
    accessTokenExpiresAt: typeof parsed.expiresIn === 'number' ? now() + parsed.expiresIn * 1000 : null,
  }
  store.setOAuthTokenSet(CONNECTOR.id, tokenSet) // 连接态转 connected:true
}

/**
 * M4a `makeOAuthSecretSource` 的镜像:固定 ref → 「喂这个 MCP server」的活令牌。
 * enabled && connected 都要;其余一切穿透到 base(= 没连接器时字节不变)。
 */
function oauthSecretSource(store: IdentityStore, base: SecretSource): (server: string) => SecretSource {
  return (mcpServerName) => (name) => {
    if (name === OAUTH_ACCESS_TOKEN_REF) {
      for (const c of store.listOAuthConnectors()) {
        if (c.enabled && c.connected && c.mcpServerName === mcpServerName) {
          const token = store.getOAuthTokenSet(c.id)?.accessToken
          if (token !== undefined) return token
        }
      }
    }
    return base(name)
  }
}

/**
 * M4b `OAuthTokenRefresher.tick` 的镜像:从非密的 accessTokenExpiresAt 投影判到期
 * (不解密就分诊),到期的才 refresh_token grant 换新存回(新响应缺 refresh_token
 * 就前推旧的)。返回实际刷新过的连接器数,好断言。
 */
async function refreshIfDue(
  store: IdentityStore,
  doFetch: typeof fetch,
  now: () => number,
): Promise<number> {
  let refreshed = 0
  for (const c of store.listOAuthConnectors()) {
    if (!c.enabled || !c.connected) continue
    if (c.accessTokenExpiresAt == null) continue
    if (c.accessTokenExpiresAt - now() > REFRESH_SKEW_MS) continue // 还新鲜,跳过
    const stored = store.getOAuthTokenSet(c.id)
    if (!stored?.refreshToken) continue
    const res = await doFetch(c.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: buildTokenRefreshBody(toProvider(store, c.id), stored.refreshToken),
    })
    const parsed = parseTokenResponse(await res.json())
    store.setOAuthTokenSet(c.id, {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken ?? stored.refreshToken, // 前推旧 refresh
      tokenType: parsed.tokenType ?? stored.tokenType,
      scope: parsed.scope ?? stored.scope,
      accessTokenExpiresAt: typeof parsed.expiresIn === 'number' ? now() + parsed.expiresIn * 1000 : null,
    })
    refreshed++
  }
  return refreshed
}

async function main(): Promise<void> {
  console.log('\n=== Gotong case: reallife-oauth — 用 Google 登录,令牌自动保鲜 (接入现实生活 C-M2) ===\n')

  // 真 vault 存储,落到临时文件(好在末尾抓原始字节断言加密)。
  const dir = mkdtempSync(join(tmpdir(), 'gotong-reallife-oauth-'))
  const dbPath = join(dir, 'identity.db')
  const store = openIdentityStore({ dbPath, masterKey: randomBytes(MASTER_KEY_LEN_BYTES) })

  // demo 自己的时钟(脚本里不许用 Date.now —— 也让「到期」可控)。
  let clock = T0
  const now = (): number => clock

  // base secret source:对 oauth ref 返回哨兵,好把「穿透」显形。
  const base: SecretSource = (name) => (name === OAUTH_ACCESS_TOKEN_REF ? 'FELL_THROUGH_TO_ENV' : undefined)
  const source = oauthSecretSource(store, base)
  const { fn: fetchImpl, calls } = fakeGoogleToken()

  // --- [0] 装一条 Google 日历连接器(opt-in:装了才有「用 X 登录」)---------------
  section('[0] 装一条 Google 日历连接器(M5b 预设形状)—— 装之前注入层是透明的')
  assert(
    source('google_calendar')(OAUTH_ACCESS_TOKEN_REF) === 'FELL_THROUGH_TO_ENV',
    'opt-in:零连接器时 ${OAUTH_ACCESS_TOKEN} 穿透到 base —— 与今天字节一致',
  )
  store.registerOAuthConnector(CONNECTOR)
  const fresh = store.getOAuthConnector(CONNECTOR.id)
  assert(fresh?.connected === false, '刚装上:配置在,但还没连接(connected:false,无令牌)')
  console.log(`  已装「${CONNECTOR.displayName}」→ 喂 MCP server「${CONNECTOR.mcpServerName}」`)

  // --- [1] begin:授权 URL 的形状(原生 scope / 无 openid / S256 / offline)-------
  section('[1] begin → 造授权 URL(真 M1 核:S256 PKCE + 原生 scope,不塞 openid)')
  const state = randomState()
  const pkce = generatePkce()
  const authUrl = buildOutboundAuthorizationUrl({
    provider: toProvider(store, CONNECTOR.id),
    state,
    codeChallenge: pkce.codeChallenge,
  })
  const u = new URL(authUrl)
  assert(u.searchParams.get('response_type') === 'code', 'response_type=code(授权码流)')
  assert(u.searchParams.get('scope') === CONNECTOR.scope, '用 provider 原生日历 scope')
  assert(!(u.searchParams.get('scope') ?? '').includes('openid'), '不塞 openid(出站不是登录,没有 id_token)')
  assert(u.searchParams.get('code_challenge_method') === 'S256', 'PKCE S256')
  assert((u.searchParams.get('code_challenge') ?? '').length > 0, '带 code_challenge')
  assert(u.searchParams.get('access_type') === 'offline', 'access_type=offline(否则 Google 不发 refresh_token)')
  console.log(`  authorize → ${u.origin}${u.pathname}?…scope=${CONNECTOR.scope.split('/').pop()}…access_type=offline`)
  console.log('  (成员在浏览器点「同意」,Google 带 ?code=… 回跳 hub 的 /api/oauth/callback)')

  // --- [2] callback → 换码 → 令牌进 vault(明文不落盘)---------------------------
  section('[2] callback:换码 → 令牌集写进 vault(信封加密,明文不落盘)')
  await exchangeAndStore(store, toProvider(store, CONNECTOR.id), 'auth-code-from-google', pkce.codeVerifier, fetchImpl, now)
  const connected = store.getOAuthConnector(CONNECTOR.id)
  assert(connected?.connected === true, '换码后连接器转 connected:true')
  assert(calls[0]?.grant === 'authorization_code', '第一跳是 authorization_code grant')
  assert(calls[0]?.body.includes('client_secret=GOCSPX-demo-secret') === true, 'client_secret 走 body(client_secret_post)')
  const storedNow = store.getOAuthTokenSet(CONNECTOR.id)
  assert(storedNow?.accessToken === FIRST_ACCESS, '存回的活令牌 = Google 首发的 access_token')
  console.log(`  已连接 ✓  活令牌到期 = T0 + ${((storedNow!.accessTokenExpiresAt! - T0) / 60000).toFixed(0)}min`)

  // --- [3] 注入:活令牌 → 远程 MCP 的 Authorization: Bearer 头 -------------------
  section('[3] 注入:M4a 缝把 ${OAUTH_ACCESS_TOKEN} 解析成 google_calendar 的活令牌')
  const injected = source('google_calendar')(OAUTH_ACCESS_TOKEN_REF)
  assert(injected === FIRST_ACCESS, '喂 google_calendar 的 bearer = 活令牌(正是流进 MCP Authorization 头的那串)')
  assert(
    source('some-other-server')(OAUTH_ACCESS_TOKEN_REF) === 'FELL_THROUGH_TO_ENV',
    'per-server 隔离:别的 MCP server 名拿不到这条连接器的令牌',
  )
  assert(source('google_calendar')('PATH') === undefined, '非 oauth ref(PATH)照常穿透到 base')
  console.log(`  google_calendar 的 Authorization 头 → Bearer ${injected!.slice(0, 18)}…`)

  // --- [4] 保鲜:时钟跳过到期 → refresh_token grant 换新 ------------------------
  section('[4] 一小时后:时钟跳过到期 → M4b refresh_token grant 换新令牌存回')
  clock = T0 + 3400_000 // 到期(T0+3.6M)前 5min 的 skew 窗内 → 到期
  const n = await refreshIfDue(store, fetchImpl, now)
  assert(n === 1, '恰刷新了 1 条到期连接器')
  assert(calls[1]?.grant === 'refresh_token', '第二跳是 refresh_token grant')
  const afterRefresh = store.getOAuthTokenSet(CONNECTOR.id)
  assert(afterRefresh?.accessToken === SECOND_ACCESS, '存回的是刷新后的新 access_token')
  assert(afterRefresh?.refreshToken === REFRESH, '响应没带新 refresh_token → 前推旧的(不丢保鲜能力)')
  console.log(`  刷新 ✓  新活令牌到期 = T0 + ${((afterRefresh!.accessTokenExpiresAt! - T0) / 60000).toFixed(0)}min`)

  // --- [5] 同一条缝,现在吐新令牌(连一次、永续、重生即新鲜)---------------------
  section('[5] 重生的 MCP 工具集从同一条缝拿 bearer —— 现在是刷新后的新令牌')
  assert(
    source('google_calendar')(OAUTH_ACCESS_TOKEN_REF) === SECOND_ACCESS,
    '注入缝现在吐新令牌 —— 会话重生即拿到新鲜 bearer(连一次,永续)',
  )
  console.log(`  google_calendar 的 Authorization 头 → Bearer ${SECOND_ACCESS.slice(0, 18)}… (已换新)`)

  // --- [verify] 凭证纪律:明文令牌一个字节都不在原始 DB 上 ----------------------
  section('[verify] 凭证纪律 —— 抓原始 DB 字节,断言令牌 / 机密从不明文落盘')
  const raw = readRawDbBytes(dbPath)
  assert(!raw.includes(FIRST_ACCESS), '首发 access_token 不在原始 DB 字节里(vault 信封加密)')
  assert(!raw.includes(SECOND_ACCESS), '刷新后 access_token 也不在原始 DB 字节里')
  assert(!raw.includes(REFRESH), 'refresh_token 不在原始 DB 字节里')
  assert(!raw.includes(CONNECTOR.clientSecret), 'client_secret 不在原始 DB 字节里')
  console.log('  all checks passed.')

  // 三条边界回收(narrated —— 代码里能证的上面证了,证不到的说清楚):
  section('三条不可破边界')
  console.log('  ① 全走 MCP 不存数据:hub 存的是一把令牌(钥匙),不是你的日程 —— 日历数据全在 Google/MCP 那端.')
  console.log('  ② 凭证纪律:令牌进 vault 信封加密(上面原始字节已证),注入用固定占位 ${OAUTH_ACCESS_TOKEN} 而非明文.')
  console.log('  ③ 接入 ≠ 授权:活令牌给的是「读/调」的触达;真发邀请/删事件仍过 personal-butler 的 governed 审批闸.')

  store.close?.()
  rmSync(dir, { recursive: true, force: true })

  section('done')
  console.log('  用 Google 登录一次 → 令牌进 vault → 喂进 MCP 头 → 到期自动刷 → 同一条缝永远新鲜.\n')
  process.exit(0)
}

/** 把主 DB 文件(+ 可能的 WAL/SHM 旁文件)全读出来拼一起,好断言明文不在任何盘上。 */
function readRawDbBytes(dbPath: string): string {
  let bytes = ''
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(p)) bytes += readFileSync(p, 'latin1')
  }
  return bytes
}

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`)
  console.log(`  ✓ ${label}`)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
