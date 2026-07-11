#!/usr/bin/env node
/**
 * 真·两进程 跨 hub 端到端测试（L3/L4）。
 *
 * 仓库里已有 12 个 `*-ws-e2e` 测试，它们启两个真 Hub 对象、过一个真
 * WebSocketServer——但两个 Hub 跑在同一个 Node 进程里、共享内存。那一级
 * 证明了联邦「逻辑」，却证明不了真实部署形态：两个 **独立进程**、各自独立
 * 的 GOTONG_SPACE、各自独立的加密 vault、真的占两个端口、其中一个 **断电
 * 重启后从磁盘恢复 peer 记录并自动重拨**。这个脚本补那一级：spawn（或贴上）
 * 真的 `packages/host/dist/main.js` 生产二进制，像 FEDERATION-RUNBOOK 的
 * 两机操作那样登记 peer、跨真 socket 派活、跑真工作流、过审批闸、重启验证自愈。
 *
 * ── 五幕 ─────────────────────────────────────────────────────────────
 *   A. 握手 + 派活 + 回传    —— A 派一个 capability，解析到 B 的 peer wrapper，
 *      跨 socket 落到 B 的 agent，结果真的回传到 A。
 *   D. 多组织隔离            —— 未在 outboundCaps 里授权的能力，跨 hub 派活被
 *      拒；一条边的授权不外溢。
 *   E. 跨 hub 工作流状态机   —— 真 YAML 工作流（步 capability 落在对端）：
 *      ① 顺跑 run=done + 步 output 真来自对端 + executedBy=对端 id；
 *      ② 未授权能力步 run=failed（工作流层的隔离，不止裸派活层）。
 *   C. 重启自动重拨          —— 重启「可控的那一侧」：重启 B 证 A 退避重拨自
 *      愈；只有 A 可控时重启 A 证「本地电脑重启后从磁盘恢复 peer 记录重拨」。
 *      两侧都不可控（纯 attach 且无命令钩子）则显式 SKIP，绝不静默。
 *   B. 出站审批闸（含工作流挂起态）—— PATCH 边为需审批（走面板同款
 *      refreshPolicy 热重装，不重启进程）：① 裸派活 park 到 owner 收件箱，
 *      批准前零字节出门，批准后放行；② 工作流 run 停在 running + 步
 *      status='suspended'，批准后 run=done；③ 再跑一发拒绝，run=failed +
 *      步错误 outbound_approval_denied。收尾还原开关。
 *
 * 工作流 run 的「通用状态」全谱因此都有硬断言：
 *   done / failed(无参与者) / running+步suspended(挂起) / 批准续跑→done /
 *   拒绝→failed(outbound_approval_denied) / 对端宕机派活失败→重启自愈。
 *
 * ── 三种拓扑（每侧独立 attach-or-spawn）────────────────────────────────
 *   默认（零环境变量）     ：本机 spawn 两个进程 —— L3 回归门（也覆盖「同一台
 *                            vps 上两个 hub」：在那台 vps 上跑本脚本即是）。
 *   XHUB_A_URL+XHUB_B_URL ：两侧都贴已在跑的 hub —— 「不同 vps 之间」（或同
 *                            vps 已跑的两个 systemd 实例）。脚本零 spawn，纯
 *                            HTTP 驱动 + 结束 best-effort 清理自己造的行。
 *   只设 XHUB_B_URL       ：A 本机 spawn、B 贴远端 —— 「本地电脑 × vps」。
 *                            A 主动拨出，本地在 NAT 后也通（无需入站端口）。
 *
 * ── 环境变量 ──────────────────────────────────────────────────────────
 *   attach 侧（X ∈ A|B）：
 *     XHUB_X_URL        该侧 web 底址（http://host:port，owner 能到即可）
 *     XHUB_X_TOKEN      该侧 owner 的 aipk_ key（peer 登记要 owner 门）
 *     XHUB_B_WS_URL     B 的联邦 ws 地址【A 拨它，必填于 B attach】
 *     XHUB_X_STOP_CMD / XHUB_X_START_CMD   幕 C 命令钩子（如 ssh vps
 *                        'systemctl stop/start gotong'）；或
 *     XHUB_X_RESTART_CMD 单条重启命令（幕 C 只验「重启后自愈」，跳宕机段）
 *   spawn 侧：XHUB_X_SPACE / XHUB_X_WEB / XHUB_X_WS 覆盖目录与端口。
 *   夹具：XHUB_PROVISION=1 只起两台本机 host 并打印上述 attach 变量后驻留
 *         （Ctrl-C 结束）——本机彩排 attach 拓扑 / L4 演练用。
 *
 * 提示：attach 请指向**验收/新部署环境**。脚本会在两侧创建测试 peer 边、
 * mock agent、工作流（id 均带时间戳唯一化），结束时 best-effort 删除并还原
 * 改过的开关；复用已存在的边时要求它已授权 xhub-review，否则显式失败指路。
 *
 * 零真实 LLM：B 的 worker 用 `provider: 'mock'`（local-agent-pool 一等公民，
 * 无需 key、不计费），回确定的 `[mock reply to: …]`，所以每一幕都能硬断言。
 *
 *   用法：  node scripts/test-cross-hub-e2e.mjs        （从 repo root 跑）
 *   退出码：0 全绿 / 1 有断言失败或异常。
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

// ── 配置（每侧独立 attach-or-spawn）───────────────────────────────────
const STAMP = Date.now()
const S = STAMP.toString(36) // 唯一化后缀：多次跑同一验收环境不撞行
function sideCfg(name, defWeb, defWs) {
  const P = 'XHUB_' + name + '_'
  const url = process.env[P + 'URL']
  const cfg = {
    name,
    label: 'org' + name,
    attach: !!url,
    base: url ? url.replace(/\/+$/, '') : null, // spawn 侧就绪后回填
    token: process.env[P + 'TOKEN'] || null, //    spawn 侧 initSpace 回填
    hubId: null, //                                两种模式都在就绪后回填
    wsUrl: process.env[P + 'WS_URL'] || null, //   对端拨我用的地址
    space: process.env[P + 'SPACE'] || join(tmpdir(), `gotong-xhub-${name}-${STAMP}`),
    web: Number(process.env[P + 'WEB'] || defWeb),
    ws: Number(process.env[P + 'WS'] || defWs),
    stopCmd: process.env[P + 'STOP_CMD'] || null,
    startCmd: process.env[P + 'START_CMD'] || null,
    restartCmd: process.env[P + 'RESTART_CMD'] || null,
    host: null, // spawn 侧的进程句柄
  }
  if (!cfg.attach) {
    cfg.base = 'http://127.0.0.1:' + cfg.web
    if (!cfg.wsUrl) cfg.wsUrl = 'ws://127.0.0.1:' + cfg.ws
  }
  return cfg
}
const A = sideCfg('A', 3311, 4311)
const B = sideCfg('B', 3312, 4312)
const HOST_MAIN = resolve('packages/host/dist/main.js')
const CAP = 'xhub-review'
// 幕 D/E②用：B 的 worker 也覆盖它，但 A 的边**不授权**它——证明「B 有这能力 ≠ A
// 能跨界用它」，一条边的 outboundCaps 授权绝不外溢到 B 的其它能力。
const SECRET_CAP = 'xhub-secret'
const WORKER_ID = 'xhub-reviewer-' + S

// ── 断言 + 进程台账 ───────────────────────────────────────────────────
let failures = 0
let sceneFailures = 0
const procs = new Set()
// attach 侧清理台账：只清我们自己造的东西，只还原我们自己改的开关。
const undo = []

function check(label, ok, detail) {
  console.log((ok ? '  PASS' : '  FAIL') + '  ' + label + (detail && !ok ? '  -- ' + detail : ''))
  if (!ok) { failures++; sceneFailures++ }
}
function skip(label, why) { console.log('  SKIP  ' + label + '  -- ' + why) }
function scene(name) { console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(0, 56 - name.length))); sceneFailures = 0 }
function sceneEnd(name) { console.log(sceneFailures === 0 ? '  ' + name + ' 全绿' : '  ' + name + ' 有 ' + sceneFailures + ' 处失败') }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function fetchJson(url, opts = {}) {
  try {
    const r = await fetch(url, opts)
    let body = null
    try { body = await r.json() } catch { /* non-JSON */ }
    return { status: r.status, body }
  } catch (e) {
    return { status: 0, body: { error: String(e?.cause?.code ?? e?.message ?? e) } }
  }
}
function H(token) { return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }
async function pollUntil(fn, timeoutMs, everyMs, what) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('超时：' + what)
    await sleep(everyMs)
  }
}

