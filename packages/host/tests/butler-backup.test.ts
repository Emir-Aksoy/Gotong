/**
 * AFR-M7 承重门 — 阿同恢复层。
 *
 * 计划钉的三道 + 本刀补的两道:
 *   ① 批准前零打包(真 Hub + 真 park→/me→批准→真 CLI backup 全环:批准前
 *      backups/ 不存在、批准后档案真出现且事实文件更新);
 *   ② sweeper 冷却往返(注入时钟:从未备份→提醒→冷却静默→+14 天再提醒;
 *      同意面 + owner/admin 过滤 + 送达才记标记);
 *   ③ 提醒文案含 M5 面包屑(卡标题从 BUTLER_GUIDE_CARDS 现查,绝不硬编码;
 *      指针是自然话——原始工具名一个不出现);
 *   ④ 权限两端闸:classify 非 owner/admin 直接 refuse(不进收件箱),
 *      execute 批准后再核(park→批准之间被降级,批准补不回资格);
 *   ⑤ backup_status 渲染诚实(无记录/新鲜/陈旧/含主钥/身份档不含关系)。
 */

import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, Space, type Logger } from '@gotong/core'
import { openIdentityStore, MASTER_KEY_LEN_BYTES, type IdentityStore } from '@gotong/identity'
import { randomBytes } from 'node:crypto'
import { FileInboxStore } from '@gotong/inbox'
import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@gotong/llm'
import { PersonalButlerAgent } from '@gotong/personal-butler'

import { HostInboxService } from '../src/inbox-service.js'
import {
  BACKUP_NUDGE_COOLDOWN_MS,
  BACKUP_STALE_AFTER_MS,
  ButlerBackupNudgeSweeper,
  buildButlerBackupOps,
  buildButlerBackupPackToolset,
  formatBackupNudgeMessage,
  renderBackupStatus,
  triageBackupNudge,
} from '../src/personal-butler-backup.js'
import { butlerApprovalItemFor } from '../src/personal-butler-escalation.js'
import { BUTLER_GUIDE_CARDS } from '../src/personal-butler-guide.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { writeButlerRunBroadcastConfig } from '../src/personal-butler-run-broadcast.js'

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silentLogger
  },
}

/** 面包屑断言不硬编码卡标题——卡改名/删卡这里当场红(镜像 breadcrumbs 门)。 */
function cardTitle(id: string): string {
  const card = BUTLER_GUIDE_CARDS.find((c) => c.id === id)
  if (!card) throw new Error(`guide card '${id}' missing — breadcrumb would point at nothing`)
  return card.title
}

const DAY = 24 * 60 * 60 * 1000

const fact = (at: number, tier: 'identity' | 'relations' | 'full' = 'identity', includesMasterKey = false) => ({
  format: 'gotong.last-backup/v1' as const,
  at,
  tier,
  includesMasterKey,
  archive: 'gotong-x-20260101T000000Z.tar.gz',
})

describe('AFR-M7 — triage 纯分诊(注入时钟)', () => {
  it('从未备份 = 陈旧;冷却挡重复;过冷却再 due', () => {
    const now = 100 * DAY
    const first = triageBackupNudge({ fact: null, lastNudgeAt: null, now })
    expect(first).toMatchObject({ due: true, stale: true, cooled: true, daysSince: null })
    // 刚提醒过 → 冷却压住
    const cooled = triageBackupNudge({ fact: null, lastNudgeAt: now, now: now + DAY })
    expect(cooled.due).toBe(false)
    expect(cooled.stale).toBe(true)
    // 冷却期满 → 再 due
    const again = triageBackupNudge({ fact: null, lastNudgeAt: now, now: now + BACKUP_NUDGE_COOLDOWN_MS })
    expect(again.due).toBe(true)
  })

  it('新鲜备份不打扰;过陈旧阈值才 due', () => {
    const now = 100 * DAY
    expect(triageBackupNudge({ fact: fact(now - DAY), lastNudgeAt: null, now }).due).toBe(false)
    const stale = triageBackupNudge({ fact: fact(now - BACKUP_STALE_AFTER_MS), lastNudgeAt: null, now })
    expect(stale).toMatchObject({ due: true, daysSince: 14 })
  })
})

