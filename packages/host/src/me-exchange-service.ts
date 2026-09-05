/**
 * EXCH-M1 — member-facing exchange surface: the hub side of the human-relayed
 * envelope flow (docs/zh/EXCHANGE-ENVELOPE.md §六 M1).
 *
 * Two-step confirm (wizard compose/approve precedent): `preview` is ZERO
 * side-effect — parse + signature verdict + replay lookup, nothing written,
 * nothing dispatched; `importRequest` is the confirmed step — it re-parses the
 * raw text itself (the route's preview is UI convenience, never the
 * authority), claims the idempotency key, archives the exact bytes the human
 * approved, and dispatches AS the importing member. Authority is 100% the
 * `/api/me/dispatch` model: the web route resolves which surface.me workflow
 * this member's role may run and hands over its capability + declared input
 * fields; this service whitelists the envelope payload against those fields
 * and force-pins the user-scope field to the session member — an envelope can
 * never reach anything the member could not dispatch by hand, and never as
 * anyone else.
 *
 * File-first archive under `<space>/exchange/` (nothing until first use —
 * opt-in, bytes-identical when unused):
 *   <id>.json         imported request, EXACT raw bytes (what the human saw)
 *   <id>.meta.json    hub-local record: importer / workflow / status
 *   <id>.result.json  result envelope (signed when the hub key is usable)
 * The `wx` create of `<id>.json` IS the replay gate: first import wins
 * atomically, a second import of the same id is refused and pointed at the
 * first. Write order inside settle is result-file THEN meta, so
 * `meta.status === 'done'` implies the result bytes are durable (a crash
 * between the two is healed by result() probing the file).
 *
 * Result signing reuses the STD-M1 hub identity key LAZILY — the key file is
 * only loaded/created on the first result assembly, so a hub that never
 * exchanges never grows the file. A corrupt key warns and settles to an
 * unsigned minimal error result, never leaving an in-flight result behind.
 * The key is NEVER silently regenerated (peers may pin the kid).
 *
 * Honest M1 residuals (documented, not hidden): a dispatch that suspends for
 * human approval resolves this promise as 'suspended' — the run continues
 * inside the hub but no result envelope is auto-assembled (status stays
 * 'suspended'; the member relays the outcome by hand). A host restart while
 * status is 'running' loses the in-flight promise the same way any /me
 * dispatch does — status stays 'running' with its importedAt visible.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger, writeFileAtomic, writeJsonAtomic, type TaskResult } from '@gotong/core'
import type { AgentCardSigner } from '@gotong/a2a'
import { FileAgentCardSigner } from './agent-card-signing.js'
import { verifyDeliveryEvidence, type DeliveryVerification } from './delivery-evidence.js'
import {
  ENVELOPE_ID_RE,
  ENVELOPE_MAX_FILE_BYTES,
  buildResultEnvelope,
  parseExchangeEnvelope,
  signExchangeEnvelope,
  verifyExchangeEnvelope,
  type EnvelopeSigVerdict,
  type ExchangeEnvelope,
} from './exchange-envelope.js'

const log = createLogger('me-exchange')

/** Duck view of Hub.dispatch — structural so tests inject a capture fake. */
export interface ExchangeHubLike {
  dispatch(opts: {
    from: string
    origin: { orgId: string; userId: string }
    strategy: { kind: 'capability'; capabilities: string[] }
    payload: Record<string, unknown>
    title: string
  }): Promise<TaskResult>
}

export interface BuildMeExchangeOpts {
  spaceRoot: string
  hub: ExchangeHubLike
  /** Result envelope `from.name`. The kid is the cryptographic identity. */
  fromName?: string
  /** Test seam: replace the lazy FileAgentCardSigner. */
  signerFactory?: () => AgentCardSigner
  now?: () => Date
}

/** Gate facts the web route resolved from the member's surface.me workflow. */
export interface ExchangeImportArgs {
  raw: string
  workflowId: string
  capability: string
  inputFieldIds: string[]
  userScopeField: string
  label: string
}

