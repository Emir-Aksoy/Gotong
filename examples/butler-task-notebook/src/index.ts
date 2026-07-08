/**
 * butler-task-notebook — TN-M3 capstone: the WEAK-MODEL claim, proven.
 *
 * The task notebook's whole argument is: "在上下文里记住 8 步计划撑 20 轮" needs
 * a strong model, but "读笔记本 → 做一步 → 勾掉" only needs small, bounded,
 * single-step reasoning. So this demo drives the REAL `PersonalButlerAgent`
 * with a deliberately AMNESIAC scripted provider:
 *
 *   - a FRESH provider instance every turn (zero carried state),
 *   - memory capture OFF (`captureTurns: false` — no episodic crutch),
 *   - every turn starts a brand-new conversation (`req.messages` = just the
 *     new user line — asserted),
 *
 * …and the ONLY way it can know where the mission stands is the notebook
 * digest the agent injects into the system prompt (the TN-M1 recitation seam).
 * A 5-step mission still completes, across 6 independent turns, surviving a
 * "restart" EVERY turn (agent + notebook are rebuilt from disk each time).
 *
 * And the boundary holds under pressure: step 4 is a governed action (send
 * invites = 对外发送). Writing it in the notebook authorizes NOTHING — the
 * turn PARKS for the owner's approval with the step still un-ticked, and only
 * an explicit approval executes it (笔记本 ≠ 授权).
 *
 * Self-asserting; exits 0 only if every invariant holds. No API key.
 *
 * Run:  pnpm demo:butler-task-notebook
 */

import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SuspendTaskError, type Task } from '@gotong/core'
import type { LlmMessage, LlmProvider, LlmRequest, LlmStreamChunk } from '@gotong/llm'
import type { MemoryEntry, MemoryHandle, NewMemoryEntry } from '@gotong/services-sdk'
import {
  GovernedActionToolset,
  PersonalButlerAgent,
  createTaskNotebookToolset,
  openTaskNotebook,
  readButlerGateState,
  readTaskNotesSnapshot,
} from '@gotong/personal-butler'

// ─── mission ──────────────────────────────────────────────────────────────────

const STEPS = ['定日期和预算', '订蛋糕', '订场地', '给宾客发邀请短信', '确认出席人数']
const GOVERNED_STEP = 4 // 1-based — 对外发送, must park for approval

// ─── an inert in-memory MemoryHandle ─────────────────────────────────────────
// The butler requires one, but this demo deliberately gives it NOTHING to lean
// on: capture is off, nothing is ever remembered, the frozen block stays empty.
// Progress has exactly one home — the notebook file.

function inertMemory(): MemoryHandle {
  return {
    recall: async () => [],
    remember: async (ne: NewMemoryEntry): Promise<MemoryEntry> => ({ id: 'x', kind: ne.kind, text: ne.text, ts: 0 }),
    list: async () => [],
    forget: async () => {},
    clear: async () => {},
  }
}

// ─── the amnesiac provider ────────────────────────────────────────────────────
// Everything it "knows" is (re)derived from the request bytes of the CURRENT
// call: the notebook digest in the system prompt, or the tool results of the
// round it is in. There is no instance state that survives a turn — and a new
// instance is constructed per turn anyway.

/** The digest line, e.g. `- [tn-1] 筹备生日会(2/5 步) 下一步: 订场地`.
 *  (The step-count parens are plain ASCII `(` `)` in the digest template —
 *  escaped here so they match literally instead of opening regex groups.) */
const DIGEST_LINE = /- \[(tn-\d+)\] [^\n]*?\((\d+)\/(\d+) 步\) (?:下一步: ([^\n]+)|全部步骤已完成)/

interface TurnLog {
  /** `req.system` of the FIRST provider call of each member turn. */
  systems: string[]
  /** `req.messages.length` at the OPENING of each FRESH member turn (the
   *  approval resume is exempt — it legitimately continues the parked
   *  transcript). 1 everywhere ⇒ no conversation ever crossed a turn. */
  freshTurnMessageCounts: number[]
}

