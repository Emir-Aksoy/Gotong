/**
 * BF-M3 — `LocalAgentPool` spawns a `chat`-capable LLM row through the injected
 * `butlerFactory` (instead of a plain `LlmAgent`) when butler mode is enabled.
 *
 * These tests drive the pool with a RECORDING fake factory: it logs the base
 * options it was handed and returns a distinctive echo participant, so we can
 * assert (a) WHEN the factory is consulted (the gate: default-on, per-agent
 * opt-in/opt-out, the `chat` capability requirement, the `'llm'`-kind
 * requirement, factory presence) and (b) THAT the factory's participant is the
 * one the hub actually dispatches to — registered under the SAME agent id.
 *
 * The factory never builds a real butler here; BF-M5's E2E exercises the real
 * memory + capture path. This milestone only proves the pool wiring + gate.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  Hub,
  Space,
  AgentParticipant,
  type AgentRecord,
  type ManagedAgentSpec,
  type Task,
} from '@gotong/core'
import type { LlmAgentOptions } from '@gotong/llm'

import { LocalAgentPool, type ButlerFactory } from '../src/local-agent-pool.js'

/** A stand-in participant the fake factory returns; its output marks it. */
class FakeButler extends AgentParticipant {
  constructor(id: string, caps: readonly string[]) {
    super({ id, capabilities: caps })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    return { butler: true, by: this.id, saw: task.payload }
  }
}

interface Recorder {
  factory: ButlerFactory
  calls: Array<{ id: string; capabilities: readonly string[]; provider: unknown; system: unknown }>
}

/** A factory that records each base it built from + returns a {@link FakeButler}. */
function recordingFactory(): Recorder {
  const calls: Recorder['calls'] = []
  const factory: ButlerFactory = (base: LlmAgentOptions) => {
    calls.push({
      id: base.id,
      capabilities: base.capabilities,
      provider: base.provider,
      system: base.system,
    })
    return new FakeButler(base.id, base.capabilities)
  }
  return { factory, calls }
}

describe('LocalAgentPool — butler fold-in (BF-M3)', () => {
  let root: string
  let space: Space
  let hub: Hub

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-lap-butler-'))
    await rm(root, { recursive: true, force: true })
    const opened = await Space.init(root, { name: 'test' })
    space = opened.space
    hub = new Hub({ space })
    await hub.start()
  })
  afterEach(async () => {
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  function chatRow(id: string, extra: Partial<ManagedAgentSpec> = {}): AgentRecord {
    return {
      id,
      allowedCapabilities: ['chat'],
      createdAt: new Date().toISOString(),
      managed: { kind: 'llm', provider: 'mock', system: 'you are the assistant', ...extra },
    }
  }

  it('default-on: a chat-capable LLM row is built via the factory and handles dispatch', async () => {
    await space.upsertAgent(chatRow('assistant'))
    const rec = recordingFactory()
    const pool = new LocalAgentPool({ hub, space, butlerFactory: rec.factory, butlerDefaultOn: true })
    await pool.start()

    // The factory was consulted ONCE, with the base the pool built.
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0]!.id).toBe('assistant')
    expect(rec.calls[0]!.capabilities).toContain('chat')
    expect(rec.calls[0]!.provider).toBeDefined() // pool-built mock provider
    expect(rec.calls[0]!.system).toBe('you are the assistant')

    // The participant registered under `assistant` is the FAKE BUTLER — the
    // hub dispatches a `chat` task straight to it.
    const r = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['chat'] },
      payload: { text: 'hi' },
    })
    expect(r.kind).toBe('ok')
    expect((r as { output: { butler?: boolean } }).output.butler).toBe(true)
    await pool.stop()
  })

  it('default-on but NOT chat-capable: stays a plain LlmAgent (factory not consulted)', async () => {
    await space.upsertAgent({
      id: 'backoffice',
      allowedCapabilities: ['draft'], // no chat
      createdAt: new Date().toISOString(),
      managed: { kind: 'llm', provider: 'mock', system: 'drafter' },
    })
    const rec = recordingFactory()
    const pool = new LocalAgentPool({ hub, space, butlerFactory: rec.factory, butlerDefaultOn: true })
    await pool.start()

    expect(rec.calls).toHaveLength(0)
    // Still spawns + dispatches (as a normal mock LlmAgent).
    const r = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: 'x',
    })
    expect(r.kind).toBe('ok')
    await pool.stop()
  })

  it('explicit butler:false opts OUT even with default-on', async () => {
    await space.upsertAgent(chatRow('assistant', { butler: false }))
    const rec = recordingFactory()
    const pool = new LocalAgentPool({ hub, space, butlerFactory: rec.factory, butlerDefaultOn: true })
    await pool.start()
    expect(rec.calls).toHaveLength(0)
    await pool.stop()
  })

  it('explicit butler:true opts IN even with default OFF', async () => {
    await space.upsertAgent(chatRow('assistant', { butler: true }))
    const rec = recordingFactory()
    // butlerDefaultOn omitted → defaults false.
    const pool = new LocalAgentPool({ hub, space, butlerFactory: rec.factory })
    await pool.start()
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0]!.id).toBe('assistant')
    await pool.stop()
  })

  it('no factory wired: a chat row stays a plain LlmAgent (never crashes)', async () => {
    await space.upsertAgent(chatRow('assistant', { butler: true }))
    // No butlerFactory at all — butler mode can never engage.
    const pool = new LocalAgentPool({ hub, space })
    await pool.start()
    const r = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['chat'] },
      payload: { text: 'hi' },
    })
    expect(r.kind).toBe('ok')
    // A plain LlmAgent (mock) reply — NOT the fake butler marker.
    expect((r as { output: { butler?: boolean } }).output.butler).toBeUndefined()
    await pool.stop()
  })

  it('specialized kind (personal-growth) is never turned into a butler', async () => {
    await space.upsertAgent({
      id: 'interviewer',
      allowedCapabilities: ['chat'],
      createdAt: new Date().toISOString(),
      managed: { kind: 'personal-growth', provider: 'mock', system: 'interview' },
    })
    const rec = recordingFactory()
    const pool = new LocalAgentPool({ hub, space, butlerFactory: rec.factory, butlerDefaultOn: true })
    await pool.start()
    expect(rec.calls).toHaveLength(0) // gate excludes non-'llm' kinds
    await pool.stop()
  })

  it('respawn (edit) re-routes through the factory and the new butler handles dispatch', async () => {
    await space.upsertAgent(chatRow('assistant'))
    const rec = recordingFactory()
    const pool = new LocalAgentPool({ hub, space, butlerFactory: rec.factory, butlerDefaultOn: true })
    await pool.start()
    expect(rec.calls).toHaveLength(1)

    // Edit the row → respawn. The factory must be consulted again (a fresh
    // butler), and the live id still dispatches to a butler.
    await space.upsertAgent(chatRow('assistant', { system: 'edited assistant' }))
    await pool.start(await firstAgentRecord(space, 'assistant'))
    expect(rec.calls).toHaveLength(2)
    expect(rec.calls[1]!.system).toBe('edited assistant')

    const r = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['chat'] },
      payload: { text: 'hi again' },
    })
    expect((r as { output: { butler?: boolean } }).output.butler).toBe(true)
    await pool.stop()
  })
})

async function firstAgentRecord(space: Space, id: string): Promise<AgentRecord> {
  const all = await space.agents()
  const rec = all.find((a) => a.id === id)
  if (!rec) throw new Error(`no agent ${id}`)
  return rec
}
