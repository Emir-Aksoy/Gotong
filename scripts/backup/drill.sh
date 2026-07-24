#!/usr/bin/env bash
# Gotong disaster-recovery DRILL — prove a backup actually restores.
#
# A backup you've never restored is a hope, not a backup. This script turns the
# manual drill in docs/OPERATIONS.md into one repeatable command you can run on
# a schedule (cron / CI): it backs up a workspace, restores the tarball into a
# throwaway dir, runs verify.sh, and then diffs the structural invariants that
# decide whether the restored copy is actually usable — same admins (or you
# can't log in), encrypted secrets carried over, and the master keys correctly
# ABSENT (backup.sh excludes the v3 secret.key* family — including the retired
# .pre-unify.bak from key unification — and the v4 identity-master.key* family
# by design, plus unification/rotation debris). It reports PASS/FAIL and a non-zero
# exit so a cron failure mail / CI red tells you your DR is broken BEFORE the
# day you need it.
#
# Read-only on the source: backup.sh only reads, and restore/verify happen in a
# scratch dir — safe to point at a LIVE `.gotong/` on a running host.
#
# Node-less by design (pure bash + tar + jq), so it runs on a bare recovery box.
# The one step it can't cover without Node is actually BOOTING the restored
# host; that's the complementary vitest packages/host/tests/backup-restore-smoke
# (run: pnpm -C packages/host test backup-restore-smoke).
#
# Usage:
#   ./drill.sh <space-dir>                 # drill, then clean up the scratch dir
#   ./drill.sh <space-dir> --keep          # leave the scratch dir for inspection
#   ./drill.sh <space-dir> --workdir DIR   # use DIR instead of a mktemp scratch
#
# Exit codes:
#   0 — DRILL PASSED
#   1 — usage / arg error
#   2 — source workspace invalid (no space.json)
#   3 — backup step failed
#   4 — restore / verify step failed
#   5 — structural invariants failed (restore is incomplete / unusable)

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BACKUP_SH="$HERE/backup.sh"
RESTORE_SH="$HERE/restore.sh"

SRC=""
KEEP=0
WORKDIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --workdir) WORKDIR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    -*) echo "✖ unknown flag: $1" >&2; exit 1 ;;
    *) if [ -z "$SRC" ]; then SRC="$1"; else echo "✖ unexpected arg: $1" >&2; exit 1; fi; shift ;;
  esac
done

if [ -z "$SRC" ]; then
  echo "usage: $(basename "$0") <space-dir> [--keep] [--workdir DIR]" >&2
  exit 1
fi
if [ ! -f "$SRC/space.json" ]; then
  echo "✖ not an Gotong workspace (no space.json): $SRC" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "✖ jq is required (install: brew install jq | apt install jq)" >&2
  exit 2
fi

# Scratch area. mktemp unless the operator pinned one with --workdir.
if [ -z "$WORKDIR" ]; then
  WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/gotong-drill.XXXXXX")"
fi
BACKUP_DIR="$WORKDIR/backup"
RESTORE_DIR="$WORKDIR/restored"
mkdir -p "$BACKUP_DIR"

cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    echo "ℹ scratch dir kept: $WORKDIR"
  else
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT

echo "→ DR drill for $SRC"
echo "  scratch: $WORKDIR"
echo

# --- 1. backup -------------------------------------------------------------
echo "[1/3] backup …"
if ! bash "$BACKUP_SH" "$SRC" "$BACKUP_DIR" >/dev/null; then
  echo "✖ backup step failed" >&2
  exit 3
fi
# backup.sh names files sortably; grab the newest tarball it produced.
TARBALL="$(ls -1t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | head -n1 || true)"
if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
  echo "✖ backup produced no tarball in $BACKUP_DIR" >&2
  exit 3
fi
echo "  ✓ $(basename "$TARBALL")"

# --- 2. restore (+ verify, which restore.sh runs internally) ---------------
echo "[2/3] restore + verify …"
if ! bash "$RESTORE_SH" "$TARBALL" "$RESTORE_DIR" --force >/dev/null; then
  echo "✖ restore/verify step failed (restore.sh exit non-zero)" >&2
  exit 4
fi
echo "  ✓ restored to $RESTORE_DIR (verify.sh passed)"

# --- 3. structural invariants: source vs restored --------------------------
# verify.sh already proved the restored copy is internally sound. These extra
# checks prove it's a faithful, usable copy of THIS source — the properties an
# operator implicitly assumes a "restore" guarantees.
echo "[3/3] invariants (source vs restored) …"
FAIL=0
fail() { echo "  ✖ $1"; FAIL=$((FAIL + 1)); }
ok()   { echo "  ✓ $1"; }

