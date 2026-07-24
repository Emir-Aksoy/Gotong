# Operations playbook

Day-2 runbook for an Gotong deployment. Covers what's on disk, how to
back it up safely, and how to recover from "the disk is gone."

The scope is the same as the rest of the project: **dozens of users,
single-node**. Multi-region, multi-tenant, cluster failover are
outside what Gotong is built for — if that's your story, the
storage layer needs to change before any of this matters.

---

## 1. What's in `.gotong/`

A workspace is a single directory. Everything the Hub remembers across
restarts lives here.

```
.gotong/
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
    └── secret.key             # 🔑 legacy space-secrets key (pre-unification only — see below)
```

(`identity.sqlite` runs in WAL mode, so at runtime you'll also see
transient `identity.sqlite-wal` / `-shm` companions.)

These files deserve special care:

- **`identity-master.key`** is the single root key (KEK, default
  `local-file` provider). It wraps the DEK that encrypts the vault
  inside `identity.sqlite` — SSO/OIDC client secrets, TOTP seeds,
  per-user credentials — **and**, since the key unification, the
  space-secrets key (for `secrets.enc.json`, i.e. every provider/agent
  LLM API key) is derived from it via HKDF. One key, whole blast
  radius: anyone holding this key plus the workspace can decrypt
  everything. **Back it up separately**, with separate access controls
  (1Password / GCP Secret Manager / AWS KMS-protected S3 bucket / paper
  envelope in a safe — anything that doesn't share an access policy with
  the rest of the workspace). KEK rotation (run with the host
  stopped) stages the next key as `identity-master.key.next`, so treat
  the entire `identity-master.key*` family as the secret. `backup.sh` and
  `gotong backup` exclude it by default.

- **`runtime/secret.key`** is the **legacy** space-secrets key. It only
  exists in workspaces created before the unification: on the first
  boot with an identity KEK present, the host re-encrypts
  `secrets.enc.json` under the derived key and retires this file to
  `runtime/secret.key.pre-unify.bak` (renamed, never deleted — a
  pre-migration ciphertext copy is kept as
  `secrets.enc.json.pre-unify.bak` too). If you still see a live
  `runtime/secret.key`, the workspace hasn't been unified yet (or the
  legacy key was missing at migration time — the boot log says so):
  until then it guards all LLM keys and needs the same offsite care.

- **`runtime/*-sessions.json`** are short-lived; restoring them from
  an old backup revives cookie sids that a stale browser tab can
  replay. They are deliberately **excluded** from `backup.sh`.

The other files are all plain JSON / JSONL and can be diffed,
grepped, and `jq`'d. That is on purpose.

---

## 2. Daily backup recipe

### Scripts

Five bash scripts under `scripts/backup/`:

| Script | Job |
|---|---|
| `backup.sh` | Tar + gzip the workspace; exclude both master keys (secret.key + identity-master.key) + sessions. |
| `restore.sh` | Extract a backup to a fresh directory; stash any existing target. |
| `verify.sh` | Sanity-check a workspace (or backup) using `jq` only — no Node needed. |
| `prune.sh` | Drop tarballs older than N days. Built for cron: quiet on success, validates its args, and only ever matches `gotong-*.tar.gz` so it can't sweep an unrelated archive parked in the same directory. |
| `drill.sh` | Disaster-recovery drill: backup → restore → verify → invariant diff, **exiting non-zero when a backup does not cleanly restore**. Read-only on the source, safe against a live `.gotong/`. This is the one that turns "we have backups" into "we have backups that work". |

The same semantics also ship as TS-native CLI commands — `gotong backup` /
`gotong restore` — for machines without bash (Windows, the portable bundle).
They add a `gotong-backup-manifest.json` (file list + sha256) inside the
archive, and `gotong restore` refuses to touch the target unless every hash
verifies. Servers with cron keep using the `.sh` scripts; both formats
exclude the same keys/sessions. See `gotong help backup` / `gotong help restore`.

> **Backups are also your only rollback.** Schema migrations are forward-only —
> no `down` SQL exists — so reverting the binary does *not* revert the store; an
> older host now refuses to boot against a migrated database rather than
> silently running old code on a new schema. Take a fresh backup immediately
> before every upgrade, not just nightly. Procedure:
> [`docs/zh/UPGRADE-RUNBOOK.md`](zh/UPGRADE-RUNBOOK.md).

### One-shot example

```bash
# Online (host can stay running)
bash scripts/backup/backup.sh /var/lib/gotong/.gotong /var/backups/gotong/

# Atomic (briefly stops the host)
bash scripts/backup/backup.sh /var/lib/gotong/.gotong /var/backups/gotong/ --stop-host
```

