/**
 * 记忆单探针的门(M2c)。
 *
 * 这个探针唯一的权力是「往提示词尾巴上加字」,所以门量的就是**什么时候不加**:
 *
 *   ① **静默契约**:没问题 / 没网 / 召不到 / 渲染为空 —— 四种空手都必须 `null`,
 *      因为 `null` 才等于「提示词与没接这个探针时逐字节相同」。加了字就得指得回
 *      一条召回,这是可证伪性,不是省钱。
 *   ② **顾问姿态**:网抛异常一律吞掉。一次读盘失败不该把正常聊天带下水。
 *   ③ **读到的问题必须和模型看到的是同一句**:三种 payload 形状照抄
 *      `LlmAgent.buildRequest` 的翻译,读错了记忆单就在答另一道题。
 *   ④ **每行带出处 + 预算真收口**。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Task } from '@gotong/core'

import { openIntegrationSpace, type IntegrationSpace } from '../src/memory-integration-benchmark.js'
import { buildMemoryNet, type MemoryNet } from '../src/memory-net.js'
import { buildMemorySheetProbe, MEMORY_SHEET_HEADER } from '../src/memory-sheet-probe.js'
import { INTEGRATION_NOW, INTEGRATION_SEED, INTEGRATION_USER } from './fixtures/integration-cases.js'

let space: IntegrationSpace
let net: MemoryNet
let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gotong-sheet-probe-'))
  space = await openIntegrationSpace({
    dir: join(dir, 'space'),
    userId: INTEGRATION_USER,
    now: () => INTEGRATION_NOW,
    seed: INTEGRATION_SEED,
  })
  net = await buildMemoryNet(space)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 一个只带 payload 的最小任务信封。 */
function task(payload: unknown): Task {
  return {
    id: 't-1',
    from: 'u-mei',
    strategy: { kind: 'direct', to: 'butler' },
    payload,
    createdAt: INTEGRATION_NOW,
  } as unknown as Task
}

const liveNet = async (): Promise<MemoryNet> => net

describe('① 静默契约', () => {
  it('取不出问题 ⇒ null', async () => {
    const probe = buildMemorySheetProbe({ net: liveNet })
    for (const p of [undefined, null, 42, '', '   ', {}, { prompt: '  ' }, { messages: [] }]) {
      expect(await probe(task(p))).toBeNull()
    }
  })

  it('没网 / 空网 ⇒ null', async () => {
    expect(await buildMemorySheetProbe({ net: async () => null })(task('我对什么过敏'))).toBeNull()
    const empty = { nodes: [], edges: [] }
    expect(await buildMemorySheetProbe({ net: async () => empty })(task('我对什么过敏'))).toBeNull()
  })

  it('问了但一条都召不到 ⇒ null', async () => {
    const probe = buildMemorySheetProbe({ net: liveNet })
    // 与这份空间毫无字面交集的一问:两条臂都没信号 ⇒ 空页 ⇒ 静默。
    expect(await probe(task('zzqqxx'))).toBeNull()
  })

  it('预算小到一行都放不下 ⇒ null,不许只贴一个光杆抬头', async () => {
    const probe = buildMemorySheetProbe({ net: liveNet, maxBytes: 1 })
    expect(await probe(task('我对什么过敏'))).toBeNull()
  })
})

describe('② 顾问姿态', () => {
  it('取网抛异常 ⇒ 吞掉返 null,并记一条 warn', async () => {
    const warns: string[] = []
    const probe = buildMemorySheetProbe({
      net: async () => {
        throw new Error('盘炸了')
      },
      logger: { warn: (m) => warns.push(m) },
    })
    expect(await probe(task('我对什么过敏'))).toBeNull()
    expect(warns).toHaveLength(1)
  })
})

describe('③ 读到的问题就是模型看到的那句', () => {
  const probe = buildMemorySheetProbe({ net: liveNet })

  it('裸字符串 payload', async () => {
    expect(await probe(task('我对什么过敏'))).toContain('花生')
  })

  it('payload.prompt', async () => {
    expect(await probe(task({ prompt: '我对什么过敏' }))).toContain('花生')
  })

  it('payload.messages 的最后一条 user(不是第一条)', async () => {
    const sheet = await probe(
      task({
        messages: [
          { role: 'user', content: '番茄开花以后多久施一次肥' },
          { role: 'assistant', content: '好的' },
          { role: 'user', content: '我对什么过敏' },
        ],
      }),
    )
    // 读成第一条就会召回番茄那一支 —— 这两问的答案在不同的店,分得开。
    expect(sheet).toContain('花生')
    expect(sheet).not.toContain('番茄')
  })

  it('prompt 优先于 messages(与 buildRequest 的优先级一致)', async () => {
    const sheet = await probe(
      task({ prompt: '我对什么过敏', messages: [{ role: 'user', content: '番茄开花以后多久施一次肥' }] }),
    )
    expect(sheet).toContain('花生')
  })
})

describe('④ 记忆单的形状', () => {
  it('抬头在最前,每行带出处店名', async () => {
    const probe = buildMemorySheetProbe({ net: liveNet })
    const sheet = (await probe(task('咖啡机出水慢要怎么处理')))!
    const lines = sheet.split('\n')
    expect(lines[0]).toBe(MEMORY_SHEET_HEADER)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines.slice(1)) expect(line).toMatch(/^- \[[^\]]+\] /)
    // 这一问的答案本来就不在记忆店 —— 记忆单必须真把别的店端上来。
    expect(sheet).toContain('knowledge')
  })

  it('行数上限收口,且上限数的是真实行数', async () => {
    const probe = buildMemorySheetProbe({ net: liveNet, k: 6, maxLines: 2 })
    const sheet = (await probe(task('我的体重最近怎么变化的')))!
    expect(sheet.split('\n')).toHaveLength(1 + 2)
  })
})
