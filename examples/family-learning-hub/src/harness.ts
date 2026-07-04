/**
 * harness.ts — the shared, side-effect-FREE world-builder for family-learning-hub.
 *
 * Both the hermetic demo (`index.ts`, deterministic `LessonTutorStandin`) and real mode
 * (`index.real.ts`, an LlmAgent tutor) build the SAME topology — a 家长 hub running the
 * real `tutor-teach` workflow, a 孩子 hub owning the learning-records master, a third-party
 * hub (only to prove confinement), and the two cross-org links — and drive runs to
 * completion through the SAME two-step resume mirror. Factoring it here keeps that one
 * world definition (and the fail-open fixes it encodes) identical across both entries, and
 * lets `index.real.ts` import it WITHOUT triggering `index.ts`'s top-level `main()`.
 *
 * The ONE thing the two callers vary is the tutor: `buildEnv` takes the `teach.lesson`
 * participant as a parameter (stand-in vs real LlmAgent). Every GATE participant
 * (topic.screen / content.moderate / records.append / report.to-guardian) stays
 * deterministic in both modes — the framework never lets an LLM make a gate decision.
 *
 * The two-step resume (`resolveHumanStep`) is a ~30-line mirror of HostInboxService.resolve
 * (host/src/inbox-service.ts), hand-rolled so the mechanism is visible (cafe-ops /
 * tea-supply-link precedent).
 */

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  Hub,
  InMemoryStorage,
  createInprocHubLinkPair,
  installPeerLink,
  type AgentParticipant,
  type ParticipantId,
  type Task,
  type TaskResult,
} from '@gotong/core'
import { FileInboxStore, HumanInboxParticipant, type InboxDecision, type InboxItem } from '@gotong/inbox'
import { parseWorkflow, WorkflowRunner, type WorkflowDefinition } from '@gotong/workflow'

import {
  ModerationParticipant,
  RecordsAppendParticipant,
  ReportToGuardianParticipant,
  ThirdPartyStandin,
  TopicScreenParticipant,
  type LearningRecord,
  type Lesson,
  type ModerationResult,
  type ModerationRule,
  type ScreenResult,
} from './participants.js'

const WORKFLOWS_DIR = fileURLToPath(new URL('../workflows', import.meta.url))

export const GUARDIAN = 'guardian-parent' as ParticipantId // the 家长 user who approves (local to the 家长 hub)
export const LEARNER = 'kid-lin' // the 孩子 member; /me would force payload.learner_id = this userId
export const CHILD_LEARNING = 'child-learning' // the data class tagged on every cross-hub step

/** Two reusable decisions the 家长 makes in their inbox. */
export const APPROVE: InboxDecision = { kind: 'approval', approved: true }
export const REJECT: InboxDecision = { kind: 'approval', approved: false }

/** The `tutor-teach` workflow's output shape (steps: screen → guardian-approval → teach → moderate → mod-approval). */
export interface LessonOut {
  screened?: ScreenResult
  lesson?: Lesson
  moderated?: ModerationResult
}

/** In-memory stand-in for identity.suspended_tasks — what a parked task needs to resume. */
export interface ParkedRow {
  agentId: ParticipantId
  state: unknown
  taskJson: string
}

/**
 * One self-contained world: a 家长 hub running the real `tutor-teach` workflow, a 孩子 hub
 * owning the learning-records master, a third-party hub (only to prove confinement), and
 * the two cross-org links. The tutor that serves `teach.lesson` is supplied by the caller.
 */
export interface Env {
  name: string
  parentHub: Hub
  childHub: Hub
  thirdPartyHub: Hub
  guardianInbox: ReportToGuardianParticipant
  thirdParty: ThirdPartyStandin
  childDesk: RecordsAppendParticipant
  inbox: FileInboxStore
  parked: Map<string, ParkedRow>
  def: WorkflowDefinition
}

/** Make a fresh temp root for one demo run (caller rms it at teardown). */
export function makeTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'gotong-family-learning-'))
}

/**
 * Build one world. `tutor` serves `teach.lesson` (a `LessonTutorStandin` in the hermetic
 * demo, an LlmAgent in real mode); `moderationRules` is a per-env knob so the SAME content
 * can run with rules ON and OFF to prove the rule-engine layer is opt-out.
 */
