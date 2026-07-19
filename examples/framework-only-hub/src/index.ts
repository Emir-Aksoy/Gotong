/**
 * framework-only-hub — 「只装框架 + 自带 agent + 零 Atong」的最短证明。
 *
 * 这个进程只 import 了 `@gotong/core`(见 package.json —— 唯一依赖)。
 * 没有 `@gotong/personal-butler`、没有 `@gotong/llm`、没有任何 Atong 模块,
 * 也不联网、不需要任何 key。它证明的是:
 *
 *   Gotong 的框架层(Hub / Participant / 派发 / transcript)本身就是一个
 *   完整可用的多方协作底座 —— 你带上自己的 agent(一个 Participant)就能跑,
 *   Atong(管家)是**另一个包**里的可选装饰,你根本没装它。
 *
 * 场景(一个极简的值班支持台,规则确定、零 LLM):
 *   1. 你自己的 `TriageAgent`(能力 `triage`)按关键词把告警分成 urgent / routine。
 *   2. urgent 的告警显式派给值班工程师(一个 `HumanParticipant`,能力 `ack`)。
 *   3. routine 的就只记进 transcript,不打扰人。
 *
 * 收尾自校验(exit 0 = 全过,exit 1 = 有断言失败):
 *   - triage 的分类结果符合规则;
 *   - urgent 告警真的到了人手上并被 ack;
 *   - **「没有 Atong」的证明分两层**:结构上 —— 本进程只 import `@gotong/core`,而 core
 *     只依赖 `@gotong/protocol`,依赖图里根本没有 `@gotong/personal-butler`,这才是硬证明;
 *     运行时再加一道**花名册哨兵**:注册过的参与者恰好只有你注册的那两个,且没有任何一个
 *     带 `chat` 能力(Atong 站在会话 agent 前面的信号)。
 */

import {
  AgentParticipant,
  Hub,
  HumanParticipant,
  type Task,
  type TranscriptEntry,
} from '@gotong/core'

// Atong 的管家只会“站在”带这个能力的会话 agent 前面(见 host 的
// BUTLER_CHAT_CAPABILITY)。框架层没有它 = 结构上不可能有管家。
const BUTLER_CHAT_CAPABILITY = 'chat'

// --- payload / output 形状(仅为本 demo 可读性) ------------------------------

type Severity = 'urgent' | 'routine'
type TriagePayload = { kind: 'triage'; alert: string }
type TriageOutput = { severity: Severity; reason: string }
type AckPayload = { alert: string; reason: string }

// --- 你自己的 agent:一个确定性分诊器(零 LLM) --------------------------------

class TriageAgent extends AgentParticipant {
  constructor() {
    super({ id: 'triage', capabilities: ['triage'] })
  }

  protected async handleTask(task: Task): Promise<TriageOutput> {
    const { alert } = task.payload as TriagePayload
    // 纯关键词规则 —— 换成你自己的领域逻辑(甚至一个真 LLM agent)也一样接。
    const urgent = /\b(down|outage|breach|crash|urgent|p0|500)\b/i.test(alert)
    return urgent
      ? { severity: 'urgent', reason: '命中高危关键词,需要人立刻看' }
      : { severity: 'routine', reason: '无高危关键词,进日常队列即可' }
  }
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  // 这个 demo 要进 CI 当 exit-0 门。先把退出码钉成失败,只有跑到最后所有断言都过才显式
  // exit(0):这样即便某个 dispatch 永远不返回、Node 事件循环耗尽后自然退出,也不会假绿成
  // 0。看门狗再兜一层上界 —— 卡住就响亮失败,同时它是个 pending timer,堵死「无 timer 就
  // 静默 drain 到 0」那条路。
  process.exitCode = 1
  const watchdog = setTimeout(() => {
    console.error('\n❌ 看门狗超时:demo 卡住了(某个 dispatch 没返回?)')
    process.exit(1)
  }, 15_000)

  const hub = Hub.inMemory()
  await hub.start()

  // 记录每一次「参与者加入」—— 收尾用它做花名册证明,只用了公开的 onEvent。
  const joins: Array<{ id: string; capabilities: readonly string[] }> = []
  hub.onEvent((e: TranscriptEntry) => {
    if (e.kind === 'participant_joined') {
      joins.push({ id: e.data.id, capabilities: e.data.capabilities })
    }
    console.log(`  [seq=${String(e.seq).padStart(2, '0')}] ${describe(e)}`)
  })

  // 你只注册了两个参与者:你的 agent + 一个值班的人。没有别的。
  const triage = new TriageAgent()
  const oncall = new HumanParticipant({ id: 'oncall', capabilities: ['ack'] })
  hub.register(triage)
  hub.register(oncall)

  // 模拟值班工程师的 UI:真实部署里这一圈由 web 收件箱替你做。
  const oncallLoop = (async () => {
    while (true) {
      const task = await oncall.next()
      const p = task.payload as AckPayload
      console.log(`\n  🧑‍🔧 oncall 收到告警: "${p.alert}" (${p.reason})`)
      console.log('     ...看 400ms,然后确认。')
      await sleep(400)
      oncall.complete(task.id, { acked: true })
    }
  })()
  void oncallLoop

