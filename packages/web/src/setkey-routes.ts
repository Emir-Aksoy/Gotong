/**
 * setkey-routes.ts — HANDS-M3b. The web half of `/setkey link`: a member on a
 * phone gets a one-time URL in their DM, opens it, and pastes the key into a
 * form served by their own hub over TLS. The IM platform carries the URL, not
 * the secret.
 *
 *   GET  /setkey/<token>   PUBLIC — the form
 *   POST /setkey           PUBLIC — spend the link, write the key
 *
 * ── Why these are public, and what holds them up ────────────────────────────
 * Same shape as `/api/devices/claim`: the caller has no session — acquiring the
 * ability to do this one thing IS the request. So they mount BEFORE the CSRF
 * gate, and three things stand in for auth:
 *
 *   1. The token is 256 bits, single-use, and dies in ten minutes.
 *   2. A per-IP limiter, injected so it shares the server's RateLimiter.
 *   3. Every failure that could be used to probe — bad token, expired token,
 *      spent token — is one answer with one wording.
 *
 * CSRF is not the threat here and skipping the Origin check does not weaken it:
 * a CSRF attack spends the VICTIM's ambient credentials, and there are none on
 * this path. An attacker who holds the token does not need a victim's browser —
 * they can just open the link. Which is why the IM reply says, in as many
 * words, that the link is itself the credential.
 *
 * ── No JavaScript, on purpose ───────────────────────────────────────────────
 * The hub's CSP is `script-src 'self'` with no `unsafe-inline`, so an inline
 * `<script>` would be silently dropped (SHELL-M4 lost an afternoon to exactly
 * that). A plain `<form method="post">` needs none: no countdown timer, no
 * reveal toggle, no client-side validation. Everything that must be true is
 * decided by the host on submit anyway.
 *
 * ── What never appears on these pages ───────────────────────────────────────
 * The secret. Not in a value attribute, not on the result page, not in a URL.
 * The form is `method="post"` for that reason alone — a GET would put the key
 * in the request line, the access log, and the browser history. On the one
 * failure that re-renders the form (a paste too short to be a key) the field
 * comes back EMPTY: convenience there would mean holding the secret in HTML we
 * just sent back down the wire.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { readTextBody } from './http-helpers.js'

/**
 * Host-side surface (duck-typed; web stays host-free).
 *
 * Note neither method takes a userId: the token IS the authorisation, and
 * whose link it is stays the host's answer, never the caller's claim — the
 * same posture `MeDeviceSurface.claim` takes.
 */
export interface SetKeyLinkSurface {
  linkPage(token: unknown): Promise<SetKeyLinkPageDto>
  submitLink(args: { token: unknown; target: string; secret: string }): Promise<SetKeySubmitDto>
}

export interface SetKeyLinkTargetDto {
  value: string
  kind: 'agent' | 'provider'
  name: string
  provider?: string
  blocked?: 'env-pinned' | 'mock'
  envName?: string
  filled: boolean
}

export type SetKeyLinkPageDto =
  | { ok: true; targets: SetKeyLinkTargetDto[]; expiresAt: number }
  | { ok: false; code: 'link_invalid' | 'not_allowed' }

/**
 * The host's outcome vocabulary, structurally mirrored so web keeps no runtime
 * dependency on host. Rendering happens twice (chat text in `im-bridge.ts`,
 * HTML here) because the media differ — but both render from THESE codes, so
 * the two faces cannot come to mean different things by one of them being
 * reworded. The `switch` below is exhaustive, so a code added host-side and
 * forgotten here is a type error, not a blank page.
 */
export type SetKeySubmitDto =
  | { ok: true; slot: 'agent'; agentId: string; provider: string; restart: RestartDto }
  | {
      ok: true
      slot: 'shared'
      provider: string
      shadowed: Array<{ agentId: string; reason: 'per-agent' | 'env-pinned' }>
      restart: RestartDto
    }
  | { ok: false; code: 'bad_secret'; reason: 'too_short' | 'too_long' | 'bad_chars' }
  | { ok: false; code: 'unknown_target'; agents: string[]; providers: string[] }
  | { ok: false; code: 'ambiguous_target'; target: string }
  | { ok: false; code: 'env_pinned'; agentId: string; envName: string }
  | { ok: false; code: 'mock_agent'; agentId: string }
  | { ok: false; code: 'vendor_ambiguous'; agents: string[] }
  | { ok: false; code: 'link_invalid' }
  | { ok: false; code: 'not_allowed' }

