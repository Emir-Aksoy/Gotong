# Operations playbook

Day-2 runbook for an AipeHub deployment. Covers what's on disk, how to
back it up safely, and how to recover from "the disk is gone."

The scope is the same as the rest of the project: **dozens of users,
single-node**. Multi-region, multi-tenant, cluster failover are
outside what AipeHub is built for — if that's your story, the
storage layer needs to change before any of this matters.

---

## 1. What's in `.aipehub/`

A workspace is a single directory. Everything the Hub remembers across
restarts lives here.

```
.aipehub/
├── space.json                 # workspace metadata (name, created_at)
├── config.json                # workspace config
├── admins.json                # admin records + bcrypt-hashed tokens
├── agents.json                # managed-agent records (templated agents)
├── workers.json               # worker (HumanParticipant) registry
├── secrets.enc.json           # v3 encrypted provider/agent API keys
├── identity.sqlite            # v4 identity layer — users/sessions/vault/quota/audit
├── identity-master.key        # 🔑 v4 vault KEK — protect separately
├── transcript.jsonl           # append-only event log
├── services/                  # service-plugin state (memory, datastore, artifact)
│   ├── memory/                  one dir per plugin instance — JSON or SQLite
│   ├── datastore/
│   └── artifact/
└── runtime/
    ├── pending-apps.json      # in-flight admission applications
    ├── admin-sessions.json    # active admin cookie sids
    ├── worker-sessions.json   # active worker cookie sids
    └── secret.key             # 🔑 v3 SpaceSecrets master key — protect separately
```

(`identity.sqlite` runs in WAL mode, so at runtime you'll also see
transient `identity.sqlite-wal` / `-shm` companions.)

These files deserve special care:

- **`runtime/secret.key`** is the v3 master encryption key for
  `secrets.enc.json`. Anyone with both files has every provider/agent
  API key. **Back it up separately**, with separate access controls
  (1Password / GCP Secret Manager / AWS KMS-protected S3 bucket / paper
  envelope in a safe — anything that doesn't share an access policy with
  the rest of the workspace).

- **`identity-master.key`** is the v4 identity-vault KEK (default
  `local-file` provider). It wraps the DEK that encrypts the vault
  inside `identity.sqlite` — SSO/OIDC client secrets, TOTP seeds,
  per-user credentials. Same rule, same blast radius: anyone holding
  both this key and `identity.sqlite` can decrypt the whole vault.
  **Back it up separately too.** Online KEK rotation stages the next
  key as `identity-master.key.next`, so treat the entire
  `identity-master.key*` family as the secret. `backup.sh` excludes it
  for exactly the same reason it excludes `secret.key`.

- **`runtime/*-sessions.json`** are short-lived; restoring them from
  an old backup revives cookie sids that a stale browser tab can
  replay. They are deliberately **excluded** from `backup.sh`.

The other files are all plain JSON / JSONL and can be diffed,
grepped, and `jq`'d. That is on purpose.

---

## 2. Daily backup recipe

### Scripts

Three small bash scripts under `scripts/backup/`:

| Script | Job |
|---|---|
| `backup.sh` | Tar + gzip the workspace; exclude both master keys (secret.key + identity-master.key) + sessions. |
| `restore.sh` | Extract a backup to a fresh directory; stash any existing target. |
| `verify.sh` | Sanity-check a workspace (or backup) using `jq` only — no Node needed. |

### One-shot example

```bash
# Online (host can stay running)
bash scripts/backup/backup.sh /var/lib/aipehub/.aipehub /var/backups/aipehub/

# Atomic (briefly stops the host)
bash scripts/backup/backup.sh /var/lib/aipehub/.aipehub /var/backups/aipehub/ --stop-host
```

Output: `aipehub-<workspace>-<UTC-timestamp>.tar.gz`.

### Recommended cron

A reasonable starting cadence: **hourly online snapshots, kept for
14 days, plus a daily offsite copy.** Adjust upward only if you have
a write-heavy room.