Output: `gotong-<workspace>-<UTC-timestamp>.tar.gz`.

### Recommended cron

A reasonable starting cadence: **hourly online snapshots, kept for
14 days, plus a daily offsite copy.** Adjust upward only if you have
a write-heavy room.

```cron
# /etc/cron.d/gotong-backup  — runs as the gotong user
# m h dom mon dow user      command
  17 *  *   *   *  gotong  /opt/gotong/scripts/backup/backup.sh /var/lib/gotong/.gotong /var/backups/gotong
  0  3  *   *   *  gotong  /opt/gotong/scripts/backup/prune.sh /var/backups/gotong 14
  0  4  *   *   *  gotong  rclone copy /var/backups/gotong remote:gotong-backups/
  0  5  *   *   0  gotong  /opt/gotong/scripts/backup/drill.sh /var/lib/gotong/.gotong
```

The weekly `drill.sh` line is the one people skip and then regret: it
restores the backup into a scratch dir and diffs the invariants, so cron
mails you the week a backup silently stops restoring — instead of you
finding out during the outage. An untested backup is a guess.

**Installed from npm instead of a git checkout?** Then there is no
`scripts/` directory on the box. Use the CLI, which produces the same
`gotong-<label>-<UTC-timestamp>.tar.gz` name — so `prune.sh`'s glob and any
retention tooling you already have keep working across both:

```cron
  17 *  *   *   *  gotong  gotong backup /var/lib/gotong/.gotong /var/backups/gotong
  0  3  *   *   *  gotong  find /var/backups/gotong -maxdepth 1 -type f -name 'gotong-*.tar.gz' -mtime +14 -print -delete
```

Pick one lane and stay in it. The two are interchangeable by design — same
exclusions, same filename — but the `.sh` lane needs no Node (it runs on a
bare recovery box) while the CLI lane needs no bash (Windows, portable
bundle) and additionally verifies a sha256 manifest before restore writes
anything.

> **One asymmetry, on purpose.** Only the CLI lane records
> `<space>/runtime/last-backup.json` — the fact Atong's `backup_status` reads
> and its staleness reminder watches. `backup.sh` deliberately never writes
> into the workspace it is archiving, because `drill.sh` runs it against a
> **live** `.gotong/` and that read-only promise is what makes the drill safe.
> Consequence: back up purely via cron `.sh` and Atong will keep saying it has
> never seen a backup. That is a blind spot, not a broken backup — your
> tarballs are fine. If you want Atong in the loop, run the CLI lane, or add a
> weekly `gotong backup` alongside the hourly `.sh` one purely to refresh the
> fact.

### Master key handling

Since the key unification there is **one** root key to safeguard:
`identity-master.key`. It wraps the `identity.sqlite` vault DEK, and
the space-secrets key (for `secrets.enc.json`) is derived from it.
It never belongs in the same destination as the workspace backups —
`backup.sh` and `gotong backup` refuse to include it, but they can't
enforce your cron.

Recommended places for the key:

- **1Password / Bitwarden vault item** with a controlled-access tag,
  one entry per environment (staging / prod).
- **GCP Secret Manager** / **AWS Secrets Manager** with a one-step
  recover command in the runbook.
- **Sealed offsite paper copy** for the worst-case "everything else
  is gone" recovery.

Rotate the KEK with the host `rotate-master-key` subcommand — it
re-wraps the vault DEK under a new key staged at
`identity-master.key.next` **and** re-encrypts `secrets.enc.json`
under the new derived key (staged as `secrets.enc.json.next`), then
promotes both, with no plaintext re-entry. One rotation covers both
stores. **Stop the host first.** A running host still holds the old
derived key in memory: a secret saved between staging and promote is
written under the old key, so the staged copy no longer covers the
live file — the rotation refuses to settle it (a loud error, never a
silent clobber) and you are left reconciling the two files by hand.
`systemctl stop gotong-host` → rotate → start.
Run **one rotation at a time** — concurrent runs can't brick the
vault (every staging claim is re-verified byte-for-byte before the
commit), but the losing run aborts and can leave a
`secrets.enc.json.next` behind that blocks the next rotation until
you move it aside. And keep the workspace on a **local disk**: the
crash-safety story leans on POSIX rename atomicity and fsync, which
NFS/SMB weaken.
Back up the new key the same way and retire the old — including any
offsite copies of it.