export interface ExchangePreviewView {
  valid: boolean
  errors?: string[]
  summary?: {
    id: string
    kind: 'request' | 'result'
    title: string
    fromName: string
    fromHub?: string
    toName?: string
    capability?: string
    createdAt: string
    replyTo?: string
    payloadBytes: number
  }
  signature?: EnvelopeSigVerdict
  evidence?: DeliveryVerification
  /** Present when this id was already imported here (idempotency). Status is
   * only disclosed to the member who imported it. */
  replay?: { imported: true; mine: boolean; status?: string }
  /** Only a request can be dispatched; a result previews as read-only. */
  dispatchable: boolean
}

export type ExchangeResultView =
  | { status: 'not_found' }
  | { status: 'running'; importedAt: string }
  | { status: 'suspended'; importedAt: string; note: string }
  | { status: 'done'; resultId: string; envelope: string }

/** Thrown by importRequest; the route maps `code` to an HTTP status. */
export class ExchangeError extends Error {
  constructor(
    readonly code: 'invalid' | 'replay' | 'capability_mismatch' | 'not_dispatchable',
    message: string,
    readonly errors?: string[],
    readonly replayStatus?: string,
  ) {
    super(message)
    this.name = 'ExchangeError'
  }
}

interface ExchangeMeta {
  envelopeId: string
  title: string
  importedBy: string
  importedAt: string
  workflowId: string
  capability: string
  status: 'running' | 'suspended' | 'done'
  settledAt?: string
  resultId?: string
}

export interface MeExchangeService {
  preview(userId: string, raw: string, requestRaw?: string): Promise<ExchangePreviewView>
  importRequest(userId: string, args: ExchangeImportArgs): Promise<{ id: string }>
  result(userId: string, id: string): Promise<ExchangeResultView>
}

