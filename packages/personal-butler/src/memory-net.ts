/**
 * memory-net.ts — 记忆经济 M2b:把七个店接成**一次**召回。
 *
 * M1 那把尺子量出的病灶是具体的:跨店 recall@5 只有 16.7%,六问里三问平地板
 * 零分——`coffee-repair` / `tax-prep` / `tomato-fertilizer` 的答案整个躺在
 * `knowledge/` / `tasks.json` / 会话窗 / 长任务档案里,而今天的生产召回**结构上
 * 没有任何一条路径**能吐出 `memory:` 以外的 id。它给的还不是沉默:问「咖啡机
 * 出水慢」,它自信地召回「我每天喝手冲咖啡」。
 *
 * 这个模块是治它的另一半:M2a 的联想网(`@gotong/personal-memory` 的
 * `deriveEdges` / `diffuse` / `applyStoreQuota` / `renderMemorySheet`)是纯核,
 * 这里负责**读七个店、喂给纯核、把结果折成一页**。分工的理由是层次:
 * `personal-memory` 不该知道管家恰好有个知识树和任务本,店名是这一层的词汇。
 *
 * # 三条边界
 *
 * ① **只读。** 列举、建网、召回,全程不写一个字节。网是派生的,盘上真相仍归
 *    各店;整层丢掉,下次调用重建。
 * ② **不发新 id。** 节点 id 是 `<store>:<那个店自己的寻址>`,能原路指回盘上
 *    那一条。发一套新 id 就等于让网变成第二份真相。
 * ③ **零模型调用。** 种子走既有 `fuseArms`(与生产检索器同一份算术),扩散是
 *    纯函数,语义边逐字读既有 `meta.links`。这条路上没有一次 LLM。
 *
 * # 两个店今天不给时间戳,如实缺席
 *
 * `KnowledgeFileInfo` 只报 path/bytes/archived,`SessionMessage` 只有
 * role/content(渲染视图已经合并了同角色连续轮,盘上那个 `at` 到不了这里)。
 * 于是这两个店的节点**没有 `ts`**,结构上拿不到时序边。给它们编一个当下时钟
 * 会让它们全部落在同一瞬间、互相都算「相邻」,凭空造出一张稠密的假时序网——
 * 缺席比编造诚实。想让它们也进时序,得先把那两个店的读接口拓宽,那是另一刀。
 */

import {
  deriveEdges,
  diffuse,
  applyStoreQuota,
  renderMemorySheet,
  fuseArms,
  effectiveSalience,
  importanceOf,
  linksOf,
  validFromOf,
  validToOf,
  DEFAULT_IMPORTANCE,
  type AssocEdge,
  type AssocNode,
  type DeriveEdgesOptions,
  type MemorySheetOptions,
} from '@gotong/personal-memory'
import type { MemoryEntry } from '@gotong/services-sdk'

import type { KnowledgeLibrary } from './knowledge-library.js'
import type { LongRunDossierStore } from './longrun-dossier.js'
import type { ButlerSessionWindow } from './session-window.js'
import type { TaskNotebook } from './task-notebook.js'

// ---------------------------------------------------------------------------
// 寻址:七个店折成五个可寻址的面
// ---------------------------------------------------------------------------

/**
 * 七个店折成五个面——personal-memory 的 episodic/semantic/working 共用
 * `memory:`,因为它们本来就在一个店、一个 id 空间里。
 */
export type MemoryStore = 'memory' | 'knowledge' | 'task' | 'session' | 'dossier'

export const MEMORY_STORES: readonly MemoryStore[] = [
  'memory',
  'knowledge',
  'task',
  'session',
  'dossier',
] as const

/**
 * 节点 id = `<store>:<pointer>`,pointer 是**那个店自己的**寻址方式:
 *
 *   - `memory:<MemoryEntry.id>`
 *   - `knowledge:<相对 knowledge/ 的路径>`
 *   - `task:tn-<n>`
 *   - `session:<userId>#<渲染视图下标>`
 *   - `dossier:<taskId>#<seg>`(`#0` = objective,`#n` = 第 n 段日志)
 */
