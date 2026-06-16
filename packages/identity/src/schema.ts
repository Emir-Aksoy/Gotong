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

import { transactionImmediate, type SqliteDb } from './db.js'

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
  {
    // Phase 19 P4-M2 — peer-aware usage accounting. One additive nullable
    // column: `peer_id` is the LOCAL peer-registry row id a federated LLM
    // call came in through (NULL for local usage). org_id / user_id already
    // carry the wire-claimed origin org / user, so we add ONLY the trustworthy
    // local peer handle (decided 2026-06-01: no redundant origin_* columns,
    // no link_id since links aren't persistently identified apart from the
    // peer row). `WHERE peer_id IS NOT NULL` cleanly isolates cross-org usage.
    version: 14,
    name: 'ledger-peer-id',
    sql: `
      ALTER TABLE usage_ledger ADD COLUMN peer_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_ledger_peer
        ON usage_ledger(peer_id, ts DESC);
    `,
  },
  {
    // Phase 19 P4-M4 — per-link trust contract (the rest of a peer's policy
    // beyond v12's ACL / allowlist / approval). Three additive columns, each
    // nullable or defaulted so an un-migrated row keeps today's behaviour:
    // not revoked, no per-link quota, all data classes allowed.
    //
    //   revocation_state          'active' | 'revoked' — a one-way, auditable
    //                             kill switch distinct from enabled (which is
    //                             a reversible on/off). A revoked peer is never
    //                             dialed, inbound is refused, and a live link is
    //                             torn down.
    //   per_link_quota_budget     max inbound tasks this peer may dispatch per
    //                             rolling budget period; NULL / <=0 = unlimited.
    //                             Enforced fail-closed at the inbound gate,
    //                             independently per peer (no cross-link bleed).
    //   allowed_data_classes_json outbound data-class allowlist (string[]);
    //                             NULL = all classes allowed. A task that
    //                             declares data classes not in this set is
    //                             refused before it leaves to the peer.
    version: 15,
    name: 'peer-link-contract',
    sql: `
      ALTER TABLE peers ADD COLUMN revocation_state TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE peers ADD COLUMN per_link_quota_budget INTEGER;
      ALTER TABLE peers ADD COLUMN allowed_data_classes_json TEXT;
    `,
  },
  {
    // v5 Stream A-M1 — the unified resource_grants table (decision #3). One
    // grant model for every resource, replacing the user-only workflow_grants
    // (v13). The principal column holds a principalKey ("<kind>:<id>") so a
    // single TEXT column carries any of hub/user/agent/peer. The owner is just
    // the perm='owner' row (owner-as-grant), same as before.
    //
    // We MIGRATE the data, then DROP the old table — no row is lost (the
    // INSERT…SELECT copies every workflow_grants row, mapping user_id → the
    // 'user:<id>' principal key), and the old table is dropped so there is one
    // grant table, not two (the whole point of #3). workflow_grants always
    // exists here (v13 created it before this v16 runs); on a fresh DB the copy
    // is a no-op over an empty table.
    version: 16,
    name: 'resource-grants',
    sql: `
      CREATE TABLE IF NOT EXISTS resource_grants (
        resource_kind TEXT NOT NULL,
        resource_id   TEXT NOT NULL,
        principal     TEXT NOT NULL,
        perm          TEXT NOT NULL,
        granted_by    TEXT,
        granted_at    INTEGER NOT NULL,
        PRIMARY KEY (resource_kind, resource_id, principal)
      );
      CREATE INDEX IF NOT EXISTS idx_resource_grants_principal
        ON resource_grants(principal);
      CREATE INDEX IF NOT EXISTS idx_resource_grants_resource
        ON resource_grants(resource_kind, resource_id);
      INSERT OR IGNORE INTO resource_grants
        (resource_kind, resource_id, principal, perm, granted_by, granted_at)
        SELECT 'workflow', workflow_id, 'user:' || user_id, perm, granted_by, granted_at
        FROM workflow_grants;
      DROP TABLE workflow_grants;
    `,
  },
  {
    // v5 Stream C-M1 — the callable-knowledge-base dimension of the per-link
    // trust contract. A peer may only discover + call the shared MCP servers
    // (knowledge bases) named in this allowlist:
    //   allowed_knowledge_bases_json  inbound KB allowlist (string[] of shared
    //                                 MCP server names — for a B-M5 KB template
    //                                 that's the KB slot name). NULL = every
    //                                 shared server is callable (legacy / unset,
    //                                 pre-C behaviour). `[]` = lock the peer out
    //                                 of every shared KB. Enforced inbound at the
    //                                 per-link mcp.* responder (listShared is
    //                                 filtered; callTool/listTools on a server
    //                                 outside the set is refused).
    version: 17,
    name: 'peer-link-knowledge-bases',
    sql: `
      ALTER TABLE peers ADD COLUMN allowed_knowledge_bases_json TEXT;
    `,
  },
  {
    // Route B P0-M4b — envelope encryption metadata. A small key/value
    // table holding the vault's wrapped data key (DEK): the 32-byte DEK
    // that encrypts every vault secret, itself encrypted under the host
    // master key (KEK). Rotating the KEK (M4c) re-wraps this one row
    // instead of re-encrypting every secret. The wrapped DEK is exactly
    // as secret as the ciphertext beside it — without the KEK it can't be
    // unwrapped — so it lives with the data, not the key file.
    //
    // Lazily seeded on the first vault operation, not at migrate time:
    // a host that never configures a master key never gets a DEK, and the
    // seed must re-encrypt any pre-envelope (legacy KEK-direct) rows under
    // the new DEK in the same transaction.
    version: 18,
    name: 'vault-envelope-meta',
    sql: `
      CREATE TABLE IF NOT EXISTS vault_meta (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    // Route B P1-M3b — MFA (TOTP) enrollment STATE. The secret itself is NOT
    // here: it lives as a vault entry (kind='totp', ownerKind='user'), so the
    // DEK envelope encrypts it at rest and a master-key rotation (M4c) covers
    // it for free — same path as a member's per-user LLM key (A-M3b). This
    // table only points at that secret and records lifecycle:
    //   vault_id      the vault entry holding the encrypted shared secret.
    //   confirmed_at  NULL = enrolled-but-unconfirmed (a pending secret that
    //                 must NOT yet gate login); non-NULL = active second factor.
    //   last_used_at  bumped on a successful login verification.
    // One row per user (PK = user_id); re-enrolling replaces it. ON DELETE
    // CASCADE drops the state with the user (the orphaned vault entry is
    // cleaned by disableTotp on the normal path).
    version: 19,
    name: 'user-totp',
    sql: `
      CREATE TABLE IF NOT EXISTS user_totp (
        user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        vault_id     TEXT NOT NULL,
        confirmed_at INTEGER,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER
      );
    `,
  },
  {
    // Route B P1-M4d — OIDC identity-provider (IdP) registrations. The hub is
    // the Relying Party; one row per IdP it accepts SSO from. The confidential
    // client_secret is NOT here: like a TOTP secret (v19) it lives as a vault
    // entry (kind='oidc_client_secret', ownerKind='org'), so envelope
    // encryption + master-key rotation cover it for free. `vault_id` points at
    // that entry; NULL = a public (PKCE-only) client with no secret.
    //   issuer        UNIQUE — the IdP's issuer URL, the discovery base and the
    //                 expected id_token `iss`. Immutable per registration.
    //   redirect_uri  the callback this hub registered with the IdP.
    //   scope         extra space-separated scopes (NULL = client default).
    //   enabled       0 disables it without deleting the config (+ its secret).
    version: 20,
    name: 'oidc-providers',
    sql: `
      CREATE TABLE IF NOT EXISTS oidc_providers (
        id           TEXT PRIMARY KEY,
        issuer       TEXT NOT NULL UNIQUE,
        client_id    TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scope        TEXT,
        vault_id     TEXT,
        enabled      INTEGER NOT NULL DEFAULT 1,
        label        TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
    `,
  },
  {
    // Route B P1-M5c — SAML 2.0 IdP registrations. The hub is the Service
    // Provider; one row per IdP it accepts SSO from. Unlike OIDC there is NO
    // vault pointer: `idp_cert` is the IdP's X.509 SIGNING cert — a PUBLIC
    // verification key, not a secret — so it sits in the table directly. (We do
    // not sign AuthnRequests in this MVP, so there is no SP private key to
    // protect either.)
    //   idp_entity_id  UNIQUE — the IdP's SAML entityID, the expected assertion
    //                  Issuer. Immutable per registration.
    //   sso_url        the IdP's SSO endpoint (HTTP-Redirect binding).
    //   idp_cert       the IdP's X.509 signing cert (PEM), pinned for verify.
    //   sp_entity_id   this hub's SP entityID (the assertion Audience).
    //   enabled        0 disables it without deleting the config.
    version: 21,
    name: 'saml-providers',
    sql: `
      CREATE TABLE IF NOT EXISTS saml_providers (
        id            TEXT PRIMARY KEY,
        idp_entity_id TEXT NOT NULL UNIQUE,
        sso_url       TEXT NOT NULL,
        idp_cert      TEXT NOT NULL,
        sp_entity_id  TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        label         TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
    `,
  },
  {
    // Route B P1-M11a — outbound A2A agent registrations. An entry makes a
    // local capability dispatch reach OUT to an external A2A agent's
    // `message/send` (the mirror of the inbound A2aServer). Replaces the
    // `AIPE_A2A_AGENTS` env blob with persisted, admin-editable config.
    //
    // There is NO vault pointer here — like saml_providers (idp_cert is
    // public), every column is NON-secret. The bearer the remote demands is
    // NOT stored: `token_env` names the env var the host reads it from at
    // registration time, so the secret stays in the normal env channel and
    // never touches the DB or an admin HTTP body. A row whose `token_env` is
    // unset at boot is persisted-but-inactive (logged, not registered).
    //   id            PK = the LOCAL participant id (dispatch target); unique
    //                 on the hub, admin-supplied (not synthetic).
    //   capabilities  JSON string[] advertised on the local hub → routing key.
    //   url           the remote A2A `message/send` endpoint.
    //   token_env     name of the env var holding the bearer (never the secret).
    //   peer_id       our X-Aipe-Peer-Id (AipeHub↔AipeHub only); NULL = generic.
    //   target_skill  metadata.skill the remote should dispatch to; NULL = its default.
    //   enabled       0 disables without deleting the config.
    version: 22,
    name: 'a2a-outbound-agents',
    sql: `
      CREATE TABLE IF NOT EXISTS a2a_outbound_agents (
        id           TEXT PRIMARY KEY,
        capabilities TEXT NOT NULL,
        url          TEXT NOT NULL,
        token_env    TEXT NOT NULL,
        peer_id      TEXT,
        target_skill TEXT,
        enabled      INTEGER NOT NULL DEFAULT 1,
        label        TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
    `,
  },
  {
    // v5 Stream E5 — per-link opt-in to expose a privacy-safe summary over the
    // `peer.summary` RPC. One additive, defaulted column so an un-migrated row
    // keeps today's behaviour: NOT shared. This is the control-plane gate — a
    // peer reads my asset/activity/health COUNTS only if I flipped this on for
    // the link to it (fail-closed). Mirrors the per-link contract columns (v15)
    // and the callable-KB allowlist (v17): one dedicated column per dimension.
    //
    //   share_summary  0 | 1 — default 0 = my summary is never returned to this
    //                  peer. Set to 1 to opt this specific link into sharing.
    version: 23,
    name: 'peer-share-summary',
    sql: `
      ALTER TABLE peers ADD COLUMN share_summary INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // v5 Stream F — control-plane history. The E5 `peer.summary` control plane is
    // point-in-time only (in-mem cache, lost on restart by design). To draw trends
    // we persist one COUNTS-ONLY snapshot per refresh: same privacy contract as the
    // live summary (no row ever lands here, only the aggregate `PeerSummary` blob).
    //
    // identity stays domain-agnostic: it stores `summary_json` OPAQUE and never
    // parses it — all PeerSummary semantics (metric projection for trends, alert
    // evaluation) live in the host where the type is defined. Append-only with a
    // retention prune, exactly like `usage_ledger`.
    //
    //   captured_at   ms epoch the host took the snapshot (refresh time).
    //   source        'local' for this hub's own footprint, else the peer id.
    //   summary_json  the full PeerSummary blob, verbatim. Opaque to identity.
    version: 24,
    name: 'peer-summary-snapshots',
    sql: `
      CREATE TABLE IF NOT EXISTS peer_summary_snapshots (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at  INTEGER NOT NULL,
        source       TEXT NOT NULL,
        summary_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pss_source_time
        ON peer_summary_snapshots(source, captured_at);
    `,
  },
  {
    // v5 Stream F — control-plane alert rules. A rule says "breach when this
    // source's metric crosses this threshold" and is evaluated LIVE against the
    // current summaries (no breach history in the MVP). Like the snapshots
    // above, identity stays domain-agnostic about WHICH metrics exist — `metric`
    // and `source` are opaque strings the host interprets. Only the generic
    // structural bits (comparator enum, numeric threshold) are validated at the
    // storage boundary.
    //
    //   source      'local' | a peer id | '*' (any source).
    //   metric      a PeerSummary metric key (e.g. health.suspendedTasks).
    //   comparator  gt | gte | lt | lte.
    //   threshold   the boundary value (REAL — counts are integers but a rule
    //               may target a fractional bound).
    version: 25,
    name: 'peer-summary-alert-rules',
    sql: `
      CREATE TABLE IF NOT EXISTS peer_summary_alert_rules (
        id          TEXT PRIMARY KEY,
        source      TEXT NOT NULL,
        metric      TEXT NOT NULL,
        comparator  TEXT NOT NULL,
        threshold   REAL NOT NULL,
        label       TEXT,
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_psar_source_metric
        ON peer_summary_alert_rules(source, metric);
    `,
  },
  {
    // ACP-OUT-M1 — outbound ACP agent registrations. An entry makes a local
    // capability dispatch SPAWN and drive an external coding agent (Claude Code
    // / Codex) over ACP, OpenClaw-style: spawn once, hold one session, dispatch
    // many tasks (the host-side mirror of the inbound `aipehub connect`).
    // Replaces hand-written example glue with persisted, admin-editable config.
    //
    // Like a2a_outbound_agents (v22) there is NO vault pointer — and ACP goes
    // one further: not even a `token_env`. ACP bridges authenticate with the
    // underlying agent's OWN login (the hub injects no key), so every column is
    // non-secret config. A disabled row is persisted-but-inactive.
    //   id            PK = the LOCAL participant id (dispatch target); unique
    //                 on the hub, admin-supplied (not synthetic).
    //   capabilities  JSON string[] advertised on the local hub → routing key.
    //   command       the ACP bridge command (e.g. `npx`).
    //   args          JSON string[] args to the bridge (may be empty []).
    //   cwd           working dir the agent operates in; NULL = host cwd.
    //   enabled       0 disables without deleting the config.
    version: 26,
    name: 'acp-outbound-agents',
    sql: `
      CREATE TABLE IF NOT EXISTS acp_outbound_agents (
        id           TEXT PRIMARY KEY,
        capabilities TEXT NOT NULL,
        command      TEXT NOT NULL,
        args         TEXT NOT NULL,
        cwd          TEXT,
        enabled      INTEGER NOT NULL DEFAULT 1,
        label        TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
    `,
  },
  {
    // v5 Stream G day-5 — control-plane transcript chain. Symmetric to
    // share_summary (v23): default 0 = my execution TRACE of a task this peer
    // dispatched to me is never returned to it. Set to 1 to opt THIS specific
    // link into the `peer.transcript` RPC, which lets the caller fetch the
    // transcript of the ONE task it sent (its task + result + my agent's LLM
    // stream — never my internal sub-dispatches), so its run detail can chain
    // the off-hub hop. Fail-closed; one dedicated column per dimension like the
    // per-link contract columns (v15) and the callable-KB allowlist (v17).
    //
    //   share_transcript  0 | 1 — default 0 = my per-task transcript is never
    //                     returned to this peer. Set to 1 to opt this link in.
    version: 27,
    name: 'peer-share-transcript',
    sql: `
      ALTER TABLE peers ADD COLUMN share_transcript INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // v5 Stream F day-3 — control-plane alert FIRINGS (breach history). The F
    // MVP evaluated rules point-in-time and kept no history ("a fired alert is
    // a fact about NOW"); day-3 persists one row per open→resolve lifecycle so
    // the control plane shows a timeline AND a delivery dispatcher can
    // edge-trigger — notify ONCE when a breach opens, not every evaluation.
    // Append-only + a resolved_at stamp; no FK (rule_id is kept verbatim after
    // the rule is deleted, like the ledger keeps a user id). Same counts-only
    // privacy contract as the rest of this plane — every column is a number, a
    // comparator, or an id of THIS hub's own alert config.
    //
    //   rule_id      the asr_<hex> rule that fired (kept even if rule removed).
    //   source       the ACTUAL source that breached ('local' | a peer id).
    //   value        the projected metric value when the firing OPENED.
    //   opened_at    ms epoch the breach was first observed.
    //   resolved_at  ms epoch the metric fell back; NULL = still firing.
    // The partial UNIQUE index enforces at-most-one OPEN firing per
    // (rule_id, source) — the edge-trigger invariant lives in the schema.
    version: 28,
    name: 'peer-summary-alert-firings',
    sql: `
      CREATE TABLE IF NOT EXISTS peer_summary_alert_firings (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id      TEXT NOT NULL,
        source       TEXT NOT NULL,
        metric       TEXT NOT NULL,
        comparator   TEXT NOT NULL,
        threshold    REAL NOT NULL,
        value        REAL NOT NULL,
        label        TEXT,
        opened_at    INTEGER NOT NULL,
        resolved_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_psaf_opened
        ON peer_summary_alert_firings(opened_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_psaf_open_unique
        ON peer_summary_alert_firings(rule_id, source)
        WHERE resolved_at IS NULL;
    `,
  },
  {
    // v5 Stream F day-3 — notification CHANNELS the control plane delivers
    // alert firings to. Kinds: 'webhook' (a fire-and-forget HTTP POST of the
    // counts-only firing payload), 'im' (a stateless platform send), and
    // 'email' (HTTP email API POST). Modeled on a2a_outbound_agents (v22): a
    // small config table with full CRUD and NO vault — the only sensitive bit
    // is an optional `header_env`, which is an ENVIRONMENT VARIABLE NAME (not
    // the bearer); the host reads the value at delivery time so the secret
    // never touches the database. The im/email destination fields (platform /
    // target) are added additively in v30.
    //
    //   kind        'webhook' | 'im' | 'email'. Validated against a closed set.
    //   url         the delivery endpoint (http/https, validated on write).
    //   header_env  env-var NAME for the auth secret; NULL = none.
    //   enabled     0 disables without deleting the config.
    version: 29,
    name: 'peer-summary-alert-channels',
    sql: `
      CREATE TABLE IF NOT EXISTS peer_summary_alert_channels (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        url         TEXT NOT NULL,
        header_env  TEXT,
        enabled     INTEGER NOT NULL DEFAULT 1,
        label       TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `,
  },
  {
    // v5 Stream F multi-channel — 'im' / 'email' channels need a platform
    // selector and a delivery destination beyond the webhook url. Additive
    // nullable columns: webhook rows leave both NULL; im sets platform (+ target
    // for bot-API platforms like Telegram); email sets target (the recipient).
    version: 30,
    name: 'peer-summary-alert-channels-multichannel',
    sql: `
      ALTER TABLE peer_summary_alert_channels ADD COLUMN platform TEXT;
      ALTER TABLE peer_summary_alert_channels ADD COLUMN target TEXT;
    `,
  },
  {
    // R9 (tech-debt) — atomic claim for the resume sweep. One additive,
    // nullable column on suspended_tasks.
    //
    // Before this, the sweep listed due rows then re-entered each via
    // `hub.resumeTask` and only removed the row AFTER a terminal result.
    // That window is at-least-once: crash between re-enter and remove →
    // restart re-runs the task (and `onResume` isn't required to be
    // idempotent); two hosts sharing this store both list the same due row
    // and both resume it. The fix is a compare-and-set claim — the sweep
    // runs `UPDATE … SET claimed_at=? WHERE task_id=? AND claimed_at IS NULL`
    // and only proceeds when `changes===1`, so exactly one claimant owns a
    // due row at a time.
    //
    //   claimed_at  NULL = unclaimed (the common state); a non-NULL stamp is
    //               an in-flight resume. A claim that outlives a generous TTL
    //               is a crashed claimant and gets reset to NULL by the
    //               stale-claim reclaimer so the row is retried, not stranded.
    //
    // INSERT OR REPLACE on suspend-again omits this column, so a re-parked
    // row is naturally unclaimed again. No index: the claim is keyed by the
    // PRIMARY KEY (task_id); the reclaimer's `claimed_at < ?` scan runs over
    // the handful of in-flight rows, not the whole table.
    version: 31,
    name: 'suspended-tasks-claim',
    sql: `
      ALTER TABLE suspended_tasks ADD COLUMN claimed_at INTEGER;
    `,
  },
  {
    // Stream H2-OUT — opt-in long-running lifecycle for an outbound A2A agent.
    // One additive, nullable column so an un-migrated row keeps today's
    // behaviour: NULL = blocking (a remote that returns a `working` Task is an
    // error, the Stream H sibling). A JSON object opts in: the participant PARKS
    // and polls `tasks/get` until the remote settles.
    //
    // Stored as JSON in one column, mirroring `capabilities` in this same table
    // — it maps 1:1 to the @aipehub/a2a participant's `lifecycle?` option object
    // ({pollIntervalMs?,maxAttempts?}), so `{}` = lifecycle on with defaults.
    // Identity validates only the structural bits (numeric, positive); the
    // participant owns the flooring/semantics.
    //
    //   lifecycle  NULL = blocking (legacy). JSON {pollIntervalMs?,maxAttempts?}
    //              = poll the remote until it settles.
    version: 32,
    name: 'a2a-outbound-lifecycle',
    sql: `
      ALTER TABLE a2a_outbound_agents ADD COLUMN lifecycle TEXT;
    `,
  },
  {
    // Audit F1 — TOTP replay within the accept window. RFC 6238 §5.2: a code
    // observed over the shoulder stayed valid for the rest of its ±1-step
    // window even after a successful login. Persist the last ACCEPTED time
    // step; verifyForLogin rejects any code at or before it.
    //
    //   last_step  NULL = nothing accepted yet (legacy rows keep working).
    version: 33,
    name: 'totp-last-step',
    sql: `
      ALTER TABLE user_totp ADD COLUMN last_step INTEGER;
    `,
  },
  {
    // Item 2 — route the RAW A2A/ACP outbound edges through the P4-M4
    // chokepoint. `A2aRemoteParticipant` / `AcpParticipant` are LOCAL
    // participants that never cross a `RemoteHubViaLink`, so the mesh
    // data-class + quota gates (which live in that wrapper) are structurally
    // unreachable for them. These per-agent policy columns drive the SAME gates
    // applied at the participant's own outbound edge (X-M4), so a workflow step
    // dispatched to an external A2A/ACP capability is bounded the same way a
    // mesh peer step is. Additive, nullable, NO secret column (continues the
    // store's "never store a credential" discipline). Mirrors the per-link
    // contract columns on `peers` (v15): one column per policy dimension.
    //
    //   allowed_data_classes_json  NULL = no contract (send anything, legacy).
    //                              '[]' = lockdown (refuse any declared class).
    //                              '["pii"]' = allowlist. Gates `Task.dataClasses`
    //                              via the SHARED core `checkOutboundDataClasses`.
    //   outbound_quota_budget      NULL / 0 = no quota. >0 = max sends per window
    //                              (host owns the FixedWindowLimiter; X-M4).
    //   require_approval_outbound  (a2a only) 0 | 1 — 1 wraps the participant in
    //                              `ApprovalGatedParticipant` so an outbound send
    //                              parks for owner approval first (Y-M1). ACP has
    //                              no such column: it already escalates per-tool
    //                              to the inbox (`dangerousToolGate`), and it is a
    //                              local subprocess, not a network egress (D5/D6).
    version: 34,
    name: 'a2a-acp-outbound-gate',
    sql: `
      ALTER TABLE a2a_outbound_agents ADD COLUMN allowed_data_classes_json TEXT;
      ALTER TABLE a2a_outbound_agents ADD COLUMN outbound_quota_budget INTEGER;
      ALTER TABLE a2a_outbound_agents ADD COLUMN require_approval_outbound INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE acp_outbound_agents ADD COLUMN allowed_data_classes_json TEXT;
      ALTER TABLE acp_outbound_agents ADD COLUMN outbound_quota_budget INTEGER;
    `,
  },
]

/**
 * The full ordered list of migration version numbers. Exported so isolation
 * tests can mark "every migration except the one under test" as already
 * applied — keeping those tests immune to later appended migrations (a v16
 * test must not break the day a v17 ALTER lands on a table it never seeded).
 */
export const MIGRATION_VERSIONS: number[] = MIGRATIONS.map((m) => m.version)

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
  const recheck = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
  for (const m of MIGRATIONS) {
    if (appliedVersions.has(m.version)) continue
    // BEGIN IMMEDIATE serializes two hosts sharing one store, but serializing
    // alone isn't enough: both can read the stale `appliedVersions` snapshot
    // above, then queue on the lock. The winner applies + records the row; the
    // loser would then re-run a NON-idempotent ALTER and crash boot with a
    // duplicate-column error (audit L3-1). So re-check the registry once the
    // lock is held — the winner's INSERT is now visible — and adopt it instead
    // of re-applying. Mirrors vault-store's seed() re-check-under-lock. (BEGIN
    // IMMEDIATE only orders the writers; it does not make the earlier read see
    // later writes.)
    const applied = transactionImmediate(db, () => {
      if (recheck.get(m.version)) return false
      db.exec(m.sql)
      db.prepare(
        'INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?)',
      ).run(m.version, m.name, Date.now())
      return true
    })
    if (applied) newlyApplied.push(m.version)
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
