/**
 * `gotong provision <pack.yaml> --url <hub> --token <admin> [--user <memberId>]`
 * — FDE-M3: 起完 hub 之后的「开荒」一条命令。装模板 → (可选)按模板的
 * `schedules[]` 建议补人建真调度 → 跑 pack 自带的黄金验收 → 出绿/黄/红
 * 开荒报告。之前这三段全是手工续段(浏览器里装、定时卡里建、验收卡里跑)。
 *
 * 立场与边界(全部沿用既有闸,不开新路):
 *   - 一切走 hub 的 admin HTTP API(Bearer token),CLI 不碰磁盘状态 —— 这
 *     条命令对远程 hub 与本机 hub 一视同仁,正是 FDE「部署/验收」段要的。
 *   - `--user` 只是把模板建议落成真调度行(POST 同一个 upsert);到点触发
 *     仍走成员闸(published + surface.me + role + 强制 scope key)——
 *     provision 做不出该成员自己做不到的事。不给 `--user` 就黄牌提醒。
 *   - 验收以「调用者(admin session)」身份跑,与验收卡同一条路;烧真
 *     token,所以给 `--skip-acceptance` 省跳。
 *
 * 出码(脚本可依赖):
 *   0 = 绿或仅黄(黄是提醒不是失败: 连接器未接/建议未补人/key 未配)
 *   1 = 用法错误 / pack 文件读不了
 *   2 = 装模板失败(解析拒绝 / HTTP 错 / 网络不通)
 *   3 = 装上了但没到位: 工作流落地失败 / 建调度失败 / 验收红
 */

import { readFile } from 'node:fs/promises'

import { printHelp } from './help.js'

/** Injectable seams so tests drive a real rig without capturing streams. */
export interface ProvisionDeps {
  fetchImpl?: typeof fetch
  readFileImpl?: (path: string) => Promise<string>
  out?: (line: string) => void
  err?: (line: string) => void
}

interface ProvisionFlags {
  file: string
  url: string
  token: string
  user?: string
  skipAcceptance: boolean
}

/** Parse args; string = usage error (printed by the caller). Exported for tests. */
export function parseProvisionArgs(args: readonly string[]): ProvisionFlags | string {
  let file: string | undefined
  let url: string | undefined
  let token: string | undefined
  let user: string | undefined
  let skipAcceptance = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--help' || a === '-h') return 'help'
    if (a === '--skip-acceptance') { skipAcceptance = true; continue }
    if (a === '--url' || a === '--token' || a === '--user') {
      const v = args[++i]
      if (!v || v.startsWith('--')) return `${a} 需要一个值`
      if (a === '--url') url = v
      else if (a === '--token') token = v
      else user = v
      continue
    }
    if (a.startsWith('--')) return `不认识的旗标: ${a}`
    if (file) return `只接受一个 pack 文件,收到第二个: ${a}`
    file = a
  }
  if (!file) return '缺 pack 文件路径(gotong.template/v1 YAML)'
  if (!url) return '缺 --url <hub 地址,如 http://127.0.0.1:8787>'
  if (!token) return '缺 --token <admin token>'
  return { file, url: url.replace(/\/+$/, ''), token, skipAcceptance, ...(user ? { user } : {}) }
}

/** Plain-text cadence for report lines (mirrors the admin card's wording). */
export function cadenceText(c: unknown): string {
  const o = (c ?? {}) as Record<string, unknown>
  if (o.kind === 'daily') return `每天 ${o.hour}:00`
  if (o.kind === 'weekly') return `每周${'日一二三四五六'[Number(o.weekday)] ?? o.weekday} ${o.hour}:00`
  if (o.kind === 'interval') return `每隔 ${Math.round(Number(o.everyMs) / 60000)} 分钟`
  return JSON.stringify(c)
}

interface ApiResult {
  status: number
  ok: boolean
  json: Record<string, unknown> | null
}

