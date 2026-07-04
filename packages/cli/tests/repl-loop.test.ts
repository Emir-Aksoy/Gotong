/**
 * Integration tests for the REPL loop.
 *
 * We drive `runReplLoop` with a `ScriptedIo` (an in-memory queue of
 * "lines to read" + a buffer of "everything written") against a real
 * in-memory `Hub` from `@gotong/core`. That covers parsing, dispatch
 * routing, error handling, transcript rendering — all the wiring —
 * without spawning a child process or touching real stdin/stdout.
 */

import { AgentParticipant, type Task } from '@gotong/core'
import { afterEach, describe, expect, it } from 'vitest'

import { createReplHub, ReplEchoAgent, type ReplHubHandle } from '../src/repl/bootstrap.js'
import { runReplLoop, type ReplIo } from '../src/repl/loop.js'

class ScriptedIo implements ReplIo {
  private readonly scripted: string[]
  public readonly written: string[] = []
  public closed = false

  constructor(scripted: readonly string[]) {
    this.scripted = [...scripted]
  }

  async read(_prompt: string): Promise<string | null> {
    void _prompt
    if (this.scripted.length === 0) return null
    return this.scripted.shift()!
  }
  write(chunk: string): void {
    this.written.push(chunk)
  }
  close(): void {
    this.closed = true
  }
  /** Convenience: written buffer joined for substring asserts. */
  text(): string {
    return this.written.join('')
  }
}

