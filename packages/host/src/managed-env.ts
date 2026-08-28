/**
 * UXCFG-M1 — 让 `<space>/gotong.env` 真的被这台 hub 读到。
 *
 * ## 这个文件治的是一句假话
 *
 * `config-set`(网页设置台 / CLI / 阿同的 `set_hub_config`)把旋钮写进
 * `<space>/gotong.env`,写完对人说「下次重启生效」。`serializeEnvFile` 的文件头
 * 也写着「由启动器 / systemd `EnvironmentFile=` 在 host 启动前 source 进来」。
 *
 * 那句话**在四条已发货的启动路径里只有一条是真的**:
 *   - 桌面启动器(`deploy/Gotong.command` / `.sh`)  真的 source 它            ✅
 *   - `deploy/gotong.service`                      读的是 `/etc/gotong.env`  ❌
 *   - `deploy/cloud-quickstart.sh`                 也写 `/etc/gotong.env`    ❌
 *   - prod compose                                 具名卷,结构上够不到       ❌
 *
 * 也就是说:在最主流的 VPS 部署上,一个人在网页上把端口改掉、重启、然后发现
 * 什么都没变——而界面刚刚亲口告诉他这次改动会生效。**一个改不动东西的设置页,
 * 比没有设置页更坏**,因为它把「我配好了」这件事变成了幻觉。
 *
 * ## 为什么修在这里,而不是逐条去补启动器
 *
 * 补启动器要改三个文件、而 compose 那条**根本补不了**(具名卷里的路径宿主看不见)。
 * 让 host 自己在 boot 读那个文件,一处覆盖全部部署形态——**包括将来任何一种新的
 * 起法**,因为它不再依赖「谁在 host 之前替我 source 一下」这个外部约定。
 *
 * ## 三条不变量(每一条都是承重的)
 *
 * 1. **只认白名单** —— 认的键恰好是 `ENV_KNOBS`,也就是**写入方允许写的那一份**。
 *    一份定义两处执法:能写什么,就认什么。副作用是安全性质而不只是整洁——有人
 *    (或一个被注入的模型)往这个文件里写 `GOTONG_MASTER_KEY=...`,读路径**结构上
 *    看不见它**。凭证永远搬不进来,不是因为我们记得去挡,而是因为没有那条路。
 *
 * 2. **`process.env` 永远赢** —— 运维显式设的(systemd `Environment=`、compose
 *    `environment:`、shell export)一律压过盘上的值。反过来会让一个几个月前在
 *    网页上点过的旧值,悄悄盖掉运维今天在 unit 文件里写下的那一行。
 *    「已设」按 `env()` 的语义判:**空串 = 未设**(`main-cli.ts` 的 `env()` 对
 *    `''` 就是回落 fallback)。两边不一致的话,`FOO=` 会 shadow 掉文件里的值,
 *    而下游又把它当没设——那个旋钮于是既不是文件说的,也不是环境说的。
 *
 * 3. **值要过写入方同一个校验器** —— 文件是我们自己写的,写的时候已经校验过;
 *    但人会手改。手改成非法值时**不注入**比注入更诚实:注入了要么让下游当场抛
 *    (`GOTONG_DEFAULT_LANG` 就会),要么被静默回落成默认——两种都是「我照你说的
 *    做了」的谎。拒绝的那个键会被记进 `rejected`,由调用方响亮报出来。
 *
 * ## 读不动的时候
 *
 * ENOENT = 诚实的「没有这个文件」(绝大多数部署本来就没有),零 problem。
 * 其它错(EACCES / EISDIR / EIO)= **必须说出来**:读不动意味着这个人在网页上改的
 * 每一个旋钮都不生效,而 hub 看起来一切正常。这里**不拒启**——为一个配置便利层
 * 拒启,会让唯一能修它的那个界面也够不着;但 problem 会走 warn + 启动横幅,
 * 让它不至于是静默的。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENV_KNOBS, parseEnvFile } from './ops-config-write.js'

/** 被托管的 env 文件的绝对路径。写入方(`envFileOf`)拼的是同一个。 */
export function managedEnvFilePath(spaceDir: string): string {
  return join(spaceDir, 'gotong.env')
}

export interface ManagedEnvResult {
  /** 试着读的那个文件。 */
  path: string
  /** 真正注入了 `process.env` 的键(排序)。 */
  applied: readonly string[]
  /** 文件里有,但 `process.env` 已经设了 ⇒ 环境赢,文件让位。 */
  shadowed: readonly string[]
  /** 文件里有,但不在白名单 ⇒ 结构性看不见(凭证就落在这里)。 */
  ignored: readonly string[]
  /** 文件里有、在白名单、但值过不了写入方的校验器 ⇒ 不注入。 */
  rejected: readonly { key: string; reason: string }[]
  /** 读不动时的人话(ENOENT 不算问题,那只是「没有」)。 */
  problem?: string
}

export interface LoadManagedEnvOptions {
  /** 注入目标,默认 `process.env`(测试注入用)。 */
  target?: Record<string, string | undefined>
  /** 读文件的缝(测试注入用)。 */
  readFileImpl?: (p: string) => string
}

/**
 * 读 `<space>/gotong.env`,把白名单内、环境未设、值合法的键注入 `target`。
 *
 * **同步**是刻意的:它必须跑在 boot 的最前面——在 logger 建起来之前、在任何
 * 读 env 的模块被求值之前。一个 `await` 就会把它推到微任务队列之后,那时
 * 半个 host 已经读过 `process.env` 了。
 */
export function loadManagedEnv(spaceDir: string, opts: LoadManagedEnvOptions = {}): ManagedEnvResult {
  const path = managedEnvFilePath(spaceDir)
  const target = opts.target ?? (process.env as Record<string, string | undefined>)
  const read = opts.readFileImpl ?? ((p: string) => readFileSync(p, 'utf8'))

  let text: string
  try {
    text = read(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') {
      return { path, applied: [], shadowed: [], ignored: [], rejected: [] }
    }
    return {
      path,
      applied: [],
      shadowed: [],
      ignored: [],
      rejected: [],
      problem: `读不了 ${path}(${code ?? 'unknown'}) — 在设置页改过的旋钮这次不会生效 / unreadable, settings written there will NOT apply`,
    }
  }

  const parsed = parseEnvFile(text)
  const applied: string[] = []
  const shadowed: string[] = []
  const ignored: string[] = []
  const rejected: { key: string; reason: string }[] = []

  for (const [key, raw] of parsed) {
    const spec = ENV_KNOBS.find((k) => k.key === key)
    if (!spec) {
      ignored.push(key)
      continue
    }
    // 不变量 2 —— 空串按 `env()` 的语义算「未设」。
    const current = target[key]
    if (current !== undefined && current !== '') {
      shadowed.push(key)
      continue
    }
    const verdict = spec.validate(raw)
    if (!verdict.ok) {
      rejected.push({ key, reason: verdict.reason })
      continue
    }
    target[key] = verdict.value
    applied.push(key)
  }

  const sort = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  return {
    path,
    applied: applied.sort(sort),
    shadowed: shadowed.sort(sort),
    ignored: ignored.sort(sort),
    rejected: rejected.sort((a, b) => sort(a.key, b.key)),
  }
}
