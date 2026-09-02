/**
 * memory-integration-benchmark.ts — 记忆经济 M1 的尺子(整合召回)。
 *
 * # 它量的是什么
 *
 * 阿同的记忆今天散在七个店里(personal-memory 的 episodic/semantic/working、
 * `knowledge/` md 树、`tasks.json` 笔记本、会话窗、长任务档案)。每个店各自
 * 有自己的门:MU-M1 那把尺子只量 personal-memory 一家的 recall,写侧 M-EVAL
 * 只量整理决策。**没有任何一把尺子问过「一次提问,答案跨两个店时能不能都拿到」**
 * ——而那正是「一块一块 vs 整体」这句诊断的可测形式。
 *
 * 这把尺子就是那个问题:给一个成员空间和一句提问,召回返回一串**节点 id**
 * (跨店寻址),按黄金集算 recall@k / MRR / 命中率。
 *
 * # 四条承重判断
 *
 * ① **算术只有一份**。评分全部委托给 `@gotong/personal-memory` 的
 *    {@link scoreRankedIds} / {@link aggregateRankedScores} ——两把尺子的数字
 *    要能相互比较,就必须出自同一个实现,否则一次「提升」和一次「算术差异」
 *    从数字上分不出来。这里连一行 recall 公式都不许重写。
 *
 * ② **空间是真店不是假件**。{@link openIntegrationSpace} 拿真
 *    `openKnowledgeLibrary` / `openTaskNotebook` / `ButlerSessionWindow` /
 *    `openLongRunDossierStore` 在一个 tmpdir 里建**同一个**成员空间(注入固定
 *    钟)。一个共享空间意味着**别的用例的内容天然是这一例的干扰项**;若为省事
 *    造一套假店,M2 就可能在假件上通过而在真店上不通过。
 *
 * ③ **会话节点指的是渲染视图不是盘上流水**。`history()` 会合并同角色连续轮、
 *    丢掉结尾的 user 轮;`session:<userId>#<i>` 的 `<i>` 是**渲染后**那一列的
 *    下标。理由不是省事:模型看见的就是渲染后那份,指盘上流水会指到一条模型
 *    根本读不到的东西。
 *
 * ④ **基线结构上只会吐 `memory:`**。{@link memoryOnlyRecall} 是今天的生产
 *    召回(MU-M2 融合检索器)套一层前缀,它**没有任何路径**能返回别的店的 id。
 *    于是跨店用例在基线上拿的是**部分分**(黄金集里 memory 那半能中)而不是 0
 *    ——部分分比 0 更有信息量,且与 MU-M1 里 `semantic` 类恒 0 那条诚实天花板
 *    是同一种写法:把「这条路今天走不通」如实量出来,而不是假装没这条路。
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  aggregateRankedScores,
  buildInvertedIndex,
  formatRankedResult,
  fusedRetriever,
  scoreRankedIds,
  type RankedAggregate,
  type RankedCaseScore,
} from '@gotong/personal-memory'
import type { MemoryEntry } from '@gotong/services-sdk'

import { openKnowledgeLibrary, type KnowledgeLibrary } from './knowledge-library.js'
import { openLongRunDossierStore, type LongRunDossierStore } from './longrun-dossier.js'
import { ButlerSessionWindow } from './session-window.js'
import { openTaskNotebook, type TaskNotebook } from './task-notebook.js'

/** 七个店折成五个可寻址的面(personal-memory 的三种 kind 共用 `memory:`,
 *  因为它们本来就在一个店里、一个 id 空间里)。 */
export type IntegrationStore = 'memory' | 'knowledge' | 'task' | 'session' | 'dossier'

export const INTEGRATION_STORES: readonly IntegrationStore[] = [
  'memory',
  'knowledge',
  'task',
  'session',
  'dossier',
] as const

/**
 * 节点 id = `<store>:<pointer>`。
 *
 * pointer 是**那个店自己的**寻址方式,不另发一套 id:
 *   - `memory:<MemoryEntry.id>`
 *   - `knowledge:<相对 knowledge/ 的路径>`
 *   - `task:tn-<n>`
 *   - `session:<userId>#<渲染视图下标>`
 *   - `dossier:<taskId>#<seg>`(`#0` = objective 本身,`#n` = 第 n 段日志)
 *
 * 不发新 id 是刻意的:节点 id 必须能**原路指回**盘上那一条,否则 M2 的联想网
 * 会变成第二份真相。
 */
export function nodeId(store: IntegrationStore, pointer: string): string {
  return `${store}:${pointer}`
}

export function parseNodeId(id: string): { store: IntegrationStore; pointer: string } | null {
  const at = id.indexOf(':')
  if (at <= 0) return null
  const store = id.slice(0, at)
  if (!INTEGRATION_STORES.includes(store as IntegrationStore)) return null
  const pointer = id.slice(at + 1)
  if (!pointer) return null
  return { store: store as IntegrationStore, pointer }
}