export function nodeId(store: MemoryStore, pointer: string): string {
  return `${store}:${pointer}`
}

export function parseNodeId(id: string): { store: MemoryStore; pointer: string } | null {
  const at = id.indexOf(':')
  if (at <= 0) return null
  const store = id.slice(0, at)
  if (!MEMORY_STORES.includes(store as MemoryStore)) return null
  const pointer = id.slice(at + 1)
  if (!pointer) return null
  return { store: store as MemoryStore, pointer }
}

// ---------------------------------------------------------------------------
// 空间与节点
// ---------------------------------------------------------------------------

/** 一个成员的五个店。列举只读它们的公开读接口,不碰盘。 */
/**
 * 要接进网里的那些面。
 *
 * 除 `entries` 外**每一个店都是可选的**,因为生产里它们并不在同一个作用域:管家
 * 工厂手上有记忆 / 知识库 / 任务本 / 长任务档案,而会话窗住在 IM 桥的接线里。
 * 一个只接得到四个面的调用方应当能**如实**说出「我只有这四个」,而不是被类型
 * 逼着塞一个假的第五个进来 —— 缺席比编造诚实,与 `AssocNode.ts` 缺席同一条理由。
 * 少接一个店的代价是那个店召不回来,不是别的店算错。
 */
export interface MemorySpace {
  readonly userId: string
  /** 已取回的 personal-memory 条目(调用方决定取多少)。 */
  readonly entries: readonly MemoryEntry[]
  readonly knowledge?: KnowledgeLibrary
  readonly notebook?: TaskNotebook
  readonly sessions?: ButlerSessionWindow
  readonly dossiers?: LongRunDossierStore
  /** 要列举的长任务档案。档案店按 taskId 寻址,没有「列出全部」。 */
  readonly dossierIds?: readonly string[]
}

/** 网里的一个节点:{@link AssocNode} 收窄到本层的店名。 */
export interface MemoryNode extends AssocNode {
  readonly store: MemoryStore
}

/**
 * 非 memory 店的显著性。
 *
 * 取 `DEFAULT_IMPORTANCE`(3)不是随手挑的:memory 节点走 `effectiveSalience`,
 * 未标注 importance 的条目正好也是 3。于是「知识库里的一篇」与「一条没人标过
 * 轻重的记忆」起点相同——这是唯一能自圆其说的中立值。给 1 会把四个店系统性
 * 埋掉,给 5 等于宣称它们天然比记忆重要,两种都是在没有信号的地方硬造信号。
 */
export const NON_MEMORY_SALIENCE = DEFAULT_IMPORTANCE

/**
 * 把空间里**当下能被指到的**节点全列出来。
 *
 * 只读:不改名、不建目录、不落一个字节。这趟读同时是 M1 夹具卫生检查的依据
 * (黄金 id 必须真指得到)和建网的输入,两处共用一份实现——两份「什么算存在」
 * 的实现迟早会不一致,而一条静默得 0 分的用例比一条红的用例坏得多。
 *
 * 会话节点指的是**渲染视图**而不是盘上流水:`history()` 合并同角色连续轮、
 * 丢掉结尾的 user 轮,`session:<userId>#<i>` 里的 `<i>` 是渲染后那一列的下标。
 * 理由不是省事——模型看见的就是渲染后那份,指盘上流水会指到一条模型根本读不到
 * 的东西。
 */