// ── space 预置（spawn 侧：init + v4 owner api_key + 读 wire hubId）─────
// peer 登记要 owner role（v3 admin token 不够）。所以 spawn host 之前，先用
// identity store 直接造一个 v4 owner 并签发 aipk_ key——owner 既过 owner 门也
// 过 admin 门，全脚本一把 token 走到底。造完 close，host 再打开同一 sqlite。
async function initSpace(cfg) {
  const { Space } = await import('../packages/core/dist/index.js')
  const { openIdentityStore } = await import('../packages/identity/dist/index.js')
  mkdirSync(cfg.space, { recursive: true })
  const res = await Space.init(cfg.space, { name: cfg.label })
  if (!res.adminToken) await res.space.createAdmin('xhub-admin') // host 启动需一个管理员
  const meta = await res.space.meta()
  const identity = openIdentityStore({ dbPath: join(cfg.space, 'identity.sqlite') })
  try {
    const owner = identity.createUser({ email: `owner@${cfg.label}.local`, role: 'owner' })
    cfg.token = identity.issueApiKey({ userId: owner.id, label: 'xhub-e2e' }).key
  } finally {
    identity.close?.()
  }
  cfg.hubId = meta.hubId
}

// ── spawn / attach 一侧 ───────────────────────────────────────────────
// 联邦拓扑刻意用单向：A 主动 dial B，B 只接受入站（消费方连提供方；本地电脑
// 在 NAT 后也因此可用）。B 侧登记 A 只为入站认证，endpointUrl 指不可达端口，
// 避免双向 dial 每 tick 碰撞。
function spawnHost(cfg, extraEnv = {}) {
  const proc = spawn('node', [HOST_MAIN], {
    env: {
      ...process.env,
      GOTONG_SPACE: cfg.space,
      GOTONG_HOST: '127.0.0.1',
      GOTONG_WEB_PORT: String(cfg.web),
      GOTONG_WS_PORT: String(cfg.ws),
      GOTONG_PEER_POLL_MS: '1000', // 5s→1s：加速重拨 tick，让测试几秒内收敛
      GOTONG_ASSISTANT_PROVIDER: 'n', // workflow-assist mock，免 key
      GOTONG_OPEN_BROWSER: 'never',
      GOTONG_DEFAULT_LANG: 'zh',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logbuf = ''
  proc.stdout.on('data', (c) => { logbuf += c.toString() })
  proc.stderr.on('data', (c) => { logbuf += c.toString() })
  procs.add(proc)
  cfg.host = { proc, getLog: () => logbuf, cfg }
  return cfg.host
}

async function waitReady(cfg, ms = 60_000) {
  // 统一用 HTTP 探活（attach 侧只有这条路），顺手把 hubId 回填。
  await pollUntil(async () => {
    const r = await fetchJson(cfg.base + '/api/federation/self', { headers: H(cfg.token) })
    if (r.status === 200 && r.body?.hubId) { cfg.hubId = r.body.hubId; return true }
    return false
  }, ms, 500, cfg.label + ' 未就绪（GET /api/federation/self 不通或 token 不对）')
}

function killHost(host) {
  return new Promise((r) => {
    if (host.proc.exitCode !== null || host.proc.signalCode !== null) { procs.delete(host.proc); return r() }
    host.proc.once('exit', () => { procs.delete(host.proc); r() })
    host.proc.kill('SIGTERM')
    setTimeout(() => { try { host.proc.kill('SIGKILL') } catch { /* gone */ } }, 3000)
  })
}

function runCmd(cmd) {
  const r = spawnSync('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
  return { ok: r.status === 0, out: String(r.stdout || '') + String(r.stderr || '') }
}

function cleanupProcsAndSpaces() {
  for (const p of procs) { try { p.kill('SIGKILL') } catch { /* gone */ } }
  for (const cfg of [A, B]) {
    if (!cfg.attach) { try { rmSync(cfg.space, { recursive: true, force: true }) } catch { /* best-effort */ } }
  }
}

// attach 侧收尾：还原改过的开关、删自己造的行。逐条 best-effort，失败只打日志
// ——验收环境的残留要让操作员看见，不能静默吞。
async function runUndo() {
  for (const u of undo.reverse()) {
    try {
      const r = await u.fn()
      if (!r) console.log('  [清理] ' + u.what + ' —— 未成功，请手动检查')
    } catch (e) {
      console.log('  [清理] ' + u.what + ' —— 失败：' + String(e).slice(0, 120))
    }
  }
}

function dumpPeerLogs() {
  const pat = /peer|link|HELLO|dial|handshake|federation|token|reject|closed/i
  for (const cfg of [A, B]) {
    if (!cfg.host) continue
    console.log('  --- ' + cfg.label + ' peer/link 日志（尾 18 行）---')
    console.log(cfg.host.getLog().split('\n').filter((l) => pat.test(l)).slice(-18).map((l) => '    ' + l).join('\n'))
  }
}

// ── 工作流侧助手 ──────────────────────────────────────────────────────
const WF_OK = { id: 'xhub-flow-' + S, cap: 'xhub-start-' + S }
const WF_BAD = { id: 'xhub-fail-' + S, cap: 'xhub-failstart-' + S }
function wfYaml(wf, stepCap) {
  return [
    'schema: gotong.workflow/v1',
    'workflow:',
    '  id: ' + wf.id,
    '  name: ' + wf.id,
    '  trigger: { capability: ' + wf.cap + ' }',
    '  steps:',
    '    - id: review',
    '      dispatch:',
    '        strategy: { kind: capability, capabilities: [' + stepCap + '] }',
    '        payload: { doc: $trigger.payload.doc }',
    '',
  ].join('\n')
}
async function importWorkflow(wf, stepCap) {
  return fetchJson(A.base + '/api/admin/workflows/import', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + A.token, 'Content-Type': 'text/yaml' },
    body: wfYaml(wf, stepCap),
  })
}
async function listRunIds(wfId) {
  const r = await fetchJson(A.base + '/api/admin/workflows/runs?workflowId=' + encodeURIComponent(wfId), { headers: H(A.token) })
  return (r.body?.runs ?? []).map((x) => x.runId ?? x.id).filter(Boolean)
}
async function readRun(runId) {
  const r = await fetchJson(A.base + '/api/admin/workflows/runs/' + encodeURIComponent(runId), { headers: H(A.token) })
  return r.body?.run ?? null
}
/** 派发 trigger capability 开一个新 run，等它出现在 run 列表里，返回 runId。 */
async function triggerRun(wf, payload) {
  const before = new Set(await listRunIds(wf.id))
  await fetchJson(A.base + '/api/admin/dispatch', {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ strategy: { kind: 'capability', capabilities: [wf.cap] }, payload, title: wf.id, wait: false }),
  })
  return pollUntil(async () => (await listRunIds(wf.id)).find((id) => !before.has(id)) ?? null,
    20_000, 700, wf.id + ' 的新 run 出现')
}
/** 轮询 run 直到谓词满足（返回 run），或超时抛错。 */
function pollRun(runId, pred, what, timeoutMs = 40_000) {
  return pollUntil(async () => {
    const run = await readRun(runId)
    return run && pred(run) ? run : null
  }, timeoutMs, 900, what)
}
const stepOf = (run, id) => (run?.steps ?? []).find((s) => s.stepId === id)

