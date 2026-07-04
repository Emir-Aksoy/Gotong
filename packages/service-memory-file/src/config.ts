/**
 * Config for `@gotong/service-memory-file`. Authored by yaml:
 *
 *   uses:
 *     - type: memory
 *       impl: file
 *       config:
 *         kinds: [episodic, semantic]   # default: all three
 *         maxEpisodicBytes: 4194304     # default: no cap
 *         maxSemanticBytes: 1048576     # default: no cap
 *
 * `scope:` is NOT here — it's translated into an Owner by the
 * registry before `attach` is called, so the plugin never sees the
 * yaml scope string. See `services-sdk/src/owner.ts`.
 */

import { ServiceConfigError, type MemoryKind } from '@gotong/services-sdk'

export interface MemoryFileConfig {
  /**
   * Which memory kinds this owner is allowed to write/read. Default:
   * all three. Limiting at config time lets agents declare intent —
   * e.g. a "summarizer" agent that only uses semantic memory can
   * refuse stray episodic writes early.
   */
  readonly kinds: ReadonlyArray<MemoryKind>
  /**
   * Bytes after which `episodic.jsonl` triggers truncation. The plugin
   * drops the oldest ~50 % of entries when crossed. Default: no cap
   * (the agent / admin is responsible for trimming).
   */
  readonly maxEpisodicBytes?: number
  /**
   * Same for `semantic.jsonl`. Semantic entries are usually curated
   * and small, so default is also no cap.
   */
  readonly maxSemanticBytes?: number
}

const ALL_KINDS: ReadonlyArray<MemoryKind> = ['episodic', 'semantic', 'working']

/**
 * Plugin-side config validator. Used by both ServicePlugin.validateConfig
 * (yaml load path) and tests.
 *
 * Strict shape — unknown fields raise, so typos don't silently disable
 * features.
 */
export function validateMemoryFileConfig(raw: unknown): MemoryFileConfig {
  const obj = (raw ?? {}) as Record<string, unknown>
  if (raw != null && typeof raw !== 'object') {
    throw new ServiceConfigError('memory', 'file', `config must be an object, got ${typeof raw}`)
  }

  // kinds
  let kinds: ReadonlyArray<MemoryKind> = ALL_KINDS
  if (obj.kinds !== undefined) {
    if (!Array.isArray(obj.kinds)) {
      throw new ServiceConfigError('memory', 'file', 'kinds must be an array')
    }
    for (const k of obj.kinds) {
      if (k !== 'episodic' && k !== 'semantic' && k !== 'working') {
        throw new ServiceConfigError(
          'memory', 'file',
          `unknown kind '${String(k)}' — must be one of episodic / semantic / working`,
        )
      }
    }
    if (obj.kinds.length === 0) {
      throw new ServiceConfigError('memory', 'file', 'kinds must not be empty when set')
    }
    // Deduplicate while preserving order.
    kinds = [...new Set(obj.kinds as MemoryKind[])]
  }

  const maxEpisodicBytes = parsePositiveInt(obj.maxEpisodicBytes, 'maxEpisodicBytes')
  const maxSemanticBytes = parsePositiveInt(obj.maxSemanticBytes, 'maxSemanticBytes')

  const unknown = Object.keys(obj).filter(
    (k) => !['kinds', 'maxEpisodicBytes', 'maxSemanticBytes', 'scope'].includes(k),
  )
  if (unknown.length > 0) {
    throw new ServiceConfigError(
      'memory', 'file',
      `unknown config keys: ${unknown.join(', ')}`,
    )
  }

  const cfg: MemoryFileConfig = {
    kinds,
    ...(maxEpisodicBytes !== undefined ? { maxEpisodicBytes } : {}),
    ...(maxSemanticBytes !== undefined ? { maxSemanticBytes } : {}),
  }
  return cfg
}

function parsePositiveInt(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || Math.floor(v) !== v) {
    throw new ServiceConfigError(
      'memory', 'file',
      `${name} must be a positive integer (got ${JSON.stringify(v)})`,
    )
  }
  return v
}
