/**
 * `gotong wechat-login` — mint a WeChat iLink bot token by QR scan.
 *
 * WeChat is the one bridge whose credential CANNOT be copy-pasted from a
 * vendor console: the token is minted by scanning a QR with the phone app
 * (1 WeChat account = 1 bot). This command runs the official login flow
 * (POST get_bot_qrcode → long-poll get_qrcode_status) against the same
 * `@gotong/im-wechat` client the bridge uses, and prints the result as
 * ready-to-paste env lines.
 *
 * Output discipline (mirrors `mint-peer-token`): credentials alone go to
 * stdout (`GOTONG_WECHAT_BOT_TOKEN=…` / `GOTONG_WECHAT_BASE_URL=…`, so
 * `gotong wechat-login >> host.env` works); the QR, progress, and guidance
 * all go to stderr. The token is a SECRET — same handling as a bot token.
 *
 * Deliberate default (Auto Mode note): this command is STATELESS — it does
 * not open the identity store to write a vault row, because the CLI has no
 * master-key resolution of its own and duplicating the host's would drift.
 * The host's vault path for wechat (resolveImCreds) is forward-compat for
 * a future admin-panel scan card; until then env vars are the documented
 * route, exactly like every other IM bridge's first setup.
 *
 * State machine mirrors the official plugin (login-qr.ts, 2026-07-09):
 * wait → keep polling · scaned → confirm on phone · scaned_but_redirect →
 * switch polling host (IDC affinity) · need_verifycode → pairing digits
 * from stdin, re-poll immediately · expired / verify_code_blocked →
 * refresh the QR up to a small cap · binded_redirect → already bound
 * (no new token is issued) · confirmed → credentials.
 */

import type { WechatIlinkClient } from '@gotong/im-wechat'

import { printHelp } from './help.js'

/** The two token-less login endpoints the flow drives (structural subset of
 *  the real client, so tests inject a scripted fake). */
export type WechatLoginClient = Pick<WechatIlinkClient, 'fetchBotQrcode' | 'pollQrcodeStatus'>

export type WechatLoginOutcome =
  | { ok: true; botToken: string; botId: string; baseUrl?: string; userId?: string }
  | {
      ok: false
      reason: 'timeout' | 'expired' | 'blocked' | 'already_bound' | 'protocol' | 'no_tty'
      message: string
    }

