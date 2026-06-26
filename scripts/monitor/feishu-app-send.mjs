#!/usr/bin/env node
// Feishu app-bot alert sender for the liveness watchdog (healthcheck.sh).
//
// Why a node helper instead of curl in the shell script: sending via a Feishu
// *app bot* (not a custom-bot webhook) is a two-step dance — fetch a
// tenant_access_token from the App ID/Secret, then POST the message with that
// token as a bearer. Doing that in bash means the App Secret and the bearer
// token would pass through `curl` argv / `-d` bodies that show up in `ps` and
// risk leaking into logs. Keeping it in a tiny node process means the secret is
// read from the environment and lives only in process memory; nothing
// secret-grade ever lands on a command line.
//
// This needs only the app's `im:message` scope (the same scope the IM bridge
// already uses to reply) — no `im:chat:*`, no custom-bot webhook. It can page
// a person directly (receive_id_type=open_id, an ou_… id) or a group
// (receive_id_type=chat_id, an oc_… id).
//
// Inputs (all via env, except the message text):
//   AIPE_LARK_APP_ID              Feishu app id      (required)
//   AIPE_LARK_APP_SECRET          Feishu app secret  (required; never printed)
//   FEISHU_ALERT_RECEIVE_ID       open_id (ou_…) or chat_id (oc_…)  (required)
//   FEISHU_ALERT_RECEIVE_ID_TYPE  open_id (default) | chat_id | user_id |
//                                 union_id | email
//   FEISHU_BASE_URL               override API base (default open.feishu.cn)
//   message text                  argv[2] if given, else read from stdin
//
// Exit codes: 0 = delivered (Feishu code 0). Non-zero = misconfig or send
// failure (a sanitized reason on stderr — never the secret or the token).

const appId = (process.env.AIPE_LARK_APP_ID || '').trim()
const appSecret = (process.env.AIPE_LARK_APP_SECRET || '').trim()
const receiveId = (process.env.FEISHU_ALERT_RECEIVE_ID || '').trim()
const receiveIdType = (process.env.FEISHU_ALERT_RECEIVE_ID_TYPE || 'open_id').trim()
const base = (process.env.FEISHU_BASE_URL || 'https://open.feishu.cn').replace(/\/+$/, '')

function die(reason) {
  // Sanitized: callers must be able to log this. No secret/token here.
  process.stderr.write(`feishu-app-send: ${reason}\n`)
  process.exit(1)
}

if (!appId || !appSecret) die('AIPE_LARK_APP_ID / AIPE_LARK_APP_SECRET not set')
if (!receiveId) die('FEISHU_ALERT_RECEIVE_ID not set')

async function readText() {
  if (process.argv[2] != null && process.argv[2] !== '') return process.argv[2]
  // Read the whole of stdin (the watchdog pipes the alert prose in).
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8').trim()
}

async function postJson(url, headers, payload) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 10_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    })
    let body = {}
    try { body = await res.json() } catch { /* non-JSON error body */ }
    return { status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

const text = await readText()
if (!text) die('empty message text (argv[2] and stdin both empty)')

// 1. tenant_access_token from App ID/Secret.
const tok = await postJson(
  `${base}/open-apis/auth/v3/tenant_access_token/internal`,
  {},
  { app_id: appId, app_secret: appSecret },
).catch((e) => die(`token request failed: ${e?.name || 'error'}`))
if (tok.body?.code !== 0 || !tok.body?.tenant_access_token) {
  die(`token rejected (code ${tok.body?.code}): ${tok.body?.msg || 'unknown'}`)
}

// 2. Send the text message. Feishu wants `content` as a JSON *string*.
const send = await postJson(
  `${base}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
  { Authorization: `Bearer ${tok.body.tenant_access_token}` },
  { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }) },
).catch((e) => die(`send request failed: ${e?.name || 'error'}`))

if (send.body?.code === 0) {
  process.stdout.write('feishu-app-send: ok\n')
  process.exit(0)
}
die(`send rejected (http ${send.status}, code ${send.body?.code}): ${send.body?.msg || 'unknown'}`)
