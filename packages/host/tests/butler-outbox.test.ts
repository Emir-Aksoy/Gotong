/**
 * CARE-M8 承重门 — the butler's persistent DELIVERY retry (ButlerOutbox).
 *
 * `ButlerReachableRegistry.push` is best-effort: a member whose bridge is
 * mid-reconnect (or who never bound a chat) gets `{delivered:false}`, and every
 * caller (outage broadcast, patrol escalation, reminder, approval push-back, run
 * broadcast) can only LOG that miss. The line is lost — a briefly-unreachable
 * member never learns the brain broke (or came back).
 *
 * The outbox is the primitive that closes that: a failed push is appended to a
 * file-first per-member queue and re-sent when the member next speaks
 * (record → flush) or on the cadence sweep. This gate pins the contract:
 *
 *   1. deliver on success = pass-through, nothing enqueued;
 *   2. deliver on failure = returns the SAME typed failure AND persists the line;
 *   3. flush retries FIFO and STOPS on the first failure — order survives retries;
 *   4. bounded, and LOUD about it: queue cap drops oldest (warn), TTL drops stale
 *      (info) — never a silent cap (CONVENTIONS);
 *   5. flushAll sweeps every queued member; corrupt file → empty, never a crash;
 *   6. per-member lock serializes read-modify-write so a concurrent double
 *      deliver can't lose an item.
 *
 * Pure unit test: `push` and `now` are injected, so no bridge, no token, no real
 * clock — the failure/recovery edge is driven by flipping a boolean.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ButlerOutbox } from '../src/butler-outbox.js'
import type { ButlerPushResult } from '../src/butler-reachable.js'
import type { ImLogger } from '../src/im-bridge.js'

/** A capturing logger — lets a test read back the "no silent caps" info/warn lines. */
class LoggerHolder {
  readonly warns: Array<{ msg: string; ctx?: Record<string, unknown> }> = []
  readonly infos: Array<{ msg: string; ctx?: Record<string, unknown> }> = []
  readonly log: ImLogger = {
    info: (msg, ctx) => void this.infos.push({ msg, ...(ctx ? { ctx } : {}) }),
    warn: (msg, ctx) => void this.warns.push({ msg, ...(ctx ? { ctx } : {}) }),
    error: () => {},
  }
}

/** A controllable push — flip `reachable` to simulate a bridge coming back. */
class PushController {
  readonly calls: Array<{ userId: string; text: string }> = []
  reachable = false
  reason: 'unknown_member' | 'no_bridge' | 'send_failed' = 'no_bridge'
  push = async (userId: string, text: string): Promise<ButlerPushResult> => {
    this.calls.push({ userId, text })
    if (this.reachable) return { delivered: true }
    return { delivered: false, reason: this.reason }
  }
}

