/**
 * 降温尺子的夹具(记忆经济 M3c)。
 *
 * # 这份夹具要分开的是什么
 *
 * M3b 的夹具全是散装事实,分的是「用没用过」。降温分的是另一件事:**回收该落在谁头上**。
 *
 * 今天的生产配置(= M3b 通电后的那一套)按层级逐:episodic(0)→ 散装事实(1)→
 * digest(2)→ profile(3)。于是压力一来,先被吃掉的是**近期流水账**——哪怕库里躺着一堆
 * 半年没人碰过的冷事实。降温把冷事实盖上 `validTo`,它们落进「已过期」带,那一带排在
 * episodic **前面**,回收这才落到该落的地方。
 *
 * 所以每条用例的形状都是:**一堆还有用的近期流水 + 一批该被翻篇的冷事实**,预算刚好卡在
 * 「流水全留下」。基线必然先吃流水,降温必然先吃冷事实。
 *
 * # 每条用例都带一个陷阱
 *
 * 光证明「降温有用」不够 —— 一个把什么都翻篇的实现在第一条用例上也是满分。所以后三条各放
 * 一个**不许翻**的东西,而「翻错了」的代价都一样重:翻篇 = 进过期带 = 排到队列最前面,
 * 于是一个本该最受保护的东西会变成最先被逐的。
 *
 * 但陷阱有没有真的咬合,要看变异结果而不是意图:`protection-holds` 与 `profile-never-cools`
 * 会随对应的守卫被拆掉而变红(N6-C / N6-B),**`pin-never-cools` 不会**——显著性排序自己
 * 就把钉住的挡在了最后。那道守卫是更深一层的保险,只有单元测试够得着。用例里如实写了。
 *
 * # 数字为什么这么排
 *
 *   - **12 条 episodic**:`enforceBudget` 的 `protectRecentEpisodic` 默认护住最新 8 条,
 *     所以要 12 条才有 4 条落在保护圈外、真的会被逐。少于 9 条的夹具量不出任何东西。
 *   - **8 条「近期事实」**:降温自己的保护期 `DEFAULT_PROTECT_RECENT` 也是 8,而且是在
 *     **散装事实内部**数的。所以要先用 8 条把保护期占满,更旧的冷事实才够得着。
 *     这一条是踩出来的:第一版夹具只放 4 条冷事实,8 > 4 ⇒ 全在保护期里 ⇒ 降温一条都没翻,
 *     用例空洞地绿着。夹具必须尊重默认值,不能把默认值调小来迁就夹具。
 */

import { benchEntry, type EvictionCase } from '../../src/eviction-benchmark.js'

/** 近期流水账:12 条,最新 8 条被 `protectRecentEpisodic` 护住,剩 4 条裸露。 */
function recentLogs(): ReturnType<typeof benchEntry>[] {
  return Array.from({ length: 12 }, (_, i) =>
    benchEntry({
      id: `log-${String(i + 1).padStart(2, '0')}`,
      kind: 'episodic',
      text: `第 ${i + 1} 天的对话记录:讨论了记忆经济这一段要怎么收口,以及下一步该量什么。`,
      writtenDaysAgo: i + 1,
    }),
  )
}

/** 近期事实:8 条,刚好占满降温自己的保护期。它们该活下来。 */
function freshFacts(): ReturnType<typeof benchEntry>[] {
  return Array.from({ length: 8 }, (_, i) =>
    benchEntry({
      id: `fresh-${String(i + 1).padStart(2, '0')}`,
      text: `最近记下的第 ${i + 1} 条事实,还在保护期里。`,
      writtenDaysAgo: 10 + i,
    }),
  )
}

/** 冷事实:半年没人碰,从没被召回过。降温该翻的就是它们。 */
function staleFacts(n: number): ReturnType<typeof benchEntry>[] {
  return Array.from({ length: n }, (_, i) =>
    benchEntry({
      id: `stale-${String(i + 1).padStart(2, '0')}`,
      text: `很久以前记下的第 ${i + 1} 条事实,之后再没被翻出来过。`,
      writtenDaysAgo: 150 + i,
    }),
  )
}

const LOG_IDS = recentLogs().map((e) => e.id)
const FRESH_IDS = freshFacts().map((e) => e.id)

export const COOLING_CASES: readonly EvictionCase[] = [
  {
    name: 'cold-facts-vs-recent-log',
    why: '一堆还有用的近期流水 vs 四条半年没人碰的冷事实。基线按层级先吃流水;降温把冷事实翻篇,回收才落到冷事实头上。',
    corpus: [...recentLogs(), ...freshFacts(), ...staleFacts(4)],
    shouldKeep: [...LOG_IDS, ...FRESH_IDS],
  },
  {
    name: 'protection-holds',
    why: '库里一条冷事实都没有 —— 八条事实全在降温的保护期里。降温该**什么都不做**,把回收让回给流水尾巴。翻了保护期里的事实就会当场掉分。',
    corpus: [...recentLogs(), ...freshFacts()],
    // 最新 8 条 episodic 受保护,最旧 4 条是这一局唯一该走的。
    shouldKeep: [...LOG_IDS.slice(0, 8), ...FRESH_IDS],
  },
  {
    name: 'pin-never-cools',
    why: '一条钉住的冷事实(importance 5)混在三条普通冷事实里:钉住的要毫发无损地穿过整轮降温+回收。注意这一条**量不出**降温里那道钉住守卫——显著性本身就把钉住的排在最冷序的最末,三条普通冷事实先被取走,轮不到它。守卫是极端压力下的第二层(目标字节大到要吃穿整层时才咬合),那一层钉在单元测试里(变异 N6-A 只在那边变红,这里不变)。',
    corpus: [
      ...recentLogs(),
      ...freshFacts(),
      ...staleFacts(3),
      benchEntry({
        id: 'pinned-cold',
        text: '我对花生过敏(钉住)。',
        writtenDaysAgo: 160,
        importance: 5,
      }),
    ],
    shouldKeep: [...LOG_IDS, ...FRESH_IDS, 'pinned-cold'],
  },
  {
    name: 'profile-never-cools',
    why: '一份很冷的 profile —— 逐出序里最受保护的第 3 层。它比所有冷事实都旧,所以一个不看层级的降温会**第一个**翻它,而翻完它就排到了队列最前面:分层保护当场倒置。',
    corpus: [
      ...recentLogs(),
      ...freshFacts(),
      ...staleFacts(3),
      benchEntry({
        id: 'cold-profile',
        text: '用户画像:住槟城,做记忆经济,偏好中文,不喜欢被反复确认。',
        writtenDaysAgo: 170,
        profile: true,
      }),
    ],
    shouldKeep: [...LOG_IDS, ...FRESH_IDS, 'cold-profile'],
  },
]