async function api(
  fetchImpl: typeof fetch,
  method: string,
  url: string,
  token: string,
  body?: unknown,
): Promise<ApiResult> {
  const res = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json: Record<string, unknown> | null = null
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    json = null
  }
  return { status: res.status, ok: res.ok, json }
}

const apiError = (r: ApiResult): string =>
  typeof r.json?.error === 'string' ? (r.json.error as string) : `HTTP ${r.status}`

export async function provision(
  args: readonly string[],
  deps: ProvisionDeps = {},
): Promise<number> {
  const out = deps.out ?? ((l: string) => { console.log(l) })
  const err = deps.err ?? ((l: string) => { console.error(l) })
  const fetchImpl = deps.fetchImpl ?? fetch
  const readFileImpl = deps.readFileImpl ?? ((p: string) => readFile(p, 'utf8'))

  const flags = parseProvisionArgs(args)
  if (flags === 'help') { printHelp('provision'); return 0 }
  if (typeof flags === 'string') {
    err(`[gotong provision] ${flags}`)
    printHelp('provision')
    return 1
  }

  let templateText: string
  try {
    templateText = await readFileImpl(flags.file)
  } catch (e) {
    err(`[gotong provision] 读不了 pack 文件 ${flags.file}: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }

  // The report: three buckets, printed at the end. 红 decides the exit code.
  const green: string[] = []
  const yellow: string[] = []
  const red: string[] = []

  // ① Install — the same import route the gallery button uses (parser rejects
  //    loudly: bad schedules[]/acceptance[]/connector blocks die HERE).
  let imp: ApiResult
  try {
    imp = await api(fetchImpl, 'POST', `${flags.url}/api/admin/templates/import`, flags.token, {
      template: templateText,
    })
  } catch (e) {
    err(`[gotong provision] 连不上 hub ${flags.url}: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
  if (!imp.ok) {
    err(`[gotong provision] 装模板被拒: ${apiError(imp)}`)
    return 2
  }
  const body = imp.json ?? {}
  const tpl = (body.template ?? {}) as Record<string, unknown>
  const pack = typeof tpl.name === 'string' ? tpl.name : flags.file
  const team = (body.team ?? {}) as { created?: unknown[]; skipped?: unknown[] }
  const wfRows = Array.isArray(body.workflows)
    ? (body.workflows as { id: string; ok: boolean; error?: string }[])
    : []
  const wfFailed = wfRows.filter((w) => !w.ok)
  const createdN = team.created?.length ?? 0
  const skippedN = team.skipped?.length ?? 0
  green.push(
    `装入模板「${pack}」: ${createdN} 个 agent 新建` +
      (skippedN > 0 ? ` (${skippedN} 个已存在,复用)` : '') +
      ` + ${wfRows.length - wfFailed.length} 条工作流`,
  )
  for (const w of wfFailed) red.push(`工作流 ${w.id} 落地失败: ${w.error ?? '未知原因'}`)

  const checklist = (body.postInstallChecklist ?? {}) as Record<string, unknown>
  for (const c of (checklist.connectorsToWire as { id?: string; optional?: boolean }[] | undefined) ?? []) {
    yellow.push(`连接器槽待接: ${c.id}${c.optional ? ' (可选)' : ''} — 「MCP」页把同名 server 接上`)
  }
  for (const kb of (checklist.kbSlotsToWire as { name?: string }[] | undefined) ?? []) {
    yellow.push(`知识库槽待接: ${kb.name}`)
  }
  for (const a of (checklist.agentsMissingKey as { id?: string; provider?: string }[] | undefined) ?? []) {
    yellow.push(`agent ${a.id} 还没配 ${a.provider} key — 「Agent」页或 env 补上`)
  }

  // ② Schedules — template suggestions become REAL rows only with --user
  //    (templates bring structure, never people). Without it: yellow.
  const suggestions =
    (checklist.scheduleSuggestions as
      | { workflowId: string; cadence: unknown; inputs?: Record<string, unknown>; note?: string }[]
      | undefined) ?? []
  for (const s of suggestions) {
    const label = `${s.workflowId} ${cadenceText(s.cadence)}`
    if (!flags.user) {
      yellow.push(`定时建议未补人: ${label} — 重跑加 --user <成员id>,或 admin「定时」卡补人启用`)
      continue
    }
    let sr: ApiResult
    try {
      sr = await api(fetchImpl, 'POST', `${flags.url}/api/admin/workflow-schedules`, flags.token, {
        workflowId: s.workflowId,
        userId: flags.user,
        cadence: s.cadence,
        ...(s.inputs !== undefined ? { inputs: s.inputs } : {}),
        enabled: true,
      })
    } catch (e) {
      red.push(`建调度失败: ${label} — ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    if (!sr.ok) {
      red.push(`建调度被拒: ${label} — ${apiError(sr)}`)
      continue
    }
    const sid = ((sr.json?.schedule ?? {}) as { id?: string }).id ?? '?'
    green.push(`定时已建: ${label} → ${flags.user} (${sid})`)
  }

  // ③ Acceptance — the pack's golden cases, run for real as the calling admin
  //    through the SAME gate as the workflows page's 「跑验收」. Burns tokens;
  //    that's the point of 开荒验收 (and why --skip-acceptance exists).
  const caseN = ((checklist.acceptanceCases as unknown[] | undefined) ?? []).length
  if (caseN > 0 && flags.skipAcceptance) {
    yellow.push(`跳过验收(--skip-acceptance): ${caseN} 条黄金用例没跑`)
  } else if (caseN > 0) {
    out(`[gotong provision] 跑验收: ${caseN} 条黄金用例(真实跑工作流,每条最多等 2 分钟)…`)
    let ar: ApiResult
    try {
      ar = await api(
        fetchImpl,
        'POST',
        `${flags.url}/api/admin/templates/acceptance/${encodeURIComponent(pack)}/run`,
        flags.token,
        {},
      )
    } catch (e) {
      red.push(`验收没跑起来: ${e instanceof Error ? e.message : String(e)}`)
      ar = { status: 0, ok: false, json: null }
    }
    if (ar.status === 503) {
      yellow.push('验收面未接线(host 没开 templateAcceptance)——用例装了,以后可在验收卡跑')
    } else if (!ar.ok && ar.status !== 0) {
      red.push(`验收失败: ${apiError(ar)}`)
    } else if (ar.ok) {
      const report = (ar.json?.report ?? {}) as {
        allGreen?: boolean
        results?: {
          caseId?: string
          verdict?: string
          reason?: string
          message?: string
          violations?: { kind?: string; message?: string }[]
        }[]
      }
      for (const r of report.results ?? []) {
        if (r.verdict === 'green') {
          green.push(`验收 ${r.caseId}: 通过`)
        } else {
          red.push(`验收 ${r.caseId}: ${r.reason ?? 'red'}${r.message ? ` — ${r.message}` : ''}`)
          for (const v of r.violations ?? []) red.push(`  · ${v.kind}: ${v.message}`)
        }
      }
    }
  }

  out('')
  out(`—— 开荒报告 · ${pack} ——`)
  for (const l of green) out(`[绿] ${l}`)
  for (const l of yellow) out(`[黄] ${l}`)
  for (const l of red) out(`[红] ${l}`)
  out(`结论: 绿 ${green.length} / 黄 ${yellow.length} / 红 ${red.length}`)
  if (red.length > 0) {
    out('装上了但还没到位——按上面红行修,然后重跑同一条命令(装模板是幂等的,已存在的 agent 会复用)。')
    return 3
  }
  if (yellow.length > 0) out('可用,但上面黄行补齐后才是完整体验。')
  else out('全绿,开箱即用。')
  return 0
}
