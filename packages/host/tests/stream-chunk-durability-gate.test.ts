/**
 * 防腐门:`chunkDeservesDisk` 的白名单必须对 `LlmStreamChunk` 那个联合**逐个
 * 点名**。
 *
 * 白名单的方向是刻意的:provider 哪天发明一种新的高频片段(思考流、音频),
 * 它不该悄悄开始填满磁盘。代价是这条规则的镜像——一种新的**动作型**片段会
 * 被静默丢掉,而那正是 A③ 自己犯过的错(它把 `tool_use` 跟 `text` 一起丢了,
 * 而它的理由只覆盖了 `text`)。同一个形状不该在同一个仓库里发生两次,所以这
 * 道门把「有人往联合里加了一种片段」从一次静默的丢失变成一次红灯。
 *
 * 门为什么读源码文本:类型在运行期是不存在的,枚举不出联合成员。这与
 * `sdui-ui-contract.test.ts`(web 读 personal-butler 源码文本核组件闭集)、
 * `builtin-mcp-connectors` 那族同一姿态。
 *
 * 它住在 host 而不是 core:判据在 `@gotong/core`、联合在 `@gotong/llm`,而
 * core **不许**依赖 llm(内核依赖方向门)。host 同时依赖两者,是唯一能把两半
 * 摆在一起对拍的地方。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { chunkDeservesDisk } from '@gotong/core'

const LLM_TYPES = fileURLToPath(new URL('../../llm/src/types.ts', import.meta.url))

/**
 * 每一种流片段的落盘裁决。**加一个条目就是做一次决定**——把一种新片段写进
 * 这张表的人,必须先回答「它是不是一次动作」。
 *
 * true  = 落盘。判据只有一条:除了它,盘上再没有别的东西记着这件事发生过。
 * false = 只播不存。最终 task_result 已经带着同样的内容。
 */
const EXPECTED_VERDICTS: Readonly<Record<string, boolean>> = {
  // 散文。task_result.output.text 逐字带着它。
  text: false,
  // 动作。task_result 只带一个 `toolRounds` 数字——工具叫什么、参数是什么、
  // 到底跑没跑过,盘上没有第二处记着。
  tool_use: true,
  // 记账与收尾。用量另有 usage_ledger 一张真表,end/error 是流的协议帧。
  usage: false,
  end: false,
  error: false,
}

/** 解析不到就红——一道解析不出东西的门,是一道永远绿的假门。 */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`gate could not parse ${what}`)
  return value
}

/**
 * 从 `packages/llm/src/types.ts` 里把 `LlmStreamChunk` 联合的成员逐个解析成
 * 它们的 `type` 字面量。
 */
function unionChunkTypes(): string[] {
  const src = readFileSync(LLM_TYPES, 'utf8')
  const union = must(
    /export type LlmStreamChunk =([\s\S]*?)\n\n/.exec(src),
    'the LlmStreamChunk union',
  )[1]!
  const members = union
    .split('|')
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
  expect(members.length).toBeGreaterThan(1) // 解析没空转

  return members.map((name) => {
    const iface = must(
      new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(src),
      `interface ${name}`,
    )[1]!
    return must(/\btype:\s*'([^']+)'/.exec(iface), `the type literal of ${name}`)[1]!
  })
}

describe('durable stream chunks — whitelist vs the LlmStreamChunk union', () => {
  it('the union has exactly the chunk types this gate has ruled on', () => {
    // 两向:联合里多一种而表里没有 ⇒ 有人加了片段没做决定;表里多一种而联合
    // 里没有 ⇒ 裁决指着一种已经不存在的片段。
    expect(unionChunkTypes().slice().sort()).toEqual(Object.keys(EXPECTED_VERDICTS).sort())
  })

  it('the live predicate agrees with every ruling', () => {
    for (const [type, expected] of Object.entries(EXPECTED_VERDICTS)) {
      expect(chunkDeservesDisk({ type })).toBe(expected)
    }
  })

  it('exactly one chunk type is durable — the action-bearing one', () => {
    // 不是「至少一个」:白名单一旦变宽,A③ 想省的那 99.4% 就会一点点回来。
    const durable = Object.entries(EXPECTED_VERDICTS)
      .filter(([, v]) => v)
      .map(([k]) => k)
    expect(durable).toEqual(['tool_use'])
  })
})
