/**
 * Parser + validator for `aipehub.workflow/v1` YAML / JSON files.
 *
 * The contract is the same as `parseManifest` in `@aipehub/web`:
 *   - try JSON first if the body looks JSON-y (`{` / `[`)
 *   - else parse YAML
 *   - reject loudly with a helpful message; the admin UI surfaces these
 *     reasons verbatim
 *
 * The parser only checks *structure* — it doesn't try to validate `$ref`
 * expressions, since those refer to runtime values and are checked by
 * `resolver.ts` at execution time.
 */

import { parse as parseYaml } from 'yaml'

import type { DispatchStrategy } from '@aipehub/core'

import { parsePredicate, WorkflowPredicateError } from './predicate.js'
import {
  WORKFLOW_SCHEMA_V1,
  WorkflowSchemaError,
  type Branch,
  type DispatchSpec,
  type ParallelStep,
  type PayloadFieldSpec,
  type SimpleStep,
  type Step,
  type StepFailurePolicy,
  type WorkflowDefinition,
} from './types.js'

const ID_RE = /^[a-zA-Z0-9_.:-]+$/

export function parseWorkflow(raw: string): WorkflowDefinition {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new WorkflowSchemaError('workflow file is empty')
  }

  let doc: unknown
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      doc = JSON.parse(trimmed)
    } catch (err) {
      throw new WorkflowSchemaError(
        `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    try {
      doc = parseYaml(trimmed)
    } catch (err) {
      throw new WorkflowSchemaError(
        `not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  if (!doc || typeof doc !== 'object') {
    throw new WorkflowSchemaError(`workflow file must be an object at the top level`)
  }
  const root = doc as Record<string, unknown>
  if (root.schema !== WORKFLOW_SCHEMA_V1) {
    throw new WorkflowSchemaError(
      `unexpected 'schema' value '${String(root.schema)}' — expected '${WORKFLOW_SCHEMA_V1}'`,
    )
  }
  const wf = root.workflow
  if (!wf || typeof wf !== 'object') {
    throw new WorkflowSchemaError(`top-level 'workflow' object is required`)
  }
  return validateWorkflow(wf as Record<string, unknown>)
}

function validateWorkflow(w: Record<string, unknown>): WorkflowDefinition {
  // id
  if (typeof w.id !== 'string' || w.id.length === 0) {
    throw new WorkflowSchemaError(`workflow.id is required (non-empty string)`)
  }
  if (w.id.length > 80) {
    throw new WorkflowSchemaError(`workflow.id is too long (max 80 chars)`)
  }
  if (!ID_RE.test(w.id)) {
    throw new WorkflowSchemaError(
      `workflow.id may only contain letters, digits, '_', '.', ':', '-' — got '${w.id}'`,
    )
  }
  // trigger
  const trigger = w.trigger
  if (!trigger || typeof trigger !== 'object') {
    throw new WorkflowSchemaError(`workflow.trigger is required (object)`)
  }
  const triggerObj = trigger as Record<string, unknown>
  const cap = triggerObj.capability
  if (typeof cap !== 'string' || cap.length === 0) {
    throw new WorkflowSchemaError(
      `workflow.trigger.capability is required (non-empty string)`,
    )
  }
  // Optional payload_schema — pure UI hint for the admin dispatch
  // form. Accept either snake_case (yaml convention) or camelCase
  // (json convention).
  const rawSchema = triggerObj.payload_schema ?? triggerObj.payloadSchema
  const payloadSchema = rawSchema !== undefined
    ? validatePayloadSchema(rawSchema, 'workflow.trigger.payload_schema')
    : undefined
  // steps
  const stepsRaw = w.steps
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new WorkflowSchemaError(`workflow.steps must be a non-empty array`)
  }
  const seenStepIds = new Set<string>()
  const steps: Step[] = []
  for (let i = 0; i < stepsRaw.length; i++) {
    const s = validateStep(stepsRaw[i], `workflow.steps[${i}]`, seenStepIds)
    steps.push(s)
  }
  // onFailure (workflow-level)
  let onFailure: 'halt' | 'continue' = 'halt'
  if (w.onFailure !== undefined) {
    if (w.onFailure !== 'halt' && w.onFailure !== 'continue') {
      throw new WorkflowSchemaError(
        `workflow.onFailure must be 'halt' or 'continue', got '${String(w.onFailure)}'`,
      )
    }
    onFailure = w.onFailure
  }
  const out: WorkflowDefinition = {
    schema: WORKFLOW_SCHEMA_V1,
    id: w.id,
    trigger: payloadSchema
      ? { capability: cap, payloadSchema }
      : { capability: cap },
    steps,
    onFailure,
  }
  if (typeof w.name === 'string') out.name = w.name
  if (typeof w.description === 'string') out.description = w.description
  if (w.output !== undefined) out.output = w.output
  return out
}

