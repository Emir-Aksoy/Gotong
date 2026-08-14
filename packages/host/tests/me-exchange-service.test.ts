/**
 * EXCH-M1 — me-exchange-service (import / archive / dispatch / result).
 *
 * Load-bearing claims:
 *  - preview is ZERO side-effect (nothing on disk, nothing dispatched);
 *  - importRequest archives the EXACT raw bytes the human approved, and the
 *    `wx` create is an atomic first-import-wins replay gate;
 *  - dispatch is the /api/me/dispatch model verbatim: origin.userId pinned to
 *    the importing member, capability strategy from the RESOLVED workflow,
 *    payload whitelisted to declared input fields with the scope field
 *    force-pinned (an envelope-supplied scope value can never win);
 *  - settle writes the result file THEN the meta ('done' implies durable
 *    result), the result envelope is signed with the hub key and verifiable
 *    offline, and a suspended dispatch honestly stays 'suspended' with no
 *    fabricated result;
 *  - result() is scoped to the importer (anti-enumeration: other members and
 *    unknown ids get the same not_found) and self-heals the crash window
 *    between result-file and meta writes.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TaskResult } from '@gotong/core'
import { ecThumbprint, es256Sign, type AgentCardSigner } from '@gotong/a2a'

import {
  ENVELOPE_SCHEMA_V1,
  parseExchangeEnvelope,
  verifyExchangeEnvelope,
} from '../src/exchange-envelope.js'
import {
  ExchangeError,
  buildMeExchange,
  type ExchangeImportArgs,
  type MeExchangeService,
} from '../src/me-exchange-service.js'

const REQ_ID = 'exg-aaaabbbbccccdddd0001'
const USER = 'user-father'
const OTHER = 'user-mother'

function makeSigner(): AgentCardSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>
  const pub = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
  const kid = ecThumbprint(pub)
  return {
    kid: () => kid,
    publicJwk: () => ({ ...pub }),
    sign: (input: Buffer) => es256Sign(privateKey, input),
  }
}

function requestRaw(over: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      schema: ENVELOPE_SCHEMA_V1,
      id: REQ_ID,
      kind: 'request',
      createdAt: '2026-08-14T02:00:00Z',
      from: { name: '老陈 (pi @ MacBook)' },
      capability: 'market.analysis',
      title: '请分析一下今天恒指的走势',
      payload: { question: '恒指今天怎么看?', evil_extra: 'should be dropped', requester_id: 'attacker-id' },
      ...over,
    },
    null,
    2,
  )
}

function importArgs(raw: string, over: Partial<ExchangeImportArgs> = {}): ExchangeImportArgs {
  return {
    raw,
    workflowId: 'wf-analysis',
    capability: 'market.analysis',
    inputFieldIds: ['question', 'notes'],
    userScopeField: 'requester_id',
    label: '行情分析',
    ...over,
  }
}

interface CapturedDispatch {
  from: string
  origin: { orgId: string; userId: string }
  strategy: { kind: 'capability'; capabilities: string[] }
  payload: Record<string, unknown>
  title: string
}

/** Capture fake hub whose dispatch outcome is set per test. */
function makeHub(result: TaskResult | (() => Promise<TaskResult>)): { calls: CapturedDispatch[]; dispatch: (opts: CapturedDispatch) => Promise<TaskResult> } {
  const calls: CapturedDispatch[] = []
  return {
    calls,
    dispatch: async (opts: CapturedDispatch) => {
      calls.push(opts)
      return typeof result === 'function' ? result() : result
    },
  }
}

const okResult = (output: unknown): TaskResult => ({ kind: 'ok', taskId: 't1', by: 'agent-1', output, ts: 1_755_100_000_000 })

