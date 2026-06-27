/**
 * `setting-ops-service` — the host-side construction of the web `SettingOpsSurface`
 * (setting-ops M4). It binds ops-core's static deps (space dir / env / live health /
 * backup dir / managed env + pricing files / audit sink) ONCE, and exposes the two
 * online operations the admin web surface needs: `list` (the full ops catalog,
 * annotated for the web surface + this actor) and `run` (one read / safe-mutate /
 * config-write(owner) command).
 *
 * Why a host service (not web calling ops-core directly): web takes ZERO runtime
 * dependency on `@aipehub/host` — it consumes this as a duck-typed surface, exactly
 * like `AdminHealthSurface`. The host owns the deps + the audit binding; web stays a
 * thin requireAdmin → resolveActor → echo.
 *
 * The tier boundary is NOT re-implemented here. This service maps the resolved
 * actor onto ops-core's `OpsCaller` (`surface:'web'`, `allowConfigWrite: actor.isOwner`)
 * and lets ops-core's `runOpsCommand` chokepoint enforce it: a destructive-offline
 * id ALWAYS throws `OpsTierError` (web can never reach a destructive op through here,
 * by construction), and a config-write id throws unless the caller is the owner. So
 * the asymmetry stays in the single chokepoint, driven by the flag web supplies.
 */

import { AUDIT_ACTIONS } from '@aipehub/identity'

import type { AdminHealthSurface } from './admin-health.js'
import {
  listOpsCommands,
  runOpsCommand,
  type ConfigWriteAuditSink,
  type OpsCommandInfo,
  type OpsResult,
} from './ops-core.js'

/**
 * The acting admin, resolved by the web layer's shared `resolveResourceActor`
 * closure. `isOwner` is the v4 'owner' role OR a v3 Space-admin token (the
 * personal-mode operator) — exactly ops-core's `allowConfigWrite` semantics for
 * the web surface. `userId` is for audit attribution (null for a v3 token).
 */
export interface SettingOpsActor {
  userId: string | null
  isOwner: boolean
}

/**
 * Narrow audit-write capability — structurally satisfied by the host `IdentityStore`
 * (its `writeAuditLog` is optional too). Absent → config writes still happen,
 * unaudited (e.g. a host without an identity store). The `action` is always the
 * additive `setting_config_write` verb; the surface binds the per-call actor.
 */
export interface SettingAuditSink {
  writeAuditLog?(input: {
    action: string
    actorSource: 'v4-session' | 'v4-bearer' | 'anonymous' | 'system' | 'federated'
    actorUserId?: string | null
    metadata?: Record<string, unknown> | null
    success?: boolean
  }): unknown
}

export interface SettingOpsServiceDeps {
  /** Workspace root (AIPE_SPACE). */
  spaceDir: string
  /** Env the read/config views report on. Defaults to process.env. */
  env?: Record<string, string | undefined>
  /** Live hub health surface — added to the `status` snapshot. Reuse the same
   * `createAdminHealthService` instance the overview panel uses so they never
   * disagree. */
  health?: AdminHealthSurface
  /** Directory `inventory` scans. Defaults to env.AIPE_BACKUP_DIR (read-only). */
  backupDir?: string
  /** Managed env file `config-set` writes. Defaults to <space>/aipehub.env. */
  envFilePath?: string
  /** Pricing override file `config-price` writes. Defaults to <space>/pricing.json. */
  pricingPath?: string
  /** Best-effort audit sink for config writes (the IdentityStore satisfies it). */
  audit?: SettingAuditSink
}

/** The duck-typed surface web consumes (its `SettingOpsSurface` mirror). */
export interface SettingOpsService {
  list(actor: SettingOpsActor): Promise<OpsCommandInfo[]>
  run(id: string, args: readonly string[], actor: SettingOpsActor): Promise<OpsResult>
}

/**
 * Build the web setting-ops surface. The returned object structurally satisfies
 * web's `SettingOpsSurface`, so `main.ts` passes it straight into `serveWeb`.
 */
export function createSettingOpsService(deps: SettingOpsServiceDeps): SettingOpsService {
  const env = deps.env ?? process.env

  /**
   * Per-call audit closure for a config write. Bound to the resolved actor so
   * the row carries who made the change. Best-effort: an audit hiccup must NEVER
   * surface as a write failure (the bytes already landed), so it swallows errors.
   * `actorSource`: a real v4 user → 'v4-session'; a v3 Space-admin token (no user
   * row) → 'system' (the operator without an identity).
   */
  function auditFor(actor: SettingOpsActor): ConfigWriteAuditSink | undefined {
    const sink = deps.audit
    if (!sink || typeof sink.writeAuditLog !== 'function') return undefined
    return (metadata) => {
      try {
        sink.writeAuditLog!({
          action: AUDIT_ACTIONS.SETTING_CONFIG_WRITE,
          actorSource: actor.userId ? 'v4-session' : 'system',
          actorUserId: actor.userId,
          metadata,
          success: true,
        })
      } catch {
        // best-effort — the config write already succeeded.
      }
    }
  }

  function depsFor(actor: SettingOpsActor) {
    const audit = auditFor(actor)
    return {
      spaceDir: deps.spaceDir,
      env,
      ...(deps.health ? { health: deps.health } : {}),
      ...(deps.backupDir ? { backupDir: deps.backupDir } : {}),
      ...(deps.envFilePath ? { envFilePath: deps.envFilePath } : {}),
      ...(deps.pricingPath ? { pricingPath: deps.pricingPath } : {}),
      ...(audit ? { audit } : {}),
    }
  }

  return {
    async list(actor) {
      return listOpsCommands({ surface: 'web', allowConfigWrite: actor.isOwner })
    },
    async run(id, args, actor) {
      return runOpsCommand(
        id,
        args,
        { surface: 'web', allowConfigWrite: actor.isOwner },
        depsFor(actor),
      )
    },
  }
}
