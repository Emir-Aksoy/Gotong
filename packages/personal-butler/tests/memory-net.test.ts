/**
 * 跨店记忆网里那层**渲染**的门:`renderNetSheet`。
 *
 * 网与召回由 `memory-integration-bench.test.ts`(那把尺子)量;这里只钉渲染的
 * 三条契约,它们决定记忆单进不进得了提示词:
 *   ① 顺序听召回的,不自作主张重排 —— 排名是上一层辛苦挣来的,渲染不许打乱;
 *   ② 不认识的 id 静默跳过 —— 记忆单是渲染不是校验,一个陈旧 id 不该炸掉整页;
 *   ③ 每行标出处店名 —— 「这句话是哪儿来的」是跨店召回唯一新增的负担。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openIntegrationSpace, type IntegrationSpace } from '../src/memory-integration-benchmark.js'
import { buildMemoryNet, renderNetSheet, type MemoryNet } from '../src/memory-net.js'
import { INTEGRATION_NOW, INTEGRATION_SEED, INTEGRATION_USER } from './fixtures/integration-cases.js'

let space: IntegrationSpace
let net: MemoryNet
let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gotong-memory-net-'))
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

describe('记忆单', () => {
  it('顺序听召回的:换个入参顺序,渲染出来的行也跟着换', () => {
    const ids = ['memory:m-peanut', 'task:tn-1']
    const a = renderNetSheet(net, ids).split('\n')
    const b = renderNetSheet(net, [...ids].reverse()).split('\n')
    expect(a).toHaveLength(2)
    expect(b).toEqual([a[1], a[0]])
  })

  it('不认识的 id 静默跳过,认识的照渲染', () => {
    const sheet = renderNetSheet(net, ['memory:__不存在', 'memory:m-peanut', '压根不是个 id'])
    expect(sheet.split('\n')).toHaveLength(1)
    expect(sheet).toContain('花生')
  })

  it('每行标出处店名', () => {
    // 五个店各取一条:跨店召回唯一新增的负担就是「这句话是哪儿来的」。
    const ids = ['memory:m-peanut', 'task:tn-1', 'knowledge:garden/tomato.md', 'session:u-mei#0', 'dossier:weight-track#0']
    const lines = renderNetSheet(net, ids).split('\n')
    expect(lines).toHaveLength(5)
    for (const [i, store] of ['memory', 'task', 'knowledge', 'session', 'dossier'].entries()) {
      expect(lines[i]).toContain(store)
    }
  })

  it('没有一个 id 认得出来时给空串,不给一堆空行', () => {
    expect(renderNetSheet(net, ['memory:__a', 'task:__b'])).toBe('')
  })

  it('字节上限收口:超了就少给几行,不给半句话', () => {
    const ids = net.nodes.slice(0, 12).map((n) => n.id)
    const full = renderNetSheet(net, ids)
    const capped = renderNetSheet(net, ids, { maxBytes: 200 })
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(200)
    expect(capped.length).toBeLessThan(full.length)
    // 留下的每一行都必须是完整的原文,不能被腰斩。
    for (const line of capped.split('\n')) expect(full.split('\n')).toContain(line)
  })
})