// ── 收件箱助手（幕 B）：只碰我们这条边的审批项（prompt 里带我们的 cap）────
async function xhubInboxItems() {
  const r = await fetchJson(A.base + '/api/me/inbox', { headers: H(A.token) })
  return (r.body?.items ?? []).filter((x) => String(x.prompt ?? '').includes(CAP))
}
async function resolveItem(itemId, approved) {
  return fetchJson(A.base + '/api/me/inbox/' + itemId + '/resolve', {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ decision: { kind: 'approval', approved } }),
  })
}

// ── peer 登记（可复用已存在的边：验收环境反复跑不撞行）────────────────
async function ensurePeer(side, row) {
  let r = await fetchJson(side.base + '/api/admin/identity/peers', {
    method: 'POST', headers: H(side.token), body: JSON.stringify(row),
  })
  if (r.status === 200) {
    const id = r.body?.id ?? r.body?.peer?.id
    undo.push({ what: side.label + ' 删除测试 peer 行 ' + row.peerId, fn: async () => (await fetchJson(side.base + '/api/admin/identity/peers/' + id, { method: 'DELETE', headers: H(side.token) })).status === 200 })
    return { ok: true, id, created: true, row: r.body?.peer ?? r.body }
  }
  // 已存在（验收环境二跑 / 操作员已按 runbook 登记过）→ 复用，但要求它已授权 CAP。
  const list = await fetchJson(side.base + '/api/admin/identity/peers', { headers: H(side.token) })
  const rows = list.body?.peers ?? list.body ?? []
  const found = Array.isArray(rows) ? rows.find((p) => p.peerId === row.peerId) : null
  if (!found) return { ok: false, detail: JSON.stringify(r.body).slice(0, 200) }
  if (row.outboundCaps && !(found.outboundCaps ?? []).includes(CAP)) {
    return { ok: false, detail: '已存在的边未授权 ' + CAP + '——请先在面板给这条边加上该能力，或删除该行后重跑' }
  }
  console.log('  [复用] ' + side.label + ' 已存在 peer 行 ' + row.peerId + '（不改 token，不入清理台账）')
  return { ok: true, id: found.id, created: false, row: found }
}