export async function enumerateMemoryNodes(space: MemorySpace): Promise<MemoryNode[]> {
  const out: MemoryNode[] = []

  for (const e of space.entries) {
    const links = linksOf(e).map((id) => nodeId('memory', id))
    const from = validFromOf(e)
    const to = validToOf(e)
    out.push({
      id: nodeId('memory', e.id),
      store: 'memory',
      text: e.text,
      ts: e.ts,
      // 无选项的 effectiveSalience 就是 importanceOf(1..5) —— 衰减与强化归 M3
      // 通电,这一刀不动它,免得「跨店抬升」和「显著性经济上线」混在一个数字里。
      salience: effectiveSalience(e),
      ...(links.length > 0 ? { links } : {}),
      ...(from === undefined ? {} : { validFrom: from }),
      ...(to === undefined ? {} : { validTo: to }),
    })
  }

  if (space.knowledge) {
    const listing = await space.knowledge.list()
    for (const f of listing.files) {
      const doc = await space.knowledge.read(f.path)
      // ts 缺席:知识库的读接口今天不吐时间戳(见模块顶注)。
      out.push({
        id: nodeId('knowledge', f.path),
        store: 'knowledge',
        text: doc.text,
        salience: NON_MEMORY_SALIENCE,
      })
    }
  }

  for (const t of space.notebook ? await space.notebook.list() : []) {
    const body = [t.title, ...t.steps.map((s) => s.text), t.note ?? ''].filter(Boolean).join('\n')
    out.push({
      id: nodeId('task', t.id),
      store: 'task',
      text: body,
      ts: t.updatedAt,
      salience: NON_MEMORY_SALIENCE,
    })
  }

  const history = space.sessions ? await space.sessions.history(space.userId) : []
  history.forEach((m, i) => {
    // ts 缺席:渲染视图已经把盘上那个 `at` 合并掉了(见模块顶注)。
    out.push({
      id: nodeId('session', `${space.userId}#${i}`),
      store: 'session',
      text: m.content,
      salience: NON_MEMORY_SALIENCE,
    })
  })

  const dossiers = space.dossiers
  for (const taskId of dossiers ? (space.dossierIds ?? []) : []) {
    const loaded = await dossiers!.load(taskId)
    if (loaded.kind !== 'ok') continue
    out.push({
      id: nodeId('dossier', `${taskId}#0`),
      store: 'dossier',
      text: loaded.dossier.objective,
      salience: NON_MEMORY_SALIENCE,
    })
    for (const j of await dossiers!.readJournalTail(taskId, DOSSIER_JOURNAL_TAIL)) {
      out.push({
        id: nodeId('dossier', `${taskId}#${j.seg}`),
        store: 'dossier',
        text: [j.did, ...(j.facts ?? [])].join('\n'),
        ts: j.at,
        salience: NON_MEMORY_SALIENCE,
      })
    }
  }

  return out
}

/** 每份档案最多列举这么多段日志——列举也得有界。 */
export const DOSSIER_JOURNAL_TAIL = 100

// ---------------------------------------------------------------------------
// 建网
// ---------------------------------------------------------------------------

/** 一张建好的网:节点 + 边。派生物,可随时丢弃重建。 */
export interface MemoryNet {
  readonly nodes: readonly MemoryNode[]
  readonly edges: readonly AssocEdge[]
}

/** 读一遍五个店,derive 出边,得到一张网。只读。 */
export async function buildMemoryNet(
  space: MemorySpace,
  opts: DeriveEdgesOptions = {},
): Promise<MemoryNet> {
  const nodes = await enumerateMemoryNodes(space)
  return { nodes, edges: deriveEdges(nodes, opts) }
}

// ---------------------------------------------------------------------------
// 跨店召回:一句话进,一串跨店 id 出
// ---------------------------------------------------------------------------

/** 默认取多少个种子。种子是「直接命中」,宁少勿滥——扩散会把邻居带出来。 */
export const DEFAULT_SEED_K = 6

/** 默认每店配额:任何一个店都不许把一页占满。 */
export const DEFAULT_STORE_QUOTA = 3

