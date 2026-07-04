/**
 * Outbound bridge: an Gotong agent that delegates a task to a durable
 * external workflow engine (Windmill) and returns its result.
 *
 * This is the mirror image of the Activepieces bridge (which is inbound). Here
 * the Hub dispatches a task to a normal `AgentParticipant`; the participant
 * hands the work to Windmill — which *persists* the job, retries failed steps,
 * and survives its own restarts — then polls until the durable job completes
 * and surfaces the result back through the Hub's transcript. The same shape
 * fits any "submit job, poll for result" engine (Temporal, Inngest, a queue
 * worker): swap the two URLs.
 *
 * `fetchImpl` is injectable so this unit-tests deterministically; the token is
 * passed in by the caller (read from env / vault), never inlined here.
 */

import { AgentParticipant, type Task } from '@gotong/core'

export type FetchLike = (url: string, init?: {
  method?: string
  headers?: Record<string, string>
  body?: string
}) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>

export interface WindmillParticipantOptions {
  id: string
  capabilities: string[]
  /** e.g. `https://app.windmill.dev` or a self-hosted instance. */
  baseUrl: string
  workspace: string
  /** Windmill API token (Bearer). Read from env/vault by the caller. */
  token: string
  /** Flow path, e.g. `u/alice/process_lead` or `f/onboarding/triage`. */
  flowPath: string
  /** Map the Gotong task to the flow's inputs. Default: the payload object. */
  toInputs?: (task: Task) => Record<string, unknown>
  /** Map the durable job's result to the task output. Default: identity. */
  fromResult?: (result: unknown) => unknown
  /** Poll cadence + ceiling while the durable job runs. Default 500ms x 120. */
  pollIntervalMs?: number
  maxPolls?: number
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike
}

export class WindmillParticipant extends AgentParticipant {
  private readonly baseUrl: string
  private readonly workspace: string
  private readonly token: string
  private readonly flowPath: string
  private readonly toInputs: (task: Task) => Record<string, unknown>
  private readonly fromResult: (result: unknown) => unknown
  private readonly pollIntervalMs: number
  private readonly maxPolls: number
  private readonly fetchImpl: FetchLike

  constructor(opts: WindmillParticipantOptions) {
    super({ id: opts.id, capabilities: opts.capabilities })
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.workspace = opts.workspace
    this.token = opts.token
    this.flowPath = opts.flowPath.replace(/^\/+/, '')
    this.toInputs = opts.toInputs ?? ((task) => (isObject(task.payload) ? task.payload : {}))
    this.fromResult = opts.fromResult ?? ((r) => r)
    this.pollIntervalMs = opts.pollIntervalMs ?? 500
    this.maxPolls = opts.maxPolls ?? 120
    this.fetchImpl = opts.fetchImpl ?? ((globalThis as { fetch: FetchLike }).fetch)
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const inputs = this.toInputs(task)
    const jobId = await this.submit(inputs)
    const result = await this.pollResult(jobId)
    return this.fromResult(result)
  }

  /** Kick off the durable flow; Windmill returns the job uuid immediately. */
  private async submit(inputs: Record<string, unknown>): Promise<string> {
    const url = `${this.baseUrl}/api/w/${this.workspace}/jobs/run/f/${this.flowPath}`
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(inputs),
    })
    if (!res.ok) throw new Error(`windmill_submit_failed:${res.status}`)
    // Windmill returns the uuid as a bare string body, sometimes JSON-quoted.
    return (await res.text()).trim().replace(/^"|"$/g, '')
  }

  /** Poll until the durable job completes; surface a failed job as an error. */
  private async pollResult(jobId: string): Promise<unknown> {
    const url = `${this.baseUrl}/api/w/${this.workspace}/jobs_u/completed/get_result_maybe/${jobId}`
    for (let i = 0; i < this.maxPolls; i++) {
      const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${this.token}` } })
      if (!res.ok) throw new Error(`windmill_poll_failed:${res.status}`)
      const body = (await res.json()) as { completed?: boolean; success?: boolean; result?: unknown }
      if (body.completed) {
        // A durable job that ran to completion but failed its own logic is a
        // task failure, not a bridge failure — surface the engine's result.
        if (body.success === false) throw new Error(`windmill_job_failed:${JSON.stringify(body.result)}`)
        return body.result
      }
      await sleep(this.pollIntervalMs)
    }
    throw new Error('windmill_job_timeout')
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