async function until<T>(fn: () => Promise<T | null>, what: string, timeoutMs = 3000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v !== null) return v
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function untilDone(svc: MeExchangeService, userId: string, id: string) {
  return until(async () => {
    const view = await svc.result(userId, id)
    return view.status === 'done' ? view : null
  }, `result ${id} to settle`)
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gotong-exch-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('preview', () => {
  it('is zero side-effect and reports summary + signature + dispatchable', async () => {
    const hub = makeHub(okResult({ text: 'x' }))
    const svc = buildMeExchange({ spaceRoot: dir, hub, signerFactory: makeSigner })
    const view = await svc.preview(USER, requestRaw())
    expect(view.valid).toBe(true)
    expect(view.dispatchable).toBe(true)
    expect(view.summary?.id).toBe(REQ_ID)
    expect(view.summary?.capability).toBe('market.analysis')
    expect(view.signature).toEqual({ state: 'unsigned' })
    expect(view.replay).toBeUndefined()
    // Nothing dispatched, nothing on disk (exchange/ not even created).
    expect(hub.calls).toHaveLength(0)
    await expect(readdir(join(dir, 'exchange'))).rejects.toThrow()
  })

  it('reports validation errors without throwing', async () => {
    const svc = buildMeExchange({ spaceRoot: dir, hub: makeHub(okResult({})), signerFactory: makeSigner })
    const view = await svc.preview(USER, '{"schema":"nope"}')
    expect(view.valid).toBe(false)
    expect(view.dispatchable).toBe(false)
    expect(view.errors?.length).toBeGreaterThan(0)
  })
})

describe('importRequest', () => {
  it('archives the EXACT raw bytes and dispatches as the importing member with a whitelisted payload', async () => {
    const hub = makeHub(okResult({ text: '分析结果' }))
    const svc = buildMeExchange({ spaceRoot: dir, hub, signerFactory: makeSigner })
    const raw = requestRaw()
    const { id } = await svc.importRequest(USER, importArgs(raw))
    expect(id).toBe(REQ_ID)

    // Archive is byte-identical to what the human previewed.
    expect(await readFile(join(dir, 'exchange', `${REQ_ID}.json`), 'utf8')).toBe(raw)

    // Dispatch mirrors /api/me/dispatch: pinned origin, capability strategy,
    // whitelisted payload — the envelope's evil_extra and attacker-supplied
    // scope value are both gone.
    expect(hub.calls).toHaveLength(1)
    const call = hub.calls[0]
    expect(call.from).toBe(USER)
    expect(call.origin).toEqual({ orgId: 'local', userId: USER })
    expect(call.strategy).toEqual({ kind: 'capability', capabilities: ['market.analysis'] })
    expect(call.payload).toEqual({ question: '恒指今天怎么看?', requester_id: USER })
    expect(call.title).toBe(`行情分析 — ${USER}`)
  })

  it('settles into a SIGNED result envelope, result-file durable when meta says done', async () => {
    const signer = makeSigner()
    const hub = makeHub(okResult({ text: '恒指今日走势分析……' }))
    const svc = buildMeExchange({ spaceRoot: dir, hub, signerFactory: () => signer, fromName: '阿同 @ family hub' })
    await svc.importRequest(USER, importArgs(requestRaw()))
    const done = await untilDone(svc, USER, REQ_ID)

    const parsed = parseExchangeEnvelope(done.envelope)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const env = parsed.envelope
    expect(env.kind).toBe('result')
    expect(env.replyTo).toBe(REQ_ID)
    expect(env.id).toBe(done.resultId)
    expect(env.from.name).toBe('阿同 @ family hub')
    expect(env.payload).toEqual({ ok: true, output: { text: '恒指今日走势分析……' } })
    // Offline-verifiable with the key INSIDE the envelope.
    expect(verifyExchangeEnvelope(env)).toEqual({ state: 'valid', kid: signer.kid() })
    // Durable on disk too.
    expect(await readFile(join(dir, 'exchange', `${REQ_ID}.result.json`), 'utf8')).toBe(done.envelope)
  })

  it('refuses a replay atomically; status disclosed only to the original importer', async () => {
    const svc = buildMeExchange({ spaceRoot: dir, hub: makeHub(okResult({ text: 'x' })), signerFactory: makeSigner })
    const raw = requestRaw()
    await svc.importRequest(USER, importArgs(raw))
    await untilDone(svc, USER, REQ_ID)

    const mine = await svc.importRequest(USER, importArgs(raw)).catch((e) => e as ExchangeError)
    expect(mine).toBeInstanceOf(ExchangeError)
    expect((mine as ExchangeError).code).toBe('replay')
    expect((mine as ExchangeError).replayStatus).toBe('done')

    const theirs = await svc.importRequest(OTHER, importArgs(raw)).catch((e) => e as ExchangeError)
    expect((theirs as ExchangeError).code).toBe('replay')
    expect((theirs as ExchangeError).replayStatus).toBeUndefined()

    // preview mirrors the same scoping.
    const previewMine = await svc.preview(USER, raw)
    expect(previewMine.replay).toEqual({ imported: true, mine: true, status: 'done' })
    const previewTheirs = await svc.preview(OTHER, raw)
    expect(previewTheirs.replay).toEqual({ imported: true, mine: false })
  })

  it('refuses a result envelope (read-only) and a capability mismatch (echoing only the envelope side)', async () => {
    const hub = makeHub(okResult({}))
    const svc = buildMeExchange({ spaceRoot: dir, hub, signerFactory: makeSigner })

    const resultRaw = requestRaw({ kind: 'result', replyTo: 'exg-someotherrequest01', payload: { ok: true } })
    const e1 = await svc.importRequest(USER, importArgs(resultRaw)).catch((e) => e as ExchangeError)
    expect((e1 as ExchangeError).code).toBe('not_dispatchable')

    const e2 = await svc.importRequest(USER, importArgs(requestRaw(), { capability: 'garden.watering' })).catch((e) => e as ExchangeError)
    expect((e2 as ExchangeError).code).toBe('capability_mismatch')
    expect((e2 as ExchangeError).message).toContain('market.analysis')
    expect((e2 as ExchangeError).message).not.toContain('garden.watering')

    // Neither refusal left anything on disk or dispatched anything.
    expect(hub.calls).toHaveLength(0)
    await expect(readdir(join(dir, 'exchange'))).rejects.toThrow()
  })

  it('an invalid envelope throws code=invalid with the collected errors', async () => {
    const svc = buildMeExchange({ spaceRoot: dir, hub: makeHub(okResult({})), signerFactory: makeSigner })
    const err = await svc.importRequest(USER, importArgs('{"schema":"gotong.envelope/v1"}')).catch((e) => e as ExchangeError)
    expect((err as ExchangeError).code).toBe('invalid')
    expect((err as ExchangeError).errors?.length).toBeGreaterThan(0)
  })
})

describe('settle honesty', () => {
  it('a suspended dispatch stays suspended — no fabricated result envelope', async () => {
    const suspended: TaskResult = { kind: 'suspended', taskId: 't1', by: 'agent-1', resumeAt: 9_999_999_999_000, ts: 1 }
    const svc = buildMeExchange({ spaceRoot: dir, hub: makeHub(suspended), signerFactory: makeSigner })
    await svc.importRequest(USER, importArgs(requestRaw()))
    const view = await until(async () => {
      const v = await svc.result(USER, REQ_ID)
      return v.status === 'suspended' ? v : null
    }, 'suspended status')
    expect(view.note).toContain('human step')
    await expect(readFile(join(dir, 'exchange', `${REQ_ID}.result.json`), 'utf8')).rejects.toThrow()
  })

  it('a rejected dispatch becomes an honest ok:false result envelope', async () => {
    const svc = buildMeExchange({
      spaceRoot: dir,
      hub: makeHub(() => Promise.reject(new Error('provider exploded'))),
      signerFactory: makeSigner,
    })
    await svc.importRequest(USER, importArgs(requestRaw()))
    const done = await untilDone(svc, USER, REQ_ID)
    const parsed = parseExchangeEnvelope(done.envelope)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.envelope.payload.ok).toBe(false)
    expect(String(parsed.envelope.payload.error)).toContain('provider exploded')
  })

  it('a broken signing key warns and ships the result UNSIGNED — never blocks, never regenerates', async () => {
    const svc = buildMeExchange({
      spaceRoot: dir,
      hub: makeHub(okResult({ text: 'x' })),
      signerFactory: () => {
        throw new Error('corrupt key file')
      },
    })
    await svc.importRequest(USER, importArgs(requestRaw()))
    const done = await untilDone(svc, USER, REQ_ID)
    const parsed = parseExchangeEnvelope(done.envelope)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.envelope.sig).toBeUndefined()
    expect(verifyExchangeEnvelope(parsed.envelope)).toEqual({ state: 'unsigned' })
  })
})

