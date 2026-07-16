/**
 * AFR-M5 防腐门 — 面包屑接线:三处零 LLM 播报(BE-M5 运行播报 / CARE-M2 断供
 * 播报 / CARE-M6 长断供升级卡)的尾部必须带静态 topic 指针,且指针问句 = 真实
 * 卡标题(从卡常量派生 —— 卡改名这里当场红,面包屑结构性不指空)。
 *
 * 面包屑纪律:
 *   ① 指针是成员会照抄的自然问话,绝不甩生工具名(gotong_guide/use_tool 是
 *      模型的事,不是成员的话);
 *   ② 只在「有修法可指」的分支附(run done/cancelled 不附,恢复播报不附);
 *   ③ 断供类播报诚实标「到时/恢复后」—— 断供期大脑拉不了卡,不许假装能答。
 */

import { describe, expect, it } from 'vitest'

import { BUTLER_GUIDE_CARDS, guideBreadcrumb } from '../src/personal-butler-guide.js'
import { llmOutageAnnouncement, llmRecoveryAnnouncement } from '../src/llm-outage.js'
import { outageEscalationCard } from '../src/personal-butler-patrol.js'
import { runBroadcastMessage } from '../src/personal-butler-run-broadcast.js'
import type { ButlerRunView } from '../src/personal-butler-observe.js'

/** 指针问句必须等于真实卡标题 —— 查不到就地失败,绝不放过指空。 */
function cardTitle(id: string): string {
  const card = BUTLER_GUIDE_CARDS.find((c) => c.id === id)
  expect(card, `面包屑指向的卡 ${id} 不存在`).toBeDefined()
  return card!.title
}

function run(over: Partial<ButlerRunView> & Pick<ButlerRunView, 'status'>): ButlerRunView {
  return { runId: 'r1', workflowId: 'wf', startedAt: 1, endedAt: 2, ...over }
}

describe('AFR-M5 — 零 LLM 播报的向导卡面包屑', () => {
  it('guideBreadcrumb:问句=卡标题、支持换开头,自然话术不甩生工具名', () => {
    const b = guideBreadcrumb('workflow-failed')
    expect(b).toBe(`想看修法,问我「${cardTitle('workflow-failed')}」就行。`)
    expect(guideBreadcrumb('llm-outage', '到时想看完整修法')).toBe(
      `到时想看完整修法,问我「${cardTitle('llm-outage')}」就行。`,
    )
    for (const s of [b, guideBreadcrumb('backup')]) {
      expect(s).not.toContain('gotong_guide')
      expect(s).not.toContain('use_tool')
    }
  })

  it('BE-M5 运行播报:失败分支尾带 workflow-failed 指针;done/cancelled 不附', () => {
    const failed = runBroadcastMessage(run({ status: 'failed', error: '密钥无效' }))
    expect(failed).toContain(`问我「${cardTitle('workflow-failed')}」`)
    // 没有修法可指的分支不附 —— 面包屑不是口头禅
    expect(runBroadcastMessage(run({ status: 'done' }))).not.toContain('问我「')
    expect(runBroadcastMessage(run({ status: 'cancelled' }))).not.toContain('问我「')
  })

  it('CARE-M2 断供播报:zh 尾带 llm-outage 指针且诚实标「到时」;en 有同义指路;恢复播报不附', () => {
    const zh = llmOutageAnnouncement('auth', 'zh')
    expect(zh).toContain(`问我「${cardTitle('llm-outage')}」`)
    expect(zh).toContain('到时') // 断供期拉不了卡,指针只许许诺恢复之后
    const en = llmOutageAnnouncement('auth', 'en')
    expect(en).toContain("Once I'm back, ask me")
    expect(llmRecoveryAnnouncement('zh')).not.toContain('问我「')
  })

  it('CARE-M6 长断供升级卡:fact 尾带 llm-outage 指针,标「恢复后」', () => {
    const T0 = 1_000_000_000
    const card = outageEscalationCard({ kind: 'auth', since: T0 - 31 * 60_000, announced: true }, T0, 30 * 60_000)
    expect(card).not.toBe(null)
    expect(card!.fact).toContain(`问我「${cardTitle('llm-outage')}」`)
    expect(card!.fact).toContain('恢复后')
  })
})
