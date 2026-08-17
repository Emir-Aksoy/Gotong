/**
 * HANDS-M3c — `set_hub_config`:config-write 上手机(两步确认走 IMA)。
 *
 * 这道门守的三件事,按重要性排:
 *  ① **classify 是真规则的预检,不是第二套策略** —— 顺序逐字镜像 `applyEnvKnob`
 *     (密钥名 → 白名单 → 值校验)。两边一旦分叉,人就会为一件根本落不了盘的事
 *     花掉一次审批,而那正是「批准了」这三个字要买的东西。
 *  ② **写只有一处** —— execute 落的字节由 `runOpsCommand('config-set')` 写,和
 *     网页 owner / CLI 同一个咽喉、同一份审计 action。测试因此用**真 ops** 打真
 *     临时目录:断言的是盘上那一行,不是某个 mock 被调过。
 *  ③ **参数空间是封闭的** —— 四个具名旋钮 + 枚举/端口值。这不是文案短,是它长不
 *     出来;`IM_APPROVABLE_TOOLS` 收它的理由就是这条结构性事实,故这里把 schema
 *     的 enum 与 `ENV_KNOBS` 双向钉死:白名单加一项而 schema 没跟上(反之亦然),红。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ENV_KNOBS, OpsTierError, runOpsCommand } from '../src/ops-core.js'
import { IM_APPROVABLE_TOOLS } from '../src/personal-butler-escalation.js'
import {
  buildButlerConfigOps,
  buildButlerConfigToolset,
  type ButlerConfigKnobView,
  type ButlerConfigOps,
} from '../src/personal-butler-config.js'

const silentLogger = { warn: () => {} }

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gotong-butler-config-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 假 ops:classify/describe/execute 的单元测试不需要真盘。 */
function fakeOps(over: Partial<ButlerConfigOps> = {}): ButlerConfigOps & { sets: unknown[] } {
  const sets: unknown[] = []
  return {
    sets,
    privileged: () => true,
    knobs: async () => [],
    set: async (input) => {
      sets.push(input)
      return { lines: ['GOTONG_WEB_PORT=8080 (was unset)'] }
    },
    ...over,
  }
}

function toolset(ops: ButlerConfigOps, userId = 'u-owner') {
  return buildButlerConfigToolset({ userId, ops, logger: silentLogger })
}

const view = (over: Partial<ButlerConfigKnobView> = {}): ButlerConfigKnobView => ({
  key: 'GOTONG_WEB_PORT',
  summary: 'Admin UI / API port.',
  default: '3000',
  fileValue: null,
  envValue: null,
  ...over,
})

describe('HANDS-M3c — set_hub_config 工具面与参数空间', () => {
  it('只有一件工具,且它的 key 枚举 ≡ ENV_KNOBS(参数空间封闭 = IM 可批的理由)', async () => {
    const tools = await toolset(fakeOps()).listTools()
    expect(tools.map((t) => t.name)).toEqual(['set_hub_config'])

    const schema = tools[0]!.inputSchema as {
      properties: { key: { enum: string[] } }
      required: string[]
      additionalProperties: boolean
    }
    expect([...schema.properties.key.enum].sort()).toEqual([...ENV_KNOBS.map((k) => k.key)].sort())
    expect(schema.required.sort()).toEqual(['key', 'value'])
    // 自由文本字段进不来:多一个键都会让「一行读得全」的论证失效。
    expect(schema.additionalProperties).toBe(false)
  })

  it('在 IM 可批名单上(与工具真名逐字一致)', () => {
    expect(IM_APPROVABLE_TOOLS.has('set_hub_config')).toBe(true)
  })

  it('描述里点名 /setkey 与网页,把两类不走这里的东西指出去', async () => {
    const tools = await toolset(fakeOps()).listTools()
    const desc = tools[0]!.description ?? ''
    expect(desc).toContain('/setkey') // 凭证
    expect(desc).toMatch(/价格/) // config-price 仍在网页/CLI
  })
})