describe('result scoping + self-heal', () => {
  it('answers not_found for other members, unknown ids, and malformed ids alike', async () => {
    const svc = buildMeExchange({ spaceRoot: dir, hub: makeHub(okResult({ text: 'x' })), signerFactory: makeSigner })
    await svc.importRequest(USER, importArgs(requestRaw()))
    await untilDone(svc, USER, REQ_ID)
    expect(await svc.result(OTHER, REQ_ID)).toEqual({ status: 'not_found' })
    expect(await svc.result(USER, 'exg-neverimported00001')).toEqual({ status: 'not_found' })
    expect(await svc.result(USER, '../../etc/passwd')).toEqual({ status: 'not_found' })
  })

  it('self-heals the result-then-meta crash window (meta running, result durable)', async () => {
    const svc = buildMeExchange({ spaceRoot: dir, hub: makeHub(okResult({ text: 'x' })), signerFactory: makeSigner })
    await svc.importRequest(USER, importArgs(requestRaw()))
    await untilDone(svc, USER, REQ_ID)
    // Simulate the crash: rewind the meta to 'running' with no resultId.
    const metaPath = join(dir, 'exchange', `${REQ_ID}.meta.json`)
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
    delete meta.resultId
    meta.status = 'running'
    await writeFile(metaPath, JSON.stringify(meta), 'utf8')

    const view = await svc.result(USER, REQ_ID)
    expect(view.status).toBe('done')
    if (view.status !== 'done') return
    // The resultId is recovered from the envelope bytes themselves.
    const env = JSON.parse(view.envelope) as { id: string }
    expect(view.resultId).toBe(env.id)
  })
})