// ── 幕 C：重启目标选择（谁可控重启谁；都不可控则显式 SKIP）─────────────
function restartability(cfg) {
  if (!cfg.attach) return 'proc'
  if (cfg.stopCmd && cfg.startCmd) return 'cmds'
  if (cfg.restartCmd) return 'restart-only'
  return null
}
async function stopSide(cfg, how) {
  if (how === 'proc') { await killHost(cfg.host); return true }
  return runCmd(cfg.stopCmd).ok
}
async function startSide(cfg, how) {
  if (how === 'proc') { spawnHost(cfg); await waitReady(cfg); return true }
  const ok = runCmd(cfg.startCmd).ok
  if (ok) await waitReady(cfg)
  return ok
}

// ── 夹具模式：只起两台本机 host，打印 attach 变量后驻留 ────────────────
async function provisionMode() {
  await initSpace(A)
  await initSpace(B)
  spawnHost(A); spawnHost(B)
  await Promise.all([waitReady(A), waitReady(B)])
  console.log('两台本机 host 已驻留（Ctrl-C 结束并清理）。attach 拓扑变量：\n')
  console.log('export XHUB_A_URL=' + A.base)
  console.log('export XHUB_A_TOKEN=' + A.token)
  console.log('export XHUB_B_URL=' + B.base)
  console.log('export XHUB_B_TOKEN=' + B.token)
  console.log('export XHUB_B_WS_URL=' + B.wsUrl)
  console.log('\n# 幕 C 命令钩子（可选——本机模拟「远端 systemctl stop/start」）：')
  console.log("export XHUB_B_STOP_CMD='lsof -ti tcp:" + B.ws + " -sTCP:LISTEN | xargs kill'")
  console.log("export XHUB_B_START_CMD='GOTONG_SPACE=" + B.space + ' GOTONG_HOST=127.0.0.1 GOTONG_WEB_PORT=' + B.web + ' GOTONG_WS_PORT=' + B.ws + " GOTONG_PEER_POLL_MS=1000 GOTONG_ASSISTANT_PROVIDER=n GOTONG_OPEN_BROWSER=never nohup node packages/host/dist/main.js >/dev/null 2>&1 &'")
  process.on('SIGINT', () => { cleanupProcsAndSpaces(); process.exit(0) })
  process.on('SIGTERM', () => { cleanupProcsAndSpaces(); process.exit(0) })
  // 兜底：任何退出路径（含未捕获异常）都不留孤儿 host——SIGKILL 父进程除外。
  process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL') } catch { /* gone */ } } })
  await new Promise(() => { /* 驻留 */ })
}

