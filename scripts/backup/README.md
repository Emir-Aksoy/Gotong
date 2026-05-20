# `scripts/backup/`

Bash + jq operations toolkit for AipeHub workspaces.

| Script | Purpose |
|---|---|
| `backup.sh` | Tar+gzip a `.aipehub/` workspace. Excludes `secret.key` and session files. |
| `restore.sh` | Extract a backup into a fresh dir, run `verify.sh`, print the post-restore checklist. |
| `verify.sh` | Sanity-check a workspace (or backup) using only `jq`. Run before / after / instead of restore as you like. |
| `prune.sh` | Drop tarballs older than N days. Designed for cron. |
| `drill-init.example.mjs` | Canonical seed script used by the disaster-recovery drill in `docs/OPERATIONS.md`. Not for production use. |

These scripts intentionally have no runtime dependency on the AipeHub
Node packages — they're pure bash + `tar` + `jq`. That means you can
run them from a fresh recovery box where you haven't installed Node
yet.

Quick start:

```bash
bash scripts/backup/backup.sh /var/lib/aipehub/.aipehub /var/backups/aipehub/
bash scripts/backup/verify.sh /var/lib/aipehub/.aipehub
bash scripts/backup/restore.sh /var/backups/aipehub/aipehub-...tar.gz /var/lib/aipehub/.aipehub --force
bash scripts/backup/prune.sh /var/backups/aipehub 14
```

The full playbook (cron recipes, secret.key handling, end-to-end
disaster recovery drill) lives in [`docs/OPERATIONS.md`](../../docs/OPERATIONS.md).
