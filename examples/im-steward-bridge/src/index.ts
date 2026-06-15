/**
 * v5 Stream SW Phase D — IM steward bridge demo.
 *
 * Reaches the hub steward (管家) from an IM client. Spins up IdentityStore +
 * FakeStewardPort + FakeBridge + the steward-aware router in-process and walks the
 * full lifecycle a member would experience over Telegram:
 *
 *   1. /help before binding — anyone can read it.
 *   2. free text before binding — nudged to /bind.
 *   3. /bind <code> — linked.
 *   4. "帮我建一个客服助手" — steward proposes a SAFE create; /apply runs it inline.
 *   5. "删掉 mailer 助手" — steward proposes a DANGEROUS delete; /apply PARKS it to
 *      the /me inbox; resolving it APPROVED notifies back over IM and executes.
 *   6. "改一下跨 hub 的评审工作流" — CROSS-HUB edit; /apply parks; resolving REJECTED
 *      notifies back and does NOT execute (fail-closed).
 *   7. "帮我配置 openai 凭证" — operator-only sensitive ask; the member steward
 *      REFUSES (explains + points to settings). No secret ever touches chat.
 *   8. /unbind — binding removed.
 *
 * The same flow works against the 6 real `@aipehub/im-*` bridges — swap
 * `FakeBridge` for `new TelegramBridge({ token })` and point the `StewardPort` at
 * the host's real `MeHubStewardSurface`. The router, the binding flow, and the
 * tier badges are unchanged. That's the point of an example-first bridge.
 *
 * Run:  pnpm --filter @aipehub/example-im-steward-bridge start
 */

import { openIdentityStore } from '@aipehub/identity'
import type { ImMessage, ImUser } from '@aipehub/im-adapter'

import { FakeBridge } from './fake-bridge.js'
import { makeIdentityImBindingResolver } from './identity-resolver.js'
import { FakeStewardPort } from './steward-port.js'
import { StewardImRouter } from './steward-router.js'

/** Tiny throw-on-mismatch assertion (examples have no vitest). */
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`\n  ✗ ASSERTION FAILED: ${msg}\n`)
    process.exit(1)
  }
  console.log(`  ✓ ${msg}`)
}

