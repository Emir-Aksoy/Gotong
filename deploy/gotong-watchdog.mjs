#!/usr/bin/env node
/**
 * gotong-watchdog.mjs — HEAL-M2 外部看门狗(systemd timer 每分钟拉起的 oneshot)。
 *
 * 只治「卡」:unit 自称 active 而 /healthz 连续 K 次不应答(超时/拒连/非 200)
 * 才 `systemctl restart`。三类近邻刻意不归它管:
 *   - 进程退出(「死」)= unit 模板里 `Restart=always` 的事,秒级比分钟级快;
 *   - 红黄牌(巡检 derivePatrolCards)= 重启治不了的病,重启只会抹掉现场;
 *   - 运维 `systemctl stop`(unit 非 active)= 有意停机,不数失败、绝不抢着拉起。
 *
 * 台账:与 hub 侧 self-heal-log.ts 共写同一份 `<space>/runtime/self-heal-log.jsonl`
 * (hub 记开机分类,看门狗记 restart/throttled;hub 死的时候只有看门狗在写,
 * 两个写入方天然错峰——唯一重叠是 hub 开机剪枝撞上看门狗追加,窗口极小,
 * 丢一行看门狗记录不丢分类能力,接受并记档)。行形状要能被 hub 的
 * parseSelfHealLines 读、被 restart_history/面板渲染——测试用真解析器钉死。
 *
 * 限流:每小时最多 N 次重启;打满后本轮故障只记一条 watchdog-throttled
 * (响亮但不刷屏),等人来。healthz 恢复即清零整段状态。
 *
 * 零依赖(node:fs/child_process + 全局 fetch):hub 的 node_modules 坏了/删了
 * 它也得能跑。状态文件 tmp+rename 原子写;root 跑时台账 chown 回数据目录
 * 属主(否则 hub 进程 append 会 EACCES)。
 */
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chownSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const USAGE = `用法: node gotong-watchdog.mjs --url <healthz 地址> --space <空间根> [--unit gotong.service]
  --url        hub 的 liveness 探针,如 http://127.0.0.1:3000/healthz
  --space      host 空间根(下面有 runtime/ 的那层;与 GOTONG_SPACE 解析结果一致,ls 确认)
  --unit       systemd unit 名(默认 gotong.service)
  --fails      连续失败几次才重启(默认 3)
  --max-restarts-per-hour  每小时重启上限(默认 3,打满只记账不再重启)
  --timeout-ms 单次探针超时毫秒(默认 10000)`

function parseArgs(argv) {
  const out = {
    url: null,
    space: null,
    unit: 'gotong.service',
    fails: 3,
    maxPerHour: 3,
    timeoutMs: 10_000,
  }
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]
    const v = argv[i + 1]
    if (v === undefined) return null
    if (k === '--url') out.url = v
    else if (k === '--space') out.space = v
    else if (k === '--unit') out.unit = v
    else if (k === '--fails') out.fails = Number(v)
    else if (k === '--max-restarts-per-hour') out.maxPerHour = Number(v)
    else if (k === '--timeout-ms') out.timeoutMs = Number(v)
    else return null
  }
  if (!out.url || !out.space) return null
  if (!Number.isInteger(out.fails) || out.fails < 1) return null
  if (!Number.isInteger(out.maxPerHour) || out.maxPerHour < 1) return null
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs < 1) return null
  return out
}

const log = (msg) => console.log(`[gotong-watchdog] ${msg}`)

// ── 状态文件(看门狗独占;hub 从不读写它) ────────────────────────────────
function readState(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw && typeof raw === 'object') {
      return {
        fails: Number.isInteger(raw.fails) && raw.fails >= 0 ? raw.fails : 0,
        restarts: Array.isArray(raw.restarts)
          ? raw.restarts.filter((t) => typeof t === 'number')
          : [],
        throttled: raw.throttled === true,
      }
    }
  } catch {
    /* 缺席/坏文件 → 全新状态(看门狗状态丢了顶多多探几轮,不值得响) */
  }
  return { fails: 0, restarts: [], throttled: false }
}

function writeState(file, state) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, file)
}

