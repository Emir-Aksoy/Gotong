/**
 * DUO-M3 capstone — 阿同双脑四幕(docs/zh/ATONG-DUAL-BRAIN.md)。
 *
 * 形态:接待脑 = 管家 spec.model 换成轻量模型(DeepSeek V4 Flash 之类),小事
 * 自己答;重活调 escalate_to_expert(本 demo 用的是 REAL
 * `buildButlerEscalateToolset` —— 生产装配同一份代码,零重写),fire-and-forget
 * 转派给 owner 配置的专家 agent,回执立即返回、结果稍后推回同一聊天窗。
 *
 * 四幕(全自断言,零网络零 key 零 LLM,专家用可控 deferred 模拟耗时):
 *   幕1 权限面最窄:工具只有 task_summary 一个参数 —— 转给谁是 owner 在
 *       spec.escalateTo 钉死的,模型只有「转/不转」一个决定。
 *   幕2 回执先于结果:调工具立刻拿到「已转派」回执(专家还在跑),专家完成后
 *       结果才推回同一成员 —— IM 的两条消息形态。
 *   幕3 fail-closed:target 不在成员名下(配置漂移/越权)⇒ 响亮拒 + 零派发。
 *   幕4 诚实失败:派发本身炸掉 ⇒ 成员收到失败话术,绝不静默丢活。
 *
 * 跑:`pnpm demo:atong-dual-brain`(exit 0 = 全部断言通过)。
 */

import { buildButlerEscalateToolset } from '@gotong/host/butler-escalate'

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}`)
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const settle = async () => {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

const silentLog = { warn: () => {}, error: () => {} }

async function main(): Promise<void> {
  console.log('━━ 阿同双脑 — DUO-M3 capstone(真 escalate toolset,mock 专家)━━\n')

  // ── 幕1 权限面最窄 ─────────────────────────────────────────────────────────
  console.log('幕1 权限面:转给谁是 owner 定的,模型只决定转不转')
  {
    const ts = buildButlerEscalateToolset({
      userId: 'emir',
      escalateTo: 'expert-longcat',
      roster: { listOwned: async () => [{ id: 'expert-longcat', label: '深度专家' }] },
      hub: { dispatch: async () => ({ kind: 'ok' }) as never },
      logger: silentLog,
    })
    const tools = await ts.listTools()
    assert(tools.length === 1 && tools[0]!.name === 'escalate_to_expert', '工具面只有 escalate_to_expert 一件')
    const props = (tools[0]!.inputSchema as { properties: Record<string, unknown> }).properties
    assert(Object.keys(props).join(',') === 'task_summary', 'schema 只收 task_summary — 没有 target 参数')
    assert(tools[0]!.description?.includes('先用一两句话回复成员') === true, '「先回执再转派」纪律钉在工具描述里')
  }

  // ── 幕2 回执先于结果 ───────────────────────────────────────────────────────
  console.log('\n幕2 回执先于结果:转派瞬间收到回执,专家完成后结果才推回')
  {
    const expert = deferred<never>()
    const pushed: string[] = []
    const dispatched: Array<{ strategy: { to: string }; origin: { userId: string } }> = []
    const ts = buildButlerEscalateToolset({
      userId: 'emir',
      escalateTo: 'expert-longcat',
      roster: { listOwned: async () => [{ id: 'expert-longcat', label: '深度专家' }] },
      hub: {
        dispatch: (input) => {
          dispatched.push(input as never)
          return expert.promise
        },
      },
      push: (_uid, text) => { pushed.push(text) },
      logger: silentLog,
    })
    const receipt = await ts.callTool('escalate_to_expert', {
      task_summary: '写一份东南亚咖啡市场的完整分析:背景是我们要开第二家店,要产出选址建议。',
    })
    assert(receipt.isError === undefined, '回执立即返回(专家仍在跑)')
    assert(JSON.stringify(receipt.content).includes('已转派给「深度专家」'), '回执点名专家')
    assert(pushed.length === 0, '此刻还没有任何推送 — 结果没好,不装好了')
    assert(dispatched.length === 1 && dispatched[0]!.strategy.to === 'expert-longcat', '派发 explicit 指向 owner 钉的目标')
    assert(dispatched[0]!.origin.userId === 'emir', '派发以成员身份记账(origin.userId)')

    expert.resolve({ kind: 'ok', output: { text: '结论:优先考虑槟城 Gurney 区,理由有三……' } } as never)
    await settle()
    assert(pushed.length === 1, '专家完成 → 恰好一条结果推送')
    assert(pushed[0]!.includes('深度专家') && pushed[0]!.includes('槟城'), '推送带专家名 + 真实结果 — 同一聊天窗第二条消息')
  }

  // ── 幕3 fail-closed ───────────────────────────────────────────────────────
  console.log('\n幕3 fail-closed:target 不在成员名下 ⇒ 响亮拒 + 零派发')
  {
    let dispatches = 0
    const ts = buildButlerEscalateToolset({
      userId: 'guest',
      escalateTo: 'expert-longcat', // 配置指向的专家不在 guest 名下
      roster: { listOwned: async () => [{ id: 'guest-own-helper' }] },
      hub: { dispatch: async () => { dispatches += 1; return { kind: 'ok' } as never } },
      logger: silentLog,
    })
    const r = await ts.callTool('escalate_to_expert', { task_summary: '一件重活' })
    assert(r.isError === true, '拒绝是响亮的(isError)')
    assert(JSON.stringify(r.content).includes('escalateTo'), '话术指向配置根因,不是模糊的「出错了」')
    assert(dispatches === 0, '零派发 — 越权目标一个字节都不发')
  }

  // ── 幕4 诚实失败 ──────────────────────────────────────────────────────────
  console.log('\n幕4 诚实失败:派发炸了 ⇒ 成员收到失败话术,绝不静默丢活')
  {
    const pushed: string[] = []
    const ts = buildButlerEscalateToolset({
      userId: 'emir',
      escalateTo: 'expert-longcat',
      roster: { listOwned: async () => [{ id: 'expert-longcat', label: '深度专家' }] },
      hub: { dispatch: async () => { throw new Error('wire down') } },
      push: (_uid, text) => { pushed.push(text) },
      logger: silentLog,
    })
    const r = await ts.callTool('escalate_to_expert', { task_summary: '一件重活' })
    assert(r.isError === undefined, '回执本身仍成功(失败发生在后台)')
    await settle()
    assert(pushed.length === 1 && pushed[0]!.includes('没能启动'), '失败话术推回成员 — 不静默')
  }

  console.log(`\n━━ 结果:${failures === 0 ? '全部断言通过 ✓' : `${failures} 条断言失败 ✗`} ━━`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('demo crashed:', err)
  process.exit(1)
})