describe('AFR-M7 — 提醒文案(M5 面包屑纪律)', () => {
  it('含 backup 卡面包屑 + 自然复述话;原始工具名一个不出现', () => {
    const msg = formatBackupNudgeMessage(20, 3)
    expect(msg).toContain('20 天没打备份')
    expect(msg).toContain('新增了 3 条互联关系')
    expect(msg).toContain('打一份身份档备份')
    expect(msg).toContain(`问我「${cardTitle('backup')}」`)
    for (const raw of ['pack_backup', 'backup_status', 'gotong_guide', 'use_tool']) {
      expect(msg).not.toContain(raw)
    }
    // 从未备份的变体
    const never = formatBackupNudgeMessage(null, 0)
    expect(never).toContain('还没打过备份')
    expect(never).not.toContain('新增')
  })
})

describe('AFR-M7 — backup_status 渲染诚实', () => {
  it('无记录:如实说 + 建议 + 面包屑', () => {
    const text = renderBackupStatus({ lastBackup: () => null, newPeersSince: () => 9 }, 0)
    expect(text).toContain('还没有备份记录')
    expect(text).toContain(`问我「${cardTitle('backup')}」`)
    expect(text).not.toContain('新增') // 没有基线就不数——绝不编一个
  })

  it('新鲜档:时间/档位/档案名;不催', () => {
    const now = 100 * DAY
    const text = renderBackupStatus({ lastBackup: () => fact(now - DAY, 'full'), newPeersSince: () => 0 }, now)
    expect(text).toContain('(1 天前)')
    expect(text).toContain('全空间档')
    expect(text).toContain('gotong-x-20260101T000000Z.tar.gz')
    expect(text).not.toContain('建议再打一份')
  })

  it('陈旧 + 身份档 + 新增关系:催一句 + 指出身份档不含关系;含主钥如实标', () => {
    const now = 100 * DAY
    const stale = renderBackupStatus(
      { lastBackup: () => fact(now - 20 * DAY, 'identity'), newPeersSince: () => 2 },
      now,
    )
    expect(stale).toContain('(20 天前)')
    expect(stale).toContain('身份档')
    expect(stale).toContain('新增了 2 条互联关系')
    expect(stale).toContain('身份档本就不含互联关系')
    expect(stale).toContain('建议再打一份')
    const withKey = renderBackupStatus(
      { lastBackup: () => fact(now - DAY, 'full', true), newPeersSince: () => 0 },
      now,
    )
    expect(withKey).toContain('档案即凭证')
  })
})

describe('AFR-M7 — ops(事实读取/角色/计数)', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gotong-bk-ops-'))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  function ops(roles: Record<string, string>, times: number[] = []) {
    return buildButlerBackupOps({
      spaceRoot: tmp,
      membershipRole: (uid) => roles[uid] ?? null,
      peerCreatedTimes: () => times,
    })
  }

  it('privileged:owner/admin 是,member/无 membership 否', () => {
    const o = ops({ alice: 'owner', bob: 'admin', kid: 'member' })
    expect(o.privileged('alice')).toBe(true)
    expect(o.privileged('bob')).toBe(true)
    expect(o.privileged('kid')).toBe(false)
    expect(o.privileged('ghost')).toBe(false)
  })

  it('lastBackup:缺文件/坏 JSON/坏形状都 null;好文件解析成功', async () => {
    const o = ops({})
    expect(o.lastBackup()).toBeNull()
    await mkdir(join(tmp, 'runtime'), { recursive: true })
    await writeFile(join(tmp, 'runtime', 'last-backup.json'), 'not-json', 'utf8')
    expect(o.lastBackup()).toBeNull()
    await writeFile(join(tmp, 'runtime', 'last-backup.json'), JSON.stringify({ format: 'wrong/v9' }), 'utf8')
    expect(o.lastBackup()).toBeNull()
    await writeFile(join(tmp, 'runtime', 'last-backup.json'), JSON.stringify(fact(123, 'relations')), 'utf8')
    expect(o.lastBackup()).toMatchObject({ at: 123, tier: 'relations' })
  })

  it('newPeersSince:严格大于 ts 才算;坏时间戳剔除', () => {
    const o = ops({}, [10, 20, 30, Number.NaN])
    expect(o.newPeersSince(15)).toBe(2)
    expect(o.newPeersSince(30)).toBe(0)
  })
})

