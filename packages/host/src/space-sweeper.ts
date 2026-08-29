/**
 * STOR-M2 — 死物清扫与 `.bak-` 族轮转:账本之上第一把会真删字节的刀。
 *
 * M1 只丈量;M2 开始动手,但只动**两类按构造无主的东西**:
 *   类① 死物 —— 孤儿原子写临时文件 + 超额的 `.corrupt-*` 隔离残骸;
 *   类② 滚动历史 —— 空间根的部署备份族 `<name>.bak-<ts>`,按族保最新 3 代。
 * 成员内容的阶梯(类③)与凭证/身份(类④)一个字节不碰——那是 M3 的策略面
 * 与永不自动碰的红线。
 *
 * ── 五条边界 ────────────────────────────────────────────────────────────────
 * ① **孤儿判据按 fs-atomic 的真相**:原子写临时名是 `${target}.<uniq>.tmp`
 *    ——以 `.tmp` **结尾**(fs-atomic.ts 头注钉死的约定,列举器全靠
 *    `!endsWith('.tmp')` 过滤)。谓词 = 名以 `.tmp` 结尾且 mtime 超过 24h:
 *    活着的原子写以秒计,一天没动过的 tmp 只可能是崩溃孤儿。
 * ② **视野是结构性的**:只看两层——空间根一层 + `runtime/` 一层,且只看
 *    普通文件(目录/符号链接一律跳过)。`butler/`、`backups/`、`exchange/`、
 *    `inbox/`、金库与身份库的活文件因此**结构性不可见**——不是被名单挡住,
 *    是清扫器根本不走到那里;而根部的活文件(identity.sqlite / gotong.env /
 *    secrets.enc.json…)没有一个匹配三个谓词里的任何一个。删除的唯一入口
 *    就是谓词,不设第二份 deny 名单(名单会烂,谓词不会)。
 * ③ **保代数是硬不变量**:`.bak-` 族每族保最新 3 代、`.corrupt-*` 族保最新
 *    5 代——族内成员 ≤ 保留数时一个不删。剪到只剩一代等于没有轮转只有删除;
 *    `.bak-` 轮转**只在空间根**(runtime/ 没有部署备份这回事)。
 * ④ **先落账再动手**(self-heal 台账同款顺序):每一次删除先往
 *    `runtime/space-actions.jsonl` append 一行 `{at, kind:'delete', class,
 *    scope, file, bytes}`,账写不进去就**不删**(warn 一次 + 计入
 *    auditBlocked)。unlink 失败再补一行 `delete_failed`——一条被吞掉的删除
 *    失败比一次响亮的报错更接近撒谎(M-HEALTH 判例)。台账 append-only,
 *    清扫开头做一次剪枝滞回(超 300 行才剪到 200,免得每轮重写文件),
 *    读者宽容(坏行跳过、未知键透传、无文件=空)。
 * ⑤ **永不抛**:清扫是 6h 节律上的顺路活,任何一处失败都折成 warn + 部分
 *    结果,绝不连累载它的那条节律(账本丈量在它之后照跑)。
 *
 * 谓词顺序 tmp → corrupt → bak,首个命中定类:一个 `.bak-` 半途崩掉的
 * `*.tmp` 是死物,不是一代备份。
 */

import { appendFile, mkdir, readFile, readdir, lstat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Logger } from '@gotong/core'
import { writeFileAtomic } from '@gotong/core'

import { spaceLedgerAt, type SpaceLedgerFile } from './space-ledger.js'

/** 孤儿 tmp 的年龄门:mtime 比这更旧才算死物(活的原子写以秒计)。 */
export const TMP_ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000

/** `.corrupt-*` 隔离残骸每族保最新几份(证据要留,但不留一辈子)。 */
export const CORRUPT_KEEP = 5

/** 空间根 `.bak-` 部署备份族每族保最新几代(边界③:≤ 此数一个不删)。 */
export const BAK_KEEP = 3

/** 审计台账文件名(落在 `<space>/runtime/` 下)。 */
export const SPACE_ACTIONS_FILE = 'space-actions.jsonl'

/** 台账剪枝滞回(self-heal 同款):超 HIGH 才剪到 KEEP,避免每轮重写。 */
const ACTIONS_PRUNE_HIGH = 300
const ACTIONS_PRUNE_KEEP = 200

/**
 * 台账行:只钉 at/kind 两个字段,其余透传——读者按需渲染,未知键无害
 * (self-heal `SelfHealEntry` 同款宽容形状)。
 */
export interface SpaceActionEntry {
  at: string
  kind: string
  [key: string]: unknown
}

export interface SpaceSweepResult {
  deletedTmp: number
  deletedCorrupt: number
  deletedBak: number
  /** unlink 抛了非 ENOENT 的错(每条已补 `delete_failed` 台账行)。 */
  failed: number
  /** 台账写不进去而被跳过的删除(边界④:账写不进去就不删)。 */
  auditBlocked: number
}