// ---------------------------------------------------------------------------
// 空间:一个成员,五个真店,一口固定钟
// ---------------------------------------------------------------------------

/** 夹具往空间里放什么。内容归夹具,机制归这里。 */
export interface IntegrationSpaceSeed {
  /** personal-memory 的条目(episodic/semantic/working 都在这一份里)。 */
  readonly entries: readonly MemoryEntry[]
  readonly knowledge: readonly { readonly path: string; readonly markdown: string }[]
  readonly tasks: readonly {
    readonly title: string
    readonly steps: readonly string[]
    readonly note?: string
    /** 收尾的任务仍在盘上(list 返回),但不再进复述卡。 */
    readonly close?: boolean
  }[]
  readonly session: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[]
  readonly dossiers: readonly {
    readonly taskId: string
    readonly objective: string
    readonly journal: readonly { readonly did: string; readonly facts?: readonly string[] }[]
  }[]
}

export interface IntegrationSpace {
  readonly dir: string
  readonly userId: string
  readonly now: () => number
  readonly entries: readonly MemoryEntry[]
  readonly knowledge: KnowledgeLibrary
  readonly notebook: TaskNotebook
  readonly sessions: ButlerSessionWindow
  readonly dossiers: LongRunDossierStore
  readonly dossierIds: readonly string[]
}

export interface OpenIntegrationSpaceOptions {
  /** 空间根(测试传 tmpdir)。 */
  readonly dir: string
  readonly userId: string
  /** 固定钟。所有店都吃它,分数才字节稳定。 */
  readonly now: () => number
  readonly seed: IntegrationSpaceSeed
}

const silentLogger = { warn: () => {} }

/**
 * 建一个真成员空间并把种子内容写进去。布局镜像生产:
 * `<dir>/knowledge/`、`<dir>/tasks.json`、`<dir>/sessions/`、`<dir>/longrun/`。
 */
export async function openIntegrationSpace(opts: OpenIntegrationSpaceOptions): Promise<IntegrationSpace> {
  const { dir, userId, now, seed } = opts
  await mkdir(dir, { recursive: true })

  const knowledge = openKnowledgeLibrary({ dir: join(dir, 'knowledge'), now, logger: silentLogger })
  for (const f of seed.knowledge) await knowledge.write(f.path, f.markdown)

  const notebook = openTaskNotebook({ file: join(dir, 'tasks.json'), now, logger: silentLogger })
  for (const t of seed.tasks) {
    const note = await notebook.openNote({
      title: t.title,
      steps: [...t.steps],
      ...(t.note === undefined ? {} : { note: t.note }),
    })
    if (t.close) await notebook.closeNote(note.id)
  }

  const sessions = new ButlerSessionWindow({ rootDir: join(dir, 'sessions'), now, logger: silentLogger })
  for (const m of seed.session) await sessions.append(userId, m.role, m.text)

  const dossiers = openLongRunDossierStore({ dir: join(dir, 'longrun'), now, logger: silentLogger })
  for (const d of seed.dossiers) {
    await dossiers.create({ taskId: d.taskId, userId, objective: d.objective })
    let seg = 0
    for (const j of d.journal) {
      seg += 1
      await dossiers.appendJournal(d.taskId, {
        seg,
        did: j.did,
        ...(j.facts ? { facts: [...j.facts] } : {}),
      })
    }
  }

  return {
    dir,
    userId,
    now,
    entries: seed.entries,
    knowledge,
    notebook,
    sessions,
    dossiers,
    dossierIds: seed.dossiers.map((d) => d.taskId),
  }
}

/** 一个节点:id + 它背后那段字。 */
export interface IntegrationNode {
  readonly id: string
  readonly store: IntegrationStore
  readonly text: string
}

/**
 * 把空间里**当下能被指到的**节点全列出来。
 *
 * 这既是夹具卫生检查的依据(每个黄金 id 必须真指到东西,拼错的 id 会永远静默
 * 得 0 分),也正是 M2 联想网建索引时要走的那趟读。列举只读不写:不改名、不建
 * 目录、不落一个字节。
 */