export function buildMeExchange(opts: BuildMeExchangeOpts): MeExchangeService {
  const dir = join(opts.spaceRoot, 'exchange')
  const now = opts.now ?? (() => new Date())
  const fromName = opts.fromName ?? 'Gotong hub'
  const requestPath = (id: string): string => join(dir, `${id}.json`)
  const metaPath = (id: string): string => join(dir, `${id}.meta.json`)
  const resultPath = (id: string): string => join(dir, `${id}.result.json`)

  // Lazy, cached, never-throwing signer. undefined = untried, null = unusable
  // (warned once). Ids validated by ENVELOPE_ID_RE are filename-safe by
  // construction — the regex is the traversal guard.
  let signer: AgentCardSigner | null | undefined
  const getSigner = (): AgentCardSigner | null => {
    if (signer !== undefined) return signer
    try {
      signer = opts.signerFactory
        ? opts.signerFactory()
        : new FileAgentCardSigner(join(opts.spaceRoot, 'agent-card-signing.key'))
    } catch {
      log.warn('exchange: signing key unusable; results will be minimal failures (key is never silently regenerated)')
      signer = null
    }
    return signer
  }

  const readMeta = async (id: string): Promise<ExchangeMeta | null> => {
    try {
      const text = await readFile(metaPath(id), 'utf8')
      const parsed = JSON.parse(text) as ExchangeMeta
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  const fileExists = async (path: string): Promise<boolean> => {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }

  const settle = async (id: string, meta: ExchangeMeta, result: TaskResult): Promise<void> => {
    if (result.kind === 'suspended') {
      // The run lives on inside the hub (approval / timed resume); the
      // dispatch promise cannot observe its final output — honest status,
      // no fabricated result envelope.
      meta.status = 'suspended'
      meta.settledAt = now().toISOString()
      await writeJsonAtomic(metaPath(id), meta)
      return
    }
    let envelope: ExchangeEnvelope
    let raw: string
    try {
      const outcome =
        result.kind === 'ok'
          ? { ok: true as const, output: result.output }
          : {
              ok: false as const,
              error:
                result.kind === 'failed'
                  ? result.error
                  : result.kind === 'cancelled'
                    ? `cancelled: ${result.reason}`
                    : `no participant took the task: ${result.reason}`,
            }
      const archivedRequest = parseExchangeEnvelope(await readFile(requestPath(id), 'utf8'))
      if (!archivedRequest.ok) throw new ExchangeError('invalid', 'archived request is invalid')
      envelope = buildResultEnvelope({
        request: archivedRequest.envelope,
        provenance: { taskId: result.taskId, by: 'by' in result ? result.by : 'scheduler' },
        ...outcome,
        fromName,
        now: now(),
      })
      const s = getSigner()
      if (!s) throw new ExchangeError('invalid', 'result signer unavailable')
      envelope = signExchangeEnvelope(envelope, s)
      raw = serializeUnderCap(envelope)
      if (!parseExchangeEnvelope(raw).ok) {
        throw new ExchangeError('invalid', 'assembled result failed validation')
      }
    } catch {
      // Do not reuse failed output, exception text, signing, or injected display
      // fields/clock. Any of those may have caused the failure or contain secrets.
      log.error('exchange: result assembly failed; returning a minimal error envelope', { id })
      envelope = buildResultEnvelope({
        request: { id, title: 'Result unavailable' },
        ok: false,
        error: 'internal: result could not be assembled',
        fromName: 'Gotong hub',
      })
      raw = serializeUnderCap(envelope)
    }
    // Result bytes first, meta second: 'done' in the meta implies the result
    // file is durable.
    await writeFileAtomic(resultPath(id), raw)
    meta.status = 'done'
    meta.settledAt = envelope.createdAt
    meta.resultId = envelope.id
    await writeJsonAtomic(metaPath(id), meta)
  }

  return {
    async preview(userId, raw, requestRaw) {
      const parsed = parseExchangeEnvelope(raw)
      if (!parsed.ok) return { valid: false, errors: parsed.errors, dispatchable: false }
      const env = parsed.envelope
      let originalRequest: ExchangeEnvelope | undefined
      if (requestRaw !== undefined) {
        const original = parseExchangeEnvelope(requestRaw)
        if (!original.ok || original.envelope.kind !== 'request') {
          return { valid: false, errors: ['requestRaw: a valid original request is required'], dispatchable: false }
        }
        originalRequest = original.envelope
        // The evidence-only verifier cannot see the enclosing replyTo. Bind
        // that envelope relationship here, regardless of signature presence.
        if (env.kind === 'result' && env.replyTo !== originalRequest.id) {
          return { valid: false, errors: ['replyTo: does not match the supplied original request'], dispatchable: false }
        }
      }
      const view: ExchangePreviewView = {
        valid: true,
        summary: {
          id: env.id,
          kind: env.kind,
          title: env.title,
          fromName: env.from.name,
          ...(env.from.hub !== undefined ? { fromHub: env.from.hub } : {}),
          ...(env.to !== undefined ? { toName: env.to.name } : {}),
          ...(env.capability !== undefined ? { capability: env.capability } : {}),
          createdAt: env.createdAt,
          ...(env.replyTo !== undefined ? { replyTo: env.replyTo } : {}),
          payloadBytes: Buffer.byteLength(JSON.stringify(env.payload), 'utf8'),
        },
        signature: verifyExchangeEnvelope(env),
        dispatchable: env.kind === 'request',
        ...(env.evidence ? { evidence: verifyDeliveryEvidence(env.evidence, env.payload, originalRequest) } : {}),
      }
      if (await fileExists(requestPath(env.id))) {
        const meta = await readMeta(env.id)
        const mine = meta?.importedBy === userId
        view.replay = { imported: true, mine, ...(mine && meta ? { status: meta.status } : {}) }
      }
      return view
    },

    async importRequest(userId, args) {
      const parsed = parseExchangeEnvelope(args.raw)
      if (!parsed.ok) throw new ExchangeError('invalid', 'envelope failed validation', parsed.errors)
      const env = parsed.envelope
      if (env.kind !== 'request') {
        throw new ExchangeError('not_dispatchable', 'only a request envelope can be imported for dispatch; a result is read-only')
      }
      if (env.capability !== undefined && env.capability !== args.capability) {
        // Never echo the workflow's own capability (kept off the member
        // catalog on purpose) — the envelope's is the member's own file.
        throw new ExchangeError('capability_mismatch', `the chosen workflow does not handle this envelope's capability '${env.capability}'`)
      }
      // Payload hygiene — the /api/me/dispatch model, verbatim: copy ONLY the
      // workflow's declared input fields, then force the scope field to the
      // importing member. Everything else in the envelope payload is dropped.
      const payload: Record<string, unknown> = {}
      for (const field of args.inputFieldIds) {
        if (field in env.payload) payload[field] = env.payload[field]
      }
      payload[args.userScopeField] = userId

      await mkdir(dir, { recursive: true })
      try {
        // `wx` = atomic first-import-wins claim; the archive is the EXACT raw
        // bytes the human previewed and approved.
        await writeFile(requestPath(env.id), args.raw, { encoding: 'utf8', flag: 'wx' })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          const meta = await readMeta(env.id)
          throw new ExchangeError(
            'replay',
            `envelope ${env.id} was already imported`,
            undefined,
            meta?.importedBy === userId ? meta.status : undefined,
          )
        }
        throw err
      }
      const meta: ExchangeMeta = {
        envelopeId: env.id,
        title: env.title,
        importedBy: userId,
        importedAt: now().toISOString(),
        workflowId: args.workflowId,
        capability: args.capability,
        status: 'running',
      }
      await writeJsonAtomic(metaPath(env.id), meta)
      // Fire-and-settle: the HTTP confirm returns immediately; the dispatch
      // promise (minutes for LLM runs) lands in settle() → result envelope.
      void opts.hub
        .dispatch({
          from: userId,
          origin: { orgId: 'local', userId },
          strategy: { kind: 'capability', capabilities: [args.capability] },
          payload,
          title: `${args.label} — ${userId}`,
        })
        .then(
          (result) => settle(env.id, meta, result),
          (err) =>
            settle(env.id, meta, {
              kind: 'failed',
              taskId: 'exchange-dispatch',
              error: err instanceof Error ? err.message : String(err),
            } as TaskResult),
        )
        .catch((err) => log.error('exchange: settle failed', { id: env.id, err }))
      return { id: env.id }
    },

    async result(userId, id) {
      if (!ENVELOPE_ID_RE.test(id)) return { status: 'not_found' }
      const meta = await readMeta(id)
      // No meta (never imported, or the tiny claim→meta crash window): report
      // not_found to everyone — with no importer recorded there is no one to
      // scope the answer to. Same answer for other members' imports
      // (anti-enumeration: exists-but-not-yours is indistinguishable).
      if (!meta || meta.importedBy !== userId) return { status: 'not_found' }
      if (meta.status === 'suspended') {
        return {
          status: 'suspended',
          importedAt: meta.importedAt,
          note: 'the run is waiting on an in-hub human step; no result envelope is auto-assembled',
        }
      }
      // Self-heal the result-file-then-meta write order: a crash between the
      // two leaves status 'running' with the result already durable.
      if (meta.status === 'done' || (await fileExists(resultPath(id)))) {
        try {
          const raw = await readFile(resultPath(id), 'utf8')
          // In the crash-heal branch the meta never learned the result id —
          // recover it from the envelope itself.
          const resultId = meta.resultId ?? ((JSON.parse(raw) as { id?: unknown }).id as string ?? 'unknown')
          return { status: 'done', resultId, envelope: raw }
        } catch (err) {
          log.warn('exchange: meta says done but result file unreadable', { id, err })
          return { status: 'running', importedAt: meta.importedAt }
        }
      }
      return { status: 'running', importedAt: meta.importedAt }
    },
  }
}

/** Pretty JSON for human forwarding; falls back to compact when indentation
 * alone would push the file over the whole-file cap (payload is capped at
 * 200KB compact, so the compact form always fits). */
function serializeUnderCap(env: ExchangeEnvelope): string {
  const pretty = `${JSON.stringify(env, null, 2)}\n`
  if (Buffer.byteLength(pretty, 'utf8') <= ENVELOPE_MAX_FILE_BYTES) return pretty
  return `${JSON.stringify(env)}\n`
}
