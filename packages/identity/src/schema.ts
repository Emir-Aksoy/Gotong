/**
 * Schema migration registry.
 *
 * Add new versions by APPENDING to `MIGRATIONS`. Never edit a published
 * version's SQL — once a host has migrated past v=N, the only safe
 * forward path is appending v=N+1.
 *
 * `applyMigrations(db)` runs every missing migration inside a
 * transaction and records the version in `schema_migrations`. Safe to
 * call on every host startup; the function short-circuits when
 * everything is already applied.
 */

import { transaction, type SqliteDb } from './db.js'

interface Migration {
  version: number
  name: string
  sql: string
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-users-credentials-memberships-sessions',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        identifier TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        UNIQUE(kind, identifier)
      );
      CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id);

      CREATE TABLE IF NOT EXISTS memberships (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON auth_sessions(expires_at);
    `,
  },
  {
    // V4-AUDIT-06: identity audit log table.
    //
    // Every owner-gated mutation (login success/failure, logout, role
    // change, password set, api-key issue, credential revoke, user
    // create) writes one row here. The web layer is the canonical
    // call-site because that's where the actor's IP / user-agent /
    // auth source are known — the store layer cannot infer those.
    //
    // Schema:
    //   - `actor_user_id` is nullable because `login_failure` records the
    //     attempt before any user has been resolved (the failure metadata
    //     holds the attempted email).
    //   - `actor_source` is the auth surface that produced the actor.
    //     Current vocabulary: 'v4-session' | 'v4-bearer' | 'anonymous' |
    //     'system' | 'federated'. Pre-A2.2 rows may carry the now-removed
    //     'v3-admin' value; `rowToAuditLog` clamps unknown values to
    //     'system' on read.
    //   - `target_user_id` / `target_credential_id` reference the object
    //     of the action (also nullable — `login_failure` has neither).
    //     NO foreign keys — we want the audit row to survive even after
    //     the referenced user / credential is deleted (the whole point
    //     of an audit log).
    //   - `metadata` is a JSON blob for per-action extras (attempted
    //     email on login failure, role transition pairs, label of
    //     newly-issued credentials). Caller passes a plain object; the
    //     store JSON.stringifies it.
    //   - `success` is 1 / 0 — most actions only write on success but
    //     login records both, so we use the explicit column rather than
    //     a 'login_failure' action string alone, to make filtering
    //     "show me all failures" trivial.
    //
    // Indexes:
    //   - idx_audit_ts: the list query is "give me the most recent N",
    //     so a descending index on ts is the hot path.
    //   - idx_audit_target_user: future per-user-history view ("show
    //     everything that's been done TO this user").
    //   - idx_audit_action: filter-by-action queries (e.g. "show me all
    //     credential revocations").
    version: 2,
    name: 'identity-audit-log',
    sql: `
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        actor_user_id TEXT,
        actor_source TEXT NOT NULL,
        action TEXT NOT NULL,
        target_user_id TEXT,
        target_credential_id TEXT,
        ip TEXT,
        user_agent TEXT,
        metadata TEXT,
        success INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_target_user ON audit_log(target_user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
    `,
  },
  {
    // Invitations table (Phase 3 — user invitation flow).
    //
    // Each row is a one-time invite that an owner mints for a
    // prospective user. The raw token is shown to the owner ONCE at
    // creation (out-of-band delivery: Signal, 1Password, etc) — only
    // sha256(token) is persisted, mirroring the api_key / admin_token
    // pattern in `credentials.identifier`.
    //
    // Schema notes:
    //   - `token_hash` is UNIQUE — collisions on 192-bit randoms are
    //     mathematically impossible at any scale, but the constraint is
    //     defence-in-depth.
    //   - `email` is the email the invite will assign at accept time.
    //     COLLATE NOCASE so a re-invite of the same address (different
    //     case) collides on the index lookup.
    //   - `role` is the role the new user is assigned at accept time.
    //   - `invited_by` is the inviting v4 user id, nullable for system-
    //     initiated invites (no human actor). NO FK — keeping the audit
    //     trail intact if the inviter is later deleted.
    //   - `status` transitions: pending → accepted | revoked. Expiry
    //     is computed on read (`expires_at < now`) so a row never sits
    //     in an "expired" state requiring a sweeper to flip it.
    //   - `accepted_user_id` ties the invite to the freshly-created
    //     user row. Informational only; no FK so user deletion doesn't
    //     cascade out the invite history.
    //
    // Indexes:
    //   - idx_invitations_email_pending: lets `createInvitation` cheaply
    //     refuse "you already have a pending invite for this email".
    //   - idx_invitations_status: list-pending is the admin UI's hot
    //     query.
    version: 3,
    name: 'invitations',
    sql: `
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL COLLATE NOCASE,
        role TEXT NOT NULL,
        invited_by TEXT,
        display_name TEXT,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        accepted_at INTEGER,
        accepted_user_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_invitations_email_pending
        ON invitations(email) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_invitations_status
        ON invitations(status);
    `,
  },
  {
    // A1 (v4 Phase 5) — vault table for two-way (encrypted, recoverable)
    // secrets. Distinct from `credentials`, which holds one-way HASHED
    // auth material for user login. Different threat models, different
    // primitives.
    //
    // What lives here:
    //   - LLM provider keys (Anthropic / OpenAI / DeepSeek) — must be
    //     readable to call the upstream API.
    //   - MCP server tokens (github / brave-search / private MCP) — same.
    //   - Peer-hub mutual-auth tokens — read at HubLink connection time.
    //   - Generic third-party API tokens.
    //
    // Schema notes:
    //   - `owner_kind` is 'user' | 'org' | 'peer' (mirrors the unified
    //     OwnerRef model that A3 will roll out across memory/artifact).
    //   - `owner_id` is NULL when owner_kind == 'org' (the host itself
    //     is the implicit org). For 'user' / 'peer' it holds the
    //     respective foreign id. NO FK because owner_kind switches the
    //     referenced table (users / peer_registry-not-yet-built /
    //     conceptual self-org). Integrity is application-layer at
    //     create time.
    //   - `secret_enc` holds the AES-256-GCM blob in format
    //     `v1.gcm$<nonce>$<ct>$<tag>` (see crypto.ts). Plaintext is
    //     never persisted, never logged.
    //   - `revoked_at` is a timestamp, NULL when active. Soft-delete:
    //     rows survive forever for audit forensics; the active-rows hot
    //     path filters `WHERE revoked_at IS NULL`.
    //   - `metadata` is a JSON blob for provider-specific context
    //     (e.g. {provider: 'anthropic', model: 'claude-opus-4'}).
    //     Optional; clamped to 8KB at write time (same as audit_log).
    //
    // Indexes:
    //   - idx_vault_kind: filter "show me all llm_provider entries".
    //   - idx_vault_owner: lookup by (owner_kind, owner_id) tuple.
    //   - idx_vault_active: hot-path partial index for "currently active".
    version: 4,
    name: 'vault',
    sql: `
      CREATE TABLE IF NOT EXISTS vault (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        owner_kind TEXT NOT NULL,
        owner_id TEXT,
        label TEXT,
        secret_enc TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_vault_kind ON vault(kind);
      CREATE INDEX IF NOT EXISTS idx_vault_owner ON vault(owner_kind, owner_id);
      CREATE INDEX IF NOT EXISTS idx_vault_active
        ON vault(revoked_at) WHERE revoked_at IS NULL;
    `,
  },
  {
    // B2.1 (v4 Phase 5) — per-user usage counters for quota enforcement.
    //
    // One row per (user_id, metric, period). Holds the CURRENT period's
    // cumulative `used` plus the configured `quota` cap. When the
    // period boundary passes, the next checkAndIncrement resets
    // `used=0` and advances `period_start`. Older period values are
    // not retained here — audit_log carries the event-level trail.
    //
    // Why composite PK (no surrogate id): every read / write is by
    // exactly the (user_id, metric, period) tuple. A surrogate id
    // would force a secondary unique index + JOIN — net loss for a
    // hot-path table.
    //
    // `quota` is nullable: NULL means "unlimited" (counter still ticks
    // for visibility). `used` defaults to 0 so a fresh INSERT reads
    // correctly without a coalesce.
    //
    // `metric` is free-form TEXT (≤64 chars at write time) so future
    // subsystems can add new counters without a migration. `period`
    // is constrained to the UsagePeriod enum at the application
    // layer — no SQL CHECK so we can extend it without a migration
    // either.
    //
    // FK ON DELETE CASCADE: a deleted user's quota rows vanish too —
    // keeps the table tied to its principal lifecycle.
    version: 5,
    name: 'usage-counters',
    sql: `
      CREATE TABLE IF NOT EXISTS usage_counters (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        metric TEXT NOT NULL,
        period TEXT NOT NULL,
        period_start INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        quota INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, metric, period)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_counters(user_id);
    `,
  },
  {
    // D1 (v4 Phase 5) — Peer Registry. Replaces "peer config baked into
    // an env var / json file" with vault-encrypted tokens + a sqlite row
    // per remote hub. The host's PeerRegistry polls this table on a
    // 5s tick (default; AIPE_PEER_POLL_MS overrides) and reconciles
    // its set of open HubLinks: new rows trigger connectHubLink, vanished
    // / disabled rows trigger uninstall().
    //
    // - `peer_id` is the remote hub's wire selfId (used as
    //   expectedPeerId on outbound HELLO_ACK verification). UNIQUE
    //   because you can't have two simultaneous connections to "the
    //   same hub" — second add would be ambiguous routing.
    // - `vault_entry_id` is the soft FK to vault.id holding the peer's
    //   shared secret (kind='peer_token', ownerKind='peer'). NOT a hard
    //   FK because vault entries are revoked (not deleted) on token
    //   rotation; we want the peer row to outlive a revoke for audit
    //   continuity (mirrors invitations table pattern above).
    // - `enabled` toggle keeps a peer row around for one-click
    //   re-enable without losing the token, vs DELETE which also revokes.
    version: 6,
    name: 'peers',
    sql: `
      CREATE TABLE IF NOT EXISTS peers (
        id              TEXT PRIMARY KEY,
        peer_id         TEXT NOT NULL UNIQUE,
        endpoint_url    TEXT NOT NULL,
        label           TEXT,
        enabled         INTEGER NOT NULL DEFAULT 1,
        vault_entry_id  TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_peers_enabled ON peers(enabled);
    `,
  },
  {
    // E1 (v4 Phase 5) — per-org soft quotas.
    //
    // One row per (metric, period). The host's orgQuotaSweep timer pulls
    // every row on a 1h cadence, sums `usage_counters.used` across all
    // users (sumUsage) for that (metric, period), and compares against
    // `quota`. State transitions (ok→warn, warn→over, *→ok) emit an
    // audit_log entry. `last_state` is stored so re-checks at the same
    // threshold don't spam audit (idempotency).
    //
    // Why a SEPARATE table from usage_counters:
    //   - usage_counters is per-user (PK includes user_id); quotas here
    //     are aggregate. Mixing them would require a sentinel user_id
    //     value and confuse every per-user query.
    //   - The cap policy lifecycle (admin sets/edits/removes) is
    //     decoupled from the hot-path counter writes — two surfaces,
    //     two tables.
    //
    // Schema notes:
    //   - Composite PK (metric, period) — same rationale as
    //     usage_counters: every read is by exactly this tuple.
    //   - `quota` is NOT NULL — "unlimited" is represented by NOT having
    //     a row (deleteOrgQuota). Avoids the ambiguity of "row with
    //     quota=null means unlimited" vs "no row means unconfigured".
    //   - `warn_pct` defaults to 80 (% of quota). Operators can tune
    //     per-quota — a soft "memo" alert at 50% for something
    //     expensive, vs 95% for plentiful resources.
    //   - `last_state` ∈ {'ok','warn','over'}. Updated atomically inside
    //     checkOrgQuotaThreshold when the state changes, so the sweep
    //     can `transitioned=true` ⇒ write audit, `false` ⇒ skip.
    //   - `last_checked` is informational, useful for "when did the
    //     sweep last see this row" admin diagnostics.
    version: 7,
    name: 'org-quotas',
    sql: `
      CREATE TABLE IF NOT EXISTS org_quotas (
        metric        TEXT NOT NULL,
        period        TEXT NOT NULL,
        quota         INTEGER NOT NULL,
        warn_pct      INTEGER NOT NULL DEFAULT 80,
        last_state    TEXT NOT NULL DEFAULT 'ok',
        last_checked  INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (metric, period)
      );
    `,
  },
  {
    // Phase 7 M4 — org-wide key/value config bag. First use:
    // `org_mode` ∈ {'personal','team'} powers the SPA shell switch.
    // Future keys live here too (eg. default LLM provider, brand
    // name) so we don't need a new table per scalar.
    //
    // Why not stuff this into vault as a non-secret entry? vault
    // rows are encrypted + audited per read; this is plain config
    // that the UI hot-reloads. Different access pattern, different
    // table. Cheap.
    version: 8,
    name: 'org-meta-kv',
    sql: `
      CREATE TABLE IF NOT EXISTS org_meta (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    // Phase 11 M2 — suspended tasks. When a participant throws
    // `SuspendTaskError`, the scheduler persists a row here keyed by
    // task_id. The resume sweep (M3) selects rows where
    // resume_at <= now() and re-dispatches the same task back to the
    // same agent via `Participant.onResume(task, state)`. Rows are
    // deleted on successful resume.
    //
    // Why not in core/storage? Single-host runs already have one
    // SQLite open (identity.sqlite); adding a table here avoids a
    // second db connection / a parallel migration story. The
    // contents are operational state, not user identity — same
    // pragmatic logic as `usage_counters` and `peer_registry`.
    //
    // Indexes:
    //   - resume_at: the sweep query (`WHERE resume_at <= ?`) needs
    //     to scan only due rows. Most rows are NOT due at any given
    //     moment.
    //   - agent_id: future admin UI "what's parked on this agent"
    //     queries — cheap to add now while the table is new.
    version: 9,
    name: 'suspended-tasks',
    sql: `
      CREATE TABLE IF NOT EXISTS suspended_tasks (
        task_id         TEXT PRIMARY KEY,
        agent_id        TEXT NOT NULL,
        hub_id          TEXT,
        origin_user_id  TEXT,
        resume_at       INTEGER NOT NULL,
        state           TEXT,
        task_json       TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_suspended_resume_at
        ON suspended_tasks(resume_at);
      CREATE INDEX IF NOT EXISTS idx_suspended_agent
        ON suspended_tasks(agent_id);
    `,
  },
  {
    // Phase 12 M1 — IM bindings. Two tables, one migration:
    //
    //   im_bindings — confirmed (platform, platformUserId) → userId
    //                 rows. PK on (platform, platformUserId) means one
    //                 IM identity binds to exactly one AipeHub user.
    //                 ON DELETE CASCADE strips bindings when the
    //                 AipeHub user is deleted.
    //   im_binding_codes — short-lived (10 min default) codes the user
    //                 types into the IM client to prove ownership.
    //                 PK on `code` so a re-issued code rotates
    //                 atomically (we DELETE-by-user before INSERT to
    //                 keep "at most one outstanding code per user").
    //
    // Why both here and not split: they're an indivisible feature pair;
    // a deploy that has one but not the other can't run the bind flow.
    //
    // Indexes:
    //   - im_bindings(user_id): "list all bindings for this user" — admin
    //     UI "Connected accounts" page.
    //   - im_binding_codes(user_id): backs the rotate-before-insert
    //     delete on re-issue.
    //   - im_binding_codes(expires_at): backs `sweepExpiredImBindingCodes`
    //     housekeeping pass; cheap to add now while the table is new.
    version: 10,
    name: 'im-bindings',
    sql: `
      CREATE TABLE IF NOT EXISTS im_bindings (
        platform           TEXT NOT NULL,
        platform_user_id   TEXT NOT NULL,
        user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        display_name       TEXT,
        created_at         INTEGER NOT NULL,
        PRIMARY KEY (platform, platform_user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_im_bindings_user
        ON im_bindings(user_id);

      CREATE TABLE IF NOT EXISTS im_binding_codes (
        code        TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at  INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_im_binding_codes_user
        ON im_binding_codes(user_id);
      CREATE INDEX IF NOT EXISTS idx_im_binding_codes_expires
        ON im_binding_codes(expires_at);
    `,
  },
  {
    // Phase 17 (Sprint 4) — usage/cost ledger. One row per LLM provider
    // call (a tool-use loop writes one row PER ROUND, not per task) so
    // cost can be attributed and exported per user / agent / workflow /
    // model / day. This is the raw line-item layer UNDER the existing
    // usage_counters (which only counts aggregate ticks): the counters
    // answer "is this user over their daily cap" on the hot path; the
    // ledger answers "show me exactly what was spent and on what".
    //
    // Design notes:
    //   - INTEGER PK AUTOINCREMENT: append-only, monotonic, gives a
    //     stable export/pagination cursor (id DESC == newest-first).
    //   - NO foreign keys (mirrors audit_log V4-AUDIT-06): a billing row
    //     MUST outlive the user / agent it bills — deleting a user can't
    //     be allowed to erase last month's cost forensics.
    //   - org_id / user_id / workflow_id / task_id / provider are
    //     NULLABLE: unattributed local dispatches (no task.origin) still
    //     record tokens for cost visibility — they just aren't billed to
    //     anyone. agent_id + model are always present on an LLM call.
    //   - cost_micros is INTEGER micro-USD (1e-6 USD). Integer math only
    //     — never store float dollars (drift across millions of rows).
    //   - unpriced (0/1): the model had no price entry, so cost_micros is
    //     0 by convention but tokens are real. Surfaced so a dashboard can
    //     flag "tokens counted, cost unknown" rather than silently $0.
    //   - meta_json: small escape hatch (stopReason / toolRounds / etc).
    //
    // Indices back the four query/aggregate axes (by user / agent /
    // workflow / model), each paired with ts DESC for the common
    // "recent activity for X" scan; idx_ledger_ts backs the unfiltered
    // newest-first list + export.
    version: 11,
    name: 'usage-ledger',
    sql: `
      CREATE TABLE IF NOT EXISTS usage_ledger (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                     INTEGER NOT NULL,
        org_id                 TEXT,
        user_id                TEXT,
        agent_id               TEXT NOT NULL,
        workflow_id            TEXT,
        task_id                TEXT,
        model                  TEXT NOT NULL,
        provider               TEXT,
        input_tokens           INTEGER NOT NULL DEFAULT 0,
        output_tokens          INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
        cost_micros            INTEGER NOT NULL DEFAULT 0,
        unpriced               INTEGER NOT NULL DEFAULT 0,
        meta_json              TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_ts
        ON usage_ledger(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_ledger_user
        ON usage_ledger(user_id, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_ledger_agent
        ON usage_ledger(agent_id, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_ledger_workflow
        ON usage_ledger(workflow_id, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_ledger_model
        ON usage_ledger(model, ts DESC);
    `,
  },
  {
    // Phase 18 (Sprint 5) B-M1 — per-peer cross-org policy. Four additive
    // columns on the existing peers table (v6), each nullable or defaulted
    // so an un-migrated row keeps today's behaviour: kind='service', no
    // inbound ACL (accept all), no outbound allowlist (send all), approval
    // off. Policy is 1:1 with a peer and read on the same PeerRegistry tick
    // that reads the row, so it lives ON the row — a side table joined every
    // 5s would buy nothing. The migration framework runs each version
    // exactly once, so ALTER ... ADD COLUMN (SQLite has no IF NOT EXISTS for
    // columns) is safe here.
    //
    //   kind                      personal|organization|project|service —
    //                             admin's label for what's on the far end.
    //   acl_json                  inbound PeerLinkAcl as JSON; NULL = accept
    //                             all (legacy). What we ACCEPT from the peer.
    //   outbound_caps_json        outbound capability allowlist (string[]);
    //                             NULL = send all. What we may SEND to it.
    //   require_approval_outbound 0/1 — when 1, an outbound cross-org task
    //                             parks in the member inbox (Phase 16) until
    //                             a human approves it (B-M3).
    version: 12,
    name: 'peer-policy',
    sql: `
      ALTER TABLE peers ADD COLUMN kind TEXT NOT NULL DEFAULT 'service';
      ALTER TABLE peers ADD COLUMN acl_json TEXT;
      ALTER TABLE peers ADD COLUMN outbound_caps_json TEXT;
      ALTER TABLE peers ADD COLUMN require_approval_outbound INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Phase 19 P2-M5 — resource-level RBAC for workflows (ownership MVP).
    // One grant row per (workflow, user). The OWNER is just the grant with
    // perm='owner' — no separate owner column, so ownership + sharing share
    // one model and one store. Perm ladder owner > editor > viewer is compared
    // by rank in the store (no SQL CHECK, so it can extend without a migration).
    // No FK to users: a deleted user's grant simply dangles (prunable) — the
    // same append-friendly posture as audit_log. The composite PK gives
    // upsert-on-regrant and exactly one perm per user per workflow.
    //
    //   workflow_id  stable workflow id (matches WorkflowDefinition.id)
    //   user_id      v4 identity user id the grant is for
    //   perm         'owner' | 'editor' | 'viewer'
    //   granted_by   user_id that wrote the grant; NULL = system (import seed)
    //   granted_at   epoch ms
    //
    // idx_wf_grants_user backs "what workflows may this user touch"; the PK
    // already backs "who may touch workflow X".
    version: 13,
    name: 'workflow-grants',
    sql: `
      CREATE TABLE IF NOT EXISTS workflow_grants (
        workflow_id  TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        perm         TEXT NOT NULL,
        granted_by   TEXT,
        granted_at   INTEGER NOT NULL,
        PRIMARY KEY (workflow_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_wf_grants_user
        ON workflow_grants(user_id);
    `,
  },
]

export function applyMigrations(db: SqliteDb): { applied: number[] } {
  // Bootstrap the migrations table itself. This is the chicken-and-egg
  // moment — we can't read it to know what's applied if it doesn't
  // exist. Idempotent CREATE IF NOT EXISTS does the right thing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)
  const appliedVersions = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  )
  const newlyApplied: number[] = []
  for (const m of MIGRATIONS) {
    if (appliedVersions.has(m.version)) continue
    transaction(db, () => {
      db.exec(m.sql)
      db.prepare(
        'INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?)',
      ).run(m.version, m.name, Date.now())
    })
    newlyApplied.push(m.version)
  }
  return { applied: newlyApplied }
}

export function latestSchemaVersion(): number {
  let max = 0
  for (const m of MIGRATIONS) {
    if (m.version > max) max = m.version
  }
  return max
}
