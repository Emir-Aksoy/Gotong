/**
 * acp-escalation-inbox-e2e — the ACP-HITL acceptance gate.
 *
 * acp-agent-e2e proved the PARTICIPANT seam (escalate → park → resume) with a
 * HAND-WIRED inbox and a hand-rolled resume. This drives the PRODUCTION wiring
 * that main.ts assembles, end to end:
 *
 *   - AcpOutboundManager registers an AcpParticipant with `escalateDanger: true`,
 *     so its gate ESCALATES a destructive tool instead of denying it inline;
 *   - a production-shaped ASYNC suspendNotifier persists the park AND runs the
 *     `acpApprovalItemFor` sink → an `approval` InboxItem in the approver's queue
 *     (exactly the closure main.ts installs);
 *   - HostInboxService.resolve runs the real two-step recovery (`{...row.state,
 *     answer}` so the ACP adapter re-finds its in-memory permissionToken).
 *
 * Approve → the held ACP turn finishes with no drift. Reject → fail-closed (the
 * destructive work never runs). The mock ACP server is spawned for real (real
 * stdio / NDJSON) and stands in for claude-code-acp / codex-acp.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, InMemoryStorage, type Logger } from '@gotong/core'
import { ACP_NEVER_RESUME_AT } from '@gotong/acp-agent'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import { FileInboxStore } from '@gotong/inbox'

import { AcpOutboundManager } from '../src/acp-outbound.js'
import { acpApprovalItemFor } from '../src/acp-escalation.js'
import { HostInboxService } from '../src/inbox-service.js'

const MOCK_ACP = fileURLToPath(new URL('./fixtures/mock-acp-server.mjs', import.meta.url))
/** The approver the sink assigns ACP approvals to (main.ts uses the org owner). */
const APPROVER = 'owner-user'

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silentLogger
  },
}

interface AcpOutput {
  text: string
  stopReason: string
  permissionApproved?: boolean
}

describe('ACP-HITL — destructive coding action escalates to a /me approval', () => {
  let tmp: string
  let identity: IdentityStore
  let hub: Hub
  let inboxStore: FileInboxStore
  let manager: AcpOutboundManager
  let hostInbox: HostInboxService

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-acp-hitl-'))
    identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
    inboxStore = new FileInboxStore(tmp)
    inboxStore.ensureDirs()

    hub = new Hub({
      storage: new InMemoryStorage(),
      // Mirror main.ts: persist the park, THEN turn an ACP permission park into a
      // /me approval item. Awaited, so the item exists before dispatch returns.
      suspendNotifier: async (task, by, s) => {
        identity.persistSuspendedTask({
          taskId: task.id,
          agentId: by,
          hubId: 'local',
          originUserId: task.origin?.userId ?? null,
          resumeAt: s.resumeAt,
          state: s.state,
          taskJson: JSON.stringify(task),
        })
        const item = acpApprovalItemFor(task, by, s.state, { approver: APPROVER })
        if (item) await inboxStore.write(item)
      },
    })
    await hub.start()

    // The manager materialises the stored agent with escalateDanger=true — the
    // production gate posture when an inbox + owner exist.
    manager = new AcpOutboundManager({ hub, source: identity, logger: silentLogger, escalateDanger: true })
    identity.addAcpAgent({ id: 'acp-coder', capabilities: ['code'], command: process.execPath, args: [MOCK_ACP] })
    manager.registerAllFromStore()

    hostInbox = new HostInboxService({ hub, store: inboxStore, identity, logger: silentLogger })
  })

  afterEach(async () => {
    manager.remove('acp-coder') // onShutdown → kill the held child
    await hub.stop().catch(() => {})
    identity.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  async function dispatchDestructive(prompt: string): Promise<string> {
    const fired = await hub.dispatch({
      from: 'human',
      strategy: { kind: 'capability', capabilities: ['code'] },
      payload: { prompt },
    })
    expect(fired.kind).toBe('suspended')
    if (fired.kind !== 'suspended') throw new Error('expected suspended')
    return fired.taskId
  }

  it('escalates → approval item appears → approve finishes the held turn (no drift)', async () => {
    const taskId = await dispatchDestructive('cleanup please — NEED_PERM')

    // The sink wrote an approval item to the approver's /me inbox (deterministic:
    // the awaited suspendNotifier completed before dispatch returned).
    const pending = await inboxStore.listPending(APPROVER)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.itemId).toBe(taskId)
    expect(pending[0]!.kind).toBe('approval')
    expect(pending[0]!.prompt).toContain('acp-coder')
    expect(pending[0]!.prompt).toContain('rm -rf build')

    // Parked at the never-resume sentinel → the 30s sweep can NEVER wake it; only
    // a person's resolve does.
    const row = identity.getSuspendedTask(taskId)
    expect(row!.resumeAt).toBe(ACP_NEVER_RESUME_AT)
    expect(identity.listDueSuspendedTasks({ now: Date.now() }).some((d) => d.taskId === taskId)).toBe(false)

    // The real resolve path: race-guarded markResolved → two-step recovery.
    await hostInbox.resolve({
      itemId: taskId,
      userId: APPROVER,
      decision: { kind: 'approval', approved: true },
    })

    // The item is resolved and the park row is gone.
    expect((await inboxStore.get(taskId))!.status).toBe('resolved')
    expect(identity.getSuspendedTask(taskId)).toBeNull()

    // The held turn finished ok, no drift: the pre-permission stream is preserved
    // AND the post-permission work ran on the SAME session.
    const res = hub.taskResult(taskId)
    expect(res?.kind).toBe('ok')
    const out = (res as { output: AcpOutput }).output
    expect(out.stopReason).toBe('end_turn')
    expect(out.permissionApproved).toBe(true)
    expect(out.text).toContain('perm:allowed')
  })

  it('rejecting the approval is fail-closed — the destructive action never runs', async () => {
    const taskId = await dispatchDestructive('wipe everything — NEED_PERM')
    expect(await inboxStore.listPending(APPROVER)).toHaveLength(1)

    await hostInbox.resolve({
      itemId: taskId,
      userId: APPROVER,
      decision: { kind: 'approval', approved: false },
    })

    expect((await inboxStore.get(taskId))!.status).toBe('resolved')
    const res = hub.taskResult(taskId)
    // ACP semantics: a denied permission is NOT a hub-level failure — the agent
    // declines the tool and finishes the turn with a 'refusal' stopReason.
    expect(res?.kind).toBe('ok')
    const out = (res as { output: AcpOutput }).output
    expect(out.stopReason).toBe('refusal')
    expect(out.permissionApproved).toBe(false)
    expect(out.text).not.toContain('perm:allowed')
  })

  it('a foreign user cannot resolve the owner-assigned approval', async () => {
    const taskId = await dispatchDestructive('cleanup — NEED_PERM')
    // The item belongs to APPROVER; a different member is forbidden (ownership
    // check in HostInboxService.resolve, before any resume runs).
    await expect(
      hostInbox.resolve({ itemId: taskId, userId: 'someone-else', decision: { kind: 'approval', approved: true } }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    // Still parked + still pending — nothing leaked through.
    expect(identity.getSuspendedTask(taskId)).not.toBeNull()
    expect((await inboxStore.get(taskId))!.status).toBe('pending')
  })
})
