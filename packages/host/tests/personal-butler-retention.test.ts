/**
 * STOR-M3 — governed `set_retention` 闸与 ButlerRetentionOps 的合同测试。
 *
 * 镜像 personal-butler-config.test.ts(HANDS-M3c)的驱动形状。这里钉的四件事:
 *
 *   1. **参数空间封闭** — key 是 3 键闭集 enum、days 有界整数、reset 布尔、
 *      additionalProperties:false。这正是它进 `IM_APPROVABLE_TOOLS` 名单的
 *      理由(一行渲染结构上长不出来),所以 schema 与名单在同一个文件里被钉。
 *   2. **classify 顺序是策略** — 角色 → 键闭集 → days⊕reset 互斥 → 值域,与
 *      writeRetentionPolicy 的写前验逐字一致;角色排最前(参数再坏也先答角色,
 *      不给不够格的人当参数校验器用)。current() 读盘失败是装饰性缺一句,
 *      绝不从闸里炸出去(GovernedActionToolset.classify 对抛出不设 catch)。
 *   3. **describe 零自由文本回显** — 键不在闭集打「(未指定)」,敌意串一个
 *      字符也不进人的聊天窗(比 config 先例更严)。
 *   4. **execute 再问一遍角色** — park→批准之间可能被降权,批准补不回资格;
 *      真写走真 buildButlerRetentionOps 落真 retention.json + 审计行
 *      (metadata.kind='retention'),审计打嗝绝不变成写失败。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AUDIT_ACTIONS } from '@gotong/identity'
import { afterEach, describe, expect, it } from 'vitest'

import { IM_APPROVABLE_TOOLS } from '../src/personal-butler-escalation.js'
import {
  buildButlerRetentionOps,
  buildButlerRetentionToolset,
  type ButlerRetentionOps,
} from '../src/personal-butler-retention.js'
import { RETENTION_FILE, RETENTION_KEYS, loadRetentionPolicy } from '../src/space-retention.js'

const silentLogger = { warn: () => {} }

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function makeSpace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gotong-retention-tool-'))
  tempDirs.push(dir)
  return dir
}

/** classify/describe 单测用的假 ops——带 writes 收集器证「refuse = 零写」。 */
function fakeOps(over: Partial<ButlerRetentionOps> = {}): ButlerRetentionOps & { writes: unknown[] } {
  const writes: unknown[] = []
  return {
    writes,
    privileged: () => true,
    current: async () => null,
    write: async (input) => {
      writes.push(input)
      return input.reset ? {} : { [input.key]: input.days }
    },
    ...over,
  }
}

function toolset(ops: ButlerRetentionOps, userId = 'u-owner') {
  return buildButlerRetentionToolset({ userId, ops, logger: silentLogger })
}

/** 真 ops——真盘 + 审计收集器;e2e 那几例走它,不手搭第二份写路径。 */
function realOps(spaceDir: string, role: string | null | undefined, auditRows: unknown[]) {
  return buildButlerRetentionOps({
    spaceDir,
    membershipRole: () => role,
    audit: { writeAuditLog: (row) => void auditRows.push(row) },
    logger: silentLogger,
  })
}

