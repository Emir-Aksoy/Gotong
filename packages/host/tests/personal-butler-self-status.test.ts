/**
 * SEN-M3 承重门 — `my_status` 自我状态一卡。
 *
 * Pins the four contracts that make the self-check honest:
 *
 *   1. fixed six-line card — every fragment dep is optional and degrades to its
 *      OWN line (「(未接)」/「(读取失败)」); one dead fragment never blanks the
 *      other five, and absence is rendered, never skipped (honest-unknown);
 *   2. reuse discipline — outage headline / cost format / backup tier label all
 *      come from their owning modules (never re-implemented), and the usage
 *      line says 累计, NEVER 今日 (the ledger aggregate has no day boundary);
 *   3. privacy red line — memory renders COUNTS only; entry content structurally
 *      cannot reach the text (the reader slice doesn't even declare it);
 *   4. tool posture — one tool, unknown name refused, render failure isError.
 */

import { describe, expect, it } from 'vitest'

import {
  buildButlerSelfStatusToolset,
  renderSelfStatus,
  type ButlerSelfStatusDeps,
} from '../src/personal-butler-self-status.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000

const SECRET = '用户的私密纪念日是 1999-12-31' // must never surface

/** All six fragments wired and healthy-ish — the full-card fixture. */
function fullDeps(overrides: Partial<ButlerSelfStatusDeps> = {}): ButlerSelfStatusDeps {
  return {
    userId: 'u1',
    llms: {
      listForButler: async () => [
        { index: 0, role: 'primary', label: 'anthropic', model: 'claude-x', health: 'healthy' },
        { index: 1, role: 'fallback', label: 'deepseek', model: null, health: 'healthy' },
      ],
    },
    health: () => ({ snapshot: async () => ({ llmOutage: null }) }),
    usage: {
      aggregateForUser: () => [
        { key: 'anthropic:claude-x', calls: 10, inputTokens: 100, outputTokens: 50, costMicros: 30_000 },
        { key: 'deepseek', calls: 2, inputTokens: 10, outputTokens: 5, costMicros: 4_500 },
      ],
    },
    memory: {
      read: async () => ({
        profile: [{ text: SECRET }, { text: 'b' }],
        recent: [{ text: SECRET }],
        lastDream: { firedAt: NOW - 2 * DAY, promoted: 3, pruned: 1 },
      }),
    },
    notebook: {
      list: async () => [
        { status: 'open' },
        { status: 'done' },
        { status: 'open' },
        { status: 'dropped' },
      ],
    },
    backup: { lastBackup: () => ({ format: 'gotong.last-backup/v1', at: NOW - 3 * DAY, tier: 'identity', includesMasterKey: false, archive: 'a.tar.gz' }) },
    now: () => NOW,
    ...overrides,
  }
}