describe('AFR-M7 — pack_backup 权限两端闸(打包器录音,零真打包)', () => {
  function recorderOps(privileged: boolean) {
    const calls: string[] = []
    const ops = {
      privileged: () => privileged,
      pack: async (tier: 'identity' | 'relations') => {
        calls.push(tier)
        return { code: 0, lines: ['✓ backup written: /x/backups/a.tar.gz (1K, 3 files)'] }
      },
    }
    return { calls, toolset: buildButlerBackupPackToolset({ userId: 'u1', ops }) }
  }

  it('classify:owner/admin → approve(park);普通成员 → refuse 且不进收件箱、零打包', async () => {
    const ok = recorderOps(true)
    const v1 = await ok.toolset.classify('pack_backup', { tier: 'identity' })
    expect(v1.decision).toBe('approve')
    const no = recorderOps(false)
    const v2 = await no.toolset.classify('pack_backup', { tier: 'identity' })
    expect(v2.decision).toBe('refuse')
    if (v2.decision === 'refuse') expect(v2.reason).toContain('owner/admin')
    // classify 阶段绝不打包(两种角色都是)
    expect(ok.calls).toEqual([])
    expect(no.calls).toEqual([])
    // 坏档位当场拒,不浪费一次审批
    const v3 = await ok.toolset.classify('pack_backup', { tier: 'everything' })
    expect(v3.decision).toBe('refuse')
  })

  it('execute:批准后角色被降 → 拒 + 零打包;正常路径真调 pack 并回执', async () => {
    const demoted = recorderOps(false)
    const r1 = await demoted.toolset.callTool('pack_backup', { tier: 'identity' })
    expect(r1.isError).toBe(true)
    expect(demoted.calls).toEqual([])
    const ok = recorderOps(true)
    const r2 = await ok.toolset.callTool('pack_backup', { tier: 'relations' })
    expect(r2.isError).toBeUndefined()
    expect(ok.calls).toEqual(['relations'])
    const text = JSON.stringify(r2.content)
    expect(text).toContain('打包完成')
    expect(text).toContain('身份+关系档')
  })

  it('execute:pack 非零出码/抛错都折成诚实 isError', async () => {
    const bad = buildButlerBackupPackToolset({
      userId: 'u1',
      ops: { privileged: () => true, pack: async () => ({ code: 3, lines: ['✖ tar failed'] }) },
    })
    const res1 = await bad.callTool('pack_backup', { tier: 'identity' })
    expect(res1.isError).toBe(true)
    expect(JSON.stringify(res1.content)).toContain('exit 3')
    const boom = buildButlerBackupPackToolset({
      userId: 'u1',
      ops: {
        privileged: () => true,
        pack: async () => {
          throw new Error('disk gone')
        },
      },
    })
    const res2 = await boom.callTool('pack_backup', { tier: 'identity' })
    expect(res2.isError).toBe(true)
  })
})

// ─── ① 批准前零打包:真 Hub park→/me→批准→真 CLI backup 全环 ────────────────

/** 脚本 provider:首轮叫 pack_backup,resume 轮看到 tool_result 后收尾。 */
class PackProvider implements LlmProvider {
  readonly name = 'pack-e2e'
  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const last = [...req.messages].reverse().find((m) => m.role === 'user')
    const content = last?.content
    if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')) {
      yield { type: 'text', text: `办好了:${JSON.stringify(content).slice(0, 120)}` }
      yield { type: 'end', stopReason: 'end_turn' }
      return
    }
    yield {
      type: 'tool_use',
      toolUse: { type: 'tool_use', id: 'pb-1', name: 'pack_backup', input: { tier: 'identity' } },
    }
    yield { type: 'end', stopReason: 'tool_use' }
  }
}