function validateStep(raw: unknown, path: string, seenIds: Set<string>): Step {
  if (!raw || typeof raw !== 'object') {
    throw new WorkflowSchemaError(`${path} must be an object`)
  }
  const s = raw as Record<string, unknown>
  if (typeof s.id !== 'string' || s.id.length === 0) {
    throw new WorkflowSchemaError(`${path}.id is required (non-empty string)`)
  }
  if (!ID_RE.test(s.id)) {
    throw new WorkflowSchemaError(
      `${path}.id may only contain letters, digits, '_', '.', ':', '-' — got '${s.id}'`,
    )
  }
  if (seenIds.has(s.id)) {
    throw new WorkflowSchemaError(`${path}.id '${s.id}' duplicates an earlier step id`)
  }
  seenIds.add(s.id)

  const when = validateWhen(s.when, `${path}.when`)

  const isParallel = s.parallel === true
  if (isParallel) {
    const branchesRaw = s.branches
    if (!Array.isArray(branchesRaw) || branchesRaw.length === 0) {
      throw new WorkflowSchemaError(
        `${path}.branches must be a non-empty array (because parallel === true)`,
      )
    }
    const branchIds = new Set<string>()
    const branches: Branch[] = []
    for (let i = 0; i < branchesRaw.length; i++) {
      branches.push(
        validateBranch(branchesRaw[i], `${path}.branches[${i}]`, branchIds),
      )
    }
    const out: ParallelStep = {
      id: s.id,
      parallel: true,
      branches,
    }
    if (typeof s.description === 'string') out.description = s.description
    const fp = parseStepFailurePolicy(s.onFailure, `${path}.onFailure`)
    if (fp) out.onFailure = fp
    if (when !== undefined) out.when = when
    return out
  }

  // simple step
  if (s.dispatch === undefined) {
    throw new WorkflowSchemaError(
      `${path}.dispatch is required (or set 'parallel: true' with branches)`,
    )
  }
  const dispatch = validateDispatchSpec(s.dispatch, `${path}.dispatch`)
  const out: SimpleStep = { id: s.id, dispatch }
  if (typeof s.description === 'string') out.description = s.description
  const fp = parseStepFailurePolicy(s.onFailure, `${path}.onFailure`)
  if (fp) out.onFailure = fp
  if (when !== undefined) out.when = when
  return out
}

/**
 * Light validator for the optional `when` predicate. We parse it
 * eagerly at schema-validation time so bad predicates surface during
 * import, not at first dispatch.
 */
function validateWhen(raw: unknown, path: string): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new WorkflowSchemaError(`${path} must be a non-empty string`)
  }
  try {
    parsePredicate(raw)
  } catch (err) {
    const msg = err instanceof WorkflowPredicateError ? err.message : String(err)
    throw new WorkflowSchemaError(`${path} is not a valid predicate: ${msg}`)
  }
  return raw
}

