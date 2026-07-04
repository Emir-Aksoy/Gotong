/**
 * Phase 12 M8 — IM bridge host demo.
 *
 * Spins up a Hub + IdentityStore + FakeBridge + IM router end-to-end
 * in-process and walks through the full IM lifecycle:
 *
 *   1. A user `/help`s before binding — they get the command list.
 *   2. They `/bind <code>` with a valid 6-digit code minted by the
 *      identity store — they're linked.
 *   3. They free-text "what can you do?" — it dispatches to a chat
 *      agent and the agent's reply is sent back via the bridge.
 *   4. They `/agents` — they see what they can talk to.
 *   5. They `/workflow echo <args>` — it dispatches to an echo
 *      workflow target.
 *   6. They `/unbind` — the binding is removed.
 *
 * The same flow works against the 6 real `@gotong/im-*` bridges —
 * swap `FakeBridge` for `new TelegramBridge({ token })` or similar
 * and the rest of the code is unchanged. That's the whole point of
 * having a shared router.
 *
 * Run:  pnpm --filter @gotong/example-im-bridge-host start
 */

import { AgentParticipant, Hub, type Task } from '@gotong/core'
import { openIdentityStore } from '@gotong/identity'
import type { ImMessage, ImUser } from '@gotong/im-adapter'

import { FakeBridge } from './fake-bridge.js'
import { makeIdentityImBindingResolver } from './identity-resolver.js'
import { createImRouter } from './router.js'

// ---------------------------------------------------------------------------
// A simple echo "chat" agent. In a real host this is an `LlmAgent`
// backed by Anthropic/OpenAI/etc. Keeping it pure-text means the
// demo runs offline.
// ---------------------------------------------------------------------------

class ChatEchoAgent extends AgentParticipant {
  constructor() {
    super({ id: 'chat', capabilities: ['chat'] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    const text =
      typeof task.payload === 'object' &&
      task.payload !== null &&
      'text' in task.payload &&
      typeof (task.payload as { text: unknown }).text === 'string'
        ? (task.payload as { text: string }).text
        : '(no text)'
    return {
      text: `echo: ${text}\n(in a real host this is your default chat agent — an LlmAgent backed by your provider of choice.)`,
    }
  }
}

class WorkflowEchoAgent extends AgentParticipant {
  constructor() {
    super({ id: 'workflow-echo', capabilities: ['workflow:echo'] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    const args =
      typeof task.payload === 'object' &&
      task.payload !== null &&
      'args' in task.payload &&
      typeof (task.payload as { args: unknown }).args === 'string'
        ? (task.payload as { args: string }).args
        : ''
    return { text: `workflow ran with args: ${args || '(none)'}` }
  }
}

// ---------------------------------------------------------------------------
// Bootstrap.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n=== Gotong demo: im-bridge-host (Phase 12 M8) ===\n')

  // -- 1. Identity ----------------------------------------------------------
  // In-process SQLite. A real host points `dbPath` at
  // `<space>/identity/identity.sqlite` (which the host bootstrap
  // does automatically — see `packages/host/src/main.ts`).
  const identity = openIdentityStore({ dbPath: ':memory:' })
  const alice = identity.createUser({
    email: 'alice@example.com',
    displayName: 'Alice',
  })
  console.log(`  identity   user ${alice.id} (${alice.email}) created`)

  // Issue a binding code Alice will type into the IM client.
  const code = identity.issueImBindingCode({ userId: alice.id })
  console.log(`  identity   binding code ${code.code} issued (TTL 10m)`)

  // -- 2. Hub + agents ------------------------------------------------------
  const hub = Hub.inMemory()
  await hub.start()
  hub.register(new ChatEchoAgent())
  hub.register(new WorkflowEchoAgent())
  console.log('  hub        started, registered agents: chat, workflow-echo')

  // -- 3. Bridge ------------------------------------------------------------
  // We pretend Alice is on Telegram with platform_user_id '1001'.
  const bridge = new FakeBridge('telegram')
  bridge.onOutbound = (out) => {
    console.log(`  📤 bridge → ${out.to.platformUserId}:`)
    for (const line of out.text.split('\n')) {
      console.log(`     | ${line}`)
    }
  }
  await bridge.start()

  // -- 4. Router ------------------------------------------------------------
  const resolver = makeIdentityImBindingResolver(identity)
  const router = createImRouter({
    hub,
    resolver,
    freeTextDispatch: { strategy: { kind: 'capability', capabilities: ['chat'] } },
    onUnbind: async (platform, platformUserId) => {
      const n = identity.removeImBinding(platform, platformUserId)
      return { removed: n > 0 }
    },
    listAgents: async () => ['chat — your default chat agent', 'workflow-echo — runs the `echo` workflow'],
    resolveWorkflow: async ({ name, args }) => {
      if (name !== 'echo') return null
      return {
        payload: { args },
        strategy: { kind: 'capability', capabilities: ['workflow:echo'] },
        title: `workflow:echo`,
      }
    },
  })
  bridge.onMessage((msg) => router.handle(bridge, msg))
  console.log('  router     wired (free-text → capability:chat)\n')

  // -- 5. Walk through the lifecycle ----------------------------------------
  const aliceImUser: ImUser = {
    platform: 'telegram',
    platformUserId: '1001',
    displayName: 'Alice',
  }

  const scenarios: Array<{ note: string; text: string }> = [
    { note: 'Alice asks /help before binding — anyone can read help.', text: '/help' },
    { note: 'Alice tries to chat before binding — bridge nudges her to /bind first.', text: 'hi there!' },
    {
      note: `Alice types /bind ${code.code} with the code from her admin UI.`,
      text: `/bind ${code.code}`,
    },
    { note: 'Alice asks /agents — sees what she can talk to.', text: '/agents' },
    {
      note: 'Alice free-text chats — dispatches to chat agent.',
      text: 'what can you do?',
    },
    {
      note: 'Alice runs a named workflow with args.',
      text: '/workflow echo hello world',
    },
    { note: 'Alice unknown command — falls through to free-text.', text: '/notacommand please run this' },
    { note: 'Alice /unbind — binding is removed.', text: '/unbind' },
    {
      note: 'After unbind, free-text again gets nudged to /bind.',
      text: 'still listening?',
    },
  ]

  let stepNum = 1
  for (const s of scenarios) {
    console.log(`  [step ${stepNum++}] ${s.note}`)
    console.log(`  📥 alice → bridge: ${s.text}`)
    const msg: ImMessage = {
      from: aliceImUser,
      text: s.text,
      chatId: 'private:1001',
      ts: Date.now(),
    }
    await bridge.inject(msg)
    console.log('')
  }

  // -- 6. Summary -----------------------------------------------------------
  console.log('\n  transcript:', hub.transcript.size(), 'entries')
  console.log('  outbound:  ', bridge.outbound.length, 'IM replies sent')

  await bridge.stop()
  await hub.stop()
  identity.close()
  process.exit(0)
}

main().catch((err) => {
  console.error('[im-bridge-host] fatal:', err)
  process.exit(1)
})