export async function buildEnv(
  name: string,
  tmpRoot: string,
  moderationRules: readonly ModerationRule[],
  tutor: AgentParticipant,
): Promise<Env> {
  const root = join(tmpRoot, name)
  mkdirSync(root, { recursive: true })
  const childRecordsRoot = join(root, 'child-hub')
  const parked = new Map<string, ParkedRow>()
  const inbox = new FileInboxStore(root)
  inbox.ensureDirs()

  // 家长 hub — runs the tutor-teach WORKFLOW + serves its gate capabilities + the human
  // broker + the local fork sink. A real host parks suspended tasks in
  // identity.suspended_tasks; the demo records them in `parked` and wakes them by hand.
  const parentHub = new Hub({
    storage: new InMemoryStorage(),
    suspendNotifier: (task, by, s) => {
      parked.set(task.id, { agentId: by, state: s.state, taskJson: JSON.stringify(task) })
    },
  })
  await parentHub.start()
  const guardianInbox = new ReportToGuardianParticipant()
  parentHub.register(new HumanInboxParticipant({ store: inbox })) // gotong.human/v1 — both approval steps
  parentHub.register(new TopicScreenParticipant()) // topic.screen — ★ the gate-level fail-open fix (real boolean)
  parentHub.register(new ModerationParticipant(moderationRules)) // content.moderate — the OPTIONAL rule-engine layer
  parentHub.register(tutor) // teach.lesson — deterministic stand-in OR a real LlmAgent (real mode)
  parentHub.register(guardianInbox) // report.to-guardian — the local oversight fork sink

  // 孩子 hub — owns the learning-records MASTER copy (records.append writes to ITS disk).
  const childHub = new Hub({ storage: new InMemoryStorage() })
  await childHub.start()
  const childDesk = new RecordsAppendParticipant(childRecordsRoot)
  childHub.register(childDesk)

  // third-party hub — only here to PROVE child data can't escape to it.
  const thirdPartyHub = new Hub({ storage: new InMemoryStorage() })
  await thirdPartyHub.start()
  const thirdParty = new ThirdPartyStandin()
  thirdPartyHub.register(thirdParty)

  // 家长 → 孩子 link: the per-link contract CLEARS child-learning and advertises
  // records.append (advertise = authorize, G-M1). This is how the lesson's master copy
  // crosses to the 孩子 hub where it belongs.
  const childLink = createInprocHubLinkPair({ aPeerId: 'child-hub', bPeerId: 'parent-hub' })
  installPeerLink({
    hub: parentHub,
    link: childLink.a,
    selfHubId: 'parent-hub',
    remoteCapabilities: ['records.append'],
    outboundCaps: ['records.append'],
    allowedDataClasses: [CHILD_LEARNING],
  })
  installPeerLink({ hub: childHub, link: childLink.b, selfHubId: 'child-hub' })

  // 家长 → 第三方 link: clears ONLY 'public' → anything tagged child-learning fails closed
  // here. Same data-class lock as §六; lets [C] prove "child data flows only to the cleared 孩子".
  const thirdLink = createInprocHubLinkPair({ aPeerId: 'third-party-hub', bPeerId: 'parent-hub' })
  installPeerLink({
    hub: parentHub,
    link: thirdLink.a,
    selfHubId: 'parent-hub',
    remoteCapabilities: ['thirdparty.ingest'],
    outboundCaps: ['thirdparty.ingest'],
    allowedDataClasses: ['public'],
  })
  installPeerLink({ hub: thirdPartyHub, link: thirdLink.b, selfHubId: 'third-party-hub' })

  // The 家长 tutor-teach WORKFLOW — parsed by the REAL parseWorkflow (the same one the
  // template importer runs), so a broken workflow YAML fails the demo loudly. topic.screen
  // and content.moderate are served by the deterministic participants above, NOT the agent.
  const def = parseWorkflow(readFileSync(join(WORKFLOWS_DIR, 'tutor-teach.yaml'), 'utf8'))
  parentHub.register(new WorkflowRunner({ definition: def, hub: parentHub }))

  return { name, parentHub, childHub, thirdPartyHub, guardianInbox, thirdParty, childDesk, inbox, parked, def }
}

export async function teardown(env: Env): Promise<void> {
  await Promise.all([env.parentHub.stop(), env.childHub.stop(), env.thirdPartyHub.stop()])
}

/** Dispatch the 孩子's learning request onto the 家长 hub (it "arrived" cross-org — model 2). */
export async function dispatchLesson(env: Env, topic: string): Promise<TaskResult> {
  return env.parentHub.dispatch({
    from: 'child-portal' as ParticipantId,
    strategy: { kind: 'capability', capabilities: [env.def.trigger.capability] },
    // /me would force payload.learner_id = the member's own userId; we pass it directly.
    payload: { topic, learner_id: LEARNER, guardian_id: GUARDIAN },
    title: '孩子的学习申请',
  })
}