export interface SpaceSweepOptions {
  spaceDir: string
  /** 审计台账路径(`spaceUpkeepAt` 派生为 `runtime/space-actions.jsonl`)。 */
  actionsFile: string
  logger?: Logger
  /** 注入时钟(测试);缺省 Date.now。 */
  now?: () => number
}

/** 一个待删候选:name 是文件名(不含路径——台账里不落绝对路径)。 */
interface Candidate {
  name: string
  path: string
  mtimeMs: number
  size: number
}

type SweepClass = 'tmp' | 'corrupt' | 'bak'

/**
 * 宽容读者:坏行跳过(证据原地留)、缺 at/kind 的行跳过、未知键透传;
 * 无文件/读不动 = 空数组。返回最新的在前,顶多 `limit` 条。
 */
export async function readSpaceActions(file: string, limit = 50): Promise<SpaceActionEntry[]> {
  try {
    const text = await readFile(file, 'utf8')
    const out: SpaceActionEntry[] = []
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const obj = JSON.parse(t) as unknown
        if (
          obj !== null &&
          typeof obj === 'object' &&
          !Array.isArray(obj) &&
          typeof (obj as { at?: unknown }).at === 'string' &&
          typeof (obj as { kind?: unknown }).kind === 'string'
        ) {
          out.push(obj as SpaceActionEntry)
        }
      } catch {
        // 坏行跳过——台账是证据,读者不修史。
      }
    }
    return out.slice(-limit).reverse()
  } catch {
    return []
  }
}

/** 剪枝滞回:行数超 HIGH 才原子重写成最后 KEEP 行;任何失败不挡清扫。 */
async function pruneSpaceActions(file: string): Promise<void> {
  try {
    const text = await readFile(file, 'utf8')
    const lines = text.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length <= ACTIONS_PRUNE_HIGH) return
    await writeFileAtomic(file, lines.slice(-ACTIONS_PRUNE_KEEP).join('\n') + '\n')
  } catch {
    // ENOENT = 还没有台账;别的失败也不挡清扫(下一轮再剪)。
  }
}

/**
 * 列一个视野层(只普通文件,目录/链接跳过);读不动 = 空(清扫器不报告
 * 空虚,只是那里没得删)——但非 ENOENT 的失败值得一句 warn。
 */
async function listScopeFiles(dir: string, logger?: Logger): Promise<string[]> {
  try {
    const ents = await readdir(dir, { withFileTypes: true })
    return ents.filter((e) => e.isFile()).map((e) => e.name)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger?.warn('space sweep: scope unreadable, skipping', {
        dir,
        err: err instanceof Error ? err.message : String(err),
      })
    }
    return []
  }
}

/** 族内排序:mtime 新的在前(平局按名字倒序,ts 后缀天然可比)。 */
function newestFirst(a: Candidate, b: Candidate): number {
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs
  return a.name < b.name ? 1 : a.name > b.name ? -1 : 0
}

/**
 * 台账 appender 工厂——边界④「先落账再动手」的执法件,清扫与 M3 成员内容
 * 阶梯**共用同一份实现**(两个删除者各自手搭一份,warn 节流与目录懒建迟早
 * 漂移)。首次失败按 `label` warn 一次,此后静默返回 false(坏盘不刷屏);
 * 返回 false = 这条账没落下 ⇒ 调用方**不许删**。
 */
export function makeAuditAppender(
  actionsFile: string,
  logger: Pick<Logger, 'warn'> | undefined,
  label: string,
): (entry: SpaceActionEntry) => Promise<boolean> {
  let dirReady = false
  let warned = false
  return async (entry) => {
    try {
      if (!dirReady) {
        await mkdir(dirname(actionsFile), { recursive: true })
        dirReady = true
      }
      await appendFile(actionsFile, JSON.stringify(entry) + '\n', 'utf8')
      return true
    } catch (err) {
      if (!warned) {
        warned = true
        logger?.warn(`${label}: audit ledger unwritable, deletions skipped`, {
          file: actionsFile,
          err: err instanceof Error ? err.message : String(err),
        })
      }
      return false
    }
  }
}

/**
 * 跑一轮清扫。永不抛(边界⑤);返回逐类计数。删除序:每条先落台账行
 * (边界④),unlink 的 ENOENT 当作已删(与并发写者赛跑输了 = 目标已不在,
 * 不是失败)。
 */