/**
 * 种子推力的地板。
 *
 * `fuseArms` 给的是**相对**分:0 表示「活下来的候选里最弱的那个」,**不**表示
 * 「没信号」——没信号的项根本不在它返回的 map 里。这个区别在极端情形下会要
 * 命:全场只有一个节点有信号时,min-max 的区间为零,它自己被归一成 0,当种子
 * 的推力就是 0,扩散一片死寂、整页返空——而它恰恰是唯一正确的那条。
 * (2026-09-02 `peanut-allergy` 用例实测撞到:基线满分,接上网反而归零。)
 *
 * 所以把 [0,1] 的相对分仿射到 [SEED_FLOOR, 1] 的绝对推力上:**进了种子集这件事
 * 本身**值 SEED_FLOOR,剩下的由相对分排序。反过来在 `fuseArms` 里改归一化是错
 * 的——零区间归零是 MU-M2 有意的设计(不区分的那条臂让位给另一条臂),动它会
 * 改掉生产检索器的数。
 */
export const SEED_FLOOR = 0.2

export interface CrossStoreRecallOptions {
  /** 返回多少个 id。 */
  readonly k?: number
  /** 取多少个种子。默认 {@link DEFAULT_SEED_K}。 */
  readonly seedK?: number
  /** 每店配额。默认 {@link DEFAULT_STORE_QUOTA};传 map 可逐店设。 */
  readonly quota?: number | ReadonlyMap<MemoryStore, number>
  /** 扩散跳数,透传给 `diffuse`。 */
  readonly hops?: number
  /** 时钟。给了就按双时态过滤:翻篇的既不被激活也不能当桥。 */
  readonly now?: number
}

/**
 * 跨店召回:**一次**调用走遍五个面。
 *
 *   种子(`fuseArms`,与生产检索器同一份融合算术)
 *     → 2 跳扩散(衰减 × 边权 × 显著性,多路径求和)
 *     → 每店配额
 *     → 前 k 个 id
 *
 * 种子在**全部节点**上取而不只在 memory 上:一个直接命中知识库的问题不该先绕
 * 一圈记忆再联想回去。扩散负责的是另一半——问题只擦到某条记忆的边、而真正的
 * 答案在别的店时,把那条边走过去。
 *
 * 配额在扩散**之后**、截断**之前**:先让所有店公平竞争分数,再防止某一个店
 * (通常是会话窗,它天然有一堆近似重复的表面)把整页占满。
 */
export async function crossStoreRecall(
  net: MemoryNet,
  query: string,
  opts: CrossStoreRecallOptions = {},
): Promise<string[]> {
  const k = Math.max(1, Math.floor(opts.k ?? DEFAULT_SEED_K))
  const seedK = Math.max(1, Math.floor(opts.seedK ?? DEFAULT_SEED_K))
  const quota = opts.quota ?? DEFAULT_STORE_QUOTA

  const scored = await fuseArms(query, net.nodes)
  if (scored.size === 0) return []
  const seeds = new Map(
    [...scored.entries()]
      .sort((a, b) => (a[1] !== b[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
      .slice(0, seedK)
      .map(([id, s]): [string, number] => [id, SEED_FLOOR + (1 - SEED_FLOOR) * s]),
  )

  const activated = diffuse(seeds, net.nodes, net.edges, {
    ...(opts.hops === undefined ? {} : { hops: opts.hops }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  })
  return applyStoreQuota(activated, quota)
    .slice(0, k)
    .map((a) => a.id)
}

/**
 * 把一串节点 id 折成**记忆单**:每行带日期与出处店名,按字节收口。
 *
 * 不认识的 id 静默跳过——记忆单是渲染,不是校验;拿一个陈旧 id 来渲染不该让
 * 整页炸掉。
 */
export function renderNetSheet(
  net: MemoryNet,
  ids: readonly string[],
  opts: MemorySheetOptions = {},
): string {
  const byId = new Map(net.nodes.map((n) => [n.id, n]))
  const rows: MemoryNode[] = []
  for (const id of ids) {
    const n = byId.get(id)
    if (n) rows.push(n)
  }
  return renderMemorySheet(rows, opts)
}