export interface WechatLoginFlowDeps {
  client: WechatLoginClient
  /** Render the QR for the phone to scan (attempt = 1-based, bumps on refresh). */
  showQr: (qrcodeImgUrl: string | undefined, attempt: number) => Promise<void>
  /** Ask the person for the pairing digits WeChat shows on the phone.
   *  `null` = cannot prompt (no interactive stdin) — the flow fails honestly. */
  promptDigits: (message: string) => Promise<string | null>
  /** Progress line for the human (stderr in production). */
  info: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Whole-flow budget. Default 480s (the official plugin's). */
  timeoutMs?: number
  /** Max QR issues (initial + refreshes). Default 3 (official cap). */
  maxQrIssues?: number
}

const DEFAULT_TIMEOUT_MS = 480_000
const MAX_QR_ISSUES = 3
/** Gap between status polls. The server long-polls ~35s on `wait`, so this
 *  only paces the fast statuses — same 1s the official plugin uses. */
const POLL_GAP_MS = 1000

export async function runWechatLoginFlow(deps: WechatLoginFlowDeps): Promise<WechatLoginOutcome> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const maxQrIssues = deps.maxQrIssues ?? MAX_QR_ISSUES
  const deadline = now() + (deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  // The wire type is defensive (every field optional); a QR response
  // without its polling key is unusable — fail honestly, don't poll ''.
  const NO_QR: WechatLoginOutcome = {
    ok: false,
    reason: 'protocol',
    message: '服务器没有返回二维码 key（get_bot_qrcode 响应缺 qrcode 字段）。请重试。',
  }

  let qr = await deps.client.fetchBotQrcode()
  let qrKey = qr.qrcode?.trim()
  if (!qrKey) return NO_QR
  let qrIssues = 1
  await deps.showQr(qr.qrcode_img_content, qrIssues)

  let pendingVerifyCode: string | undefined
  let baseUrlOverride: string | undefined
  let scannedSaid = false

  /** true = fresh QR issued · false = cap reached · null = server broke. */
  const refreshQr = async (why: string): Promise<boolean | null> => {
    qrIssues++
    if (qrIssues > maxQrIssues) return false
    qr = await deps.client.fetchBotQrcode()
    qrKey = qr.qrcode?.trim()
    if (!qrKey) return null
    pendingVerifyCode = undefined
    scannedSaid = false
    deps.info(why)
    await deps.showQr(qr.qrcode_img_content, qrIssues)
    return true
  }

  while (now() < deadline) {
    const s = await deps.client.pollQrcodeStatus({
      qrcode: qrKey,
      ...(pendingVerifyCode ? { verifyCode: pendingVerifyCode } : {}),
      ...(baseUrlOverride ? { baseUrlOverride } : {}),
    })
    switch (s.status) {
      case 'wait':
        break
      case 'scaned':
        // The server accepting a pending pairing code reports plain `scaned`.
        pendingVerifyCode = undefined
        if (!scannedSaid) {
          deps.info('已扫码，请在手机上点确认。')
          scannedSaid = true
        }
        break
      case 'scaned_but_redirect': {
        // IDC affinity: keep polling on the host the server names.
        if (s.redirect_host) {
          baseUrlOverride = `https://${s.redirect_host}`
          deps.info(`服务器要求换机房轮询：${s.redirect_host}`)
        }
        break
      }
      case 'need_verifycode': {
        // Re-entering with a pending code means the previous digits were wrong.
        const msg = pendingVerifyCode
          ? '数字不匹配，请重新输入手机微信上显示的数字：'
          : '输入手机微信上显示的数字以继续：'
        const code = await deps.promptDigits(msg)
        if (code === null) {
          return {
            ok: false,
            reason: 'no_tty',
            message: '这一步需要输入手机上显示的配对数字，但当前不是交互终端。请在能打字的终端里重新运行 gotong wechat-login。',
          }
        }
        pendingVerifyCode = code.trim()
        continue // re-poll immediately, no gap
      }
      case 'expired': {
        const r = await refreshQr('二维码已过期，已刷新——请重新扫描。')
        if (r === null) return NO_QR
        if (!r) {
          return { ok: false, reason: 'expired', message: '二维码多次过期未扫，先到手机边上再重新运行吧。' }
        }
        continue
      }
      case 'verify_code_blocked': {
        pendingVerifyCode = undefined
        const r = await refreshQr('配对数字多次输错，已换一张新二维码——请重新扫描。')
        if (r === null) return NO_QR
        if (!r) {
          return { ok: false, reason: 'blocked', message: '配对数字多次输错，登录流程已停止。请稍后再试。' }
        }
        continue
      }
      case 'binded_redirect': {
        // The server matched one of `local_token_list` — but this command
        // always sends [] (stateless), so in practice this means the account
        // holds a live binding minted elsewhere. No new token is issued.
        return {
          ok: false,
          reason: 'already_bound',
          message:
            '这个微信号已经绑定过一个 bot 且旧令牌仍有效，服务器不再发新令牌。' +
            '若旧令牌已丢失，先在手机微信的服务通知/设置里解除旧绑定，再重新运行本命令。',
        }
      }
      case 'confirmed': {
        if (!s.bot_token || !s.ilink_bot_id) {
          return {
            ok: false,
            reason: 'protocol',
            message: `登录已确认但服务器未返回完整凭证（bot_token=${s.bot_token ? '有' : '缺'}, ilink_bot_id=${s.ilink_bot_id ? '有' : '缺'}）。请重试。`,
          }
        }
        return {
          ok: true,
          botToken: s.bot_token,
          botId: s.ilink_bot_id,
          ...(s.baseurl ? { baseUrl: s.baseurl } : {}),
          ...(s.ilink_user_id ? { userId: s.ilink_user_id } : {}),
        }
      }
      default:
        // Unknown status — forward-compat: report and keep waiting.
        deps.info(`未知登录状态 "${String(s.status)}"，继续等待…`)
        break
    }
    await sleep(POLL_GAP_MS)
  }
  return { ok: false, reason: 'timeout', message: '等待扫码超时。请重新运行 gotong wechat-login。' }
}

/** The stdout payload — exactly the env lines the host's wechat gate reads.
 *  Pure + exported so tests pin the format without stream capture. */
export function renderEnvLines(outcome: Extract<WechatLoginOutcome, { ok: true }>): string {
  const lines = [`GOTONG_WECHAT_BOT_TOKEN=${outcome.botToken}`]
  if (outcome.baseUrl) lines.push(`GOTONG_WECHAT_BASE_URL=${outcome.baseUrl}`)
  return lines.join('\n') + '\n'
}

/** The stderr guidance after a successful login. */
export function renderSuccessHint(outcome: Extract<WechatLoginOutcome, { ok: true }>): string {
  return [
    `[wechat-login] ✅ 已连接微信 bot（bot=${outcome.botId}${outcome.userId ? `, 扫码人=${outcome.userId}` : ''}）。`,
    '',
    '上面两行是凭证（stdout）。让 Gotong 用上它：',
    '  1. 把它们加进 host 的环境（.env / systemd 环境文件），',
    '  2. 重启 host —— 启动日志会出现 "IM bridge enabled platform=wechat"，',
    '  3. 手机微信里给这个 bot 发 /bind <绑定码> 绑定你的成员账号。',
    '',
    '注意：令牌是 secret，别提交进 git / 贴进公开频道；微信侧只能被动回复——',
    '成员先开口，管家才能回话（提醒/审批会在你下次说话时补投）。',
  ].join('\n')
}

interface WechatLoginFlags {
  baseUrl?: string
  timeoutS?: number
  help?: boolean
}

/**
 * `gotong wechat-login [--base-url=URL] [--timeout=SECONDS]`.
 * Exit 0 = credentials printed · 1 = flow failed · 2 = bad usage.
 */
export async function wechatLogin(args: readonly string[]): Promise<number> {
  const flags = parseArgs(args)
  if (!flags) return 2
  if (flags.help) {
    printHelp('wechat-login')
    return 0
  }

  // Lazy imports keep `gotong help` instant and the install lean — the same
  // discipline `ping` applies to `ws`.
  const { createWechatIlinkClient } = await import('@gotong/im-wechat')
  const client = createWechatIlinkClient(flags.baseUrl ? { baseUrl: flags.baseUrl } : {})

  const outcome = await runWechatLoginFlow({
    client,
    showQr: showQrOnStderr,
    promptDigits: promptDigitsFromStdin,
    info: (line) => console.error(`[wechat-login] ${line}`),
    ...(flags.timeoutS !== undefined ? { timeoutMs: flags.timeoutS * 1000 } : {}),
  })

  if (!outcome.ok) {
    console.error(`[wechat-login] ✗ ${outcome.message}`)
    return 1
  }
  process.stdout.write(renderEnvLines(outcome))
  console.error(renderSuccessHint(outcome))
  return 0
}

/**
 * Terminal QR on stderr, with the link as the universal fallback (the
 * official plugin's exact posture: qrcode-terminal if it loads, URL always).
 */
async function showQrOnStderr(qrcodeImgUrl: string | undefined, attempt: number): Promise<void> {
  console.error(`[wechat-login] 用手机微信「扫一扫」扫描二维码（第 ${attempt} 张）：`)
  if (!qrcodeImgUrl) {
    console.error('[wechat-login] 服务器没有返回二维码链接——请重试。')
    return
  }
  try {
    const qrterm = await import('qrcode-terminal')
    await new Promise<void>((resolve) => {
      qrterm.default.generate(qrcodeImgUrl, { small: true }, (rendered: string) => {
        console.error(rendered)
        resolve()
      })
    })
  } catch {
    // No renderer — the link below is the whole fallback.
  }
  console.error(`[wechat-login] 扫不出来？在浏览器打开这个链接会显示同一张二维码：\n  ${qrcodeImgUrl}`)
}

/** Pairing digits from an interactive stdin; `null` when there is no TTY. */
async function promptDigitsFromStdin(message: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    for (;;) {
      const answer = (await rl.question(`[wechat-login] ${message} `)).trim()
      if (answer.length > 0) return answer
    }
  } finally {
    rl.close()
  }
}

function parseArgs(args: readonly string[]): WechatLoginFlags | null {
  const flags: WechatLoginFlags = {}
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      flags.help = true
    } else if (arg.startsWith('--base-url=')) {
      const v = arg.slice('--base-url='.length).trim()
      if (!/^https:\/\//.test(v)) {
        console.error('[wechat-login] --base-url 必须是 https:// 地址')
        return null
      }
      flags.baseUrl = v
    } else if (arg.startsWith('--timeout=')) {
      const n = Number(arg.slice('--timeout='.length))
      if (!Number.isInteger(n) || n < 30 || n > 3600) {
        console.error('[wechat-login] --timeout 必须是 30–3600 的整数秒')
        return null
      }
      flags.timeoutS = n
    } else if (arg.startsWith('-')) {
      console.error(`[wechat-login] 未知选项：${arg}`)
      return null
    } else {
      console.error(`[wechat-login] 多余参数：${arg}`)
      return null
    }
  }
  return flags
}