class CapTesterAgent extends AgentParticipant {
  constructor() {
    super({ id: 'tester', capabilities: ['test'] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    return { text: `[tester] saw: ${JSON.stringify(task.payload)}` }
  }
}

describe('runReplLoop', () => {
  let handle: ReplHubHandle | null = null

  afterEach(async () => {
    if (handle) {
      await handle.shutdown()
      handle = null
    }
  })

  it('exits cleanly on :quit and reports turn count', async () => {
    handle = await createReplHub()
    const io = new ScriptedIo([':quit'])
    const result = await runReplLoop({
      io,
      hub: handle.hub,
      defaultCapability: handle.defaultCapability,
    })
    expect(result).toEqual({ turns: 1, reason: 'quit' })
    expect(io.text()).toContain('bye!')
    expect(io.closed).toBe(true)
  })

  it('exits on EOF (read returns null)', async () => {
    handle = await createReplHub()
    const io = new ScriptedIo([])
    const result = await runReplLoop({
      io,
      hub: handle.hub,
      defaultCapability: handle.defaultCapability,
    })
    expect(result.reason).toBe('eof')
    expect(result.turns).toBe(0)
    expect(io.closed).toBe(true)
  })

  it('renders the help block on :help', async () => {
    handle = await createReplHub()
    const io = new ScriptedIo([':help', ':quit'])
    await runReplLoop({
      io,
      hub: handle.hub,
      defaultCapability: handle.defaultCapability,
    })
    expect(io.text()).toContain(':help, :h, :?')
    expect(io.text()).toContain(':dispatch <id> <text>')
  })

  it('lists agents on :agents', async () => {
    handle = await createReplHub({
      injectAgents: () => [new CapTesterAgent()],
    })
    const io = new ScriptedIo([':agents', ':quit'])
    await runReplLoop({
      io,
      hub: handle.hub,
      defaultCapability: handle.defaultCapability,
    })
    const text = io.text()
    // Default echo agent + injected tester
    expect(text).toMatch(/chat\s*\[chat\]/)
    expect(text).toMatch(/tester\s*\[test\]/)
  })

  it('dispatches free text to default capability and prints reply', async () => {
    handle = await createReplHub()
    const io = new ScriptedIo(['hello world', ':quit'])
    await runReplLoop({
      io,
      hub: handle.hub,
      defaultCapability: handle.defaultCapability,
    })
    expect(io.text()).toContain('echo: hello world')
  })

  it(':dispatch routes to explicit agent', async () => {
    handle = await createReplHub({
      injectAgents: () => [new CapTesterAgent()],
    })
    const io = new ScriptedIo([':dispatch tester ping me', ':quit'])
    await runReplLoop({
      io,
      hub: handle.hub,
      defaultCapability: handle.defaultCapability,
    })
    expect(io.text()).toContain('[tester] saw:')
    expect(io.text()).toContain('"text":"ping me"')
  })

  it('renders no-participant failure when capability has no matcher', async () => {
    handle = await createReplHub({
      defaultAgent: null, // no echo agent → no `chat` cap
      defaultCapability: ['chat'],
    })
    const io = new ScriptedIo(['hello?', ':quit'])
    await runReplLoop({
      io,
      hub: handle.hub,
      defaultCapability: handle.defaultCapability,
    })
    // The default scheduler reports no_participant — message exact
    // wording is core-versioned, so just assert the prefix.
    expect(io.text()).toMatch(/no agent matched/)
  })

  it(':transcript shows recent entries', async () => {
    handle = await createReplHub()
    const io = new ScriptedIo([
      'first message',
      'second message',
      ':transcript',
      ':quit',
    ])
    await runReplLoop({
      io,
      hub: handle.hub,
      defaultCapability: handle.defaultCapability,
    })
    const text = io.text()
    // After 2 dispatches we expect at least 4 entries (2 task + 2 result).
    // The `:transcript` header tells us how many we saw.
    expect(text).toMatch(/\(last \d+ of \d+ entries\)/)
    expect(text).toContain('TASK')
    expect(text).toContain('RESULT')
  })

  it('unknown :command prints hint without crashing', async () => {
    handle = await createReplHub()
    const io = new ScriptedIo([':notacommand', ':quit'])
    const result = await runReplLoop({
      io,
      hub: handle.hub,
      defaultCapability: handle.defaultCapability,
    })
    expect(result.reason).toBe('quit')
    expect(io.text()).toContain('unknown command `:notacommand`')
  })

  it('empty lines are no-ops (no crash, no output)', async () => {
    handle = await createReplHub()
    const io = new ScriptedIo(['', '   ', 'real text', ':quit'])
    await runReplLoop({
      io,
      hub: handle.hub,
      defaultCapability: handle.defaultCapability,
    })
    // turns counts every read (incl. noops); ensure no error fragments
    expect(io.text()).not.toContain('error')
    expect(io.text()).toContain('echo: real text')
  })

  it('agent throwing inside handleTask does not crash the loop', async () => {
    class BoomAgent extends AgentParticipant {
      constructor() {
        super({ id: 'boom', capabilities: ['boom'] })
      }
      protected async handleTask(_t: Task): Promise<unknown> {
        void _t
        throw new Error('intentional boom')
      }
    }
    handle = await createReplHub({
      defaultAgent: null,
      defaultCapability: ['boom'],
      injectAgents: () => [new BoomAgent()],
    })
    const io = new ScriptedIo(['trigger', ':quit'])
    const result = await runReplLoop({
      io,
      hub: handle.hub,
      defaultCapability: handle.defaultCapability,
    })
    expect(result.reason).toBe('quit')
    // Either rendered as `dispatch failed` or `no agent matched`,
    // depending on scheduler. Just assert the loop kept running.
    expect(io.text()).toContain('bye!')
  })

  it('aborts gracefully when read throws AbortError', async () => {
    handle = await createReplHub()
    const abortingIo: ReplIo = {
      async read() {
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      },
      write(_c: string) { void _c },
      close() {},
    }
    const result = await runReplLoop({
      io: abortingIo,
      hub: handle.hub,
      defaultCapability: handle.defaultCapability,
    })
    expect(result.reason).toBe('aborted')
  })

  it('ReplEchoAgent has the documented id/capability', () => {
    const a = new ReplEchoAgent()
    expect(a.id).toBe('chat')
    expect(a.capabilities).toEqual(['chat'])
  })

  it('ReplEchoAgent honours custom id', () => {
    const a = new ReplEchoAgent('custom')
    expect(a.id).toBe('custom')
  })
})

describe('createReplHub', () => {
  it('returns a working hub + default capability', async () => {
    const h = await createReplHub()
    expect(h.defaultCapability).toEqual(['chat'])
    expect(h.hub.participants().some((p) => p.id === 'chat')).toBe(true)
    await h.shutdown()
  })

  it('shutdown is idempotent', async () => {
    const h = await createReplHub()
    await h.shutdown()
    await h.shutdown() // no throw
  })

  it('defaultAgent: null disables the echo agent', async () => {
    const h = await createReplHub({ defaultAgent: null })
    expect(h.hub.participants()).toEqual([])
    await h.shutdown()
  })

  it('defaultCapability override is honoured', async () => {
    const h = await createReplHub({ defaultCapability: ['triage'] })
    expect(h.defaultCapability).toEqual(['triage'])
    await h.shutdown()
  })
})