```cron
# /etc/cron.d/aipehub-backup  — runs as the aipehub user
# m h dom mon dow user      command
  17 *  *   *   *  aipehub  /opt/aipehub/scripts/backup/backup.sh /var/lib/aipehub/.aipehub /var/backups/aipehub
  0  3  *   *   *  aipehub  /opt/aipehub/scripts/backup/prune.sh /var/backups/aipehub 14
  0  4  *   *   *  aipehub  rclone copy /var/backups/aipehub remote:aipehub-backups/
```

There's no built-in `prune.sh`; here's a 3-liner that does it:

```bash
#!/usr/bin/env bash
# scripts/backup/prune.sh <dir> <keep-days>
find "$1" -name "aipehub-*.tar.gz" -mtime "+$2" -print -delete
```

### Master key handling

Two master keys can exist in a workspace; **neither** belongs in the
same destination as the workspace backups. `backup.sh` refuses to
include either in the archive, but it can't enforce your cron.

- **`secret.key`** (v3) encrypts `secrets.enc.json`.
- **`identity-master.key`** (v4) wraps the `identity.sqlite` vault DEK.

Recommended places for **both** keys (each as its own entry):

- **1Password / Bitwarden vault item** with a controlled-access tag,
  one entry per environment (staging / prod).
- **GCP Secret Manager** / **AWS Secrets Manager** with a one-step
  recover command in the runbook.
- **Sealed offsite paper copy** for the worst-case "everything else
  is gone" recovery.

Rotate the **v3** key by setting `AIPE_SECRET_KEY=<32 hex bytes>` on
the host and re-saving each provider key through the admin UI; then
delete old `secret.key` copies. Rotate the **v4** KEK online with the
host `rotate-master-key` subcommand — it re-wraps the vault DEK under a
new key staged at `identity-master.key.next`, then promotes it, with no
plaintext re-entry. Back up the new key the same way and retire the old.

---

## 3. Disaster recovery drill

The numbers below were captured running the actual scripts against a
seeded workspace. Re-run this drill any time you change deployment
shape (new VPS, new disk layout, new backup destination).

### Setup — seed a workspace

```bash
# Programmatic init — see scripts/backup/drill-init.example.mjs for
# the canonical version of this snippet.
node <<'EOF'
import { Space } from '/path/to/aipehub/packages/core/dist/index.js'
const { space } = await Space.init('/tmp/drill/space', {
  name: 'drill-workspace',
  adminDisplayName: 'DrillAdmin',
})
await space.setProviderApiKey('anthropic', 'sk-ant-fakedrillkey')
await space.upsertAgent({ id: 'writer', allowedCapabilities: ['draft'] })
await space.upsertAgent({ id: 'reviewer', allowedCapabilities: ['review'] })
await space.createWorker('alice', ['draft', 'review'])
EOF
```

### Step 1 — take a backup

```bash
$ bash scripts/backup/backup.sh /tmp/drill/space /tmp/drill/backups
→ archiving /tmp/drill/space → /tmp/drill/backups/aipehub-space-20260519T063818Z.tar.gz
✓ backup written: /tmp/drill/backups/aipehub-space-20260519T063818Z.tar.gz (4.0K)

Reminder: secret.key was intentionally NOT included. […]
```

The tarball **does not** contain `secret.key`, `admin-sessions.json`,
or `worker-sessions.json`:

```bash
$ tar -tzf /tmp/drill/backups/aipehub-space-20260519T063818Z.tar.gz | sort
space/
space/admins.json
space/agents.json
space/config.json
space/runtime/
space/runtime/pending-apps.json
space/secrets.enc.json
space/services/
space/space.json
space/workers.json
```

> **v4 note.** The walkthrough above seeds a v3-only space. A workspace
> that has booted the identity layer also carries `identity.sqlite` in
> the tarball (the encrypted vault) and **excludes** `identity-master.key`
> for the same reason it excludes `secret.key`. Stash the v4 KEK offsite
> alongside `secret.key` in the next step, and restore it the same way.
> The automated drill (`scripts/backup/drill.sh`) asserts **both** keys
> are absent from the restore.