describe('buildButlerRetentionOps', () => {
  it('privileged: owner/admin 是,member/viewer/无 membership 不是', async () => {
    const space = await makeSpace()
    for (const [role, want] of [
      ['owner', true],
      ['admin', true],
      ['member', false],
      ['viewer', false],
      [null, false],
      [undefined, false],
    ] as const) {
      const ops = realOps(space, role, [])
      expect(ops.privileged('u1'), `role=${String(role)}`).toBe(want)
    }
  })

  it('write(set) 真落 retention.json(pretty+换行),current() 读得回来', async () => {
    const space = await makeSpace()
    const ops = realOps(space, 'owner', [])
    const updated = await ops.write({ key: 'dossier_days', days: 90, userId: 'u1' })
    expect(updated).toEqual({ dossier_days: 90 })
    const raw = await readFile(join(space, RETENTION_FILE), 'utf8')
    expect(raw).toBe('{\n  "dossier_days": 90\n}\n')
    expect(await ops.current()).toEqual({ dossier_days: 90 })
    // loadRetentionPolicy 独立读同一份文件——写路径没有绕开阶梯读者的私有格式。
    expect(await loadRetentionPolicy(space, silentLogger)).toEqual({ dossier_days: 90 })
  })

  it('write(reset) 只移除那一个键,别的键原样留', async () => {
    const space = await makeSpace()
    const ops = realOps(space, 'owner', [])
    await ops.write({ key: 'dossier_days', days: 90, userId: 'u1' })
    await ops.write({ key: 'memory_archive_days', days: 60, userId: 'u1' })
    const updated = await ops.write({ key: 'dossier_days', reset: true, userId: 'u1' })
    expect(updated).toEqual({ memory_archive_days: 60 })
    expect(await loadRetentionPolicy(space, silentLogger)).toEqual({ memory_archive_days: 60 })
  })

  it('审计行:set 记 {kind, key, days},reset 记 {kind, key, reset},actorUserId 是写的人', async () => {
    const space = await makeSpace()
    const rows: any[] = []
    const ops = realOps(space, 'owner', rows)
    await ops.write({ key: 'departed_session_days', days: 180, userId: 'u-alice' })
    await ops.write({ key: 'departed_session_days', reset: true, userId: 'u-alice' })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      action: AUDIT_ACTIONS.SETTING_CONFIG_WRITE,
      actorSource: 'v4-session',
      actorUserId: 'u-alice',
      metadata: { kind: 'retention', key: 'departed_session_days', days: 180 },
      success: true,
    })
    expect(rows[1].metadata).toEqual({ kind: 'retention', key: 'departed_session_days', reset: true })
  })

  it('审计沉降口抛错不连累写:字节照落盘,write 不抛', async () => {
    const space = await makeSpace()
    const ops = buildButlerRetentionOps({
      spaceDir: space,
      membershipRole: () => 'owner',
      audit: {
        writeAuditLog: () => {
          throw new Error('audit disk on fire')
        },
      },
      logger: silentLogger,
    })
    const updated = await ops.write({ key: 'dossier_days', days: 45, userId: 'u1' })
    expect(updated).toEqual({ dossier_days: 45 })
    expect(await loadRetentionPolicy(space, silentLogger)).toEqual({ dossier_days: 45 })
  })
})

describe('set_retention 工具面与参数空间', () => {
  it('恰好一件工具,key 是闭集 enum,required=[key],additionalProperties:false', async () => {
    const tools = await toolset(fakeOps()).listTools()
    expect(tools).toHaveLength(1)
    const tool = tools[0]!
    expect(tool.name).toBe('set_retention')
    const schema = tool.inputSchema as {
      properties: Record<string, { type?: string; enum?: string[] }>
      required?: string[]
      additionalProperties?: boolean
    }
    expect([...(schema.properties.key!.enum ?? [])].sort()).toEqual([...RETENTION_KEYS].sort())
    expect(schema.properties.days!.type).toBe('integer')
    expect(schema.properties.reset!.type).toBe('boolean')
    expect(schema.required).toEqual(['key'])
    expect(schema.additionalProperties).toBe(false)
  })

  it('在 IM_APPROVABLE_TOOLS 名单里(参数空间封闭才配得上这一行)', () => {
    expect(IM_APPROVABLE_TOOLS.has('set_retention')).toBe(true)
  })

  it('工具描述把硬前置与边界说全:备份/git 快照、owner/admin、retention.json、收件箱', async () => {
    const tools = await toolset(fakeOps()).listTools()
    const desc = tools[0]!.description ?? ''
    expect(desc).toContain('备份')
    expect(desc).toContain('git 快照')
    expect(desc).toContain('owner/admin')
    expect(desc).toContain('retention.json')
    expect(desc).toContain('/me 收件箱')
    expect(desc).toContain('不会静默删')
  })
})

