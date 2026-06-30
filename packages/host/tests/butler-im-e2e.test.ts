/**
 * butler-im-e2e — BF-M5: the resident butler folded into the IM channel.
 *
 * The §七 `personal-butler-e2e` gate proves cross-RESTART recall (a brand-new
 * instance, same per-user memory, AFTER a consolidation step). This pins the
 * DIFFERENT, production-shaped claim the user reported missing from the Feishu
 * bot ("它告诉我它没有跨会话记忆"): a SINGLE always-on butler process, serving
 * many history-less IM messages, must remember what it captured ONE MESSAGE AGO
 * — WITHOUT any consolidation.
 *
 * What main.ts wires (mirrored here exactly):
 *   - ONE `createButlerRouter` registered under the chat agent's id, multiplexing
 *     per-user resident butlers by `task.origin.userId`;
 *   - each per-user butler = `PersonalButlerAgent` over `openButlerMemory(userId)`
 *     + the `openButlerRecallIndex` retriever, with `frozenRefreshPerTask: true`
 *     and `frozenMemoryKinds: ['semantic','episodic']` — so a captured turn
 *     surfaces in the NEXT message's frozen block with no consolidation;
 *   - the SAME `<space>/butler/memory` subtree the `/me` privacy view reads;
 *   - an async `suspendNotifier` whose butler escalation sink is INERT for a
 *     pure-memory butler (it never parks for approval).
 *
 * Claims:
 *   1. CROSS-MESSAGE RECALL (the headline) — alice msg1 captures her shop, alice
 *      msg2 → the SAME memoized butler recalls it from the frozen block. This is
 *      the exact bug the Feishu bot exhibited; it FAILS without `frozenRefreshPerTask`.
 *   2. THE REFRESH IS LOAD-BEARING — a control butler built WITHOUT the refresh
 *      freezes at msg1's (empty) block and does NOT recall, proving claim 1 is the
 *      fix at work, not provider luck.
 *   3. NO-LEAK — bob's butler (a different namespace) never sees alice's shop.
 *   4. /me VIEW PARITY — HostButlerMemoryService over the same rootDir reads
 *      alice's capture; bob's tree is separate.
 *
 * The LLM is a deterministic provider (no API key): it reads the frozen block in
 * `req.system` and echoes the shop name when present. The router, the butler
 * loop, per-user memory, capture, and the per-task refresh are the real code.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, InMemoryStorage, type Logger } from '@aipehub/core'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'
import { FileInboxStore } from '@aipehub/inbox'
import { PersonalButlerAgent } from '@aipehub/personal-butler'
import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@aipehub/llm'

import { butlerApprovalItemFor } from '../src/personal-butler-escalation.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { openButlerRecallIndex } from '../src/butler-recall-index.js'
import { createButlerRouter, type ButlerRouter } from '../src/butler-router.js'
import { HostButlerMemoryService } from '../src/butler-memory-service.js'

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

const BUTLER_SYSTEM =
  '你是用户的私人管家。你有长期记忆,会主动帮忙;但凡要改动系统、花钱、对外发送或删除东西,先请示主人再做。'

/** The chat agent id the router stands in for (main.ts reuses the managed row id). */
const ROUTER_ID = 'assistant'

const SHOP = '快乐柠檬'

