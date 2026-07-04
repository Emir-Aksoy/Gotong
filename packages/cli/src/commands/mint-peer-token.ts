/**
 * `gotong mint-peer-token` — generate a cryptographically strong bearer
 * token for a federation peer link.
 *
 * Two Gotong hubs that federate share ONE secret per direction: hub A
 * stores it as the outbound token it presents to B, and B stores the
 * SAME string as the inbound token it expects from A (compared with
 * `timingSafeEqual` over in `@gotong/transport-ws`). This command only
 * mints that string — 256 bits from the OS CSPRNG, base64url so it drops
 * cleanly into a JSON / env / Authorization value with no escaping.
 *
 * Output discipline (mirrors `connect`): the token alone goes to stdout
 * so it pipes / copy-pastes cleanly; the pairing hint goes to stderr.
 * Nothing here touches identity state — minting is pure; registering the
 * token against a peer is a separate admin action (the "对端" UI or the
 * POST /api/admin/identity/peers route). Keeping mint stateless means it
 * needs no workspace, no master key, no running hub.
 */

import { randomBytes } from 'node:crypto'

import { printHelp } from './help.js'

const DEFAULT_BYTES = 32
const MIN_BYTES = 16
const MAX_BYTES = 64

interface MintFlags {
  bytes?: number
  peerId?: string
  endpoint?: string
  help?: boolean
}

/**
 * Mint a base64url token from `bytes` of CSPRNG output (no padding).
 * Pure + exported so tests can assert the format / entropy directly
 * without capturing process streams.
 */
export function generatePeerToken(bytes: number = DEFAULT_BYTES): string {
  return randomBytes(bytes).toString('base64url')
}

/**
 * Human-readable pairing instructions for stderr. Pure so tests pin the
 * symmetric-setup wording without spying on streams. When a peerId /
 * endpoint is supplied they slot into the snippet; otherwise obvious
 * placeholders keep the example shape but signal "fill me in".
 */
export function renderPairingHint(
  opts: { peerId?: string; endpoint?: string } = {},
): string {
  const peer = opts.peerId ?? '<peer-id>'
  const url = opts.endpoint ?? '<wss://their-hub/federation>'
  return [
    `[mint-peer-token] 已生成对端令牌 (256-bit)。联邦是对称的 — 同一字符串两边各登记一次:`,
    ``,
    `  本机 → 出站到 ${peer}: 在「对端」里添加 peer`,
    `    peerId=${peer}  endpointUrl=${url}  peerToken=<上面那行令牌>`,
    ``,
    `  ${peer} → 入站接受本机: 把同一令牌登记为它期望本机出示的 token`,
    ``,
    `令牌是 secret — 走安全信道交给对端管理员, 不要提交进 git / 贴进公开频道。`,
  ].join('\n')
}

/**
 * `gotong mint-peer-token [--bytes=N] [--peer-id=ID] [--endpoint=URL]`.
 * Exit 0 on a printed token, 2 on bad input.
 */
export function mintPeerToken(args: readonly string[]): number {
  const flags = parseArgs(args)
  if (!flags) return 2
  if (flags.help) {
    printHelp('mint-peer-token')
    return 0
  }
  const token = generatePeerToken(flags.bytes ?? DEFAULT_BYTES)
  // Token alone on stdout (pipeable: `gotong mint-peer-token > t.txt`);
  // the setup hint never pollutes that stream.
  process.stdout.write(token + '\n')
  console.error(renderPairingHint({ peerId: flags.peerId, endpoint: flags.endpoint }))
  return 0
}

function parseArgs(args: readonly string[]): MintFlags | null {
  const flags: MintFlags = {}
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      flags.help = true
    } else if (arg.startsWith('--bytes=')) {
      const n = Number(arg.slice('--bytes='.length))
      if (!Number.isInteger(n) || n < MIN_BYTES || n > MAX_BYTES) {
        console.error(`[mint-peer-token] --bytes 必须是 ${MIN_BYTES}–${MAX_BYTES} 的整数`)
        return null
      }
      flags.bytes = n
    } else if (arg.startsWith('--peer-id=')) {
      flags.peerId = arg.slice('--peer-id='.length)
    } else if (arg.startsWith('--endpoint=')) {
      flags.endpoint = arg.slice('--endpoint='.length)
    } else if (arg.startsWith('-')) {
      console.error(`[mint-peer-token] 未知选项：${arg}`)
      return null
    } else {
      console.error(`[mint-peer-token] 多余参数：${arg}`)
      return null
    }
  }
  return flags
}