  console.log('\n=== framework-only-hub:只装 @gotong/core,自带 agent,零 Atong ===\n')

  const alerts = [
    'prod database is DOWN, api returning 500',
    'typo in the footer copyright year',
  ]

  const outcomes: Array<{ alert: string; severity: Severity; acked: boolean }> = []

  for (const alert of alerts) {
    // 1) 能力派发 —— 派发方只说「要 triage 能力」,不点名 agent。
    const res = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['triage'] },
      payload: { kind: 'triage', alert } satisfies TriagePayload,
      title: `triage: ${alert.slice(0, 32)}`,
    })
    if (res.kind !== 'ok') throw new Error(`triage failed: ${JSON.stringify(res)}`)
    const { severity, reason } = res.output as TriageOutput

    // 2) urgent 的显式派给值班的人;routine 的只记 transcript。
    let acked = false
    if (severity === 'urgent') {
      const ack = await hub.dispatch({
        from: 'system',
        strategy: { kind: 'explicit', to: oncall.id },
        payload: { alert, reason } satisfies AckPayload,
        title: `ack urgent: ${alert.slice(0, 24)}`,
      })
      // 收紧:不只看 dispatch ok,还要值班的人真的回了 acked:true(防以后误写成
      // complete(id,{acked:false}) 时这条断言仍假绿)。
      acked = ack.kind === 'ok' && (ack.output as { acked?: boolean }).acked === true
    } else {
      console.log(`\n  🗂️  routine 告警入日常队列,不打扰人: "${alert}"`)
    }
    outcomes.push({ alert, severity, acked })
  }

  // --- 收尾自校验 -----------------------------------------------------------

  const checks: Array<[string, boolean]> = []
  const dbAlert = outcomes.find((o) => o.alert.includes('database'))!
  const typoAlert = outcomes.find((o) => o.alert.includes('typo'))!

  checks.push(['数据库告警被判 urgent', dbAlert.severity === 'urgent'])
  checks.push(['urgent 告警真的被人 ack 了', dbAlert.acked === true])
  checks.push(['错别字告警被判 routine', typoAlert.severity === 'routine'])
  checks.push(['routine 告警没惊动人(未 ack)', typoAlert.acked === false])

  // 花名册哨兵(运行时信号,不是结构证明):注册过的参与者恰好是你注册的那两个,且没有
  // 任何一个带 `chat` 能力。真正的结构证明是依赖图 —— 本进程只依赖 @gotong/core、core 只
  // 依赖 protocol,压根没有 personal-butler(见文件头注释)。
  const roster = joins.map((j) => j.id).sort()
  const hasButler = joins.some((j) => j.capabilities.includes(BUTLER_CHAT_CAPABILITY))
  checks.push([
    '花名册恰好只有 [oncall, triage]',
    JSON.stringify(roster) === JSON.stringify(['oncall', 'triage']),
  ])
  checks.push(['没有任何参与者带 chat 能力(= 没有 Atong)', hasButler === false])

  console.log('\n=== 自校验 ===')
  let allPass = true
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${name}`)
    if (!ok) allPass = false
  }

  console.log('\n本进程的依赖只有:{ @gotong/core }')
  console.log('没有 @gotong/personal-butler、没有 @gotong/llm、没有 Atong、没联网、没 key。')
  console.log(`transcript 共 ${hub.transcript.size()} 条。`)

  await hub.stop()
  clearTimeout(watchdog)
  if (!allPass) {
    console.error('\n有断言失败。')
    process.exit(1)
  }
  console.log('\n全部通过 ✅ —— 框架层自成一体,你带自己的 agent 就能跑。')
  process.exit(0)
}

// --- helpers ----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function describe(e: TranscriptEntry): string {
  switch (e.kind) {
    case 'participant_joined':
      return `JOIN     ${e.data.id} (${e.data.participantKind}) caps=[${e.data.capabilities.join(',')}]`
    case 'participant_left':
      return `LEAVE    ${e.data.id}`
    case 'task': {
      const s = e.data.strategy
      const target =
        s.kind === 'explicit'
          ? `to=${s.to}`
          : s.kind === 'capability'
            ? `caps=[${s.capabilities.join(',')}]`
            : 'broadcast'
      return `TASK     ${e.data.from} "${e.data.title ?? '(untitled)'}" via ${s.kind} ${target}`
    }
    case 'task_result': {
      const r = e.data
      if (r.kind === 'ok') return `RESULT   ok by ${r.by}`
      if (r.kind === 'failed') return `RESULT   failed by ${r.by}: ${r.error}`
      if (r.kind === 'no_participant') return `RESULT   no_participant: ${r.reason}`
      return `RESULT   ${r.kind}`
    }
    default:
      return e.kind
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