function validateBranch(raw: unknown, path: string, seenIds: Set<string>): Branch {
  if (!raw || typeof raw !== 'object') {
    throw new WorkflowSchemaError(`${path} must be an object`)
  }
  const b = raw as Record<string, unknown>
  if (typeof b.id !== 'string' || b.id.length === 0) {
    throw new WorkflowSchemaError(`${path}.id is required (non-empty string)`)
  }
  if (!ID_RE.test(b.id)) {
    throw new WorkflowSchemaError(
      `${path}.id may only contain letters, digits, '_', '.', ':', '-' — got '${b.id}'`,
    )
  }
  if (seenIds.has(b.id)) {
    throw new WorkflowSchemaError(`${path}.id '${b.id}' duplicates a sibling branch id`)
  }
  seenIds.add(b.id)
  if (b.dispatch === undefined) {
    throw new WorkflowSchemaError(`${path}.dispatch is required`)
  }
  const dispatch = validateDispatchSpec(b.dispatch, `${path}.dispatch`)
  const when = validateWhen(b.when, `${path}.when`)
  const out: Branch = { id: b.id, dispatch }
  if (typeof b.description === 'string') out.description = b.description
  if (when !== undefined) out.when = when
  return out
}

function validateDispatchSpec(raw: unknown, path: string): DispatchSpec {
  if (!raw || typeof raw !== 'object') {
    throw new WorkflowSchemaError(`${path} must be an object`)
  }
  const d = raw as Record<string, unknown>
  const strategyRaw = d.strategy
  if (!strategyRaw || typeof strategyRaw !== 'object') {
    throw new WorkflowSchemaError(`${path}.strategy is required (object)`)
  }
  const strategy = validateStrategy(
    strategyRaw as Record<string, unknown>,
    `${path}.strategy`,
  )
  if (d.payload === undefined) {
    throw new WorkflowSchemaError(`${path}.payload is required (any value is OK)`)
  }
  const out: DispatchSpec = { strategy, payload: d.payload }
  if (typeof d.title === 'string') out.title = d.title
  if (typeof d.weight === 'number' && Number.isFinite(d.weight)) out.weight = d.weight
  if (typeof d.priority === 'number' && Number.isFinite(d.priority)) {
    out.priority = d.priority
  }
  return out
}

function validateStrategy(s: Record<string, unknown>, path: string): DispatchStrategy {
  const kind = s.kind
  if (kind === 'capability') {
    const caps = s.capabilities
    if (!Array.isArray(caps) || caps.length === 0) {
      throw new WorkflowSchemaError(
        `${path}.capabilities must be a non-empty array of strings`,
      )
    }
    const out: string[] = []
    for (const c of caps) {
      if (typeof c !== 'string' || c.length === 0) {
        throw new WorkflowSchemaError(
          `${path}.capabilities must contain non-empty strings`,
        )
      }
      out.push(c)
    }
    return { kind: 'capability', capabilities: out }
  }
  if (kind === 'explicit') {
    if (typeof s.to !== 'string' || s.to.length === 0) {
      throw new WorkflowSchemaError(`${path}.to is required (non-empty string)`)
    }
    return { kind: 'explicit', to: s.to }
  }
  if (kind === 'broadcast') {
    if (s.capabilities === undefined) {
      return { kind: 'broadcast' }
    }
    if (!Array.isArray(s.capabilities)) {
      throw new WorkflowSchemaError(`${path}.capabilities must be an array if present`)
    }
    const out: string[] = []
    for (const c of s.capabilities) {
      if (typeof c !== 'string' || c.length === 0) {
        throw new WorkflowSchemaError(
          `${path}.capabilities must contain non-empty strings`,
        )
      }
      out.push(c)
    }
    return { kind: 'broadcast', capabilities: out }
  }
  throw new WorkflowSchemaError(
    `${path}.kind must be 'capability' | 'explicit' | 'broadcast', got '${String(kind)}'`,
  )
}