export async function sweepSpaceOnce(opts: SpaceSweepOptions): Promise<SpaceSweepResult> {
  const result: SpaceSweepResult = {
    deletedTmp: 0,
    deletedCorrupt: 0,
    deletedBak: 0,
    failed: 0,
    auditBlocked: 0,
  }
  const now = (opts.now ?? Date.now)()
  try {
    await pruneSpaceActions(opts.actionsFile)

    // 台账 appender(边界④):账写不进去就不删。工厂与 M3 阶梯共用。
    const appendAudit = makeAuditAppender(opts.actionsFile, opts.logger, 'space sweep')

    // 视野 = 空间根一层 + runtime/ 一层(边界②)。`.bak-` 轮转只在根。
    const scopes = [
      { dir: opts.spaceDir, scope: 'root' as const, bak: true },
      { dir: join(opts.spaceDir, 'runtime'), scope: 'runtime' as const, bak: false },
    ]

    const planned: Array<Candidate & { class: SweepClass; scope: string }> = []
    for (const s of scopes) {
      const names = await listScopeFiles(s.dir, opts.logger)
      const corruptFamilies = new Map<string, Candidate[]>()
      const bakFamilies = new Map<string, Candidate[]>()
      for (const name of names) {
        // 谓词顺序 tmp → corrupt → bak;不匹配任何谓词的名字碰都不碰。
        const isTmp = name.endsWith('.tmp')
        const ci = isTmp ? -1 : name.indexOf('.corrupt-')
        const bi = isTmp || ci > 0 || !s.bak ? -1 : name.indexOf('.bak-')
        if (!isTmp && ci <= 0 && bi <= 0) continue
        let cand: Candidate
        try {
          const st = await lstat(join(s.dir, name))
          if (!st.isFile()) continue
          cand = { name, path: join(s.dir, name), mtimeMs: st.mtimeMs, size: st.size }
        } catch {
          continue // 与写者赛跑输了:候选已不在,跳过。
        }
        if (isTmp) {
          if (now - cand.mtimeMs >= TMP_ORPHAN_MIN_AGE_MS) {
            planned.push({ ...cand, class: 'tmp', scope: s.scope })
          }
        } else if (ci > 0) {
          const fam = name.slice(0, ci)
          const arr = corruptFamilies.get(fam) ?? []
          arr.push(cand)
          corruptFamilies.set(fam, arr)
        } else {
          const fam = name.slice(0, bi)
          const arr = bakFamilies.get(fam) ?? []
          arr.push(cand)
          bakFamilies.set(fam, arr)
        }
      }
      for (const members of corruptFamilies.values()) {
        for (const c of members.sort(newestFirst).slice(CORRUPT_KEEP)) {
          planned.push({ ...c, class: 'corrupt', scope: s.scope })
        }
      }
      for (const members of bakFamilies.values()) {
        for (const c of members.sort(newestFirst).slice(BAK_KEEP)) {
          planned.push({ ...c, class: 'bak', scope: s.scope })
        }
      }
    }

    for (const d of planned) {
      const ok = await appendAudit({
        at: new Date(now).toISOString(),
        kind: 'delete',
        class: d.class,
        scope: d.scope,
        file: d.name,
        bytes: d.size,
      })
      if (!ok) {
        result.auditBlocked++
        continue
      }
      try {
        await unlink(d.path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          result.failed++
          opts.logger?.warn('space sweep: delete failed', {
            file: d.name,
            err: err instanceof Error ? err.message : String(err),
          })
          await appendAudit({
            at: new Date((opts.now ?? Date.now)()).toISOString(),
            kind: 'delete_failed',
            file: d.name,
            err: err instanceof Error ? err.message : String(err),
          })
          continue
        }
        // ENOENT:已经不在了——账已落,结果一致,按已删计。
      }
      if (d.class === 'tmp') result.deletedTmp++
      else if (d.class === 'corrupt') result.deletedCorrupt++
      else result.deletedBak++
    }

    const acted = result.deletedTmp + result.deletedCorrupt + result.deletedBak
    if (acted > 0 || result.failed > 0) {
      opts.logger?.info('space sweep applied', { ...result })
    }
  } catch (err) {
    opts.logger?.warn('space sweep failed', {
      err: err instanceof Error ? err.message : String(err),
    })
  }
  return result
}

/**
 * 装配便利:一只「空间维护」thunk = 清扫 → (可选)成员内容阶梯 → 丈量。
 * 载体(retention 第四块 / 管家维护钩)拿到的就是这一只——所有会动字节的
 * 活都排在丈量**之前**,账本反映动手后的真相;每一段各自 best-effort,
 * 谁失败都不挡后面的(census 无论如何要跑)。`read` 透传账本读者。
 */
export function spaceUpkeepAt(
  spaceDir: string,
  logger?: Logger,
  extras?: {
    /** STOR-M3 成员内容阶梯 thunk;缺席 = 只清扫+丈量(M2 形态字节不变)。 */
    ladder?: () => Promise<unknown>
  },
): {
  ledgerFile: string
  actionsFile: string
  run: () => Promise<SpaceLedgerFile | null>
  read: () => Promise<SpaceLedgerFile | null>
} {
  const ledger = spaceLedgerAt(spaceDir, logger)
  const actionsFile = join(spaceDir, 'runtime', SPACE_ACTIONS_FILE)
  return {
    ledgerFile: ledger.ledgerFile,
    actionsFile,
    read: ledger.read,
    run: async () => {
      try {
        await sweepSpaceOnce({ spaceDir, actionsFile, logger })
      } catch {
        // sweepSpaceOnce 自己永不抛;这层是双保险——census 无论如何要跑。
      }
      if (extras?.ladder) {
        try {
          await extras.ladder()
        } catch (err) {
          logger?.warn('space upkeep: retention ladder failed', {
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
      return ledger.measure()
    },
  }
}