# admins: count must match AND be >= 1 (zero = locked out of your own hub).
SRC_ADMINS="$(jq -r '.admins | length' "$SRC/admins.json" 2>/dev/null || echo -1)"
RES_ADMINS="$(jq -r '.admins | length' "$RESTORE_DIR/admins.json" 2>/dev/null || echo -2)"
if [ "$SRC_ADMINS" -ge 1 ] && [ "$SRC_ADMINS" = "$RES_ADMINS" ]; then
  ok "admins preserved ($RES_ADMINS)"
else
  fail "admins mismatch (source=$SRC_ADMINS restored=$RES_ADMINS)"
fi

# space.json name must survive (identity of the workspace).
SRC_NAME="$(jq -r '.name' "$SRC/space.json" 2>/dev/null || echo '')"
RES_NAME="$(jq -r '.name' "$RESTORE_DIR/space.json" 2>/dev/null || echo '')"
if [ -n "$SRC_NAME" ] && [ "$SRC_NAME" = "$RES_NAME" ]; then
  ok "space name preserved ($RES_NAME)"
else
  fail "space name mismatch (source='$SRC_NAME' restored='$RES_NAME')"
fi

# agents.json (if the source has one) must carry over with the same count.
if [ -f "$SRC/agents.json" ]; then
  SRC_AG="$(jq -r 'if type=="array" then length else (.agents | length) end' "$SRC/agents.json" 2>/dev/null || echo -1)"
  RES_AG="$(jq -r 'if type=="array" then length else (.agents | length) end' "$RESTORE_DIR/agents.json" 2>/dev/null || echo -2)"
  if [ "$SRC_AG" = "$RES_AG" ]; then
    ok "agents preserved ($RES_AG)"
  else
    fail "agents mismatch (source=$SRC_AG restored=$RES_AG)"
  fi
fi

# encrypted secrets must travel (their whole point is to survive a restore).
if [ -f "$SRC/secrets.enc.json" ]; then
  if [ -f "$RESTORE_DIR/secrets.enc.json" ]; then
    ok "encrypted secrets carried over"
  else
    fail "secrets.enc.json present in source but missing after restore"
  fi
fi

# the master keys must NOT be in the backup — bundling either next to the
# ciphertext it unlocks defeats the encryption. backup.sh excludes both key
# FAMILIES on purpose: runtime/secret.key* (legacy v3 + the retired
# .pre-unify.bak left by key unification — still a working key for the
# pre-unify ciphertext) and identity-master.key* (v4 vault KEK + rotation
# .next staging). Check each independently — a v4 host has both.
if ls "$RESTORE_DIR"/runtime/secret.key* >/dev/null 2>&1; then
  fail "runtime/secret.key* leaked into the backup (legacy v3 key family must be excluded)"
else
  ok "v3 master key family (runtime/secret.key*) correctly absent"
fi
if ls "$RESTORE_DIR"/identity-master.key* >/dev/null 2>&1; then
  fail "identity-master.key leaked into the backup (v4 vault KEK must be excluded)"
else
  ok "v4 master key (identity-master.key) correctly absent"
fi

# unification/rotation debris must not travel either: the pre-unify ciphertext
# snapshot (and its never-clobber .N copies — hence the glob) pairs with the
# retired key we just proved absent, and a staged .next copy would land a
# restored host mid-migration instead of clean.
if ls "$RESTORE_DIR"/secrets.enc.json.pre-unify.bak* >/dev/null 2>&1; then
  fail "secrets.enc.json.pre-unify.bak* leaked into the backup (pre-unification snapshots must be excluded)"
else
  ok "pre-unification snapshots (secrets.enc.json.pre-unify.bak*) correctly absent"
fi
if [ -f "$RESTORE_DIR/secrets.enc.json.next" ]; then
  fail "secrets.enc.json.next leaked into the backup (staged rotation copy must be excluded)"
else
  ok "staged rotation copy (secrets.enc.json.next) correctly absent"
fi

echo
if [ "$FAIL" -gt 0 ]; then
  echo "✖ DRILL FAILED — $FAIL invariant(s) broken. Your backup does NOT cleanly restore."
  exit 5
fi
echo "✓ DRILL PASSED — backup → restore → verify → invariants all green."
echo "  (Boot-level assurance: pnpm -C packages/host test backup-restore-smoke)"
