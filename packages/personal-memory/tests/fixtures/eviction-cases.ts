/**
 * 逐出尺子的夹具(记忆经济 M3b)。
 *
 * 每条用例都被造成**重要度分不开、只有「用没用过」分得开**的形状 —— 否则量到的
 * 抬升会是重要度的功劳而不是显著性的。具体做法:同 kind(层级相同)、同重要度
 * (基线的第一判据打平),于是基线只剩最后一根稻草——**写下的新旧**。
 *
 * 于是夹具刻意把「该留的」造得**更旧**:一条三个月前写下、昨天还在用的事实,
 * 对上一条两个月前写下、从没被翻过的事实。基线会留后者(它更新),显著性会留
 * 前者(它被用着)。这就是「用得多的自然浮上来,久不用的自然沉下去」那句话的
 * 可证伪形式。
 */

import { benchEntry, type EvictionCase } from '../../src/eviction-benchmark.js'

export const EVICTION_CASES: readonly EvictionCase[] = [
  {
    name: 'used-vs-fresh',
    why: '老而常用 vs 新而没人碰。基线只看新旧,必然留错;显著性看强化次数,该留的才留。',
    corpus: [
      benchEntry({ id: 'k1', text: '我对花生过敏', writtenDaysAgo: 90, recalledDaysAgo: 1, recallCount: 8 }),
      benchEntry({ id: 'k2', text: '我住槟城乔治市', writtenDaysAgo: 80, recalledDaysAgo: 2, recallCount: 6 }),
      benchEntry({ id: 'd1', text: '某次会议提过一句天气', writtenDaysAgo: 60 }),
      benchEntry({ id: 'd2', text: '随口说过想吃拉面', writtenDaysAgo: 50 }),
    ],
    shouldKeep: ['k1', 'k2'],
  },
  {
    name: 'faded-vs-recalled',
    why: '两条都从没被强化过,但一条上个月还被召回、一条半年没人碰。衰减只有通电才分得开。',
    corpus: [
      benchEntry({ id: 'k3', text: '我的目标体重是 68 公斤', writtenDaysAgo: 200, recalledDaysAgo: 3 }),
      benchEntry({ id: 'd3', text: '两年前的一次报销流程', writtenDaysAgo: 180 }),
    ],
    shouldKeep: ['k3'],
  },
  {
    name: 'expired-first',
    why: '一条已经翻篇的死历史 vs 一条正在生效的事实。开了「先逐过期」才分得开,否则按新旧留错。',
    corpus: [
      benchEntry({ id: 'k4', text: '我现在在做记忆经济这个项目', writtenDaysAgo: 30 }),
      benchEntry({ id: 'd4', text: '我以前在做另一个项目', writtenDaysAgo: 20, validToDaysAgo: 5 }),
    ],
    shouldKeep: ['k4'],
  },
]
