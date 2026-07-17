/**
 * butler-knowledge-index.ts — LIB-M3. 阿同知识库的常驻索引卡:把成员(的
 * 阿同)自著的 INDEX.md 注入 **stable 段**(`req.system` 尾,岔口 1a 裁决)。
 *
 * # 为什么落 stable 段(经济学)
 *
 * 索引只在阿同改写 INDEX.md 时变:不变 = 字节相同 = 缓存命中按 0.1× 计价;
 * 改一次破一次缓存,之后重新命中("重算≠变更",LIB-M1 基线的读法)。落
 * volatile 段则每轮全价、永不摊薄——那是给每轮都变的卡(时钟)准备的。
 *
 * # 预算(≤KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS,LIB-M1 同一把尺)
 *
 * 用 `estimateTokens`(AFR-M1/LIB-M1 的标尺)强制,不是字符数近似——承诺
 * 和门量的是同一个数。超预算**按行截断 + 响亮标记**(no silent caps):
 * 保留部分导航比整卡丢弃更诚实(写胖一次不该让阿同全盲),标记指路精简、
 * 把细节挪进子文件。标记本身也在预算内(会把预算吹爆的封顶不叫封顶)。
 *
 * # 空态与失败姿态
 *
 * 无 INDEX.md / 空文件 → null → prompt 字节不变(缓存前缀稳定边界的另一半,
 * 探针的「无信号 = null」同款契约)。读失败(symlink 拒/IO 错)同样降级
 * null——索引卡是顾问,绝不拖垮聊天轮;非「不存在」的失败 warn 一次。
 *
 * 指路不指空(butler-tool-tiers 名单钉的规则):卡文案只说人话("去知识库
 * 读"),不点目录层工具名——那些名字不在一等脸上,点了就是指空。
 */

import { ButlerError, KNOWLEDGE_INDEX_FILE, type KnowledgeLibrary } from '@gotong/personal-butler'

import { estimateTokens } from './butler-toolface-report.js'

/** 索引卡注入预算(token,LIB-M1 estimateTokens 标尺)。M0 计划钉的 ≤500。 */
export const KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS = 500

/** 卡头:说明这是什么、谁维护、正文去哪拿(人话,不点工具名)。 */
const CARD_HEADER = '【知识库索引】(你自著的 INDEX.md;正文按路径去知识库读,改了文件记得同步索引)'

export interface ButlerKnowledgeIndexCardOptions {
  library: KnowledgeLibrary
  logger?: { warn?: (msg: string, meta?: Record<string, unknown>) => void }
  /** 测试缝;生产用常量。 */
  budgetTokens?: number
}

/**
 * 造 stable 段卡 provider(接 `PersonalButlerAgent.stableContext`)。
 * 每轮(含 resume)被 agent 调一次,现读现渲染——新鲜度即文件本身。
 */
export function buildButlerKnowledgeIndexCard(
  opts: ButlerKnowledgeIndexCardOptions,
): () => Promise<string | null> {
  const budget = opts.budgetTokens ?? KNOWLEDGE_INDEX_CARD_BUDGET_TOKENS
  let warned = false
  return async () => {
    let text: string
    try {
      text = (await opts.library.read(KNOWLEDGE_INDEX_FILE)).text
    } catch (err) {
      const notFound = err instanceof ButlerError && err.code === 'knowledge_not_found'
      if (!notFound && !warned) {
        warned = true
        opts.logger?.warn?.('butler knowledge index card degraded to none', { err: String(err) })
      }
      return null
    }
    const body = text.trim()
    if (body === '') return null
    return renderKnowledgeIndexCard(body, budget)
  }
}

/**
 * 渲染 + 预算强制(纯函数,承重门直接测它)。整卡(头+正文+可能的标记)
 * 在预算内;超了按行贪心保留——行是索引的语义单位(一行一个指针),
 * 断行截断会产出半个假路径。
 */
export function renderKnowledgeIndexCard(body: string, budgetTokens: number): string {
  const full = `${CARD_HEADER}\n${body}`
  if (estimateTokens(full) <= budgetTokens) return full

  const lines = body.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const candidate = [...kept, line]
    const withMarker = `${CARD_HEADER}\n${candidate.join('\n')}\n${truncationMarker(candidate.length, lines.length)}`
    if (estimateTokens(withMarker) > budgetTokens) break
    kept.push(line)
  }
  const marker = truncationMarker(kept.length, lines.length)
  return kept.length === 0 ? `${CARD_HEADER}\n${marker}` : `${CARD_HEADER}\n${kept.join('\n')}\n${marker}`
}

function truncationMarker(shown: number, total: number): string {
  return `(索引超出注入预算,只显示前 ${shown}/${total} 行——精简 INDEX.md,把细节挪进子文件)`
}