class AmnesiacProvider implements LlmProvider {
  readonly name = 'amnesiac-notebook-model'
  private firstCall = true
  constructor(private readonly log: TurnLog) {}

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    if (this.firstCall) {
      this.firstCall = false
      this.log.systems.push(req.system ?? '')
      const opener = lastUserMessage(req)
      if (typeof opener?.content === 'string') {
        this.log.freshTurnMessageCounts.push(req.messages.length)
      }
    }
    const last = lastUserMessage(req)
    const content = last?.content

    // ── continuation round: read this round's tool results ──
    if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')) {
      const blob = content
        .map((b) => String((b as { content?: unknown }).content ?? ''))
        .join('\n')
      if (blob.includes('已开任务')) {
        yield { type: 'text', text: '好,这件事我记进任务笔记本了,咱们一步一步来。' }
        yield { type: 'end', stopReason: 'end_turn' }
        return
      }
      // Approved governed exec came back → tick THE step it was for. The index
      // comes from our own tool_use earlier in THIS conversation (in-history,
      // not in-brain — an amnesiac can still read the transcript in front of it).
      if (blob.includes('邀请短信已发出')) {
        const call = findToolUse(req.messages, 'send_invites')
        yield {
          type: 'tool_use',
          toolUse: {
            type: 'tool_use',
            id: 'tick-after-send',
            name: 'update_task_note',
            input: { id: String(call?.note_id ?? ''), done_steps: [Number(call?.step ?? 0)] },
          },
        }
        yield { type: 'end', stopReason: 'tool_use' }
        return
      }
      // Ticking the LAST step reports "全部步骤已完成" → wrap up in-turn.
      const finished = blob.match(/\((tn-\d+)\)全部步骤已完成/)
      if (finished) {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'close-1', name: 'close_task_note', input: { id: finished[1] } },
        }
        yield { type: 'end', stopReason: 'tool_use' }
        return
      }
      if (blob.includes('已归档')) {
        yield { type: 'text', text: '这件事全部办完啦 ✅' }
        yield { type: 'end', stopReason: 'end_turn' }
        return
      }
      yield { type: 'text', text: '这一步办好了,其余的我记着账,下次接着推进。' }
      yield { type: 'end', stopReason: 'end_turn' }
      return
    }

    // ── fresh member turn: the ONLY progress source is the digest card ──
    const sys = req.system ?? ''
    const m = sys.match(DIGEST_LINE)
    if (m) {
      const [, id, done, , nextText] = m
      if (nextText === undefined) {
        // all steps done — close it out
        yield { type: 'tool_use', toolUse: { type: 'tool_use', id: 'close-2', name: 'close_task_note', input: { id } } }
        yield { type: 'end', stopReason: 'tool_use' }
        return
      }
      const stepNo = Number(done) + 1 // steps are ticked in order — X done ⇒ next is X+1
      if (nextText.includes('发邀请')) {
        // the governed step — a REAL side effect, so it must go through the gate
        yield {
          type: 'tool_use',
          toolUse: {
            type: 'tool_use',
            id: 'send-1',
            name: 'send_invites',
            input: { note_id: id, step: stepNo, text: nextText },
          },
        }
        yield { type: 'end', stopReason: 'tool_use' }
        return
      }
      yield {
        type: 'tool_use',
        toolUse: {
          type: 'tool_use',
          id: `tick-${stepNo}`,
          name: 'update_task_note',
          input: { id, done_steps: [stepNo] },
        },
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }

    // no notebook card: either the mission kickoff, or nothing to do
    const text = typeof content === 'string' ? content : ''
    if (text.includes('筹备')) {
      yield {
        type: 'tool_use',
        toolUse: {
          type: 'tool_use',
          id: 'open-1',
          name: 'open_task_note',
          input: { title: '筹备生日会', steps: STEPS },
        },
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }
    yield { type: 'text', text: '现在没有在办的事,有什么随时吩咐。' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

function lastUserMessage(req: LlmRequest): LlmMessage | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]!.role === 'user') return req.messages[i]
  }
  return undefined
}

