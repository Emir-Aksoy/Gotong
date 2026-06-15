/**
 * C-M2 — family-learning-hub parent IM oversight bridge demo.
 *
 * The PARENT-side half of the family learning loop, reached from an IM client (Telegram, …).
 * When a 孩子 requests an off-whitelist (or moderation-flagged) topic, it parks for the
 * 家长's approval; this bridge pushes that to the parent's IM, lets them /approve or /reject
 * there (or in /me), and pushes the result back. It reuses the im-steward-bridge shape
 * (fake-bridge + identity-resolver + a FORKED router) over a REAL `FileInboxStore`, so the
 * race guard is genuine — a second resolve of the same item is rejected by the store, not by
 * a hand-rolled flag.
 *
 * ★ Scope ★ — this is the IM OVERSIGHT half IN ISOLATION. The cross-hub federation that
 * actually carries an approved lesson to the tutor is C-M1 (`federation.ts`, real ws). Here a
 * `parkLessonApproval(...)` call STANDS IN for "C-M1's outbound gate just parked an
 * off-whitelist topic", so this milestone can focus on closing the parent's approval loop
 * over IM: notify → approve/reject (IM or /me) → push the result back. One concern at a time.
 *
 * The same flow works against the 6 real `@aipehub/im-*` bridges — swap `FakeBridge` for
 * `new TelegramBridge({ token })` and point the port at the host's real inbox surface. The
 * router, the binding flow, and the push-back are unchanged.
 *
 * Run:  pnpm demo:family-learning-hub:im
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openIdentityStore } from '@aipehub/identity'
import type { ImMessage, ImUser } from '@aipehub/im-adapter'
import { FileInboxStore } from '@aipehub/inbox'

import { FakeBridge } from './im-oversight/fake-bridge.js'
import { makeIdentityImBindingResolver } from './im-oversight/identity-resolver.js'
import { FamilyOversightPort } from './im-oversight/oversight-port.js'
import { OversightImRouter } from './im-oversight/oversight-router.js'

/** Tiny throw-on-mismatch assertion (examples have no vitest). */
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`\n  ✗ ASSERTION FAILED: ${msg}\n`)
    process.exit(1)
  }
  console.log(`  ✓ ${msg}`)
}