describe('HANDS-M3c — classify:真规则的预检', () => {
  it('不是 owner/admin ⇒ refuse(角色在最前,先于任何参数判断)', async () => {
    const gov = toolset(fakeOps({ privileged: () => false }))
    // 参数故意也是坏的:先答的必须是角色那句,不是「值不合法」。
    const v = await gov.classify('set_hub_config', { key: 'GOTONG_WEB_PORT', value: '99999' })
    expect(v.decision).toBe('refuse')
    expect(v.reason).toContain('owner/admin')
  })

  it('密钥名 ⇒ refuse 并指 /setkey(先于白名单,给的是「凭证不走这里」不是「不认识」)', async () => {
    const v = await toolset(fakeOps()).classify('set_hub_config', {
      key: 'GOTONG_TELEGRAM_BOT_TOKEN',
      value: 'aaa',
    })
    expect(v.decision).toBe('refuse')
    expect(v.reason).toContain('/setkey')
    expect(v.reason).not.toContain('不是可改的设置项')
  })

  it('白名单外 ⇒ refuse 并列出可改的四项', async () => {
    const v = await toolset(fakeOps()).classify('set_hub_config', { key: 'GOTONG_PROFILE', value: 'hub' })
    expect(v.decision).toBe('refuse')
    for (const k of ENV_KNOBS) expect(v.reason).toContain(k.key)
  })

  it('值不合法 ⇒ refuse 并回述你给的是什么(与 applyEnvKnob 同一个校验器)', async () => {
    const v = await toolset(fakeOps()).classify('set_hub_config', { key: 'GOTONG_WEB_PORT', value: '99999' })
    expect(v.decision).toBe('refuse')
    expect(v.reason).toContain('99999')
  })

  it('合法 ⇒ approve,卡面带归一化后的值 + 「下次重启」', async () => {
    const v = await toolset(fakeOps()).classify('set_hub_config', { key: 'GOTONG_WEB_PORT', value: ' 8080 ' })
    expect(v.decision).toBe('approve')
    expect(v.reason).toContain('8080')
    expect(v.reason).toContain('重启')
  })

  it('现值行:文件里有 ⇒ 说「现在是 X」;进程在用另一个 ⇒ 两个都说', async () => {
    const gov = toolset(fakeOps({ knobs: async () => [view({ fileValue: '3000', envValue: '9000' })] }))
    const v = await gov.classify('set_hub_config', { key: 'GOTONG_WEB_PORT', value: '8080' })
    expect(v.reason).toContain('现在配置文件里是 3000')
    expect(v.reason).toContain('当前进程在用 9000')
  })

  it('现值读不到 ⇒ 照样 approve,只是少一句(读失败绝不变成拒绝)', async () => {
    const gov = toolset(
      fakeOps({
        knobs: async () => {
          throw new Error('disk on fire')
        },
      }),
    )
    const v = await gov.classify('set_hub_config', { key: 'GOTONG_WEB_PORT', value: '8080' })
    expect(v.decision).toBe('approve')
    expect(v.reason).not.toContain('现在配置文件里是')
    expect(v.reason).not.toContain('disk on fire')
  })

  it('未知工具名 ⇒ refuse(fail-closed)', async () => {
    const v = await toolset(fakeOps()).classify('rm_rf_everything', {})
    expect(v.decision).toBe('refuse')
  })
})

describe('HANDS-M3c — describe:手机上那一行', () => {
  it('归一化后的值进标题(枚举/端口都印人要读的那个)', () => {
    const gov = toolset(fakeOps())
    expect(gov.describe('set_hub_config', { key: 'GOTONG_WEB_PORT', value: ' 8080 ' })).toBe(
      '把 hub 设置 GOTONG_WEB_PORT 改成 8080',
    )
  })

  it('一行装得下:最长的合法参数组合也远短于 IM 一行的 80 码点预算', () => {
    const gov = toolset(fakeOps())
    const longest = Math.max(
      ...ENV_KNOBS.map((k) => [...gov.describe('set_hub_config', { key: k.key, value: '65535' })].length),
    )
    expect(longest).toBeLessThan(80)
  })
})