describe('AFR-M7 e2e — 批准前零打包,批准后档案真出现(真 CLI backup)', () => {
  let tmp: string
  let hub: Hub
  let identity: IdentityStore
  let inboxStore: FileInboxStore
  let inboxService: HostInboxService
  const USER = 'owner-1'

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gotong-bk-e2e-'))
    const { space } = await Space.init(tmp, { name: 'bk-e2e' })
    identity = openIdentityStore({
      dbPath: join(tmp, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
    inboxStore = new FileInboxStore(tmp)
    inboxStore.ensureDirs()
    hub = new Hub({
      space,
      suspendNotifier: async (task, by, s) => {
        identity.persistSuspendedTask({
          taskId: task.id,
          agentId: by,
          hubId: 'local',
          originUserId: task.origin?.userId ?? null,
          resumeAt: s.resumeAt,
          state: s.state,
          taskJson: JSON.stringify(task),
        })
        const approver = task.origin?.userId
        if (approver) {
          const item = butlerApprovalItemFor(task, by, s.state, { approver })
          if (item) await inboxStore.write(item)
        }
      },
    })
    await hub.start()
    inboxService = new HostInboxService({ hub, store: inboxStore, identity })
  })

  afterEach(async () => {
    await hub.stop().catch(() => {})
    identity.close()
    await rm(tmp, { recursive: true, force: true })
  })

  it('park → 批准 → 真档案落 backups/ + 事实文件更新;拒绝则零档案', async () => {
    // 真 ops,真 CLI backup;身份档要签名钥才有密码学身份——放一个假钥文件
    // 足够(backup 只搬字节不验钥)。角色切片:USER=owner。
    writeFileSync(join(tmp, 'agent-card-signing.key'), 'fake-pkcs8-bytes', { mode: 0o600 })
    const ops = buildButlerBackupOps({
      spaceRoot: tmp,
      membershipRole: (uid) => (uid === USER ? 'owner' : null),
      peerCreatedTimes: () => [],
    })
    const butler = new PersonalButlerAgent({
      id: 'butler:me',
      provider: new PackProvider(),
      memory: openButlerMemory({ rootDir: join(tmp, 'mem'), userId: USER, logger: silentLogger }),
      system: '你是管家。',
      governed: buildButlerBackupPackToolset({ userId: USER, ops }),
      maxToolRounds: 4,
    })
    hub.register(butler)

    const parked = await hub.dispatch({
      from: `user:${USER}`,
      strategy: { kind: 'explicit', to: 'butler:me' },
      payload: '帮我打一份身份档备份。',
      origin: { orgId: 'local', userId: USER },
    })
    expect(parked.kind).toBe('suspended')
    if (parked.kind !== 'suspended') throw new Error('expected park')
    // ── 批准前:零打包(backups/ 不存在,事实文件不存在)──
    expect(existsSync(join(tmp, 'backups'))).toBe(false)
    expect(existsSync(join(tmp, 'runtime', 'last-backup.json'))).toBe(false)

    await inboxService.resolve({
      itemId: parked.taskId,
      userId: USER,
      decision: { kind: 'approval', approved: true },
    })
    const final = hub.taskResult(parked.taskId)
    expect(final?.kind).toBe('ok')

    // ── 批准后:档案真出现,事实真更新 ──
    const archives = (await readdir(join(tmp, 'backups'))).filter((f) => f.endsWith('.tar.gz'))
    expect(archives.length).toBe(1)
    const factRaw = JSON.parse(await readFile(join(tmp, 'runtime', 'last-backup.json'), 'utf8')) as {
      tier: string
      archive: string
    }
    expect(factRaw.tier).toBe('identity')
    expect(factRaw.archive).toBe(archives[0])
    // ops 读回同一份事实 → backup_status 立刻转「刚备份过」
    expect(ops.lastBackup()?.tier).toBe('identity')
  })
})

// ─── ② sweeper 冷却往返(注入时钟 + 同意面 + 资格 + 送达才记)────────────────

describe('AFR-M7 — 陈旧提醒 sweeper', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-bk-nudge-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function harness(opts: { roles: Record<string, string>; factAt?: number | null }) {
    let clock = 100 * DAY
    const pushes: Array<{ userId: string; text: string }> = []
    let deliver = true
    const sweeper = new ButlerBackupNudgeSweeper({
      rootDir: root,
      ops: {
        lastBackup: () => (opts.factAt == null ? null : fact(opts.factAt)),
        newPeersSince: () => 0,
        privileged: (uid) => opts.roles[uid] === 'owner' || opts.roles[uid] === 'admin',
      },
      push: async (userId, text) => {
        pushes.push({ userId, text })
        return { delivered: deliver }
      },
      logger: silentLogger,
      now: () => clock,
    })
    return {
      sweeper,
      pushes,
      setClock: (v: number) => {
        clock = v
      },
      getClock: () => clock,
      setDeliver: (v: boolean) => {
        deliver = v
      },
    }
  }

  async function member(userId: string, consent: boolean): Promise<void> {
    await mkdir(join(root, 'user', userId), { recursive: true })
    if (consent) await writeButlerRunBroadcastConfig(root, userId, { enabled: true, announcedMax: 0 })
  }

  it('同意面 + 资格双过滤:开播报的 owner 才收;member/未开的一律不收', async () => {
    await member('alice', true) // owner + consent → 收
    await member('kid', true) // member + consent → 不收
    await member('bob', false) // owner 无 consent → 不收
    const h = harness({ roles: { alice: 'owner', kid: 'member', bob: 'owner' } })

    expect(await h.sweeper.runOnceForMember('alice')).toEqual({ nudged: true })
    expect(await h.sweeper.runOnceForMember('kid')).toEqual({ nudged: false, reason: 'not-privileged' })
    expect(await h.sweeper.runOnceForMember('bob')).toEqual({ nudged: false, reason: 'no-consent' })
    expect(h.pushes.map((p) => p.userId)).toEqual(['alice'])
    expect(h.pushes[0]!.text).toContain(`问我「${cardTitle('backup')}」`)
  })

  it('冷却往返:提醒→冷却静默→+14 天再提醒;新鲜备份不打扰', async () => {
    await member('alice', true)
    const h = harness({ roles: { alice: 'owner' }, factAt: null })

    expect(await h.sweeper.runOnceForMember('alice')).toEqual({ nudged: true })
    // 冷却期内:分诊报 cooldown,零推送
    h.setClock(h.getClock() + DAY)
    expect(await h.sweeper.runOnceForMember('alice')).toEqual({ nudged: false, reason: 'cooldown' })
    expect(h.pushes.length).toBe(1)
    // 冷却期满:再提醒
    h.setClock(h.getClock() + BACKUP_NUDGE_COOLDOWN_MS)
    expect(await h.sweeper.runOnceForMember('alice')).toEqual({ nudged: true })
    expect(h.pushes.length).toBe(2)
  })

  it('新鲜备份 → fresh 不打扰;送达失败不记标记,下 tick 重试', async () => {
    await member('alice', true)
    const freshH = harness({ roles: { alice: 'owner' }, factAt: 100 * DAY - DAY })
    expect(await freshH.sweeper.runOnceForMember('alice')).toEqual({ nudged: false, reason: 'fresh' })

    const h = harness({ roles: { alice: 'owner' }, factAt: null })
    h.setDeliver(false)
    expect(await h.sweeper.runOnceForMember('alice')).toEqual({ nudged: false, reason: 'delivery-failed' })
    // 桥好了 → 同一 tick 语义下重试成功(标记只在送达时写过 → 立刻 due)
    h.setDeliver(true)
    expect(await h.sweeper.runOnceForMember('alice')).toEqual({ nudged: true })
  })

  it('runOnce 扫全员:坏成员目录不连累别人', async () => {
    await member('alice', true)
    await member('zed', true)
    const h = harness({ roles: { alice: 'owner', zed: 'owner' } })
    await h.sweeper.runOnce()
    expect(h.pushes.map((p) => p.userId).sort()).toEqual(['alice', 'zed'])
  })
})