async function main(): Promise<void> {
  console.log('\n=== family-learning-hub — 家长端 IM 监督桥 (C-M2) ===\n')

  const tmpRoot = mkdtempSync(join(tmpdir(), 'aipehub-family-im-'))
  const identity = openIdentityStore({ dbPath: ':memory:' })
  try {
    // -- 1. Identity: two SOVEREIGN parents, each guarding their own child. --
    const alice = identity.createUser({ email: 'alice@home.example', displayName: '家长 Alice' })
    const bob = identity.createUser({ email: 'bob@home.example', displayName: '家长 Bob' })
    const aliceCode = identity.issueImBindingCode({ userId: alice.id })
    console.log(`  identity   家长 ${alice.id}（孩子 kid-lin） + 家长 ${bob.id}（孩子 kid-sam）`)
    console.log(`  identity   alice 绑定码 ${aliceCode.code} 已签发\n`)

    // -- 2. Oversight port over a REAL FileInboxStore (genuine race guard) ----
    const inbox = new FileInboxStore(join(tmpRoot, 'inbox'))
    inbox.ensureDirs()
    const port = new FamilyOversightPort(inbox)

    // -- 3. Bridge -----------------------------------------------------------
    const bridge = new FakeBridge('telegram')
    bridge.onOutbound = (out) => {
      console.log(`  📤 监督桥 → ${out.to.platformUserId}:`)
      for (const line of out.text.split('\n')) console.log(`     | ${line}`)
    }
    await bridge.start()

    // -- 4. Router (forked from steward-router; /pending /approve /reject) ----
    const resolver = makeIdentityImBindingResolver(identity)
    const router = new OversightImRouter({
      bridge,
      port,
      resolver,
      onUnbind: async (platform, platformUserId) => {
        const n = identity.removeImBinding(platform, platformUserId)
        return { removed: n > 0 }
      },
    })
    router.start()
    console.log('  router     wired (park → notify IM; /approve|/reject → port.resolve; resolve → push back)\n')

    const aliceIm: ImUser = { platform: 'telegram', platformUserId: '2001', displayName: '家长 Alice' }
    const send = async (text: string, note: string): Promise<void> => {
      console.log(`  [in] ${note}`)
      console.log(`  📥 alice → 监督桥: ${text}`)
      const msg: ImMessage = { from: aliceIm, text, chatId: 'private:2001', ts: Date.now() }
      await bridge.inject(msg)
      console.log('')
    }
    const lastOut = (): string => bridge.outbound.at(-1)?.text ?? ''
    const crossedTopics = (): string[] => port.crossed.map((c) => c.topic)
    const countCrossed = (topic: string): number => port.crossed.filter((c) => c.topic === topic).length

    // -- 5. Walk the lifecycle ------------------------------------------------
    await send('/help', '/help before binding — anyone can read it.')
    assert(lastOut().includes('/approve') && lastOut().includes('/pending'), 'help lists the oversight verbs')

    await send('随便聊聊', 'free text before binding — nudged to /bind.')
    assert(lastOut().includes('/bind'), 'unbound free text is nudged to /bind')

    await send(`/bind ${aliceCode.code}`, 'binds with the issued code (alice now reachable).')
    assert(lastOut().includes('已绑定'), 'bind ok — alice is now reachable for push-backs')

    // ── [A] off-whitelist → parks → IM notified → /pending → /approve → crosses ──
    console.log('── [A] 白名单外「投资理财」: 挂起 → 推 IM → /pending → /approve → 跨到导师 ─────')
    await port.parkLessonApproval({ parentUserId: alice.id, learnerId: 'kid-lin', topic: '投资理财', reason: '白名单外主题' })
    assert(lastOut().includes('🔔') && lastOut().includes('投资理财'), '[A] 课程挂起即推到家长 IM (🔔 + 主题)')
    assert(await port.pendingCount(alice.id) === 1, '[A] 家长收件箱有 1 条待批')
    await send('/pending', '[A] list pending lessons.')
    assert(lastOut().includes('1.') && lastOut().includes('投资理财'), '[A] /pending 列出这节课')
    await send('/approve 1', '[A] approve it.')
    assert(lastOut().includes('✓') && lastOut().includes('投资理财'), '[A] 批准结果推回 IM (一条 ✓ 推送, 非 /approve 自身回复)')
    assert(crossedTopics().includes('投资理财'), '[A] 批准后这节课跨到导师 (crossed)')
    assert(await port.pendingCount(alice.id) === 0, '[A] 收件箱已清空')

    // ── [B] off-whitelist → parks → /pending → /reject → does NOT cross ──────
    console.log('── [B] 白名单外「网络赌博」: 挂起 → /pending → /reject → 不开课 (fail-closed) ─────')
    await port.parkLessonApproval({ parentUserId: alice.id, learnerId: 'kid-lin', topic: '网络赌博', reason: '白名单外主题' })
    assert(lastOut().includes('🔔') && lastOut().includes('网络赌博'), '[B] 课程挂起即推到家长 IM')
    await send('/pending', '[B] list pending.')
    await send('/reject 1', '[B] reject it.')
    assert(lastOut().includes('✗') && lastOut().includes('网络赌博'), '[B] 拒绝结果推回 IM')
    assert(!crossedTopics().includes('网络赌博'), '[B] 拒绝的课程不跨到导师 (fail-closed)')
    assert(await port.pendingCount(alice.id) === 0, '[B] 收件箱已清空')

    // ── [C] resolve from /me (SPA) → push-back STILL reaches the bound IM ────
    console.log('── [C] 家长在 /me 批 (非 IM): 挂起 → 推 IM → /me 直接解决 → 结果异步回推 IM ─────')
    const cItem = await port.parkLessonApproval({
      parentUserId: alice.id, learnerId: 'kid-lin', topic: '加密货币交易', reason: '白名单外主题',
    })
    assert(lastOut().includes('🔔') && lastOut().includes('加密货币交易'), '[C] 挂起即推到家长 IM')
    // Simulate the parent opening the /me inbox SPA and resolving there (NOT an IM command).
    const cOutcome = await port.resolve({ parentUserId: alice.id, itemId: cItem, decision: 'approved' })
    assert(cOutcome.status === 'done', '[C] 家长在 /me 直接批准成功')
    assert(
      lastOut().includes('✓') && lastOut().includes('加密货币交易'),
      '[C] /me 批准后结果仍异步回推到家长 IM (D-M2 的意义)',
    )
    assert(crossedTopics().includes('加密货币交易'), '[C] /me 批准后这节课跨到导师')

    // ── [D] race guard — a double /approve on a stale view is rejected once ──
    console.log('── [D] 竞态守卫: /pending 后两次 /approve 同一条 → 第二次被收件箱拒 (只跨一次) ─────')
    await port.parkLessonApproval({ parentUserId: alice.id, learnerId: 'kid-lin', topic: '民间借贷', reason: '白名单外主题' })
    await send('/pending', '[D] snapshot the pending list.')
    await send('/approve 1', '[D] approve (succeeds).')
    assert(lastOut().includes('✓') && lastOut().includes('民间借贷'), '[D] 第一次 /approve 成功并推回')
    await send('/approve 1', '[D] approve AGAIN on the same stale snapshot.')
    assert(lastOut().includes('已经处理过'), '[D] 第二次 /approve 被收件箱竞态守卫拒 (already_resolved)')
    assert(countCrossed('民间借贷') === 1, '[D] 这节课只跨了一次 (重复批准不双开)')

    // ── [E] cross-parent isolation — alice can NEVER resolve bob's child ─────
    console.log('── [E] 跨家长隔离: alice 不能批 bob 孩子的课; bob 才能 ─────────────────────')
    const bobItem = await port.parkLessonApproval({
      parentUserId: bob.id, learnerId: 'kid-sam', topic: '校园暴力应对', reason: '白名单外主题',
    })
    // alice tries to resolve bob's item at the authoritative port layer (defense in depth —
    // the router's per-user lastListed already never surfaces it to her by index).
    const aliceOnBob = await port.resolve({ parentUserId: alice.id, itemId: bobItem, decision: 'approved' })
    assert(aliceOnBob.status === 'forbidden', '[E] alice 解决 bob 孩子的课 → forbidden (所有权闸)')
    assert(!crossedTopics().includes('校园暴力应对'), '[E] 被拒后这节课没跨 (fail-closed)')
    // bob (the right parent) can resolve it.
    const bobOnBob = await port.resolve({ parentUserId: bob.id, itemId: bobItem, decision: 'approved' })
    assert(bobOnBob.status === 'done', '[E] bob 解决自己孩子的课 → done')
    assert(crossedTopics().includes('校园暴力应对'), '[E] 正确的家长批准后才跨')

    // ── /unbind ─────────────────────────────────────────────────────────────
    await send('/unbind', 'drops the binding.')
    assert(lastOut().includes('已解绑'), 'unbind ok')
    await send('还在吗？', 'after unbind, free text is nudged to /bind again.')
    assert(lastOut().includes('/bind'), 'after unbind, free text is nudged to /bind')

    // -- 6. Cross-parent no-leak invariant -----------------------------------
    // Everything ALICE ever saw over IM must never mention BOB's child. Bob never bound an
    // IM identity, so his park/resolve notifications had no target (logged a warn) — alice's
    // transcript is structurally clean.
    const aliceTranscript = bridge.outbound
      .filter((o) => o.to.platformUserId === aliceIm.platformUserId)
      .map((o) => o.text)
      .join('\n')
    assert(!aliceTranscript.includes('kid-sam'), '[no-leak] alice 的 IM 记录从不出现 bob 孩子 kid-sam')
    assert(!aliceTranscript.includes('校园暴力应对'), '[no-leak] alice 的 IM 记录从不出现 bob 孩子的课题')

    // -- 7. Summary -----------------------------------------------------------
    console.log('\n  outbound:', bridge.outbound.length, 'IM 消息')
    console.log('  crossed :', port.crossed.length, '节课跨到导师 —', crossedTopics().join(' / '))
    console.log('\n  ✓ all assertions passed\n')

    await bridge.stop()
  } finally {
    identity.close()
    rmSync(tmpRoot, { recursive: true, force: true })
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('[family-learning-hub im-oversight] fatal:', err)
  process.exit(1)
})