### Step 2 — separately stash secret.key

In production, this happens via 1Password CLI or `aws secretsmanager`.
For the drill:

```bash
$ cp /tmp/drill/space/runtime/secret.key /tmp/drill/secret.key.offsite
```

### Step 3 — simulate disaster

```bash
# In production: disk failure, accidental rm -rf, region outage, …
# Drill: rename the workspace away so we can't accidentally fall back to it.
$ mv /tmp/drill/space /tmp/drill/space.lost
```

### Step 4 — restore from the backup

```bash
$ bash scripts/backup/restore.sh \
    /tmp/drill/backups/aipehub-space-20260519T063818Z.tar.gz \
    /tmp/drill/space
→ extracting … → /tmp/drill/space
→ running verify.sh...
✓ space.json
✓ admins.json
  (admins: 1)
✓ agents.json
✓ workers.json
✓ secrets.enc.json (encrypted; not decoded here)
ℹ runtime/secret.key MISSING — expected. Drop one in before starting the host.
✓ verify finished with 1 warning(s), 0 errors

✓ restore complete: /tmp/drill/space
[…checklist…]
```

The `secret.key MISSING` warning is **expected** at this point.

### Step 5 — replace `secret.key` from the offsite copy

```bash
$ cp /tmp/drill/secret.key.offsite /tmp/drill/space/runtime/secret.key
```

### Step 6 — verify decryption + data integrity

```bash
$ node <<'EOF'
import { Space } from '/path/to/aipehub/packages/core/dist/index.js'
const space = await Space.open('/tmp/drill/space')
console.log('decrypted-key:', await space.getProviderApiKey('anthropic'))
console.log('admins:',  (await space.admins()).length)
console.log('workers:', (await space.workers()).length)
console.log('agents:',  (await space.agents()).map(a => a.id))
EOF
```

Output from the real drill that produced this doc:

```
decrypted-key: sk-ant-fakedrillkey
admins: 1
workers: 1
agents: [ 'writer', 'reviewer' ]
```

### Step 7 — clean up sessions, restart host

```bash
$ : > /tmp/drill/space/runtime/admin-sessions.json
$ : > /tmp/drill/space/runtime/worker-sessions.json
# In production, ssh to the new box and:
$ AIPE_SPACE=/tmp/drill/space pnpm host
```

When the host comes up, the admin token printed in step 1 still
works to log in. Re-issue tokens for compromised admins if the
disaster was a breach rather than a hardware failure.

### How often should you actually run this drill?

- Once before your first production deployment (definitely).
- Once per quarter on staging (recommended).
- Once after any change to where `secret.key` lives or how it's accessed
  (definitely — the most common failure mode is "we couldn't find the key").

---

## 4. Backup verification

You can verify a backup **without** restoring it:

```bash
# Extract to a scratch dir, run verify, throw away.
mkdir -p /tmp/aipehub-verify
tar -xzf /var/backups/aipehub/aipehub-space-20260519T063818Z.tar.gz \
    -C /tmp/aipehub-verify --strip-components=1
bash scripts/backup/verify.sh /tmp/aipehub-verify
```

What `verify.sh` checks (all without Node):