export interface RestartDto {
  restarted: string[]
  failed: string[]
  unavailable?: true
}

export interface SetKeyRouteDeps {
  setKeyLink: SetKeyLinkSurface | undefined
  /** False when this caller is over budget. Injected: shares the server's limiter. */
  allow(): boolean
}

/** Bounds a form body before it is parsed. A key is short; this is generous. */
const MAX_FORM_BYTES = 16 * 1024

export async function handleSetKeyLinkRoute(
  deps: SetKeyRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  const isForm = path.startsWith('/setkey/')
  if (!isForm && path !== '/setkey') return false

  // Rate limit BEFORE anything else, including reading a body: a flood must not
  // get us to parse its payloads, and the answer is the same either way.
  if (!deps.allow()) {
    sendPage(res, 429, page('慢一点 / Too many attempts', ['<p>请稍后再试。/ Please try again shortly.</p>']))
    return true
  }
  if (!deps.setKeyLink) {
    // Indistinguishable from "no such page" on a hub that never wired this —
    // an unwired surface should not advertise that keys can be set this way.
    sendPage(res, 404, page('找不到 / Not found', ['<p>404</p>']))
    return true
  }

  if (isForm) {
    if (method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' })
      res.end('method not allowed')
      return true
    }
    const token = decodeURIComponent(path.slice('/setkey/'.length))
    const view = await deps.setKeyLink.linkPage(token)
    if (!view.ok) {
      sendPage(res, view.code === 'link_invalid' ? 404 : 403, renderPageError(view.code))
      return true
    }
    sendPage(res, 200, renderForm(token, view, null))
    return true
  }

  if (method !== 'POST') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' })
    res.end('method not allowed')
    return true
  }

  let body = ''
  try {
    body = await readTextBody(req)
  } catch {
    sendPage(res, 413, page('太大了 / Too large', ['<p>请求体过大。/ Request body too large.</p>']))
    return true
  }
  if (body.length > MAX_FORM_BYTES) {
    sendPage(res, 413, page('太大了 / Too large', ['<p>请求体过大。/ Request body too large.</p>']))
    return true
  }
  const form = new URLSearchParams(body)
  const token = form.get('token') ?? ''
  const target = form.get('target') ?? ''
  const secret = form.get('secret') ?? ''

  const out = await deps.setKeyLink.submitLink({ token, target, secret })

  // The one failure that does NOT spend the link comes back as the form, so a
  // truncated paste costs a re-paste rather than a round trip to the phone.
  // (Which failures spend is the host's decision — see `submitLink`; this just
  // renders the one it kept open.)
  if (!out.ok && out.code === 'bad_secret') {
    const again = await deps.setKeyLink.linkPage(token)
    if (again.ok) {
      sendPage(res, 400, renderForm(token, again, badSecretText(out.reason)))
      return true
    }
  }
  sendPage(res, out.ok ? 200 : 400, renderResult(out))
  return true
}

// ── rendering ───────────────────────────────────────────────────────────────

/** HTML-escape. Every interpolation below goes through it, without exception. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Styles are inline because the CSP allows `style-src 'unsafe-inline'` and a
 * separate stylesheet would be one more thing that has to be reachable for a
 * credential form to be legible. Sizes follow the POLISH-M1 baseline (17px
 * body, 48px touch targets) — this page is read on a phone by definition.
 */
const STYLE = [
  'body{font:17px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;',
  'margin:0;padding:24px;background:#f6f7f9;color:#1c1e21}',
  'main{max-width:34rem;margin:0 auto;background:#fff;border-radius:14px;padding:24px;',
  'box-shadow:0 1px 3px rgba(0,0,0,.08)}',
  'h1{font-size:22px;margin:0 0 4px}',
  'p{margin:12px 0}',
  '.muted{color:#6b7280;font-size:15px}',
  '.bad{color:#b42318;background:#fef3f2;border-radius:10px;padding:12px 14px}',
  '.good{color:#067647;background:#ecfdf3;border-radius:10px;padding:12px 14px}',
  'label{display:block;margin:18px 0 6px;font-weight:600}',
  'select,input{width:100%;box-sizing:border-box;font-size:18px;padding:12px;min-height:52px;',
  'border:1px solid #d0d5dd;border-radius:10px;background:#fff}',
  'button{width:100%;min-height:56px;margin-top:22px;font-size:18px;font-weight:600;',
  'color:#fff;background:#3468c8;border:0;border-radius:10px;cursor:pointer}',
  'ul{padding-left:1.2em}',
  'code{background:#f2f4f7;border-radius:6px;padding:1px 5px}',
].join('')

