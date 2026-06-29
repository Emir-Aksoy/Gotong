/**
 * `@aipehub/personal-memory` — the memory engine for the resident butler.
 *
 * Public surface:
 *   - `renderFrozenBlock`        pure, byte-stable memory → markdown renderer
 *   - `MemorySession`            once-per-session frozen-block memoizer
 *   - `MemoryToolset`            remember / recall / forget as LLM tools
 *   - `MemoryAugmentedAgent`     LlmAgent + frozen-block injection + tools
 *   - `PersonalMemoryError`      typed error
 *
 * See `docs/zh/PERSONAL-BUTLER-DESIGN.md` (milestone M1).
 */

export { renderFrozenBlock, type RenderFrozenBlockOptions } from './frozen-block.js'
export { MemorySession, type MemorySessionOptions } from './session.js'
export { MemoryToolset, type MemoryToolsetOptions } from './toolset.js'
export {
  MemoryAugmentedAgent,
  type MemoryAugmentedAgentOptions,
} from './agent.js'
export { PersonalMemoryError, type PersonalMemoryErrorCode } from './errors.js'