async function main(): Promise<void> {
  console.log('\n=== AipeHub demo: im-steward-bridge (v5 Stream SW Phase D) ===\n')

  // -- 1. Identity ----------------------------------------------------------
  const identity = openIdentityStore({ dbPath: ':memory:' })
  const alice = identity.createUser({ email: 'alice@example.com', displayName: 'Alice' })
  const code = identity.issueImBindingCode({ userId: alice.id })
  console.log(`  identity   user ${alice.id} created; binding code ${code.code} issued`)

  // -- 2. Steward port (deterministic stand-in; REAL classifier) ------------
  const port = new FakeStewardPort()

  // -- 3. Bridge ------------------------------------------------------------
  const bridge = new FakeBridge('telegram')
  bridge.onOutbound = (out) => {
    console.log(`  📤 管家 → ${out.to.platformUserId}:`)
    for (const line of out.text.split('\n')) console.log(`     | ${line}`)
  }
  await bridge.start()

  // -- 4. Router ------------------------------------------------------------
  const resolver = makeIdentityImBindingResolver(identity)
  const router = new StewardImRouter({
    bridge,
    port,
    resolver,
    onUnbind: async (platform, platformUserId) => {
      const n = identity.removeImBinding(platform, platformUserId)
      return { removed: n > 0 }
    },
  })
  router.start()
  console.log('  router     wired (free-text → steward.plan; /apply → steward.apply)\n')

  const aliceImUser: ImUser = { platform: 'telegram', platformUserId: '1001', displayName: 'Alice' }
  const send = async (text: string, note: string): Promise<void> => {
    console.log(`  [in] ${note}`)
    console.log(`  📥 alice → 管家: ${text}`)
    const msg: ImMessage = { from: aliceImUser, text, chatId: 'private:1001', ts: Date.now() }
    await bridge.inject(msg)
    console.log('')
  }

  // -- 5. Walk the lifecycle ------------------------------------------------
  await send('/help', '/help before binding — anyone can read it.')
  await send('帮我建个助手', 'free text before binding — nudged to /bind.')
  await send(`/bind ${code.code}`, 'binds with the issued code.')

  // ── SAFE: create an agent → applied inline ──────────────────────────────
  await send('帮我建一个客服助手', 'steward proposes a SAFE create_agent.')
  await send('/apply 1', 'apply the create — runs inline.')
  assert(
    port.createdAgents.includes(`me.${alice.id}.support`),
    'create_agent executed inline (safe tier) — agent created',
  )

  // ── DANGEROUS: delete an agent → parks to inbox → approve → executes ─────
  await send('删掉 mailer 助手', 'steward proposes a DANGEROUS delete_agent.')
  await send('/apply 1', 'apply the delete — PARKS to the /me inbox (not run yet).')
  assert(port.pendingInboxCount() === 1, 'delete parked to approval inbox (dangerous → second confirmation)')
  assert(port.deletedAgents.length === 0, 'delete NOT executed while parked (fail-closed)')

  console.log('  [me] Alice opens her /me inbox and APPROVES the delete.')
  await port.resolveInbox(port.latestPendingFor(alice.id)!, 'approved')
  console.log('')
  assert(port.deletedAgents.includes(`me.${alice.id}.mailer`), 'approved delete executed after /me confirmation')
  assert(port.pendingInboxCount() === 0, 'inbox cleared after resolve')

  // ── CROSS-HUB: edit a cross-hub workflow → parks → reject → not executed ─
  await send('改一下跨 hub 的评审工作流', 'steward proposes a CROSS-HUB edit_workflow.')
  await send('/apply 1', 'apply the cross-hub edit — PARKS to the /me inbox.')
  assert(port.pendingInboxCount() === 1, 'cross-hub edit parked (cross_hub → second confirmation)')

  console.log('  [me] Alice opens her /me inbox and REJECTS the cross-hub edit.')
  await port.resolveInbox(port.latestPendingFor(alice.id)!, 'rejected')
  console.log('')
  assert(
    !port.editedWorkflows.includes('cross-hub-review'),
    'rejected cross-hub edit NOT executed (fail-closed)',
  )

  // ── FORBIDDEN: a sensitive (operator-only) ask → refused ────────────────
  await send('帮我配置 openai 凭证', 'operator-only sensitive ask — member steward REFUSES.')
  await send('/apply 1', 'apply the refuse — returns refused (never executes).')

  // ── /unbind ─────────────────────────────────────────────────────────────
  await send('/unbind', 'drops the binding.')
  await send('还在吗？', 'after unbind, free text is nudged to /bind again.')

  // -- 6. No-secret-in-transit invariant (B discipline carried to IM) -------
  const allOutbound = bridge.outbound.map((o) => o.text).join('\n')
  for (const forbidden of ['sk-', 'secret', 'OPENAI_API_KEY=']) {
    assert(!allOutbound.includes(forbidden), `no plaintext secret in IM transcript (no "${forbidden}")`)
  }
  // The refusal mentions the ENV-VAR discipline but never a key value.
  assert(
    allOutbound.includes('环境变量') && allOutbound.includes('凭证'),
    'sensitive refusal explains the env-var discipline (no secret in chat)',
  )

  // -- 7. Summary -----------------------------------------------------------
  console.log('\n  outbound:', bridge.outbound.length, 'IM replies sent')
  console.log('  created :', port.createdAgents.length, '| deleted:', port.deletedAgents.length, '| edited:', port.editedWorkflows.length)
  console.log('\n  ✓ all assertions passed\n')

  await bridge.stop()
  identity.close()
  process.exit(0)
}

main().catch((err) => {
  console.error('[im-steward-bridge] fatal:', err)
  process.exit(1)
})
