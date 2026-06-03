/**
 * TotpStore — Route B P1-M3b, the MFA (TOTP) enrollment store.
 *
 * Splits "the secret" from "the enrollment state":
 *   - The shared secret lives as a VAULT ENTRY (kind 'totp', ownerKind 'user').
 *     Reusing the vault — the exact pattern A-M3b uses for a member's per-user
 *     LLM key — means the DEK envelope encrypts it at rest and a master-key
 *     rotation (P0-M4c) re-wraps it for free. We never invented a second secret
 *     store to keep in sync with rotation.
 *   - The `user_totp` row holds only the pointer (`vault_id`) plus lifecycle
 *     (`confirmed_at` / `last_used_at`). One row per user; re-enroll replaces it.
 *
 * The algorithm (RFC 6238) is the pure totp.ts layer (M3a); this store is the
 * stateful glue: generate → persist pending → confirm with a real code →
 * verify at login. Code-time is an explicit argument (`nowSeconds`) so tests
 * pin behaviour with frozen time; production passes the wall clock.
 *
 * Vault calls (createVaultEntry / readVaultSecret / revokeVaultEntry) require a
 * master key was configured at openIdentityStore time; without one they throw —
 * MFA, like the vault, is unavailable until the host configures encryption.
 */

import { type SqliteDb, type SqliteStmt } from './db.js'
import { IdentityError } from './errors.js'
import {
  base32Decode,
  buildOtpauthUri,
  generateTotpSecret,
  verifyTotp,
} from './totp.js'
import type { TotpEnrollment, TotpState, VaultEntry } from './types.js'

/** The narrow slice of the vault facade this store needs (injected). */
export interface TotpVaultOps {
  createVaultEntry(input: {
    kind: 'totp'
    ownerKind: 'user'
    ownerId: string
    secret: string
    label?: string
  }): VaultEntry
  readVaultSecret(id: string): string
  revokeVaultEntry(id: string): boolean
}

interface TotpRow {
  user_id: string
  vault_id: string
  confirmed_at: number | null
  created_at: number
  last_used_at: number | null
}

export interface EnrollTotpInput {
  userId: string
  /** The account label shown in the authenticator app (usually the email). */
  account: string
  /** The service/issuer name shown in the authenticator app. */
  issuer: string
}

export interface VerifyTotpInput {
  userId: string
  code: string
  /** Unix SECONDS; defaults to the wall clock. Tests pass a frozen value. */
  nowSeconds?: number
}

export class TotpStore {
  private readonly stmtGet: SqliteStmt
  private readonly stmtUpsert: SqliteStmt
  private readonly stmtConfirm: SqliteStmt
  private readonly stmtTouch: SqliteStmt
  private readonly stmtDelete: SqliteStmt

  constructor(
    private readonly db: SqliteDb,
    private readonly vault: TotpVaultOps,
  ) {
    this.stmtGet = db.prepare('SELECT * FROM user_totp WHERE user_id = ?')
    this.stmtUpsert = db.prepare(
      `INSERT OR REPLACE INTO user_totp
        (user_id, vault_id, confirmed_at, created_at, last_used_at)
        VALUES (?, ?, NULL, ?, NULL)`,
    )
    this.stmtConfirm = db.prepare('UPDATE user_totp SET confirmed_at = ? WHERE user_id = ?')
    this.stmtTouch = db.prepare('UPDATE user_totp SET last_used_at = ? WHERE user_id = ?')
    this.stmtDelete = db.prepare('DELETE FROM user_totp WHERE user_id = ?')
  }

  private row(userId: string): TotpRow | undefined {
    return this.stmtGet.get(userId) as TotpRow | undefined
  }

  /** Enrollment lifecycle for a user. */
  getState(userId: string): TotpState {
    const r = this.row(userId)
    if (!r) return 'none'
    return r.confirmed_at != null ? 'active' : 'pending'
  }

  /** True iff the user has a CONFIRMED second factor (gates login). */
  isEnabled(userId: string): boolean {
    return this.getState(userId) === 'active'
  }

  /**
   * Begin (or restart) enrollment: mint a fresh secret, persist it as a pending
   * vault entry, and return the one-time payload for the QR code. Re-enrolling
   * replaces any prior secret (and revokes the old vault entry) — confirming the
   * new one is then required, so a half-finished re-enroll can't silently keep
   * the old factor working under a new QR.
   */
  enroll(input: EnrollTotpInput): TotpEnrollment {
    const { secret, base32 } = generateTotpSecret()
    // Vault stores strings; keep the base32 form (what we decode at verify).
    const entry = this.vault.createVaultEntry({
      kind: 'totp',
      ownerKind: 'user',
      ownerId: input.userId,
      secret: base32,
      label: 'mfa-totp',
    })
    const prior = this.row(input.userId)
    // Single-statement upsert (auto-commits); no outer transaction so we never
    // nest inside the vault's own DEK-seed transaction on first use.
    this.stmtUpsert.run(input.userId, entry.id, Date.now())
    // Revoke the superseded secret AFTER repointing the row, so a crash leaves
    // at most an orphan vault entry (a useless unconfirmed secret), never a row
    // pointing at a deleted secret.
    if (prior) this.vault.revokeVaultEntry(prior.vault_id)
    // `secret` is intentionally not returned raw; base32 is the user-facing form.
    void secret
    return {
      secretBase32: base32,
      otpauthUri: buildOtpauthUri({
        secretBase32: base32,
        account: input.account,
        issuer: input.issuer,
      }),
    }
  }

  /**
   * Confirm a pending enrollment by proving possession with a current code.
   * Only a 'pending' enrollment may be confirmed (re-confirming an active one,
   * or confirming nothing, is a caller bug → throws). Returns false on a wrong
   * code, leaving the enrollment pending so the user can retry.
   */
  confirm(input: VerifyTotpInput): boolean {
    const r = this.row(input.userId)
    if (!r) {
      throw new IdentityError({ code: 'invalid_input', message: 'no TOTP enrollment to confirm' })
    }
    if (r.confirmed_at != null) {
      throw new IdentityError({ code: 'invalid_input', message: 'TOTP already confirmed' })
    }
    if (!this.verifySecret(r.vault_id, input.code, input.nowSeconds)) return false
    this.stmtConfirm.run(Date.now(), input.userId)
    return true
  }

  /**
   * Verify a code at LOGIN. Fail-closed: returns false unless the user has an
   * ACTIVE factor and the code matches. Bumps last_used_at on success.
   */
  verifyForLogin(input: VerifyTotpInput): boolean {
    const r = this.row(input.userId)
    if (!r || r.confirmed_at == null) return false
    if (!this.verifySecret(r.vault_id, input.code, input.nowSeconds)) return false
    this.stmtTouch.run(Date.now(), input.userId)
    return true
  }

  /** Remove the second factor entirely (state row + the vault secret). */
  disable(userId: string): boolean {
    const r = this.row(userId)
    if (!r) return false
    this.stmtDelete.run(userId)
    this.vault.revokeVaultEntry(r.vault_id)
    return true
  }

  private verifySecret(vaultId: string, code: string, nowSeconds?: number): boolean {
    const base32 = this.vault.readVaultSecret(vaultId)
    const secret = base32Decode(base32)
    const now = nowSeconds ?? Math.floor(Date.now() / 1000)
    return verifyTotp(secret, code, now)
  }
}