// ── 台账(与 hub 共写;行形状见 self-heal-log.ts 头注) ────────────────────
function appendLedger(runtimeDir, logFile, row) {
  appendFileSync(logFile, JSON.stringify(row) + '\n')
  // root 跑(systemd timer 默认)而数据目录属于服务用户时,把台账 chown 回去:
  // 一个 root 属主的 0644 文件会让 hub 进程的 append 当场 EACCES。
  try {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      const dir = statSync(runtimeDir)
      if (dir.uid !== 0) chownSync(logFile, dir.uid, dir.gid)
    }
  } catch {
    /* best-effort;chown 失败不挡重启 */
  }
}

async function probe(url, timeoutMs) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'manual' })
    return res.status === 200
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// systemctl 三态:0=active / 非零=不在跑(维护停机、崩溃间隙) / null=命令都没有。
function unitActive(unit) {
  const r = spawnSync('systemctl', ['is-active', '--quiet', unit], { stdio: 'ignore' })
  if (r.error) return null
  return r.status === 0
}

function journalTail(unit) {
  try {
    const r = spawnSync(
      'journalctl',
      ['-u', unit, '-n', '80', '--no-pager', '-o', 'short-iso'],
      { encoding: 'utf8', timeout: 15_000 },
    )
    if (r.error || typeof r.stdout !== 'string' || !r.stdout.trim()) return undefined
    // 只留尾巴:重启前最后的呼吸最有诊断价值,台账不做日志仓库。
    return r.stdout.slice(-6000)
  } catch {
    return undefined
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args) {
    console.error(USAGE)
    process.exit(2)
  }
  const runtimeDir = join(args.space, 'runtime')
  mkdirSync(runtimeDir, { recursive: true })
  const stateFile = join(runtimeDir, 'self-heal-watchdog-state.json')
  const logFile = join(runtimeDir, 'self-heal-log.jsonl')
  const state = readState(stateFile)

  const active = unitActive(args.unit)
  if (active === false) {
    // 有意停机(或崩溃后 systemd 自己正在处理):不是 liveness 事件,清计数走人。
    if (state.fails > 0 || state.throttled) writeState(stateFile, { ...state, fails: 0, throttled: false })
    log(`unit ${args.unit} 不在 active 态 — 不数失败不重启(维护停机归人管)`)
    return
  }

  if (await probe(args.url, args.timeoutMs)) {
    if (state.fails > 0 || state.throttled) {
      writeState(stateFile, { fails: 0, restarts: state.restarts, throttled: false })
    }
    log('ok')
    return
  }

  const fails = state.fails + 1
  if (fails < args.fails) {
    writeState(stateFile, { ...state, fails })
    log(`healthz 失败 ${fails}/${args.fails} — 还不到重启线`)
    return
  }

  const now = Date.now()
  const recent = state.restarts.filter((t) => now - t < 3_600_000)
  if (recent.length >= args.maxPerHour) {
    if (!state.throttled) {
      appendLedger(runtimeDir, logFile, {
        at: new Date(now).toISOString(),
        kind: 'watchdog-throttled',
        reason: 'restart-cap',
        restartsInLastHour: recent.length,
      })
    }
    writeState(stateFile, { fails, restarts: recent, throttled: true })
    log(`重启已打满 ${recent.length}/${args.maxPerHour} 每小时 — 只记账等人,不再重启`)
    return
  }

  // 先落账再重启:重启卡死也得留下「谁在几点为什么动的手」。
  appendLedger(runtimeDir, logFile, {
    at: new Date(now).toISOString(),
    kind: 'watchdog-restart',
    reason: 'healthz-fail',
    fails,
    ...(() => {
      const tail = journalTail(args.unit)
      return tail ? { journalTail: tail } : {}
    })(),
  })
  const r = spawnSync('systemctl', ['restart', args.unit], { stdio: 'inherit' })
  if (r.error) {
    log(`systemctl 不可用(${r.error.code ?? r.error.message}) — 账已记,重启没执行`)
    writeState(stateFile, { fails, restarts: recent, throttled: state.throttled })
    return
  }
  writeState(stateFile, { fails: 0, restarts: [...recent, now], throttled: false })
  log(`healthz 连续 ${fails} 次失败 — 已 systemctl restart ${args.unit}(本小时第 ${recent.length + 1} 次)`)
}

main().catch((err) => {
  // 看门狗自己绝不静默死:异常上 journal,exit 0 免得 timer 单元被标 failed 刷屏。
  console.error('[gotong-watchdog] 内部错误(本轮放弃):', err)
})