describe('SEN-M3 — renderSelfStatus(六块碎片拼图)', () => {
  it('full card: six lines, each fragment rendered with its real facts', async () => {
    const out = await renderSelfStatus(fullDeps())

    expect(out).toContain('我的状态(阿同自检):')
    expect(out).toContain('- 大脑:主选 anthropic(claude-x),健康;候选链共 2 个,全部健康')
    expect(out).toContain('- 断供:无')
    expect(out).toContain('- 累计用量:12 次调用,约 $0.0345')
    expect(out).toContain('- 记忆:长期 2 条,近期 1 条;上次蒸馏 2 天前(提升 3 条,封存 1 条)')
    expect(out).toContain('- 手上任务:进行中 2 件') // done/dropped 不算
    expect(out).toContain('- hub 备份:上次 3 天前(身份档)')
  })

  it('all deps absent → six lines all render 「(未接)」, never a crash or a skipped row', async () => {
    const out = await renderSelfStatus({ userId: 'u1', now: () => NOW })
    const lines = out.split('\n')
    expect(lines).toHaveLength(7) // header + 6 fixed rows
    expect(lines.filter((l) => l.endsWith('(未接)'))).toHaveLength(6)
  })

  it('one fragment throwing degrades ONLY its line — the other five stay intact', async () => {
    const out = await renderSelfStatus(
      fullDeps({ memory: { read: async () => { throw new Error('disk') } } }),
    )
    expect(out).toContain('- 记忆:(读取失败)')
    expect(out).toContain('- 大脑:主选 anthropic(claude-x)') // neighbours unharmed
    expect(out).toContain('- hub 备份:上次 3 天前')
  })

  it('大脑: empty roster / degraded candidates (+list_my_llms pointer) / single sick primary', async () => {
    const empty = await renderSelfStatus(fullDeps({ llms: { listForButler: async () => [] } }))
    expect(empty).toContain('- 大脑:还没有配置到我头上的模型')

    const degraded = await renderSelfStatus(
      fullDeps({
        llms: {
          listForButler: async () => [
            { index: 0, role: 'primary', label: 'anthropic', model: null, health: 'healthy' },
            { index: 1, role: 'fallback', label: 'groq', model: null, health: 'open', errorKind: 'auth' },
          ],
        },
      }),
    )
    expect(degraded).toContain('- 大脑:主选 anthropic,健康;候选链共 2 个,1 个降级/熔断中(细节可查 list_my_llms)')

    const solo = await renderSelfStatus(
      fullDeps({
        llms: {
          listForButler: async () => [
            { index: 0, role: 'primary', label: 'anthropic', model: null, health: 'open' },
          ],
        },
      }),
    )
    expect(solo).toContain('- 大脑:主选 anthropic,熔断中;无备用候选')
  })

  it('断供 three states: field absent → 未接断供监测 / null → 无 / row → minutes + headline', async () => {
    const noField = await renderSelfStatus(fullDeps({ health: () => ({ snapshot: async () => ({}) }) }))
    expect(noField).toContain('- 断供:(未接断供监测)')

    const down = await renderSelfStatus(
      fullDeps({
        health: () => ({ snapshot: async () => ({ llmOutage: { kind: 'auth', since: NOW - 45 * MIN } }) }),
      }),
    )
    expect(down).toContain('- 断供:断供中约 45 分钟')
    expect(down).not.toContain('- 断供:无')

    // Unknown kind prints the raw code (outageHeadline guard), never crashes.
    const weird = await renderSelfStatus(
      fullDeps({
        health: () => ({ snapshot: async () => ({ llmOutage: { kind: 'martian', since: NOW - MIN } }) }),
      }),
    )
    expect(weird).toContain('martian')
  })

  it('用量 honesty: the line says 累计 and never claims 今日 (the aggregate has no day boundary)', async () => {
    const out = await renderSelfStatus(fullDeps())
    expect(out).toContain('累计用量')
    expect(out).not.toContain('今日')
    expect(out).not.toContain('今天')

    const none = await renderSelfStatus(fullDeps({ usage: { aggregateForUser: () => [] } }))
    expect(none).toContain('- 累计用量:还没有用量记录')
  })

  it('记忆 privacy red line: counts only — entry content never reaches the text; no-dream honest', async () => {
    const out = await renderSelfStatus(fullDeps())
    expect(out).not.toContain(SECRET)
    expect(out).not.toContain('1999-12-31')

    const noDream = await renderSelfStatus(
      fullDeps({ memory: { read: async () => ({ profile: [], recent: [] }) } }),
    )
    expect(noDream).toContain('- 记忆:长期 0 条,近期 0 条;还没跑过蒸馏')
  })

  it('备份: never backed up → honest nudge; fresh fact → relative age + tier label', async () => {
    const never = await renderSelfStatus(fullDeps({ backup: { lastBackup: () => null } }))
    expect(never).toContain('- hub 备份:从未打过(建议至少打一份身份档)')

    const fresh = await renderSelfStatus(
      fullDeps({
        backup: {
          lastBackup: () => ({ format: 'gotong.last-backup/v1', at: NOW - 30_000, tier: 'relations', includesMasterKey: false, archive: 'b.tar.gz' }),
        },
      }),
    )
    expect(fresh).toContain('- hub 备份:上次 刚刚(身份+关系档)')
  })

  it('手上任务: zero open → honest empty line', async () => {
    const out = await renderSelfStatus(
      fullDeps({ notebook: { list: async () => [{ status: 'done' }] } }),
    )
    expect(out).toContain('- 手上任务:没有进行中的任务')
  })
})

describe('SEN-M3 — buildButlerSelfStatusToolset(工具姿态)', () => {
  const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
    r.content.map((c) => c.text ?? '').join('\n')

  it('lists exactly my_status; description names no directory tool', () => {
    const tools = buildButlerSelfStatusToolset({ userId: 'u1' }).listTools()
    expect(tools.map((t) => t.name)).toEqual(['my_status'])
    // 防漂移:schema 描述绝不点名目录工具(渲染文本点名 list_my_llms 是
    // 另一回事——LSA-M1 先例,目录内部互指)。
    for (const banned of ['list_my_llms', 'hub_health', 'backup_status', 'gotong_guide']) {
      expect(tools[0]!.description).not.toContain(banned)
    }
  })

  it('normal call returns the rendered card', async () => {
    const out = await buildButlerSelfStatusToolset(fullDeps()).callTool('my_status', {})
    expect(out.isError).toBeUndefined()
    expect(textOf(out)).toContain('我的状态(阿同自检):')
  })

  it('unknown tool name → typed refusal', async () => {
    const r = await buildButlerSelfStatusToolset({ userId: 'u1' }).callTool('rm_rf', {})
    expect(r.isError).toBe(true)
  })

  it('injected now throwing → friendly isError, warn logged, no crash', async () => {
    const warns: string[] = []
    const r = await buildButlerSelfStatusToolset({
      userId: 'u1',
      now: () => { throw new Error('clock broke') },
      logger: { warn: (m) => { warns.push(m) } },
    }).callTool('my_status', {})
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('暂时读不到')
    expect(warns.some((w) => w.includes('render failed'))).toBe(true)
  })
})