| Check | Why |
|---|---|
| `space.json` parses + has a `name` field | Otherwise `Space.open` refuses to load |
| `admins.json` parses + has ≥1 admin | Otherwise no-one can log in |
| `agents.json` / `workers.json` parse | Catches partial-write corruption |
| `transcript.jsonl` lines all parse as JSON | Catches truncated tails — the most common silent failure |
| `secrets.enc.json` parses (encrypted; can't decrypt) | Catches structure corruption |
| `identity.sqlite` has SQLite magic + passes `integrity_check` | Catches a torn online (WAL) backup |
| `services/*/*.db` start with SQLite magic bytes | Catches SQLite truncation |
| `runtime/secret.key` is **absent** | Backup hygiene — v3 master key not bundled |
| `identity-master.key*` is **absent** | Backup hygiene — v4 vault KEK not bundled |

Run it on a fresh backup. If it ever fails, the problem is upstream
(SAN snapshot? Disk filling up mid-tar? Concurrent writes?) and your
backups have been silently broken — fix that before relying on the
next snapshot.

---

## 5. Troubleshooting

**"Restored host won't decrypt provider keys."** `secret.key` is
missing, wrong, or zero bytes. Re-copy from offsite, restart.

**"`transcript.jsonl` has a bad line and the host refuses to boot."**
That's the rarest failure mode but it happens if the disk filled up
during a write. Fix with:

```bash
# Drop the trailing partial line. The transcript is append-only; the
# UI / SDK don't depend on the truncated tail.
head -n -1 transcript.jsonl > transcript.jsonl.fixed && mv transcript.jsonl.fixed transcript.jsonl
```

**"I lost the secret.key entirely."** All `secrets.enc.json` entries
are unrecoverable. Re-mint each provider key in the upstream
dashboards (OpenAI / Anthropic / DeepSeek / …), set
`AIPE_SECRET_KEY=<32 hex bytes>` on the host as the new master, and
re-save every key through the admin UI. The admins / workers / agents
/ transcript / services data is all unaffected.

**"verify.sh says transcript truncated but the host boots."** That
means there's a partial line that the Hub's lenient JSONL parser is
skipping — the data is intact but the file shape isn't. Fix with the
`head -n -1` recipe above so future verify runs are clean.

---

## 6. Retention

Everything AipeHub persists is append-only by default — the
transcript, workflow run records, and the identity DB's ledger /
audit / control-plane tables all grow until you say otherwise. The
retention knobs below are **all off unless set** (the host never
silently deletes data), applied once at boot, and a malformed value
fails the boot loudly instead of being ignored.

| Env | What it bounds | Semantics |
|---|---|---|
| `AIPE_TRANSCRIPT_KEEP_SEGMENTS` | transcript boot-load path | Keep the N newest sealed segments active; older ones move to `<AIPE_SPACE>/archive/` (bytes stay on disk for audit/export). |
| `AIPE_TRANSCRIPT_ARCHIVE_DAYS` | transcript | Archive sealed segments whose newest entry is older than N days. Combinable with `KEEP_SEGMENTS` (both must hold). |
| `AIPE_RUN_KEEP` | workflow run scans | Keep the N newest **terminal** runs active; older ones move to `workflows/runs/archive/`. A `running` run is never archived. |
| `AIPE_RUN_ARCHIVE_DAYS` | workflow runs | Archive terminal runs that ended more than N days ago. Combinable with `AIPE_RUN_KEEP`. |
| `AIPE_LEDGER_KEEP_DAYS` | `usage_ledger` (billing) | Prune rows older than N days at boot. The retained window stays exportable (CSV/JSONL). |
| `AIPE_AUDIT_KEEP_DAYS` | `audit_log` | Same prune-at-boot semantics. |
| `AIPE_PEER_SUMMARY_KEEP_DAYS` | `peer_summary_snapshots` | Same — bounds control-plane trend history. |
| `AIPE_ALERT_FIRINGS_KEEP_DAYS` | `peer_summary_alert_firings` | Same, **resolved firings only** — an open firing is never pruned. |

Practical starting point for a small-team host:

```bash
AIPE_TRANSCRIPT_KEEP_SEGMENTS=50
AIPE_RUN_KEEP=2000
AIPE_LEDGER_KEEP_DAYS=400     # > 1 year for billing reconciliation
AIPE_AUDIT_KEEP_DAYS=400
AIPE_PEER_SUMMARY_KEEP_DAYS=90
AIPE_ALERT_FIRINGS_KEEP_DAYS=90
```

Archives (`archive/`, `runs/archive/`) are immutable once rotated —
gzip or ship them to cold storage on your own schedule. The
`AipehubDiskAlmostFull` alert runbook in
[`docs/MONITORING.md`](MONITORING.md) points back here.
