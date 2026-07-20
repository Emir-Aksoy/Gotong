import { join } from 'node:path'

import { BUTLER_MAINTENANCE_INTERVAL_MS } from './personal-butler-maintenance.js'
import { BUTLER_PROACTIVE_INTERVAL_MS } from './personal-butler-proactive.js'
import { BUTLER_RUN_BROADCAST_INTERVAL_MS } from './personal-butler-run-broadcast.js'

/**
 * 阿同的 env 旋钮解析,从 main.ts 抽出来。
 *
 * 抽的理由不是行数,是这堆判断里有三件**没人测得到**的事——它们原先散落在
 * 三十来行 `let` 声明之间,只能靠读代码确认:
 *
 *   1. **开关方向是反的,两种都在用。** `GOTONG_BUTLER` / `_GOVERNED` /
 *      `_MAINTENANCE` / `_PROACTIVE` / `_RUN_BROADCAST` 是 **opt-out**
 *      (默认开,写 `{0,false,off,no}` 才关);`_MEMORY_LINKS` / `_MEMORY_GIT` /
 *      `_MEMORY_RECONCILE` / `_MEMORY_LIBRARIAN` 是 **opt-in**(默认关,得写
 *      `{1,true,on,yes}` 才开)。后一组认的是白名单:`=enabled`、`=Y`、`=开`
 *      一律**静默当没开**——没有报错,只是不生效。
 *   2. **闸是级联的。** 维护/主动/播报三扇都 `&& butlerDefaultOn`,记忆的三个
 *      opt-in 又都 `&& maintenanceOn`。所以 `GOTONG_BUTLER=off` 会**连带**把
 *      显式写了 `GOTONG_BUTLER_MEMORY_LIBRARIAN=1` 的图书馆员一起关掉。这是
 *      对的(管家都不在了,它的后台扫描没有立场自己跑),但看代码看不出来。
 *   3. **`governedOn` 是这组里唯一不级联的。** 它没有 `&& butlerDefaultOn`。
 *      今天无害——管家关掉后 factory 根本不建管家,这个值没人读——但它和邻居
 *      不一样这件事得写下来,免得下次谁照着邻居的样子改坏。**这里逐字保留
 *      原语义**:抽取就是抽取,要不要对齐是另一个决定。
 *
 * 周期都带钳位,且走 `Number(x) || 默认值`。那个 `||` 挡的是 **NaN** 不是 0:
 * `Math.max(60000, NaN)` 仍是 NaN,拿 NaN 当 setInterval 的延迟等于没有节流,
 * 而「没设这个变量」正好就走 NaN 这条路。0 反倒会被下界救成 60s,只是让它跟
 * 「没设」一样回落更符合直觉。
 */
export interface ButlerEnvConfig {
  /** `<space>/butler/memory` —— /me 隐私视图读的是同一份字节。 */
  memoryRoot: string
  defaultOn: boolean
  governedOn: boolean
  memoryLinksOn: boolean
  maintenanceOn: boolean
  maintenanceMs: number
  memoryGitOn: boolean
  memoryReconcileOn: boolean
  memoryLibrarianOn: boolean
  proactiveOn: boolean
  proactiveMs: number
  runBroadcastOn: boolean
  runBroadcastMs: number
}

/** opt-out 组:除非明确写了关,否则算开。 */
function onUnlessDisabled(raw: string | undefined): boolean {
  return !['0', 'false', 'off', 'no'].includes((raw ?? '').trim().toLowerCase())
}

/** opt-in 组:只认白名单,其余(含拼错的)一律当没开。 */
function onlyIfEnabled(raw: string | undefined): boolean {
  return ['1', 'true', 'on', 'yes'].includes((raw ?? '').trim().toLowerCase())
}

/** 钳进 [min,max];非数字 / 0 回落 fallback。 */
function cadence(raw: string | undefined, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(raw) || fallback))
}

export function parseButlerEnv(env: NodeJS.ProcessEnv, spaceRoot: string): ButlerEnvConfig {
  const defaultOn = onUnlessDisabled(env.GOTONG_BUTLER)
  const maintenanceOn = defaultOn && onUnlessDisabled(env.GOTONG_BUTLER_MAINTENANCE)
  return {
    memoryRoot: join(spaceRoot, 'butler', 'memory'),
    defaultOn,
    // 邻居都级联,就它不 —— 见上文 3,保留原样。
    governedOn: onUnlessDisabled(env.GOTONG_BUTLER_GOVERNED),
    // M-GRAPH:6h 扫描写 meta.links + 召回扩一跳。挂 defaultOn 而非
    // maintenanceOn —— 召回扩一跳不需要扫描先跑过。
    memoryLinksOn: defaultOn && onlyIfEnabled(env.GOTONG_BUTLER_MEMORY_LINKS),
    maintenanceOn,
    maintenanceMs: cadence(env.GOTONG_BUTLER_MAINTENANCE_MS, BUTLER_MAINTENANCE_INTERVAL_MS, 60_000, 24 * 60 * 60 * 1000),
    // 下面三个都是 6h 扫描里的活,所以挂 maintenanceOn 而不是 defaultOn。
    memoryGitOn: maintenanceOn && onlyIfEnabled(env.GOTONG_BUTLER_MEMORY_GIT),
    memoryReconcileOn: maintenanceOn && onlyIfEnabled(env.GOTONG_BUTLER_MEMORY_RECONCILE),
    memoryLibrarianOn: maintenanceOn && onlyIfEnabled(env.GOTONG_BUTLER_MEMORY_LIBRARIAN),
    proactiveOn: defaultOn && onUnlessDisabled(env.GOTONG_BUTLER_PROACTIVE),
    proactiveMs: cadence(env.GOTONG_BUTLER_PROACTIVE_MS, BUTLER_PROACTIVE_INTERVAL_MS, 5 * 60 * 1000, 60 * 60 * 1000),
    runBroadcastOn: defaultOn && onUnlessDisabled(env.GOTONG_BUTLER_RUN_BROADCAST),
    runBroadcastMs: cadence(env.GOTONG_BUTLER_RUN_BROADCAST_MS, BUTLER_RUN_BROADCAST_INTERVAL_MS, 60_000, 60 * 60 * 1000),
  }
}
