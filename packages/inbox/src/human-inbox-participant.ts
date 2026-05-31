/**
 * `HumanInboxParticipant` — the broker that turns a dispatched Task into a
 * parked inbox item a person resolves.
 *
 * North-star alignment: a human is a `Participant`, not a tool. The runner (or
 * any agent) dispatches to the `aipehub.human/v1` capability exactly like any
 * other step; this broker:
 *   1. validates the {@link HumanTaskPayload} (bad → throw, so the step fails
 *      visibly instead of parking a ghost),
 *   2. records an {@link InboxItem} keyed by the Task id,
 *   3. throws `SuspendTaskError` with a FAR-FUTURE `resumeAt` so the timer
 *      sweep never auto-wakes it — only a member's `/me` action does, via
 *      `HostInboxService.resolve`.
 *
 * On resume the host passes `{ answer: <decision> }` as the state; the broker
 * returns the decision, which `AgentParticipant.onResume` wraps as the task's
 * `ok` output — and the parent workflow step's output becomes that decision.
 */

import { AgentParticipant, SuspendTaskError, type ParticipantId, type Task } from '@aipehub/core'

import { HUMAN_CAPABILITY, HUMAN_INBOX_PARTICIPANT_ID, NEVER_RESUME_AT } from './constants.js'
import {
  InboxError,
  type HumanTaskPayload,
  type InboxChoiceOption,
  type InboxEditField,
  type InboxItem,
  type InboxStore,
} from './types.js'

export interface HumanInboxParticipantOptions {
  store: InboxStore
  /** Defaults to `HUMAN_INBOX_PARTICIPANT_ID`. */
  id?: ParticipantId
  /** Defaults to `HUMAN_CAPABILITY`. */
  capability?: string
  /** Clock injection for deterministic tests. */
  now?: () => number
}

export class HumanInboxParticipant extends AgentParticipant {
  private readonly store: InboxStore
  private readonly now: () => number

  constructor(opts: HumanInboxParticipantOptions) {
    super({
      id: opts.id ?? HUMAN_INBOX_PARTICIPANT_ID,
      capabilities: [opts.capability ?? HUMAN_CAPABILITY],
    })
    this.store = opts.store
    this.now = opts.now ?? (() => Date.now())
  }

  protected async handleTask(task: Task): Promise<unknown> {
    // Throws InboxError on a malformed payload — onTask maps that to a `failed`
    // result, so the workflow step fails visibly rather than parking forever.
    const payload = parseHumanPayload(task.payload)

    // The dispatching parent is the last ancestry node. For a workflow human
    // step it's `{taskId: <wf trigger>, by: 'workflow:<id>'}`; resolve uses
    // this (by data, not by position) to resume the parent after the child.
    const parentNode = task.ancestry?.at(-1)
    const parentKind: InboxItem['parentKind'] = !parentNode
      ? 'none'
      : parentNode.by.startsWith('workflow:')
        ? 'workflow'
        : 'agent'

    const item: InboxItem = {
      itemId: task.id,
      userId: payload.assignee,
      kind: payload.kind,
      prompt: payload.prompt,
      parentKind,
      status: 'pending',
      createdAt: this.now(),
    }
    if (payload.title !== undefined) item.title = payload.title
    if (payload.options !== undefined) item.options = payload.options
    if (payload.editField !== undefined) item.editField = payload.editField
    if (parentNode) item.parent = { taskId: parentNode.taskId, by: parentNode.by }

    await this.store.write(item)

    // Park forever — a person, not a timer, wakes this task.
    throw new SuspendTaskError({ resumeAt: NEVER_RESUME_AT, state: { inboxItemId: item.itemId } })
  }

  protected handleResume(_task: Task, state: unknown): unknown {
    const answer = extractAnswer(state)
    if (!answer.found) {
      // No decision in the resume state — a stray wake (shouldn't happen given
      // NEVER_RESUME_AT). Re-park rather than completing with an empty output.
      throw new SuspendTaskError({ resumeAt: NEVER_RESUME_AT, state })
    }
    return answer.value
  }
}

// --- payload parsing -------------------------------------------------------

/**
 * Validate and normalise a dispatched `aipehub.human/v1` payload. Exported so
 * it can be unit-tested directly. Throws `InboxError('invalid_payload')` on
 * anything the broker can't act on.
 */
export function parseHumanPayload(raw: unknown): HumanTaskPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InboxError('invalid_payload', 'human task payload must be an object')
  }
  const p = raw as Record<string, unknown>
  if (typeof p.assignee !== 'string' || p.assignee.length === 0) {
    throw new InboxError(
      'invalid_payload',
      'human task payload.assignee must be a non-empty string (the user id who must act)',
    )
  }
  if (p.kind !== 'approval' && p.kind !== 'choice' && p.kind !== 'edit') {
    throw new InboxError(
      'invalid_payload',
      `human task payload.kind must be 'approval' | 'choice' | 'edit' — got ${JSON.stringify(p.kind)}`,
    )
  }
  if (typeof p.prompt !== 'string' || p.prompt.length === 0) {
    throw new InboxError('invalid_payload', 'human task payload.prompt must be a non-empty string')
  }
  const out: HumanTaskPayload = { assignee: p.assignee, kind: p.kind, prompt: p.prompt }
  if (typeof p.title === 'string') out.title = p.title

  const options = parseOptions(p.options)
  if (p.kind === 'choice' && options.length === 0) {
    throw new InboxError(
      'invalid_payload',
      "human task kind='choice' requires a non-empty payload.options array",
    )
  }
  if (options.length > 0) out.options = options

  if (p.editField !== undefined) out.editField = parseEditField(p.editField)
  return out
}

/** Accept either `[{value,label?}]` or a plain `['yes','no']` shorthand. */
function parseOptions(raw: unknown): InboxChoiceOption[] {
  if (!Array.isArray(raw)) return []
  const out: InboxChoiceOption[] = []
  for (const o of raw) {
    if (typeof o === 'string') {
      out.push({ value: o })
    } else if (o && typeof o === 'object' && typeof (o as { value?: unknown }).value === 'string') {
      const opt: InboxChoiceOption = { value: (o as { value: string }).value }
      const label = (o as { label?: unknown }).label
      if (typeof label === 'string') opt.label = label
      out.push(opt)
    }
  }
  return out
}

function parseEditField(raw: unknown): InboxEditField {
  if (!raw || typeof raw !== 'object') return {}
  const e = raw as Record<string, unknown>
  const out: InboxEditField = {}
  if (typeof e.label === 'string') out.label = e.label
  if (typeof e.placeholder === 'string') out.placeholder = e.placeholder
  if (typeof e.defaultValue === 'string') out.defaultValue = e.defaultValue
  if (typeof e.multiline === 'boolean') out.multiline = e.multiline
  return out
}

function extractAnswer(state: unknown): { found: true; value: unknown } | { found: false } {
  if (state && typeof state === 'object' && 'answer' in state) {
    return { found: true, value: (state as { answer: unknown }).answer }
  }
  return { found: false }
}