If boot recovery sweeps a staged key it judges stale, the bytes are
moved to a sweep-unique `identity-master.key.next.discarded.*` slot
(never overwriting an earlier one) — never deleted. The key promote
uses the same slots as its transient claim staging, so a crash in
the middle of a promote can also strand real key bytes there — and
is caught by the same message below. Normally these
are dead bytes you can remove once the vault opens fine. But if a
boot refuses to start with a message naming one of these files
("the live key cannot unwrap the vault DEK, but swept staging file …
can"), a concurrent rotation committed and lost its staging to a
racing sweep — recover with one move inside the space dir:
`mv <the exact filename from the message> identity-master.key.next`,
then start again; boot recovery promotes it.

The provider-secrets staging gets the same care: recovery deletes or
promotes `secrets.enc.json.next` only when a per-entry trial-decrypt
under a vault-proven key shows nothing would be lost; a copy it
cannot judge is **kept** in place (noted in the log, and it blocks
the next rotation until moved aside). A transient
`secrets.enc.json.next.judging.*` file is the reconciler's private
claim slot; a crash can strand one, and the next boot re-parks it
onto the staging path by itself — leave them alone. If a boot refuses to start
naming both `secrets.enc.json` and `secrets.enc.json.next`, the live
secrets no longer read under the promoted key and the kept staging
may be the only surviving re-encryption: inspect the two files, put
the right one at `secrets.enc.json` (or move both aside and re-enter
the API keys in the admin panel), remove the staging, start again.

**Legacy (pre-unification) workspaces** additionally carry
`runtime/secret.key` (env override `GOTONG_SECRET_KEY`) guarding
`secrets.enc.json`. Both keys need offsite care until the first boot
with the identity layer completes the migration; after that only the
root key matters, and the legacy pair sticks around as
`*.pre-unify.bak` files (excluded from backups, safe to stash offsite
alongside the retired key).

**Do not downgrade a unified workspace** to a pre-unification Gotong
binary. The old binary doesn't know the v2 `secrets.enc.json` marker
and looks for `runtime/secret.key` — which no longer exists — so it
mints a fresh junk key, fails to decrypt every stored secret, and on
the next secret write re-stamps the file under the junk key (mixing
keys and dropping the marker). If you genuinely must roll back:
restore the migration snapshots first — copy
`secrets.enc.json.pre-unify.bak` over `secrets.enc.json` and
`runtime/secret.key.pre-unify.bak` back to `runtime/secret.key` —
which returns the workspace to its exact pre-unification state;
secrets added or changed *after* unification are not in that snapshot
and must be re-entered.

Two rollback nuances. **Numbered copies**: the backups never clobber —
a differing pre-existing `.pre-unify.bak` pushes the new one to
`.pre-unify.bak.2`, `.3`, … There is no marker pairing a secrets
snapshot with the key that wrote it, so with multiple copies pair them
by *decrypt trial*: restore one pair, boot the old binary, and if the
secrets fail to decrypt (AES-GCM rejects a wrong key loudly, nothing
is corrupted by trying) swap in the next candidate. **Env-supplied
legacy key**: if the legacy key came from `GOTONG_SECRET_KEY` rather
than the key file, there is no `runtime/secret.key.pre-unify.bak` to
restore — nothing was renamed. Roll back the secrets file alone and
keep the env var set; that value still decrypts the snapshot.

### Moving house — one workspace to a new machine

"复制目录 = 搬走房间" as a recipe. No new commands — it is backup → copy →
restore → check, with the keys riding along **explicitly**:

```bash
# On the OLD machine — moving-house mode bundles BOTH master keys.
# The archive can now decrypt everything: treat it like a password.
gotong backup /var/lib/gotong/.gotong /tmp/move --include-master-key

# Carry it over an encrypted channel, then delete the intermediate copy.
scp /tmp/move/gotong-*.tar.gz newbox:/tmp/
rm /tmp/move/gotong-*.tar.gz

# On the NEW machine — verify-then-restore, then the workspace check runs
# automatically (config 体检 + workflow/agent definitions, no LLM).
gotong restore /tmp/gotong-*.tar.gz --space /var/lib/gotong/.gotong
rm /tmp/gotong-*.tar.gz
gotong doctor        # ports / node / key env for THIS box
gotong start
```

If the workspace predates the AipeHub → Gotong rename (old service package
names, `aipehub.*/v1` format ids, `AIPE_*` env prefixes), run the rename
doctor before first boot on the new box:

```bash
gotong migrate scan  /var/lib/gotong/.gotong     # read-only report
gotong migrate apply /var/lib/gotong/.gotong     # whitelist fix; *.premigrate copies kept
```

`migrate` never reads env files (they hold credentials) — for those it just
prints the `sed` one-liner to run yourself. Systemd units, `EnvironmentFile=`
copies and healthcheck greps are yours to update by hand.

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
import { Space } from '/path/to/gotong/packages/core/dist/index.js'
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
→ archiving /tmp/drill/space → /tmp/drill/backups/gotong-space-20260519T063818Z.tar.gz
✓ backup written: /tmp/drill/backups/gotong-space-20260519T063818Z.tar.gz (4.0K)

Reminder: secret.key was intentionally NOT included. […]
```

The tarball **does not** contain `secret.key`, `admin-sessions.json`,
or `worker-sessions.json`:

```bash
$ tar -tzf /tmp/drill/backups/gotong-space-20260519T063818Z.tar.gz | sort
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
>
> **Post-unification note.** A workspace that has completed the key
> unification has no live `runtime/secret.key` — `identity-master.key`
> is the only key to stash and restore (Steps 2 and 5 apply to it
> alone). Everything else in the drill is unchanged.

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
    /tmp/drill/backups/gotong-space-20260519T063818Z.tar.gz \
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
import { Space } from '/path/to/gotong/packages/core/dist/index.js'
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
$ GOTONG_SPACE=/tmp/drill/space pnpm host
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
mkdir -p /tmp/gotong-verify
tar -xzf /var/backups/gotong/gotong-space-20260519T063818Z.tar.gz \
    -C /tmp/gotong-verify --strip-components=1
bash scripts/backup/verify.sh /tmp/gotong-verify
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

**"Restored host won't decrypt provider keys."** The key guarding
`secrets.enc.json` is missing or wrong. Post-unification that's
`identity-master.key` (the file's `version: 2` marks it as bound to
the derived key); pre-unification it's `runtime/secret.key`. Re-copy
the right one from offsite, restart.

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
`GOTONG_SECRET_KEY=<32 hex bytes>` on the host as the new master, and
re-save every key through the admin UI. The admins / workers / agents
/ transcript / services data is all unaffected.

**"verify.sh says transcript truncated but the host boots."** That
means there's a partial line that the Hub's lenient JSONL parser is
skipping — the data is intact but the file shape isn't. Fix with the
`head -n -1` recipe above so future verify runs are clean.

---

## 6. Retention

Everything Gotong persists is append-only by default — the
transcript, workflow run records, and the identity DB's ledger /
audit / control-plane tables all grow until you say otherwise. The
retention knobs below are **all off unless set** (the host never
silently deletes data), and a malformed value fails the boot loudly
instead of being ignored. A configured policy is applied once at
boot **and re-applied every 6 hours at runtime** (perf audit A⑤) —
age cutoffs re-anchor to the sweep clock, so a host that is never
restarted still honors its policy instead of growing until the next
reboot.

| Env | What it bounds | Semantics |
|---|---|---|
| `GOTONG_TRANSCRIPT_KEEP_SEGMENTS` | transcript boot-load path | Keep the N newest sealed segments active; older ones move to `<GOTONG_SPACE>/archive/` (bytes stay on disk for audit/export). |
| `GOTONG_TRANSCRIPT_ARCHIVE_DAYS` | transcript | Archive sealed segments whose newest entry is older than N days. Combinable with `KEEP_SEGMENTS` (both must hold). |
| `GOTONG_RUN_KEEP` | workflow run scans | Keep the N newest **terminal** runs active; older ones move to `workflows/runs/archive/`. A `running` run is never archived. |
| `GOTONG_RUN_ARCHIVE_DAYS` | workflow runs | Archive terminal runs that ended more than N days ago. Combinable with `GOTONG_RUN_KEEP`. |
| `GOTONG_LEDGER_KEEP_DAYS` | `usage_ledger` (billing) | Prune rows older than N days at boot. The retained window stays exportable (CSV/JSONL). |
| `GOTONG_AUDIT_KEEP_DAYS` | `audit_log` | Same prune-at-boot semantics. |
| `GOTONG_PEER_SUMMARY_KEEP_DAYS` | `peer_summary_snapshots` | Same — bounds control-plane trend history. |
| `GOTONG_ALERT_FIRINGS_KEEP_DAYS` | `peer_summary_alert_firings` | Same, **resolved firings only** — an open firing is never pruned. |

Practical starting point for a small-team host:

```bash
GOTONG_TRANSCRIPT_KEEP_SEGMENTS=50
GOTONG_RUN_KEEP=2000
GOTONG_LEDGER_KEEP_DAYS=400     # > 1 year for billing reconciliation
GOTONG_AUDIT_KEEP_DAYS=400
GOTONG_PEER_SUMMARY_KEEP_DAYS=90
GOTONG_ALERT_FIRINGS_KEEP_DAYS=90
```

Archives (`archive/`, `runs/archive/`) are immutable once rotated —
gzip or ship them to cold storage on your own schedule. The
`GotongDiskAlmostFull` alert runbook in
[`docs/MONITORING.md`](MONITORING.md) points back here.