/** The 孩子 workflow's downstream master write — records.append crosses parent→child (cleared for child-learning). */
export async function appendRecord(env: Env, lesson: Lesson): Promise<LearningRecord> {
  const r = await env.parentHub.dispatch({
    from: 'parent-orchestrator' as ParticipantId,
    strategy: { kind: 'capability', capabilities: ['records.append'] },
    dataClasses: [CHILD_LEARNING], // child data — crosses to the CLEARED 孩子 hub, fail-closed everywhere else
    payload: { learner_id: lesson.learnerId, topic: lesson.topic, lesson },
    title: '把这一课记入孩子学习档案 (主副本, 跨 hub 写到孩子)',
  })
  return okOutput(r, 'records.append') as LearningRecord
}

/** The 孩子 workflow's downstream oversight fork — report.to-guardian, LOCAL on the 家长 hub. */
export async function reportFork(env: Env, lesson: Lesson): Promise<{ forked?: boolean }> {
  const r = await env.parentHub.dispatch({
    from: 'parent-orchestrator' as ParticipantId,
    strategy: { kind: 'capability', capabilities: ['report.to-guardian'] },
    payload: { learner_id: lesson.learnerId, summary: { lessonNo: lesson.lessonNo, title: lesson.title } },
    title: 'fork 一份监督副本给家长',
  })
  return okOutput(r, 'report.to-guardian') as { forked?: boolean }
}

/** Record the master copy on the 孩子 hub AND fork an oversight copy to the 家长. */
export async function recordAndFork(env: Env, lesson: Lesson): Promise<LearningRecord> {
  const record = await appendRecord(env, lesson)
  await reportFork(env, lesson)
  return record
}

/**
 * Drive a workflow run to completion, resolving each `human:` step it parks on. A single
 * run can park MORE THAN ONCE (off-whitelist topic gate, then content gate), so this loops
 * until the run is no longer suspended, collecting the gates it hit (for assertions).
 */
export async function driveToCompletion(
  env: Env,
  fired: TaskResult,
  decide: (item: InboxItem) => InboxDecision,
): Promise<{ result: TaskResult; gates: InboxItem[] }> {
  let result = fired
  const gates: InboxItem[] = []
  let guard = 0
  while (result.kind === 'suspended') {
    if (++guard > 10) throw new Error('run suspended more than 10 times — possible loop')
    const pending = await env.inbox.listPending(GUARDIAN)
    if (pending.length === 0) throw new Error('run suspended but the 家长 inbox has no pending item')
    const item = pending[0]!
    gates.push(item)
    result = await resolveHumanStep(env.parentHub, env.inbox, env.parked, item.itemId, decide(item))
  }
  return { result, gates }
}

/**
 * Resolve a parked `human:` step and resume — the two-step pattern from
 * `HostInboxService.resolve` (host/src/inbox-service.ts), hand-rolled so the mechanism is
 * visible. The three invariants that keep it correct:
 *   1. flip pending→resolved FIRST (race guard) — a repeat resolve can't double-wake.
 *   2. resume the CHILD broker before the PARENT workflow — until the child resumes, the
 *      parent's lookup of the child result is still `suspended`.
 *   3. only drop the parent row when it actually finished (it could re-suspend on another
 *      human step — off-whitelist + flagged parks twice).
 */
export async function resolveHumanStep(
  hub: Hub,
  store: FileInboxStore,
  parked: Map<string, ParkedRow>,
  itemId: string,
  decision: InboxDecision,
): Promise<TaskResult> {
  const item = await store.get(itemId)
  if (!item) throw new Error(`inbox item '${itemId}' not found`)

  // (1) race guard — pending → resolved before any resume.
  await store.markResolved(itemId, decision)

  // (2) resume the CHILD broker with the decision as its answer.
  const childRow = parked.get(itemId)
  if (!childRow) throw new Error('child broker task was not parked')
  const childTask = JSON.parse(childRow.taskJson) as Task
  await hub.resumeTask(childRow.agentId, childTask, { answer: decision })
  parked.delete(itemId)

  // (3) resume the PARENT workflow run (child strictly before parent).
  if (item.parentKind !== 'workflow' || !item.parent) {
    throw new Error('expected a workflow parent for this demo step')
  }
  const parentRow = parked.get(item.parent.taskId)
  if (!parentRow) throw new Error('parent workflow task was not parked')
  if (parentRow.agentId !== item.parent.by) {
    throw new Error(`parent agent mismatch: ${parentRow.agentId} !== ${item.parent.by}`)
  }
  const parentTask = JSON.parse(parentRow.taskJson) as Task
  const result = await hub.resumeTask(item.parent.by, parentTask, parentRow.state)
  // only drop the parent row once the run is actually done (not re-suspended on another gate).
  if (result.kind !== 'suspended') parked.delete(item.parent.taskId)
  return result
}

export function okOutput(r: TaskResult, label: string): unknown {
  if (r.kind !== 'ok') throw new Error(`${label}: expected an 'ok' result, got '${r.kind}'`)
  return (r as { output: unknown }).output
}

export function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`)
  console.log(`  ✓ ${label}`)
}

export function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}
