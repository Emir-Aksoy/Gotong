/**
 * butler-obsidian.ts — HANDS-M5 装配层:把只读投影接到 hub 的落盘路径上。
 *
 * 用户在 HANDS-M0 拍板的第 4 条岔口是「**md 投影层、JSON 仍是真相**」。纯核
 * (`@gotong/personal-butler` 的 `obsidian-projection.ts`)负责怎么渲染;这一层
 * 只负责**一件事**:让两条生成路径(每次写笔记本的末尾 / 6h 维护兜底)拿到
 * **同一个** projector 构造,否则同一份真相会因为路径不同而投影出不同的字节,
 * 投影自己就开始抖——那正是 MU-M5 的 git 快照要报告的「变化」。
 *
 * 因此这里只导出一个工厂:调用点各自 `new` 一份 handle 是这个仓库既有的姿态
 * (维护那条路每 tick 现开 memory / STATUS / 知识库),但**参数从哪儿来**必须
 * 只有一个答案。
 *
 * vault 根 = `ownerDir(rootDir, {user,id})` —— 与 STATUS.md / tasks.json /
 * knowledge/ 同一个目录,也就是成员用 Obsidian 打开的那个 vault。
 */

import { join } from 'node:path'

import type { Logger } from '@gotong/core'
import {
  openKnowledgeLibrary,
  openObsidianProjector,
  openTaskNotebook,
} from '@gotong/personal-butler'
import type { ObsidianProjector } from '@gotong/personal-butler'
import type { TierConfig } from '@gotong/personal-memory'
import { ownerDir } from '@gotong/service-memory-file'

import { openButlerMemory } from './personal-butler-memory.js'

/**
 * 从磁盘读多少条 semantic 参与投影。文件后端的 `list` 硬顶就是 500(再大也
 * 会被 clamp),所以这里写 500 是**如实**说出这条路的上界,而不是许一个做不到
 * 的诺:事实多于 500 条的成员,投影里是最新的 500 条,jsonl 仍是全部真相。
 */
export const OBSIDIAN_PROJECTION_READ_LIMIT = 500

export interface OpenButlerObsidianProjectorOptions {
  /** 管家记忆根(`<space>/butler/memory`)。 */
  rootDir: string
  userId: string
  logger: Logger
  tierConfig?: TierConfig
}

/**
 * 打开某位成员的投影器。知识库列表是**懒**的(每次投影现列一次),因为链表要
 * 反映「此刻架上真有哪些文件」——投影里出现一条指不到东西的 `[[…]]`,在
 * Obsidian 里会变成一个「点一下就新建一篇」的诱饵,而那篇笔记不该存在。
 */
export function openButlerObsidianProjector(
  opts: OpenButlerObsidianProjectorOptions,
): ObsidianProjector {
  const dir = ownerDir(opts.rootDir, { kind: 'user', id: opts.userId })
  const library = openKnowledgeLibrary({ dir: join(dir, 'knowledge'), logger: opts.logger })
  return openObsidianProjector({
    dir,
    knowledgeFiles: async () => (await library.list()).files.map((f) => f.path),
    logger: opts.logger,
    ...(opts.tierConfig ? { tierConfig: opts.tierConfig } : {}),
  })
}

export interface ProjectButlerVaultOptions extends OpenButlerObsidianProjectorOptions {
  /** 判定哪些事实「现在还成立」用的时刻(维护那一 tick 的 now)。 */
  now: number
}

/**
 * 6h 维护兜底:按**当前磁盘上的真相**重投一遍两块投影。
 *
 * 为什么需要兜底,而不是只靠各自写路径的末尾:①记忆的 semantic 主要由 6h 蒸馏
 * 改写,那条路上没有「成员的一次编辑」可挂;②双时态使「什么还算数」会随时间
 * 变(某条事实今天被 close 掉,盘上一个字节没动);③接这一刀之前就有笔记本的
 * 成员,不该等到下次编辑才第一次拿到 tasks.md。
 *
 * 永不抛:投影是派生物,读不动真相就跳过这次(下一 tick 再来),绝不连累维护。
 */
export async function projectButlerVault(opts: ProjectButlerVaultOptions): Promise<void> {
  const projector = openButlerObsidianProjector(opts)
  try {
    const notebook = openTaskNotebook({
      file: join(ownerDir(opts.rootDir, { kind: 'user', id: opts.userId }), 'tasks.json'),
      logger: opts.logger,
    })
    await projector.projectTasks(await notebook.list())
  } catch (err) {
    opts.logger.warn('obsidian projection: tasks skipped', {
      userId: opts.userId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
  await projectButlerMemoryVault({ ...opts, projector })
}

/**
 * 只重投**记忆**那一半。
 *
 * 两个调用者:6h 兜底(上面)与成员点「忘掉这一条」之后(`ButlerMemoryService.forget`)。
 * 刻意抽成一个函数而不是各写一遍 —— 与 M5 让两条写路径共用 `openButlerObsidianProjector`
 * 同一个理由:「读多少条 / 算不算读满了窗 / 投给谁」这三件事只能有一份答案,
 * 各写一遍迟早不一样,而不一样的那天没有人会被通知。
 *
 * 永不抛:投影是派生物,读不动真相就跳过这次(下一 tick 再来)。
 */
export async function projectButlerMemoryVault(
  opts: ProjectButlerVaultOptions & { readonly projector?: ObsidianProjector },
): Promise<void> {
  const projector = opts.projector ?? openButlerObsidianProjector(opts)
  try {
    const memory = openButlerMemory({ rootDir: opts.rootDir, userId: opts.userId, logger: opts.logger })
    const facts = await memory.list({ kind: 'semantic', limit: OBSIDIAN_PROJECTION_READ_LIMIT })
    // 读满了上限 = 这一次很可能没看全(后端 `list` 自己的 `LIST_MAX_LIMIT` 就是 500)。
    // 把这个事实带下去:投影层据此**不删**看起来空掉的 cluster,也在正文里说明白。
    // 「读到 500 条」与「一共正好 500 条」在这里被当成同一件事 —— 宁可多说一句
    // 「可能没列全」,也不要因为差一条而把一份还成立的投影删掉。
    await projector.projectMemory(facts, opts.now, {
      windowed: facts.length >= OBSIDIAN_PROJECTION_READ_LIMIT,
    })
  } catch (err) {
    opts.logger.warn('obsidian projection: memory skipped', {
      userId: opts.userId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}