function page(title: string, bodyHtml: string[]): string {
  return [
    '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    // Belt and braces with the global `referrer-policy` header: the token is in
    // this page's URL, and it must not ride a Referer anywhere.
    '<meta name="referrer" content="no-referrer">',
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>`,
    `<h1>${esc(title)}</h1>`,
    ...bodyHtml,
    '</main></body></html>',
  ].join('')
}

function sendPage(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    // A page holding a live one-time token has no business in any cache.
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
  })
  res.end(html)
}

function renderPageError(code: 'link_invalid' | 'not_allowed'): string {
  return code === 'link_invalid'
    ? page('链接失效了 / Link no longer valid', [
        '<p class="bad">这个链接已经用过、过期了,或者不对。</p>',
        '<p>回到聊天窗再发一次 <code>/setkey link</code> 就会有新的。</p>',
        '<p class="muted">This one-time link is spent, expired, or wrong — send <code>/setkey link</code> again.</p>',
      ])
    : page('权限不够 / Not permitted', [
        '<p class="bad">你的账号现在没有改这台 hub 的 key 的权限。</p>',
        '<p class="muted">Your account is no longer allowed to change keys on this hub.</p>',
      ])
}

function renderForm(token: string, view: { targets: SetKeyLinkTargetDto[]; expiresAt: number }, notice: string | null): string {
  const minutes = Math.max(1, Math.round((view.expiresAt - Date.now()) / 60_000))
  const options = view.targets.map((t) => {
    const bits: string[] = []
    if (t.kind === 'agent') bits.push(t.provider ?? '')
    else bits.push('共享池 / shared')
    if (t.blocked === 'mock') bits.push('mock,不用 key')
    else if (t.blocked === 'env-pinned') bits.push(`钉了环境变量 ${t.envName ?? ''}`)
    else bits.push(t.filled ? '已有 key,会被替换' : '还没有 key')
    const label = `${t.name} — ${bits.filter((b) => b.length > 0).join(' · ')}`
    // `disabled` on what cannot work: the host refuses these anyway, so this is
    // the picker declining to offer the impossible, not a second gate.
    return `<option value="${esc(t.value)}"${t.blocked ? ' disabled' : ''}>${esc(label)}</option>`
  })
  const body: string[] = []
  if (notice) body.push(`<p class="bad">${esc(notice)}</p>`)
  body.push(
    `<p class="muted">这个链接 ${minutes} 分钟内有效,只能用一次。key 只会经这里直接进这台 hub 的金库。</p>`,
    '<form method="post" action="/setkey">',
    `<input type="hidden" name="token" value="${esc(token)}">`,
    '<label for="target">改哪一个 / Which slot</label>',
    `<select id="target" name="target">${options.join('')}</select>`,
    '<label for="secret">API key</label>',
    // `type="password"`: the conventional shape for a credential field, and it
    // keeps the value out of a screenshot or a shared screen. The confirmation
    // the member actually needs is on the next page — which agent took the key
    // and whether it restarted — not being able to re-read what they pasted.
    '<input id="secret" name="secret" type="password" autocomplete="off" ' +
      'autocapitalize="off" autocorrect="off" spellcheck="false" required>',
    '<button type="submit">存进去 / Save</button>',
    '</form>',
    '<p class="muted">存好之后,用到它的 agent 会立刻重启一次,这样新 key 才是真的在用。' +
      '/ The agents that use it are restarted so the new key actually takes effect.</p>',
  )
  return page('换一把 key / Set an API key', body)
}

function badSecretText(reason: 'too_short' | 'too_long' | 'bad_chars'): string {
  return reason === 'too_short'
    ? '没存 —— 这串太短,不像一把完整的 key(多半是粘贴时被截断了)。再贴一次。'
    : reason === 'too_long'
      ? '没存 —— 这串太长,不像一把 key。再贴一次。'
      : '没存 —— 这串里有换行/控制字符,多半是粘贴时带进了别的东西。再贴一次。'
}

/**
 * The result page. Same rule as the chat renderer it mirrors: every string here
 * comes from the hub's own records (an agent id, a provider tag, an env var
 * name). Nothing the member typed is echoed back — `esc()` is still applied,
 * because "there is nothing untrusted here" is a property to defend, not to
 * rely on.
 */
function renderResult(out: SetKeySubmitDto): string {
  if (out.ok) {
    const lines: string[] = [
      out.slot === 'agent'
        ? `<p class="good">已存入 —— ${esc(out.agentId)} 的专属 key(provider: ${esc(out.provider)})</p>`
        : `<p class="good">已存入 —— 共享池的 ${esc(out.provider)} key</p>`,
    ]
    if (out.slot === 'shared' && out.shadowed.length > 0) {
      lines.push(
        '<p>用不到它的:</p><ul>' +
          out.shadowed
            .map(
              (s) =>
                `<li>${esc(s.agentId)}(${s.reason === 'per-agent' ? '有专属 key' : '钉了环境变量'})</li>`,
            )
            .join('') +
          '</ul>',
      )
    }
    const r = out.restart
    if (r.restarted.length > 0) lines.push(`<p>已重启并生效:${esc(r.restarted.join('、'))}</p>`)
    if (r.failed.length > 0) {
      lines.push(
        `<p class="bad">重启失败:${esc(r.failed.join('、'))} —— key 已存好,但要等它下次启动才生效。</p>`,
      )
    }
    if (r.unavailable) {
      lines.push('<p class="bad">这台 host 没接 agent 重启,key 已存好,但要等下次启动才生效。</p>')
    }
    if (r.restarted.length === 0 && r.failed.length === 0 && !r.unavailable) {
      lines.push('<p class="muted">当前没有 agent 会用到它,存着备用。</p>')
    }
    lines.push('<p class="muted">这个链接已经用掉了,可以关掉这个页面。/ This link is now spent — you can close this page.</p>')
    return page('存好了 / Saved', lines)
  }

  const body = ((): string[] => {
    switch (out.code) {
      case 'link_invalid':
        return [
          '<p class="bad">链接已经用过、过期了,或者不对。</p>',
          '<p>回到聊天窗再发一次 <code>/setkey link</code>。</p>',
        ]
      case 'not_allowed':
        return ['<p class="bad">你的账号现在没有改这台 hub 的 key 的权限。</p>']
      case 'bad_secret':
        // Reached only when the form could not be re-rendered (the link went
        // away between the two calls). Say the same thing, minus the retry.
        return [`<p class="bad">${esc(badSecretText(out.reason))}</p>`]
      case 'unknown_target':
        return [
          '<p class="bad">没存 —— 这台 hub 不认识那个目标。</p>',
          `<p>可用的 agent:${esc(out.agents.length > 0 ? out.agents.join('、') : '(无)')}</p>`,
          `<p>可用的共享 provider:${esc(out.providers.join('、'))}</p>`,
        ]
      case 'ambiguous_target':
        return [
          `<p class="bad">没存 —— 「${esc(out.target)}」既是 agent 也是 provider,分不清要改哪个。</p>`,
        ]
      case 'env_pinned':
        return [
          `<p class="bad">没存 —— ${esc(out.agentId)} 的 key 被钉在服务器环境变量 ` +
            `<code>${esc(out.envName)}</code> 上,存进来的 key 永远轮不上。</p>`,
          '<p>要换它,请在服务器上改那个环境变量并重启;或先在网页把这个 agent 的 apiKeyEnv 去掉。</p>',
        ]
      case 'mock_agent':
        return [`<p class="bad">没存 —— ${esc(out.agentId)} 是 mock provider,不用 key。</p>`]
      case 'vendor_ambiguous':
        return [
          '<p class="bad">没存 —— openai-compatible 是一堆不同厂商共用的标签,' +
            '存一把共享 key 会被发给错的端点。请改成按 agent 存。</p>',
        ]
      default: {
        // Exhaustiveness: a host-side code with no branch here is a type error.
        const never: never = out
        void never
        return ['<p class="bad">没存。</p>']
      }
    }
  })()
  body.push(
    '<p class="muted">这个链接已经用掉了。想再来一次,回到聊天窗发 <code>/setkey link</code>。' +
      '/ This link is spent — send <code>/setkey link</code> again.</p>',
  )
  return page('没存进去 / Not saved', body)
}
