#!/usr/bin/env bash
# Gotong — 60-second demo, designed for asciinema recording.
#
# Spawns a fresh Gotong host in a temp workspace, imports one mock-provider
# agent (no API key required), dispatches a task, prints the result, then
# tears everything down. Total wall time ≈ 5 seconds — well inside an
# asciinema 60s GIF.
#
# Usage:
#   ./scripts/demo-60s.sh            # plain run
#   asciinema rec demo.cast -c ./scripts/demo-60s.sh
#                                    # record into demo.cast (then convert to GIF — see scripts/RECORDING.md)
#
# Prerequisites:
#   - Repo has been built (`pnpm install && pnpm build`)
#   - Ports 3399 / 4399 are free
#   - `jq` is available (for pretty JSON in the recording)
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v jq >/dev/null 2>&1; then
  echo "✖ jq is required for this demo (pretty JSON). Install: brew install jq" >&2
  exit 1
fi

SPACE="$(mktemp -d -t gotong-demo-XXXXXX)"
LOG="/tmp/gotong-demo-$$.log"
HOST_PID=""

cleanup() {
  [[ -n "$HOST_PID" ]] && kill "$HOST_PID" 2>/dev/null || true
  wait "$HOST_PID" 2>/dev/null || true
  rm -rf "$SPACE" "$LOG" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

clear
cat <<'BANNER'
╔══════════════════════════════════════════════════════╗
║      Gotong — 60-second demo                         ║
║   humans + agents — one communication space          ║
╚══════════════════════════════════════════════════════╝
BANNER
sleep 0.6

step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$1"; }

step "Starting host on http://127.0.0.1:3399 (workspace: ${SPACE/$HOME/~})"
GOTONG_SPACE="$SPACE" GOTONG_WEB_PORT=3399 GOTONG_WS_PORT=4399 \
  node packages/host/bin/gotong-host.js >"$LOG" 2>&1 &
HOST_PID=$!
sleep 1.6

TOKEN=$(grep -oE 'token=[0-9a-f]+' "$LOG" | head -1 | cut -d= -f2)
AUTH=(-H "Authorization: Bearer $TOKEN" -H "content-type: application/json")
echo "  ✓ ready — admin token ${TOKEN:0:8}…"

step "Importing a mock-provider agent (no API key needed)"
curl -fsS -X POST "http://127.0.0.1:3399/api/admin/agents" "${AUTH[@]}" \
  -d '{
    "id": "echo",
    "displayName": "Echo Bot",
    "capabilities": ["echo"],
    "kind": "llm",
    "provider": "mock",
    "system": "Echo the user task back as JSON."
  }' | jq -c '{ok, agent: .agent.id, online: .agent.online}'
sleep 0.5

step "Dispatching a task (strategy=capability, waits for the result)"
curl -fsS -X POST "http://127.0.0.1:3399/api/admin/dispatch" "${AUTH[@]}" \
  -d '{
    "strategy": {"kind": "capability", "capabilities": ["echo"]},
    "payload":  {"text": "hello Gotong"},
    "title":    "60-second demo task",
    "weight":   2.0,
    "wait":     true,
    "timeoutMs": 10000
  }' | jq '{kind: .result.kind, by: .result.by, output: .result.output}'

step "Leaderboard after one task"
curl -fsS "http://127.0.0.1:3399/api/leaderboard" -H "Authorization: Bearer $TOKEN" \
  | jq '{total: .totalTaskCount, unrated: .unratedTaskCount, top: .rows[0:1]}'

GREEN=$'\033[1;32m'
RESET=$'\033[0m'
cat <<EOF

${GREEN}✓ Done.${RESET}  Real-life follow-up:
    open  http://127.0.0.1:3399/admin?token=${TOKEN:0:8}…
    or    docker compose up   (persistent workspace under ./data)

See docs/OVERVIEW.md for the full picture.
EOF
sleep 1