function parseStepFailurePolicy(
  raw: unknown,
  path: string,
): StepFailurePolicy | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object') {
    throw new WorkflowSchemaError(`${path} must be an object`)
  }
  const fp = raw as Record<string, unknown>
  if (fp.action === 'halt') return { action: 'halt' }
  if (fp.action === 'continue') return { action: 'continue' }
  if (fp.action === 'retry') {
    if (typeof fp.max !== 'number' || !Number.isInteger(fp.max) || fp.max < 1) {
      throw new WorkflowSchemaError(
        `${path}.max must be a positive integer for 'retry' action`,
      )
    }
    return { action: 'retry', max: fp.max }
  }
  throw new WorkflowSchemaError(
    `${path}.action must be 'halt' | 'continue' | 'retry', got '${String(fp.action)}'`,
  )
}

/**
 * Validate `trigger.payload_schema`. Pure structural check — the
 * runner doesn't use these values, the admin UI does. We're picky
 * about shape so a bad schema fails at workflow load time (admin
 * sees the error on import) instead of silently rendering an empty
 * dispatch form.
 */
function validatePayloadSchema(raw: unknown, path: string): PayloadFieldSpec[] {
  if (!Array.isArray(raw)) {
    throw new WorkflowSchemaError(`${path} must be an array`)
  }
  const ids = new Set<string>()
  const out: PayloadFieldSpec[] = []
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]
    const ep = `${path}[${i}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new WorkflowSchemaError(`${ep} must be an object`)
    }
    const e = entry as Record<string, unknown>
    if (typeof e.id !== 'string' || e.id.length === 0) {
      throw new WorkflowSchemaError(`${ep}.id is required (non-empty string)`)
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(e.id)) {
      throw new WorkflowSchemaError(
        `${ep}.id must match /^[a-zA-Z][a-zA-Z0-9_]*$/ — got '${e.id}'`,
      )
    }
    if (ids.has(e.id)) {
      throw new WorkflowSchemaError(`${ep}.id '${e.id}' duplicates an earlier payload field`)
    }
    ids.add(e.id)
    if (typeof e.label !== 'string' || e.label.length === 0) {
      throw new WorkflowSchemaError(`${ep}.label is required (non-empty string)`)
    }
    const type = e.type
    if (type !== 'text' && type !== 'textarea' && type !== 'number' && type !== 'select') {
      throw new WorkflowSchemaError(
        `${ep}.type must be 'text' | 'textarea' | 'number' | 'select' — got '${String(type)}'`,
      )
    }
    const spec: PayloadFieldSpec = { id: e.id, label: e.label, type }
    if (typeof e.hint === 'string') spec.hint = e.hint
    if (typeof e.placeholder === 'string') spec.placeholder = e.placeholder
    if (e.required === true) spec.required = true
    if (typeof e.defaultValue === 'string' || typeof e.defaultValue === 'number') {
      spec.defaultValue = e.defaultValue
    }
    if (typeof e.rows === 'number' && e.rows >= 1 && e.rows <= 50) {
      spec.rows = e.rows
    }
    if (type === 'select') {
      if (!Array.isArray(e.options) || e.options.length === 0) {
        throw new WorkflowSchemaError(`${ep}.options is required and non-empty when type='select'`)
      }
      const opts: { value: string; label: string }[] = []
      for (let j = 0; j < e.options.length; j++) {
        const o = e.options[j]
        if (!o || typeof o !== 'object') {
          throw new WorkflowSchemaError(`${ep}.options[${j}] must be an object`)
        }
        const oo = o as Record<string, unknown>
        if (typeof oo.value !== 'string' || typeof oo.label !== 'string') {
          throw new WorkflowSchemaError(
            `${ep}.options[${j}] requires string {value, label}`,
          )
        }
        opts.push({ value: oo.value, label: oo.label })
      }
      spec.options = opts
    }
    out.push(spec)
  }
  return out
}