describe('classify', () => {
  it('角色排最前:不够格的人连参数校验都拿不到(参数刻意全坏)', async () => {
    const ops = fakeOps({ privileged: () => false })
    const v = await toolset(ops).classify('set_retention', { key: 'not-a-key', days: -1 })
    expect(v.decision).toBe('refuse')
    expect(v.reason).toBe('改内容保留策略只对 owner/admin 开放。')
  })

  it('空 key:refuse 并列出全部可改键', async () => {
    const v = await toolset(fakeOps()).classify('set_retention', {})
    expect(v.decision).toBe('refuse')
    expect(v.reason).toContain('要改哪一类?可改的只有:')
    for (const k of RETENTION_KEYS) expect(v.reason).toContain(k)
  })

  it('闭集外的键:refuse 带病名', async () => {
    const v = await toolset(fakeOps()).classify('set_retention', { key: 'transcript_days' })
    expect(v.decision).toBe('refuse')
    expect(v.reason).toContain('transcript_days 不是保留策略的键')
  })

  it('days 与 reset 同给:互斥 refuse', async () => {
    const v = await toolset(fakeOps()).classify('set_retention', { key: 'dossier_days', days: 90, reset: true })
    expect(v.decision).toBe('refuse')
    expect(v.reason).toContain('一次只做一件')
  })

  it('值域:29/3651/小数/乱字符串全 refuse 且回显原值,数字字符串 "90" 合法', async () => {
    const ts = toolset(fakeOps())
    for (const bad of [29, 3651, 90.5, 'abc'] as const) {
      const v = await ts.classify('set_retention', { key: 'dossier_days', days: bad })
      expect(v.decision, `days=${String(bad)}`).toBe('refuse')
      expect(v.reason).toContain('30-3650')
      expect(v.reason).toContain(`你给的是 ${JSON.stringify(bad)}`)
    }
    const missing = await ts.classify('set_retention', { key: 'dossier_days' })
    expect(missing.decision).toBe('refuse')
    expect(missing.reason).toContain('要移除这个键用 reset: true')
    // 模型很容易吐字符串数字——normDays 与写前验同宽。
    const str = await ts.classify('set_retention', { key: 'dossier_days', days: '90' })
    expect(str.decision).toBe('approve')
  })

  it('approve(set):人话标签+安全网前提+现状(没设)+落点与生效节律', async () => {
    const v = await toolset(fakeOps()).classify('set_retention', { key: 'dossier_days', days: 90 })
    expect(v.decision).toBe('approve')
    expect(v.reason).toContain('长任务翻篇档案')
    expect(v.reason).toContain('保留 90 天')
    expect(v.reason).toContain('已进最近一次全量备份或 git 快照')
    expect(v.reason).toContain('现在没设(这一类不自动删)')
    expect(v.reason).toContain('retention.json')
    expect(v.reason).toContain('约 6h')
    expect(v.reason).toContain('先请你确认')
  })

  it('approve(set) 现状在场:卡面写「现在是 45 天」', async () => {
    const ops = fakeOps({ current: async () => ({ dossier_days: 45 }) })
    const v = await toolset(ops).classify('set_retention', { key: 'dossier_days', days: 90 })
    expect(v.decision).toBe('approve')
    expect(v.reason).toContain('现在是 45 天')
  })

  it('approve(reset):说清「从此不自动删」', async () => {
    const ops = fakeOps({ current: async () => ({ memory_archive_days: 60 }) })
    const v = await toolset(ops).classify('set_retention', { key: 'memory_archive_days', reset: true })
    expect(v.decision).toBe('approve')
    expect(v.reason).toContain('知识库归档层')
    expect(v.reason).toContain('自动保留移除')
    expect(v.reason).toContain('从此不自动删')
  })

  it('current() 抛错:照样 approve(少一句现状),warn 落日志,绝不从闸里炸出去', async () => {
    const warns: string[] = []
    const ops = fakeOps({
      current: async () => {
        throw new Error('policy disk on fire')
      },
    })
    const gov = buildButlerRetentionToolset({
      userId: 'u-owner',
      ops,
      logger: { warn: (msg: string) => void warns.push(msg) },
    })
    const v = await gov.classify('set_retention', { key: 'dossier_days', days: 90 })
    expect(v.decision).toBe('approve')
    expect(v.reason).not.toContain('现在是')
    expect(v.reason).not.toContain('现在没设')
    expect(v.reason).toContain('先请你确认')
    expect(warns).toContain('butler retention: current-policy lookup failed')
  })
})