describe('ButlerOutbox (CARE-M8)', () => {
  let dir: string
  const USER = 'user_alice'

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gotong-outbox-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('deliver: success passes through and enqueues nothing', async () => {
    const push = new PushController()
    push.reachable = true
    const outbox = new ButlerOutbox({ dir, push: push.push, logger: new LoggerHolder().log })

    const r = await outbox.deliver(USER, 'hello')

    expect(r).toEqual({ delivered: true })
    expect(await outbox.pending(USER)).toBe(0)
    expect(push.calls).toHaveLength(1)
  })

  it('deliver: failure returns the same typed result AND persists the line', async () => {
    const push = new PushController()
    push.reason = 'no_bridge'
    const outbox = new ButlerOutbox({ dir, push: push.push, logger: new LoggerHolder().log })

    const r = await outbox.deliver(USER, 'the brain broke')

    expect(r).toEqual({ delivered: false, reason: 'no_bridge' })
    expect(await outbox.pending(USER)).toBe(1)
    // and it really hit disk, not just memory
    const raw = JSON.parse(await readFile(join(dir, `${USER}.json`), 'utf8'))
    expect(raw).toHaveLength(1)
    expect(raw[0].text).toBe('the brain broke')
  })

  it('flush: member comes back → FIFO re-delivery, then file removed', async () => {
    const push = new PushController()
    const outbox = new ButlerOutbox({ dir, push: push.push, logger: new LoggerHolder().log })

    await outbox.deliver(USER, 'first')
    await outbox.deliver(USER, 'second')
    await outbox.deliver(USER, 'third')
    expect(await outbox.pending(USER)).toBe(3)
    push.calls.length = 0 // forget the 3 failed attempts

    push.reachable = true
    await outbox.flush(USER)

    expect(push.calls.map((c) => c.text)).toEqual(['first', 'second', 'third']) // FIFO
    expect(await outbox.pending(USER)).toBe(0)
    // empty queue = no stale shell left on disk
    await expect(readFile(join(dir, `${USER}.json`), 'utf8')).rejects.toThrow()
  })

  it('flush: stops on first failure and keeps the rest in order', async () => {
    const push = new PushController()
    const outbox = new ButlerOutbox({ dir, push: push.push, logger: new LoggerHolder().log })

    await outbox.deliver(USER, 'a')
    await outbox.deliver(USER, 'b')
    await outbox.deliver(USER, 'c')

    // Reachable for exactly one send, then the bridge drops again mid-flush.
    push.reachable = true
    let firstDone = false
    const controlledPush = async (u: string, t: string): Promise<ButlerPushResult> => {
      const res = await push.push(u, t)
      if (!firstDone) {
        firstDone = true
        push.reachable = false // next send fails
      }
      return res
    }
    const outbox2 = new ButlerOutbox({ dir, push: controlledPush, logger: new LoggerHolder().log })
    await outbox2.flush(USER)

    // 'a' delivered; 'b','c' remain in original order for the next flush
    expect(await outbox2.pending(USER)).toBe(2)
    const raw = JSON.parse(await readFile(join(dir, `${USER}.json`), 'utf8'))
    expect(raw.map((it: { text: string }) => it.text)).toEqual(['b', 'c'])
  })

  it('flush: persists after EACH delivery so a mid-flush crash re-sends at most one item (audit P2)', async () => {
    // Five queued lines. The bridge delivers the first two, then push THROWS on
    // the third (a transport fault / process crash mid-flush). The old code
    // persisted the shrunken queue only AFTER the whole loop, so a throw skipped
    // the write entirely → disk still held all five → 'a'/'b' would re-send on the
    // next flush (duplicate). Per-delivery checkpointing must leave disk at [c,d,e].
    const delivered: string[] = []
    let flushCall = 0
    let reachable = false
    const push = async (_userId: string, text: string): Promise<ButlerPushResult> => {
      // Enqueue phase: everything fails so all five land on disk.
      if (!reachable) return { delivered: false, reason: 'no_bridge' }
      // Flush phase: deliver a, b; crash on the third (c).
      flushCall++
      if (flushCall === 3) throw new Error('boom mid-flush')
      delivered.push(text)
      return { delivered: true }
    }
    const outbox = new ButlerOutbox({ dir, push, logger: new LoggerHolder().log })

    for (const t of ['a', 'b', 'c', 'd', 'e']) await outbox.deliver(USER, t)
    expect(await outbox.pending(USER)).toBe(5)

    reachable = true
    await expect(outbox.flush(USER)).rejects.toThrow('boom mid-flush')

    // Only a and b were delivered; the crash never re-sends them because the queue
    // was shrunk to [c, d, e] on disk before the throw.
    expect(delivered).toEqual(['a', 'b'])
    expect(await outbox.pending(USER)).toBe(3) // old code: 5
    const raw = JSON.parse(await readFile(join(dir, `${USER}.json`), 'utf8'))
    expect(raw.map((it: { text: string }) => it.text)).toEqual(['c', 'd', 'e'])
  })

  it('cap: queue full drops the OLDEST and warns loudly', async () => {
    const cap = new LoggerHolder()
    const push = new PushController()
    const outbox = new ButlerOutbox({ dir, push: push.push, logger: cap.log, maxQueue: 3 })

    for (const t of ['m1', 'm2', 'm3', 'm4', 'm5']) await outbox.deliver(USER, t)

    expect(await outbox.pending(USER)).toBe(3)
    const raw = JSON.parse(await readFile(join(dir, `${USER}.json`), 'utf8'))
    expect(raw.map((it: { text: string }) => it.text)).toEqual(['m3', 'm4', 'm5']) // oldest gone
    expect(cap.warns.some((w) => w.msg.includes('queue full'))).toBe(true) // not silent
  })

  it('TTL: flush drops lines older than maxAgeMs and says so', async () => {
    const cap = new LoggerHolder()
    const push = new PushController()
    let clock = 1_000_000
    const outbox = new ButlerOutbox({
      dir,
      push: push.push,
      logger: cap.log,
      now: () => clock,
      maxAgeMs: 60_000, // 1 min
    })

    await outbox.deliver(USER, 'stale') // enqueued at t=1_000_000
    push.calls.length = 0 // forget the failed initial attempt
    clock += 120_000 // 2 min later — past TTL
    push.reachable = true
    await outbox.flush(USER)

    expect(push.calls.map((c) => c.text)).not.toContain('stale') // never re-sent
    expect(await outbox.pending(USER)).toBe(0)
    expect(cap.infos.some((i) => i.msg.includes('expired'))).toBe(true)
  })

  it('flushAll: sweeps every queued member', async () => {
    const push = new PushController()
    const outbox = new ButlerOutbox({ dir, push: push.push, logger: new LoggerHolder().log })

    await outbox.deliver('user_a', 'to a')
    await outbox.deliver('user_b', 'to b')
    expect(await outbox.pending('user_a')).toBe(1)
    expect(await outbox.pending('user_b')).toBe(1)

    push.reachable = true
    await outbox.flushAll()

    expect(await outbox.pending('user_a')).toBe(0)
    expect(await outbox.pending('user_b')).toBe(0)
  })

  it('corrupt file → treated as empty, never crashes', async () => {
    await writeFile(join(dir, `${USER}.json`), 'not json at all {{{', 'utf8')
    const push = new PushController()
    const outbox = new ButlerOutbox({ dir, push: push.push, logger: new LoggerHolder().log })

    expect(await outbox.pending(USER)).toBe(0)
    await expect(outbox.flush(USER)).resolves.toBeUndefined()
  })

  it('lock: concurrent delivers to the same member lose nothing', async () => {
    const push = new PushController() // stays unreachable → all enqueue
    const outbox = new ButlerOutbox({ dir, push: push.push, logger: new LoggerHolder().log })

    await Promise.all(Array.from({ length: 20 }, (_, i) => outbox.deliver(USER, `msg-${i}`)))

    expect(await outbox.pending(USER)).toBe(20) // no lost writes from interleaving
  })
})