/** Find our own earlier `tool_use` of `name` in the transcript (resume path). */
function findToolUse(messages: readonly LlmMessage[], name: string): Record<string, unknown> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i]!.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      const blk = b as { type?: string; name?: string; input?: Record<string, unknown> }
      if (blk.type === 'tool_use' && blk.name === name) return blk.input
    }
  }
  return undefined
}

// ─── demo harness ─────────────────────────────────────────────────────────────

function task(id: string, prompt: string): Task {
  return { id, from: 'user:alice', strategy: { kind: 'explicit', to: 'butler' }, payload: prompt, createdAt: 1 }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败: ${msg}`)
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gotong-tn-demo-'))
  const file = join(dir, 'tasks.json')
  const log: TurnLog = { systems: [], freshTurnMessageCounts: [] }
  let invitesSent = false

  /**
   * ONE member turn = a FULL RESTART: new provider (amnesia), new notebook
   * store (reloaded from disk), new agent (fresh conversation). Nothing crosses
   * a turn except the bytes in `tasks.json` — which is the entire thesis.
   */
  const turn = (): PersonalButlerAgent => {
    const notebook = openTaskNotebook({ file })
    return new PersonalButlerAgent({
      id: 'butler',
      provider: new AmnesiacProvider(log),
      memory: inertMemory(),
      captureTurns: false, // no episodic crutch — progress lives ONLY in the notebook
      system: '你是这位成员的管家。',
      benign: createTaskNotebookToolset(notebook),
      governed: new GovernedActionToolset({
        tools: [
          {
            name: 'send_invites',
            description: '给宾客发送邀请短信(对外发送)',
            inputSchema: { type: 'object', properties: { note_id: { type: 'string' }, step: { type: 'integer' }, text: { type: 'string' } } },
          },
        ],
        classify: async (name) =>
          name === 'send_invites'
            ? { decision: 'approve', reason: '对外发送短信 — 需要主人确认' }
            : { decision: 'allow' },
        execute: async () => {
          invitesSent = true
          return { text: '邀请短信已发出(12 位宾客)。' }
        },
      }),
      contextProbe: () => notebook.digest(), // TN-M1 recitation seam — the host wires the same thing
      maxToolRounds: 4, // deliberately TIGHT: each turn only ever needs read→one step→tick
    })
  }

  const say = async (id: string, prompt: string): Promise<string> => {
    const res = await turn().onTask(task(id, prompt))
    assert(res.kind === 'ok', `'${prompt}' → expected ok, got '${res.kind}'`)
    const reply = (res.output as { text: string }).text
    console.log(`  成员> ${prompt}\n  管家> ${reply}\n`)
    return reply
  }
  const doneCount = async (): Promise<number> => {
    const [t] = await readTaskNotesSnapshot(file)
    return t ? t.steps.filter((s) => s.done).length : -1
  }

  // ═══ [1] 开任务 — the mission lands on DISK, not in anyone's context ═══
  console.log('━━━ [1] 开任务:计划落盘 ━━━\n')
  await say('t1', '帮我筹备生日会:定日期和预算、订蛋糕、订场地、给宾客发邀请短信、确认出席人数。')
  assert(existsSync(file), '[1] tasks.json 应已写盘')
  const [note] = await readTaskNotesSnapshot(file)
  assert(note && note.status === 'open' && note.steps.length === 5, '[1] 应有一条 5 步的进行中任务')
  assert(await doneCount() === 0, '[1] 尚未做任何一步')
  assert(!log.systems[0]!.includes('【任务笔记本】'), '[1] 开任务前的 system 不应有笔记本卡(空=字节不变)')
  console.log('  [盘] tasks.json 已落盘: 1 条任务 / 5 步 / 0 完成\n')

  // ═══ [2] 失忆推进 — every turn a FULL restart; digest alone carries progress ═══
  console.log('━━━ [2] 失忆推进:每轮全新模型+全新会话,只靠笔记本摘要 ━━━\n')
  for (const [i, prompt] of (['早,今天推进一下生日会的事。', '继续。', '接着办。'] as const).entries()) {
    await say(`t${i + 2}`, prompt)
    assert((await doneCount()) === i + 1, `[2] 第 ${i + 1} 轮后应完成 ${i + 1} 步`)
    const sys = log.systems[i + 1]!
    assert(sys.includes('【任务笔记本】'), `[2] 第 ${i + 1} 轮 system 应带笔记本摘要`)
    assert(sys.includes(`下一步: ${STEPS[i]}`), `[2] 第 ${i + 1} 轮摘要的下一步应是「${STEPS[i]}」`)
  }
  console.log('  [证] 3 轮 × (读摘要 → 做一步 → 勾掉), 进度 3/5 — 模型全程零跨轮记忆\n')

  // ═══ [3] 笔记本 ≠ 授权 — the governed step PARKS, un-ticked ═══
  console.log('━━━ [3] 笔记本≠授权:第 4 步(对外发送)照样 park 等审批 ━━━\n')
  const t5 = task('t5', '继续吧。')
  let parked: { state: unknown } | undefined
  try {
    await turn().onTask(t5)
  } catch (e) {
    assert(e instanceof SuspendTaskError, '[3] 应抛 SuspendTaskError(park)')
    parked = { state: e.state }
  }
  assert(parked, '[3] 敏感步应 park,而不是内联完成')
  const gate = readButlerGateState(parked.state)
  assert(gate?.pending?.approval.toolName === 'send_invites', '[3] park 的应是 send_invites')
  assert(!invitesSent, '[3] 审批前绝不能已发送 — 门失效!')
  assert((await doneCount()) === 3, '[3] 审批前笔记本第 4 步不能被勾掉(笔记本≠授权)')
  console.log(`  成员> 继续吧。`)
  console.log(`  [/me 收件箱] 需要确认: ${gate!.pending!.approval.title}`)
  console.log(`               原因: ${gate!.pending!.approval.reason}\n`)

  // Approve → the SAME parked turn resumes: execute, then tick step 4.
  const resumed = await turn().onResume(t5, { ...(parked.state as object), answer: { approved: true } })
  assert(resumed.kind === 'ok', '[3] 批准后 resume 应完成')
  assert(invitesSent, '[3] 批准后应已发送')
  assert((await doneCount()) === 4, '[3] 批准执行后第 4 步才被勾掉')
  console.log(`  [主人批准 ✅]\n  管家> ${(resumed.output as { text: string }).text}\n`)

  // ═══ [4] 收尾 + 静音 — finish, close, and the card disappears ═══
  console.log('━━━ [4] 收尾:最后一步 + close,摘要随之消失 ━━━\n')
  await say('t6', '把剩下的办完吧。')
  const [closed] = await readTaskNotesSnapshot(file)
  assert(closed && closed.status === 'done' && closed.steps.every((s) => s.done), '[4] 任务应 5/5 并已收尾')
  const bye = await say('t7', '早。')
  assert(!log.systems[log.systems.length - 1]!.includes('【任务笔记本】'), '[4] 收尾后 system 不应再有笔记本卡')
  assert(bye.includes('没有在办的事'), '[4] 无任务时管家如实说闲')

  // ═══ the amnesia was REAL — structural proof ═══
  // 7 member-initiated turns (t1..t7), each opening with EXACTLY the new user
  // line — nothing else. (The one approval resume is exempt by definition: it
  // continues the parked transcript of ITS OWN turn, not a previous one.)
  assert(
    log.freshTurnMessageCounts.length === 7 && log.freshTurnMessageCounts.every((n) => n === 1),
    '[证] 每个成员发起的新轮首调用只带 1 条消息 — 没有任何跨轮会话被携带',
  )

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('✅ 弱模型论点成立:')
  console.log('   [1] 5 步使命写进 tasks.json — 计划在盘上,不在模型脑子里')
  console.log('   [2] 每轮全新模型+全新会话(首调用恒 1 条消息),仅靠注入的摘要推进,3 轮走到 3/5')
  console.log('   [3] 第 4 步对外发送照样 park — 批准前未发送、未勾步(笔记本≠授权)')
  console.log('   [4] 5/5 收尾归档,摘要消失 — 没任务的轮次 prompt 与今天字节不变')
  rmSync(dir, { recursive: true, force: true })
}

main().catch((err) => {
  console.error('[butler-task-notebook] fatal:', err)
  process.exit(1)
})