describe('describe — 一行读得全,零自由文本回显', () => {
  it('set 形态逐字', () => {
    expect(toolset(fakeOps()).describe('set_retention', { key: 'dossier_days', days: 90 })).toBe(
      '把内容保留策略 dossier_days 设为 90 天',
    )
  })

  it('敌意键打「(未指定)」,原串一个字符不出现', () => {
    const line = toolset(fakeOps()).describe('set_retention', { key: 'evil<script>alert(1)', days: 90 })
    expect(line).toBe('把内容保留策略 (未指定) 设为 90 天')
    expect(line).not.toContain('evil')
  })

  it('坏 days 打「(值不合法)」', () => {
    expect(toolset(fakeOps()).describe('set_retention', { key: 'dossier_days', days: 7 })).toBe(
      '把内容保留策略 dossier_days 设为 (值不合法) 天',
    )
  })

  it('reset 形态逐字', () => {
    expect(toolset(fakeOps()).describe('set_retention', { key: 'memory_archive_days', reset: true })).toBe(
      '移除内容保留策略 memory_archive_days(这一类不再自动删)',
    )
  })
})

describe('execute', () => {
  it('park→批准之间被降权:isError + 零写(批准补不回资格)', async () => {
    const ops = fakeOps({ privileged: () => false })
    const r = await toolset(ops).execute('set_retention', { key: 'dossier_days', days: 90 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('你现在不是 owner/admin,没有执行')
    expect(ops.writes).toHaveLength(0)
  })

  it('坏键/坏值在执行侧同样拒且零写', async () => {
    const ops = fakeOps()
    const badKey = await toolset(ops).execute('set_retention', { key: 'nope' })
    expect(badKey.isError).toBe(true)
    expect(badKey.text).toContain('没有改成:nope 不是保留策略的键')
    const emptyKey = await toolset(ops).execute('set_retention', {})
    expect(emptyKey.isError).toBe(true)
    expect(emptyKey.text).toContain('(空) 不是保留策略的键')
    const badDays = await toolset(ops).execute('set_retention', { key: 'dossier_days', days: 5 })
    expect(badDays.isError).toBe(true)
    expect(badDays.text).toContain('没有改成:days 不合法')
    expect(ops.writes).toHaveLength(0)
  })

  it('真 ops e2e:set 落盘+审计行+回执点名落点,reset 移除+回执说清后果', async () => {
    const space = await makeSpace()
    const rows: any[] = []
    const gov = toolset(realOps(space, 'owner', rows))

    const set = await gov.execute('set_retention', { key: 'dossier_days', days: 90 })
    expect(set.isError).toBeUndefined()
    expect(set.text).toContain('已把 dossier_days 设为 90 天')
    expect(set.text).toContain(`(写进了 ${RETENTION_FILE})`)
    expect(set.text).toContain('没进安全网的会跳过')
    expect(await loadRetentionPolicy(space, silentLogger)).toEqual({ dossier_days: 90 })

    const reset = await gov.execute('set_retention', { key: 'dossier_days', reset: true })
    expect(reset.isError).toBeUndefined()
    expect(reset.text).toContain('已移除 dossier_days')
    expect(reset.text).toContain('长任务翻篇档案')
    expect(reset.text).toContain('从此不自动删')
    // reset 留下的是合法的空策略 `{}`(不是删文件)——阶梯的 disarm 判定
    // (`RETENTION_KEYS.some(...)`)会把它当没有策略,space-retention.test.ts 另有钉。
    expect(await loadRetentionPolicy(space, silentLogger)).toEqual({})

    expect(rows).toHaveLength(2)
    expect(rows[0].metadata).toEqual({ kind: 'retention', key: 'dossier_days', days: 90 })
    expect(rows[1].metadata).toEqual({ kind: 'retention', key: 'dossier_days', reset: true })
  })

  it('写失败:isError 人话不带内部细节,warn 落日志', async () => {
    const warns: string[] = []
    const ops = fakeOps({
      write: async () => {
        throw new Error('EACCES: /srv/secret-host/retention.json')
      },
    })
    const gov = buildButlerRetentionToolset({
      userId: 'u-owner',
      ops,
      logger: { warn: (msg: string) => void warns.push(msg) },
    })
    const r = await gov.execute('set_retention', { key: 'dossier_days', days: 90 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('写不进去(磁盘或权限的问题)')
    expect(r.text).toContain('详细原因在服务器日志里')
    expect(r.text).not.toContain('/srv/secret-host')
    expect(warns).toContain('butler retention: policy write failed')
  })
})