// ── deterministic provider ────────────────────────────────────────────────
// Answers FROM THE FROZEN BLOCK: if the butler's long-term memory (injected into
// `req.system`) already names the shop, echo it; otherwise acknowledge — and that
// acknowledged turn is what `captureTurns` records to episodic. So whether msg2
// "remembers" is entirely a question of whether msg1's capture reached the block.
class ButlerImProvider implements LlmProvider {
  readonly name = 'butler-im-e2e'

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const sys = req.system ?? ''
    if (sys.includes(SHOP)) {
      yield { type: 'text', text: `我记得,你的奶茶店叫${SHOP}。` }
    } else {
      yield { type: 'text', text: '好的,我都记下了。' }
    }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

describe('butler-im-e2e — BF-M5 resident butler over the IM channel', () => {
  let tmp: string
  let memRoot: string
  let identity: IdentityStore
  let inboxStore: FileInboxStore
  let provider: ButlerImProvider
  let hub: Hub

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-butler-im-e2e-'))
    memRoot = join(tmp, 'butler', 'memory')
    identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
    inboxStore = new FileInboxStore(tmp)
    inboxStore.ensureDirs()
    provider = new ButlerImProvider()

    hub = new Hub({
      storage: new InMemoryStorage(),
      // Mirror main.ts: persist every park, THEN run the butler escalation sink.
      // A pure-memory butler never parks, so this sink stays dormant — claim 1
      // asserts no approval item is ever written.
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
        const approver = task.origin?.userId
        if (approver) {
          const item = butlerApprovalItemFor(task, by, s.state, { approver })
          if (item) await inboxStore.write(item)
        }
      },
    })
    await hub.start()
  })

  afterEach(async () => {
    await hub.stop().catch(() => {})
    identity.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  // Build ONE per-user butler EXACTLY as main.ts's `butlerFactory` does: the chat
  // agent's id, per-user memory + recall index, episodic in the frozen block, and
  // per-task refresh so an always-on instance re-recalls between messages.
  function makeButler(id: string, userId: string, refresh: boolean): PersonalButlerAgent {
    const memory = openButlerMemory({ rootDir: memRoot, userId, logger: silentLogger })
    const recallIndex = openButlerRecallIndex({ rootDir: memRoot, userId, logger: silentLogger })
    return new PersonalButlerAgent({
      id,
      provider,
      system: BUTLER_SYSTEM,
      memory,
      memoryRetriever: recallIndex.retriever({ activeOnly: true }),
      frozenMemoryKinds: ['semantic', 'episodic'],
      frozenRefreshPerTask: refresh,
      captureMeta: { userId },
      // No `benign`, no `governed` → a pure-memory butler that never parks.
    })
  }

  function makeRouter(): ButlerRouter {
    return createButlerRouter({
      id: ROUTER_ID,
      capabilities: ['chat'],
      logger: silentLogger,
      createForUser: (userId) => makeButler(ROUTER_ID, userId, true),
    })
  }

  async function dispatchTo(to: string, userId: string, prompt: string) {
    return hub.dispatch({
      from: `user:${userId}`,
      strategy: { kind: 'explicit', to },
      payload: prompt,
      origin: { orgId: 'local', userId },
    })
  }

  it('claim 1 — remembers across messages in ONE running process (no consolidation)', async () => {
    const router = makeRouter()
    hub.register(router)

    // msg1: the butler has no memory yet → the block is empty → it acknowledges,
    // and that turn (which NAMES the shop) is captured to episodic.
    const r1 = await dispatchTo(ROUTER_ID, 'alice', `我开了一家奶茶店,叫${SHOP},主打芋圆。`)
    expect(r1.kind).toBe('ok')
    if (r1.kind !== 'ok') throw new Error('unreachable')
    expect((r1.output as { text: string }).text).not.toContain(SHOP) // block was empty at msg1

    // msg2: the SAME memoized butler. `frozenRefreshPerTask` re-recalls, so msg1's
    // capture is now in the frozen block → it remembers the shop. THIS is the bug
    // the Feishu bot had ("no cross-session memory") — green only with the refresh.
    const r2 = await dispatchTo(ROUTER_ID, 'alice', '我的奶茶店叫什么名字?')
    expect(r2.kind).toBe('ok')
    if (r2.kind !== 'ok') throw new Error('unreachable')
    expect((r2.output as { text: string }).text).toContain(SHOP)

    // One memoized butler for alice across both messages.
    expect(router.size).toBe(1)

    // The pure-memory butler never parked → the escalation sink wrote nothing.
    expect(await inboxStore.listPending('alice')).toHaveLength(0)
  })

  it('claim 2 — frozenRefreshPerTask is load-bearing (control: no refresh → forgets)', async () => {
    // Same construction, but refresh OFF — the Hermes "one session = one stable
    // prefix" default. The block freezes at msg1's (empty) contents.
    const control = makeButler('control', 'carol', false)
    hub.register(control)

    const c1 = await dispatchTo('control', 'carol', `我开了一家奶茶店,叫${SHOP},主打芋圆。`)
    expect(c1.kind).toBe('ok')

    const c2 = await dispatchTo('control', 'carol', '我的奶茶店叫什么名字?')
    expect(c2.kind).toBe('ok')
    if (c2.kind !== 'ok') throw new Error('unreachable')
    // The frozen block never refreshed → msg1's capture is invisible → it forgot.
    // (Claim 1, same construction WITH refresh, recalls — so the flag is the cause.)
    expect((c2.output as { text: string }).text).not.toContain(SHOP)
  })

  it("claim 3 — no-leak: another member's butler never sees the first member's shop", async () => {
    // Seed alice's namespace directly (order-independent — the state claim 1 builds).
    const aliceMem = openButlerMemory({ rootDir: memRoot, userId: 'alice', logger: silentLogger })
    await aliceMem.remember({ kind: 'semantic', text: `主人的奶茶店叫${SHOP},主打芋圆。` })

    const router = makeRouter()
    hub.register(router)

    // Bob — a DIFFERENT per-user namespace, an empty tree.
    const rb = await dispatchTo(ROUTER_ID, 'bob', '我的奶茶店叫什么名字?')
    expect(rb.kind).toBe('ok')
    if (rb.kind !== 'ok') throw new Error('unreachable')
    expect((rb.output as { text: string }).text).not.toContain(SHOP)

    // Sanity: alice's OWN butler recalls it — proving bob's miss is isolation,
    // not a broken provider.
    const ra = await dispatchTo(ROUTER_ID, 'alice', '我的奶茶店叫什么名字?')
    expect(ra.kind).toBe('ok')
    if (ra.kind !== 'ok') throw new Error('unreachable')
    expect((ra.output as { text: string }).text).toContain(SHOP)

    // Two live butlers behind the one registered router.
    expect(router.size).toBe(2)
  })

  it('claim 4 — the /me privacy view reads the same per-user subtree', async () => {
    const router = makeRouter()
    hub.register(router)

    await dispatchTo(ROUTER_ID, 'alice', `我开了一家奶茶店,叫${SHOP}。`)
    await dispatchTo(ROUTER_ID, 'bob', '你好,认识一下。')

    // The /me view opens the SAME `<space>/butler/memory` rootDir the butler agent
    // writes through — "what the butler remembers" == "what the member can see".
    const view = new HostButlerMemoryService({ rootDir: memRoot, logger: silentLogger })

    const aliceView = await view.read('alice')
    expect(aliceView.recent.some((e) => e.text.includes(SHOP))).toBe(true)

    // Bob's tree is separate — he captured his own turn, never alice's shop.
    const bobView = await view.read('bob')
    expect(bobView.recent.some((e) => e.text.includes(SHOP))).toBe(false)
    expect(bobView.recent.length).toBeGreaterThan(0)
  })
})