describe('HANDS-M3c — execute:批准之后', () => {
  it('批准 ⇒ 原样把 key/value 交给唯一写咽喉,回执带「下次重启」', async () => {
    const ops = fakeOps()
    const r = await toolset(ops, 'u-42').execute('set_hub_config', { key: 'GOTONG_WEB_PORT', value: '8080' })
    expect(ops.sets).toEqual([{ key: 'GOTONG_WEB_PORT', value: '8080', userId: 'u-42' }])
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('重启')
  })

  it('park→批准之间被降权 ⇒ 不执行(批准补不回资格)', async () => {
    const ops = fakeOps({ privileged: () => false })
    const r = await toolset(ops).execute('set_hub_config', { key: 'GOTONG_WEB_PORT', value: '8080' })
    expect(r.isError).toBe(true)
    expect(ops.sets).toEqual([]) // 一个字节都没写
  })

  it('写失败 ⇒ 原文透传(ops-core 抛的那句就是给人看的)', async () => {
    const ops = fakeOps({
      set: async () => {
        throw new Error('GOTONG_WEB_PORT: must be an integer 1-65535')
      },
    })
    const r = await toolset(ops).execute('set_hub_config', { key: 'GOTONG_WEB_PORT', value: '8080' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('must be an integer 1-65535')
  })
})

describe('HANDS-M3c — 真 ops:字节真落盘,审计真记账', () => {
  const opsDeps = (over: Record<string, unknown> = {}) => ({
    ops: { spaceDir: root, env: {} as Record<string, string | undefined> },
    membershipRole: (uid: string) => (uid === 'u-owner' ? 'owner' : 'member'),
    logger: silentLogger,
    ...over,
  })

  it('privileged 只认 owner/admin', () => {
    const ops = buildButlerConfigOps(opsDeps())
    expect(ops.privileged('u-owner')).toBe(true)
    expect(ops.privileged('u-other')).toBe(false)
  })

  it('set 真写 <space>/gotong.env,并落一行 setting_config_write 审计', async () => {
    const rows: Record<string, unknown>[] = []
    const ops = buildButlerConfigOps(
      opsDeps({ audit: { writeAuditLog: (row: Record<string, unknown>) => rows.push(row) } }),
    )
    const out = await ops.set({ key: 'GOTONG_WEB_PORT', value: '8080', userId: 'u-owner' })

    expect(readFileSync(join(root, 'gotong.env'), 'utf8')).toContain('GOTONG_WEB_PORT=8080')
    expect(out.lines.join('\n')).toContain('GOTONG_WEB_PORT')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.action).toBe('setting_config_write')
    expect(rows[0]!.actorSource).toBe('v4-session')
    expect(rows[0]!.actorUserId).toBe('u-owner')
  })

  it('审计沉降口抛错 ⇒ 字节仍然算写成了(best-effort,不能倒过来变成写失败)', async () => {
    const ops = buildButlerConfigOps(
      opsDeps({
        audit: {
          writeAuditLog: () => {
            throw new Error('audit down')
          },
        },
      }),
    )
    await expect(ops.set({ key: 'GOTONG_WEB_PORT', value: '8080', userId: 'u-owner' })).resolves.toBeTruthy()
    expect(readFileSync(join(root, 'gotong.env'), 'utf8')).toContain('GOTONG_WEB_PORT=8080')
  })

  it('knobs 读的是 read-tier 同一条命令(盘上已有的值真的照出来)', async () => {
    writeFileSync(join(root, 'gotong.env'), 'GOTONG_WEB_PORT=8080\n')
    const ops = buildButlerConfigOps(opsDeps())
    const row = (await ops.knobs()).find((k) => k.key === 'GOTONG_WEB_PORT')
    expect(row?.fileValue).toBe('8080')
  })

  it('全新 hub(还没有 gotong.env)⇒ 不是错误,是「还没写过」+ 默认值', async () => {
    // 这一条钉的是 classify 卡面那句话的另一半分支:fileValue=null 时说「还没写过
    // (默认 X)」。空间目录压根不存在也走这条路——缺文件不是读失败。
    const ops = buildButlerConfigOps({
      ops: { spaceDir: join(root, 'nope', 'deeper'), env: {} },
      membershipRole: () => 'owner',
      logger: silentLogger,
    })
    const rows = await ops.knobs()
    expect(rows.map((r) => r.key).sort()).toEqual([...ENV_KNOBS.map((k) => k.key)].sort())
    expect(rows.every((r) => r.fileValue === null)).toBe(true)
    expect(rows.find((r) => r.key === 'GOTONG_WEB_PORT')?.default).toBe('3000')
  })
})

describe('HANDS-M3c — surface 是第四个面,不是新权限', () => {
  it("surface='butler' 但没带 allowConfigWrite ⇒ 照样拒(闸是那面旗标,不是面的名字)", async () => {
    await expect(
      runOpsCommand(
        'config-set',
        ['GOTONG_WEB_PORT', '8080'],
        { surface: 'butler', allowConfigWrite: false },
        { spaceDir: root, env: {} },
      ),
    ).rejects.toThrow(OpsTierError)
  })

  it('IM 命令台仍然 ✗,但指的是手机上走得通的那条路(不再让人去找电脑)', async () => {
    const err = await runOpsCommand(
      'config-set',
      ['GOTONG_WEB_PORT', '8080'],
      { surface: 'im', allowConfigWrite: false },
      { spaceDir: root, env: {} },
    ).catch((e: unknown) => e as Error)
    expect(err.message).toContain('/approve')
    expect(err.message).toContain('阿同')
  })

  it('config-price 不在这条路上(五个浮点数不适合手机录入)', async () => {
    const tools = await toolset(fakeOps()).listTools()
    const schema = tools[0]!.inputSchema as { properties: { key: { enum: string[] } } }
    expect(schema.properties.key.enum.some((k) => k.includes('PRICE'))).toBe(false)
  })
})
