/**
 * LONG-M4b — 工种×模型槽解析器(pool 侧的装配叶子)。
 *
 * Builds, for ONE butler row, the `(slot) => resolution | null` closure the
 * driver consults (`ButlerLongRunDriver.slotProvider` in personal-butler; the
 * types here are its structural twin — the pool does not import that package).
 * It lives outside `local-agent-pool.ts` on purpose: it needs exactly three
 * seams from the pool (key chain / provider construction / logger), carries no
 * pool state, and the pool sits at its line budget — a leaf keeps that budget
 * honest instead of raising it.
 *
 * Semantics (all gated by `tests/local-agent-pool-butler.test.ts`):
 *  - no slot configured → `undefined`: the pool then passes no resolver at all
 *    (byte-identical third factory arg) and the driver rides the main chain for
 *    every role = M2/M3 behaviour.
 *  - model-only slot (no `provider`) → `{ model }`: the main chain with another
 *    model name (NA-M5 `maintenanceModel` semantics; the driver rides it on
 *    `req.model`).
 *  - cross-provider slot → a dedicated provider built through the SAME factory
 *    + key chain + resilience wrappers as the main chain; the slot's own
 *    `apiKeyEnv` is honoured exclusively (MR-M6: named env var missing = no key,
 *    never a silent fall-through to the stored key of another vendor).
 *  - anything unbuildable (key missing / lookup throws / factory throws) →
 *    warn + `null`. A slot may only ever improve a segment, never strand one.
 *  - successes are cached per slot for the row's lifetime (one provider per
 *    ROLE, not one per segment); failures are NOT cached, so a key that appears
 *    after a warn is picked up on the next ask without a restart.
 *  - deliberately NOT carried from the main spec: `thinking` (a vendor body
 *    extension of the MAIN endpoint — the slot may be another vendor) and
 *    `fallbacks` (slots pin their own provider/model; routing is the main
 *    chain's story).
 */
import type { LongRunModelSlot, ManagedAgentSpec, ParticipantId } from '@gotong/core'
import type { LlmProvider } from '@gotong/llm'

/** The two role slots the driver consults (mirrors core `LongRunModelSlots`). */
export type ButlerLongRunSlotName = 'compactor' | 'synthesizer'

/**
 * One resolved slot. `model` always; `provider` only when the slot crosses
 * providers (model-only = main chain with another model name).
 */
export interface ButlerLongRunSlotResolution {
  provider?: LlmProvider
  model: string
}

export type ButlerLongRunSlotResolver = (
  slot: ButlerLongRunSlotName,
) => Promise<ButlerLongRunSlotResolution | null>

/** The three pool seams the resolver needs — nothing else of the pool leaks in. */
export interface ButlerLongRunSlotDeps {
  /** The row's key chain (pool `resolveApiKey` bound to the agent): the key, or undefined. */
  resolveKey: (
    provider: NonNullable<LongRunModelSlot['provider']>,
    apiKeyEnv: string | undefined,
  ) => Promise<string | undefined>
  /** Provider construction INCLUDING the main chain's resilience wrappers. */
  buildProvider: (slotSpec: ManagedAgentSpec, apiKey: string | undefined) => LlmProvider
  warn: (msg: string, data: Record<string, unknown>) => void
}

export function buildButlerLongRunSlotResolver(
  agentId: ParticipantId,
  spec: ManagedAgentSpec,
  deps: ButlerLongRunSlotDeps,
): ButlerLongRunSlotResolver | undefined {
  const slots = spec.longRunModels
  if (!slots || (!slots.compactor && !slots.synthesizer)) return undefined
  const cache = new Map<ButlerLongRunSlotName, ButlerLongRunSlotResolution>()
  return async (slotName) => {
    const hit = cache.get(slotName)
    if (hit) return hit
    const built = await resolveSlot(agentId, spec, slotName, deps)
    if (built) cache.set(slotName, built)
    return built
  }
}

async function resolveSlot(
  agentId: ParticipantId,
  spec: ManagedAgentSpec,
  slotName: ButlerLongRunSlotName,
  deps: ButlerLongRunSlotDeps,
): Promise<ButlerLongRunSlotResolution | null> {
  const slot: LongRunModelSlot | undefined = spec.longRunModels?.[slotName]
  if (!slot) return null
  if (!slot.provider) return { model: slot.model }
  let key: string | undefined
  try {
    key = await deps.resolveKey(slot.provider, slot.apiKeyEnv)
  } catch (err) {
    deps.warn('longrun: slot key lookup failed — falling back to the main chain', {
      agentId,
      slot: slotName,
      provider: slot.provider,
      err,
    })
    return null
  }
  if (slot.provider !== 'mock' && !key) {
    deps.warn('longrun: slot has no usable key — falling back to the main chain', {
      agentId,
      slot: slotName,
      provider: slot.provider,
      ...(slot.apiKeyEnv ? { apiKeyEnv: slot.apiKeyEnv } : {}),
    })
    return null
  }
  const slotSpec: ManagedAgentSpec = {
    kind: spec.kind,
    provider: slot.provider,
    system: spec.system,
    model: slot.model,
    ...(slot.baseURL ? { baseURL: slot.baseURL } : {}),
  }
  try {
    return { provider: deps.buildProvider(slotSpec, key), model: slot.model }
  } catch (err) {
    deps.warn('longrun: slot provider unbuildable — falling back to the main chain', {
      agentId,
      slot: slotName,
      provider: slot.provider,
      err,
    })
    return null
  }
}