export async function enumerateNodes(space: IntegrationSpace): Promise<IntegrationNode[]> {
  const out: IntegrationNode[] = []

  for (const e of space.entries) {
    out.push({ id: nodeId('memory', e.id), store: 'memory', text: e.text })
  }

  const listing = await space.knowledge.list()
  for (const f of listing.files) {
    const doc = await space.knowledge.read(f.path)
    out.push({ id: nodeId('knowledge', f.path), store: 'knowledge', text: doc.text })
  }

  for (const t of await space.notebook.list()) {
    const body = [t.title, ...t.steps.map((s) => s.text), t.note ?? ''].filter(Boolean).join('\n')
    out.push({ id: nodeId('task', t.id), store: 'task', text: body })
  }

  const history = await space.sessions.history(space.userId)
  history.forEach((m, i) => {
    out.push({ id: nodeId('session', `${space.userId}#${i}`), store: 'session', text: m.content })
  })

  for (const taskId of space.dossierIds) {
    const loaded = await space.dossiers.load(taskId)
    if (loaded.kind !== 'ok') continue
    out.push({ id: nodeId('dossier', `${taskId}#0`), store: 'dossier', text: loaded.dossier.objective })
    for (const j of await space.dossiers.readJournalTail(taskId, 100)) {
      const body = [j.did, ...(j.facts ?? [])].join('\n')
      out.push({ id: nodeId('dossier', `${taskId}#${j.seg}`), store: 'dossier', text: body })
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// 被测件与用例
// ---------------------------------------------------------------------------

/** 被测的召回:一句话进,一串节点 id 出(已按相关度排序)。 */
export type IntegratedRecall = (query: { text: string; k: number }) => Promise<readonly string[]>

/**
 * 工厂而不是实例——基线与 M2 必须跑**同一批用例、同一个空间**,由尺子决定
 * 什么时候构造,被测件不能自己挑输入。
 */
export type IntegratedRecallFactory = (space: IntegrationSpace) => IntegratedRecall | Promise<IntegratedRecall>

/** `single-store` 是对照组(答案只在一个店里),`cross-store` 才是本尺子要量的余量。 */
export type IntegrationCategory = 'single-store' | 'cross-store'

export interface IntegrationCase {
  readonly name: string
  readonly category: IntegrationCategory
  readonly query: { readonly text: string; readonly k?: number }
  /** 黄金节点 id(跨店时列多个店的)。 */
  readonly gold: readonly string[]
  /** 这一例为什么这么标——写下来,免得后来的人按分数反推标注。 */
  readonly why: string
}

export interface IntegrationCaseScore extends RankedCaseScore {
  readonly name: string
  readonly k: number
}

export interface IntegrationBenchResult extends RankedAggregate {
  readonly k: number
  readonly perCase: readonly IntegrationCaseScore[]
}

/**
 * 跑一遍用例。
 *
 * 工厂**只调一次**(与 MU-M1 每例一个语料刻意不同):这里只有一个共享空间,
 * 别的用例的内容就是这一例的干扰项。
 */
export async function scoreIntegration(
  make: IntegratedRecallFactory,
  space: IntegrationSpace,
  cases: readonly IntegrationCase[],
  k = 5,
): Promise<IntegrationBenchResult> {
  const recall = await make(space)
  const perCase: IntegrationCaseScore[] = []

  for (const c of cases) {
    const caseK = c.query.k ?? k
    const ranked = await recall({ text: c.query.text, k: caseK })
    const score = scoreRankedIds(ranked, new Set(c.gold), caseK)
    perCase.push({ name: c.name, category: c.category, k: caseK, ...score })
  }

  return { k, ...aggregateRankedScores(perCase), perCase }
}

export function formatIntegrationResult(label: string, r: IntegrationBenchResult): string {
  return formatRankedResult(label, r.k, r)
}

// ---------------------------------------------------------------------------
// 基线:今天的生产召回
// ---------------------------------------------------------------------------

/**
 * 今天的召回:MU-M2 的融合检索器打 personal-memory 一家,结果套上 `memory:`
 * 前缀。它**结构上**吐不出别的店的 id ——这不是实现偷懒,这就是「一块一块」
 * 那句诊断的可执行形式,也是 M2 要抬的那条线的起点。
 */
export function memoryOnlyRecall(space: IntegrationSpace): IntegratedRecall {
  const retriever = fusedRetriever(buildInvertedIndex(space.entries), {
    activeOnly: true,
    now: space.now,
  })
  return async (q) => {
    const page = await retriever.retrieve({ text: q.text, k: q.k })
    return page.map((e) => nodeId('memory', e.id))
  }
}

/**
 * 一个 id 现在指到什么(指不到就是 null)。
 *
 * 刻意走 {@link enumerateNodes} 而不是自己按 store 分派再查一遍:两份「什么算
 * 存在」的实现迟早会不一致,而不一致的那一天,夹具卫生检查会说黄金 id 有效、
 * 召回却永远拿不到它——一条静默得 0 分的用例比一条红的用例坏得多。
 */
export async function resolveNode(space: IntegrationSpace, id: string): Promise<IntegrationNode | null> {
  const nodes = await enumerateNodes(space)
  return nodes.find((n) => n.id === id) ?? null
}