// ── 主流程 ────────────────────────────────────────────────────────────
async function main() {
  // spawn 侧跑的是生产二进制 dist（不是 src），要求工作区已构建——同 check:first-result 的前提。
  if ((!A.attach || !B.attach || process.env.XHUB_PROVISION) && !existsSync(HOST_MAIN)) {
    console.error('未找到 ' + HOST_MAIN + '——先在 repo root 跑一次 `pnpm build`（本门跑生产 dist）。')
    process.exit(1)
  }
  if (process.env.XHUB_PROVISION) return provisionMode()
  for (const cfg of [A, B]) {
    if (cfg.attach && !cfg.token) { console.error(cfg.label + ' 是 attach 模式但缺 XHUB_' + cfg.name + '_TOKEN（owner aipk_）'); process.exit(1) }
  }
  if (B.attach && !B.wsUrl) { console.error('B 是 attach 模式但缺 XHUB_B_WS_URL（A 要拨它的联邦 ws 地址）'); process.exit(1) }

  const topo = A.attach && B.attach ? 'attach×attach（两台已在跑的 hub，如不同 vps）'
    : !A.attach && B.attach ? 'A 本机 spawn × B attach（本地电脑 × vps）'
    : A.attach && !B.attach ? 'A attach × B 本机 spawn'
    : '本机双 spawn（L3 回归 / 同一台机上两个 hub）'
  console.log('真·两进程跨 hub e2e（L3/L4）  拓扑：' + topo)
  for (const cfg of [A, B]) {
    console.log('  ' + cfg.label + ': ' + (cfg.attach ? cfg.base + '（attach）' : cfg.space + '  web ' + cfg.web + ' / ws ' + cfg.ws))
  }

  if (!A.attach) await initSpace(A)
  if (!B.attach) await initSpace(B)
  if (!A.attach) spawnHost(A)
  if (!B.attach) spawnHost(B)
  await Promise.all([waitReady(A), waitReady(B)])
  console.log('  wire id — ' + A.label + '=' + A.hubId + '  ' + B.label + '=' + B.hubId)
  console.log('  两侧就绪（A 主动 dial，B 只入站认证不回拨）')

  // 跨 hub 派活：链路建立要 1-2 个 poll tick（attach 侧 host 默认 5s tick），
  // link_closed 多是「还没稳」，重试到拿到 B 的 mock 回执或用尽次数。
  async function crossDispatch(payload, cap = CAP, tries = 8) {
    let last = null
    for (let i = 0; i < tries; i++) {
      last = await fetchJson(A.base + '/api/admin/dispatch', {
        method: 'POST', headers: H(A.token),
        body: JSON.stringify({
          strategy: { kind: 'capability', capabilities: [cap] },
          payload, title: 'xhub', wait: true, timeoutMs: 20_000,
        }),
      })
      const s = JSON.stringify(last.body?.result ?? {})
      if (last.body?.ok && s.includes('[mock reply')) return last
      if (i < tries - 1) await sleep(3000)
    }
    return last
  }

  // ═══ 幕 A：握手 + 派活 + 回传 ═══════════════════════════════════════
  scene('幕 A — 握手 + 跨 socket 派活 + 结果回传')

  const T = randomBytes(32).toString('base64url') // 对称 per-peer token，两边各登记一次
  const pa = await ensurePeer(A, { peerId: B.hubId, endpointUrl: B.wsUrl, peerToken: T, outboundCaps: [CAP], kind: 'service' })
  check('A 登记（或复用）B 为出站 peer（授权能力 ' + CAP + '）', pa.ok, pa.detail)
  const peerRowB = pa.id // 幕 B 要 PATCH 这条边为「需审批」
  // 复用的边若本就开着「需审批」，先关掉让幕 A/E 顺跑，结束还原。
  if (pa.ok && !pa.created && pa.row?.requireApprovalOutbound) {
    await fetchJson(A.base + '/api/admin/identity/peers/' + peerRowB, { method: 'PATCH', headers: H(A.token), body: JSON.stringify({ requireApprovalOutbound: false }) })
    undo.push({ what: 'A 还原该边 requireApprovalOutbound=true', fn: async () => (await fetchJson(A.base + '/api/admin/identity/peers/' + peerRowB, { method: 'PATCH', headers: H(A.token), body: JSON.stringify({ requireApprovalOutbound: true }) })).status === 200 })
    console.log('  [复用] 该边原本需审批——测试期间临时关闭，结束还原')
  }

  // B 登记 A 只为「认得 A 的入站握手」（per-peer resolver 拒未登记 peer，绝不
  // fallback shared token）。endpointUrl 故意指不可达端口：B 有 A 的行能验入站，
  // 但不会回拨 A——本地电脑在 NAT 后正是这个形态。
  const pb = await ensurePeer(B, { peerId: A.hubId, endpointUrl: 'ws://127.0.0.1:59999', peerToken: T, kind: 'service' })
  check('B 登记（或复用）A 为入站 peer（同一 token，不回拨）', pb.ok, pb.detail)

  const ra = await fetchJson(B.base + '/api/admin/agents', {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ id: WORKER_ID, capabilities: [CAP, SECRET_CAP], displayName: 'XHub Reviewer', provider: 'mock', system: 'you review documents' }),
  })
  check('B 造一个覆盖 ' + CAP + ' + ' + SECRET_CAP + ' 的 mock worker', ra.status === 200, JSON.stringify(ra.body).slice(0, 200))
  if (ra.status === 200) undo.push({ what: 'B 删除测试 agent ' + WORKER_ID, fn: async () => (await fetchJson(B.base + '/api/admin/agents/' + WORKER_ID, { method: 'DELETE', headers: H(B.token) })).status === 200 })

  await sleep(3000) // 等首个 dial tick
  let r = await crossDispatch({ doc: 'hello from orgA' })
  check('A 跨 hub 派活拿到同步结果', r.status === 200 && r.body?.ok === true, JSON.stringify(r.body).slice(0, 300))
  const resA = JSON.stringify(r.body?.result ?? {})
  check('结果确实来自 B 的 mock agent（含 [mock reply）', resA.includes('[mock reply'), resA.slice(0, 240))
  check('结果标记由 ' + B.label + ' 执行（executedBy=' + B.hubId + '）', resA.includes(B.hubId), resA.slice(0, 240))
  if (sceneFailures > 0) dumpPeerLogs()
  sceneEnd('幕 A')

  // ═══ 幕 D：多组织隔离（一条边的授权不外溢）════════════════════════════
  scene('幕 D — 未授权能力被拒，边的授权不外溢')
  const rd = await fetchJson(A.base + '/api/admin/dispatch', {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({
      strategy: { kind: 'capability', capabilities: [SECRET_CAP] },
      payload: { doc: 'try the ungranted cap' }, title: 'xhub-secret', wait: true, timeoutMs: 8000,
    }),
  })
  const resD = JSON.stringify(rd.body?.result ?? rd.body ?? {})
  check('未授权能力跨 hub 派活被拒（非 ok 或无参与者）',
    rd.body?.ok !== true || /no_participant|no participant|unroutable|no_route|no candidate/i.test(resD), resD.slice(0, 240))
  check('B 绝没执行未授权能力（结果无 [mock reply）', !resD.includes('[mock reply'), resD.slice(0, 240))
  sceneEnd('幕 D')

  // ═══ 幕 E：跨 hub 工作流状态机（done / failed）════════════════════════
  scene('幕 E — 真工作流跨 hub 步：run=done 与 run=failed 两个终态')
  // ① 顺跑：步 capability 解析到对端 wrapper，run 应一路跑到 done，步 output
  //    真来自 B 的 mock agent，executedBy=B 的 hub id（Stream G 跨界真章）。
  let ri = await importWorkflow(WF_OK, CAP)
  check('导入跨 hub 工作流（步能力=' + CAP + '）', ri.status === 200 && ri.body?.ok === true, JSON.stringify(ri.body).slice(0, 200))
  undo.push({ what: 'A 删除测试工作流 ' + WF_OK.id, fn: async () => (await fetchJson(A.base + '/api/admin/workflows/' + WF_OK.id, { method: 'DELETE', headers: H(A.token) })).status === 200 })
  try {
    const runId = await triggerRun(WF_OK, { doc: 'wf-hello' })
    const done = await pollRun(runId, (x) => x.status === 'done' || x.status === 'failed', 'run 到终态')
    check('工作流 run 终态 = done', done.status === 'done', 'status=' + done.status + ' ' + JSON.stringify(done.steps ?? []).slice(0, 240))
    const st = stepOf(done, 'review')
    check('步 output 真来自对端 mock agent', JSON.stringify(st?.output ?? '').includes('[mock reply'), JSON.stringify(st ?? {}).slice(0, 240))
    check('步 executedBy = ' + B.hubId + '（跨 hub 真章）', st?.executedBy === B.hubId, 'executedBy=' + st?.executedBy)
  } catch (e) { check('工作流顺跑（done 路径）', false, String(e)) }
  // ② 失败终态：步 capability 未被这条边授权 → 无参与者可接 → run=failed。
  //    这是「工作流层」的隔离——幕 D 证的是裸派活层，这里证 runner 同样不越权。
  ri = await importWorkflow(WF_BAD, SECRET_CAP)
  check('导入未授权能力步的工作流（步能力=' + SECRET_CAP + '）', ri.status === 200 && ri.body?.ok === true, JSON.stringify(ri.body).slice(0, 200))
  undo.push({ what: 'A 删除测试工作流 ' + WF_BAD.id, fn: async () => (await fetchJson(A.base + '/api/admin/workflows/' + WF_BAD.id, { method: 'DELETE', headers: H(A.token) })).status === 200 })
  try {
    const runId = await triggerRun(WF_BAD, { doc: 'wf-secret' })
    const done = await pollRun(runId, (x) => x.status !== 'running', 'run 到终态')
    check('未授权步的 run 终态 = failed', done.status === 'failed', 'status=' + done.status)
    const st = stepOf(done, 'review')
    check('失败步没有对端产出（零字节越权）', !JSON.stringify(st?.output ?? '').includes('[mock reply'), JSON.stringify(st ?? {}).slice(0, 200))
  } catch (e) { check('工作流失败路径（failed 终态）', false, String(e)) }
  sceneEnd('幕 E')

  // ═══ 幕 C：重启自动重拨（peer 记录在磁盘，断电重启自愈）═══════════════
  scene('幕 C — 重启可控侧 → 断链检测 → 自动重拨自愈')
  const howB = restartability(B)
  const howA = restartability(A)
  if (howB === 'proc' || howB === 'cmds') {
    // 首选重启 B：证 A 的 PeerRegistry 检测断链、退避重拨、B 起来后自动重连。
    check('B 已停（' + (howB === 'proc' ? '杀本机进程' : 'STOP_CMD') + '）', await stopSide(B, howB))
    const rDown = await fetchJson(A.base + '/api/admin/dispatch', {
      method: 'POST', headers: H(A.token),
      body: JSON.stringify({ strategy: { kind: 'capability', capabilities: [CAP] }, payload: { doc: 'while B down' }, title: 'xhub', wait: true, timeoutMs: 6000 }),
    })
    check('B 宕机时跨 hub 派活确实失败', !JSON.stringify(rDown.body?.result ?? {}).includes('[mock reply'))
    // 同一 space 同端口重启 B。A 的 identity.peers 行还在，每 tick 重拨自动重连；
    // B 的 mock worker 也从磁盘恢复。
    check('B 已重启', await startSide(B, howB))
    await sleep(4000) // 给 A 的重拨 tick 收敛
    r = await crossDispatch({ doc: 'after B restart' }, CAP, 8)
    check('B 重启后 A 自动重连并跨 hub 派活跑通',
      r.body?.ok === true && JSON.stringify(r.body?.result ?? {}).includes('[mock reply'), JSON.stringify(r.body).slice(0, 300))
  } else if (howB === 'restart-only') {
    check('B 已重启（RESTART_CMD；宕机段无法分离，跳过宕机断言）', runCmd(B.restartCmd).ok)
    await waitReady(B)
    await sleep(4000)
    r = await crossDispatch({ doc: 'after B restart' }, CAP, 8)
    check('B 重启后 A 自动重连并跨 hub 派活跑通',
      r.body?.ok === true && JSON.stringify(r.body?.result ?? {}).includes('[mock reply'), JSON.stringify(r.body).slice(0, 300))
  } else if (howA === 'proc' || howA === 'cmds' || howA === 'restart-only') {
    // 只有 A 可控（典型：本地电脑 × 远端 vps）——重启 A 证「本地电脑重启后，
    // peer 行从磁盘恢复、开机自动重拨出去」，正是 laptop 重启的日常路径。
    if (howA === 'restart-only') {
      check('A 已重启（RESTART_CMD）', runCmd(A.restartCmd).ok)
    } else {
      check('A 已停（' + (howA === 'proc' ? '杀本机进程' : 'STOP_CMD') + '）', await stopSide(A, howA))
      const gone = await fetchJson(A.base + '/api/federation/self', { headers: H(A.token) })
      check('A 宕机时 API 确实不可达', gone.status !== 200)
      check('A 已重启', await startSide(A, howA))
    }
    await waitReady(A)
    await sleep(4000) // A 开机重拨
    r = await crossDispatch({ doc: 'after A restart' }, CAP, 8)
    check('A 重启后从磁盘恢复 peer 行、自动重拨、跨 hub 派活跑通',
      r.body?.ok === true && JSON.stringify(r.body?.result ?? {}).includes('[mock reply'), JSON.stringify(r.body).slice(0, 300))
  } else {
    skip('重启自愈', '两侧都是 attach 且未提供 XHUB_*_STOP_CMD/START_CMD（或 RESTART_CMD）——本拓扑无法安全重启任一侧；提供命令钩子（如 ssh vps systemctl restart gotong）后此幕自动启用')
  }
  if (sceneFailures > 0) dumpPeerLogs()
  sceneEnd('幕 C')

  // ═══ 幕 B：出站审批闸（裸派活 park + 工作流挂起/批准/拒绝三态）═════════
  scene('幕 B — 需审批的边：park→批准放行；工作流 suspended→done / 拒绝→failed')
  check('拿到 A 侧 B-peer 行 id 以便改为需审批', !!peerRowB, 'peer 登记未返回 id')
  // 面板同款热重装：PATCH gating 字段触发 refreshPolicy（teardown+按新行重拨），
  // 不重启进程——attach 拓扑下也因此可测。
  const rp = await fetchJson(A.base + '/api/admin/identity/peers/' + peerRowB, {
    method: 'PATCH', headers: H(A.token),
    body: JSON.stringify({ requireApprovalOutbound: true }),
  })
  check('A 把 A→B 边改为「出站需审批」（热重装，不重启）', rp.status === 200, JSON.stringify(rp.body).slice(0, 200))
  undo.push({ what: 'A 还原该边 requireApprovalOutbound=false', fn: async () => (await fetchJson(A.base + '/api/admin/identity/peers/' + peerRowB, { method: 'PATCH', headers: H(A.token), body: JSON.stringify({ requireApprovalOutbound: false }) })).status === 200 })
  await sleep(6000) // refreshPolicy 重拨 + 闸装配收敛（attach 侧 tick 默认 5s）

  // ① 裸派活：出站被闸拦，park 到 A owner 的 /me 收件箱（批准前零字节出门）。
  const rGate = await fetchJson(A.base + '/api/admin/dispatch', {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ strategy: { kind: 'capability', capabilities: [CAP] }, payload: { doc: 'needs approval' }, title: 'xhub-approve', wait: false }),
  })
  check('裸派活已受理（异步，等审批）', rGate.status === 200, JSON.stringify(rGate.body).slice(0, 200))
  try {
    const items = await pollUntil(async () => { const xs = await xhubInboxItems(); return xs.length >= 1 ? xs : null }, 20_000, 900, '收件箱出现审批项')
    check('批准前：A owner 收件箱出现待审批项', true)
    const itemId = items[0].itemId
    const rr = await resolveItem(itemId, true)
    check('批准该出站审批项', rr.status === 200, JSON.stringify(rr.body).slice(0, 200))
    await pollUntil(async () => !(await xhubInboxItems()).some((x) => x.itemId === itemId), 15_000, 900, '审批项消失')
    check('批准后：该待审批项已消失（任务已放行跨界）', true)
  } catch (e) { check('裸派活 park→批准 闭环', false, String(e)) }

  // ② 工作流挂起态：同一条需审批的边上跑幕 E 的工作流——run 应停在
  //    running + 步 status='suspended'（park 即挂起，重启也不丢的那份），
  //    批准后 run 一路到 done。
  try {
    const runId = await triggerRun(WF_OK, { doc: 'wf-approve' })
    const parked = await pollRun(runId, (x) => stepOf(x, 'review')?.status === 'suspended', '步进入 suspended')
    check('工作流 run 挂起：run=running + 步 status=suspended', parked.status === 'running', 'status=' + parked.status)
    check('挂起步已钉跨界去向（executedBy=' + B.hubId + '）', stepOf(parked, 'review')?.executedBy === B.hubId, JSON.stringify(stepOf(parked, 'review') ?? {}).slice(0, 200))
    const items = await pollUntil(async () => { const xs = await xhubInboxItems(); return xs.length >= 1 ? xs : null }, 15_000, 900, '工作流步的审批项出现')
    await resolveItem(items[0].itemId, true)
    const done = await pollRun(runId, (x) => x.status !== 'running', '批准后 run 到终态')
    check('批准后工作流续跑到 done，步 output 来自对端', done.status === 'done' && JSON.stringify(stepOf(done, 'review')?.output ?? '').includes('[mock reply'), 'status=' + done.status)
  } catch (e) { check('工作流 挂起→批准→done 闭环', false, String(e)) }

  // ③ 拒绝态：再跑一发，owner 拒绝——run 应到 failed，步错误注明
  //    outbound_approval_denied（拒绝是显式终态，不是静默吞掉）。
  try {
    const runId = await triggerRun(WF_OK, { doc: 'wf-deny' })
    const items = await pollUntil(async () => { const xs = await xhubInboxItems(); return xs.length >= 1 ? xs : null }, 20_000, 900, '拒绝场景的审批项出现')
    await resolveItem(items[0].itemId, false)
    const done = await pollRun(runId, (x) => x.status !== 'running', '拒绝后 run 到终态')
    check('拒绝后工作流 run=failed', done.status === 'failed', 'status=' + done.status)
    check('步错误注明 outbound_approval_denied', /outbound_approval_denied/.test(String(stepOf(done, 'review')?.error ?? '')), JSON.stringify(stepOf(done, 'review') ?? {}).slice(0, 200))
  } catch (e) { check('工作流 挂起→拒绝→failed 闭环', false, String(e)) }
  if (sceneFailures > 0) dumpPeerLogs()
  sceneEnd('幕 B')
}

main()
  .then(async () => {
    await runUndo()
    cleanupProcsAndSpaces()
    console.log('\n' + (failures ? failures + ' 处断言失败' : '全部断言通过'))
    process.exit(failures ? 1 : 0)
  })
  .catch(async (e) => {
    console.error('\n异常：', e)
    await runUndo().catch(() => { /* */ })
    cleanupProcsAndSpaces()
    process.exit(1)
  })
