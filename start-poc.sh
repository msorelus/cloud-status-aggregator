#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$ROOT_DIR/teams-agent/.runtime"
PIDS_FILE="$RUNTIME_DIR/pids"
TUNNEL_LOG="$RUNTIME_DIR/devtunnel.log"
mkdir -p "$RUNTIME_DIR"

cleanup() {
  if [[ -f "$PIDS_FILE" ]]; then
    while read -r pid; do
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
      fi
    done < "$PIDS_FILE"
  fi
  rm -f "$PIDS_FILE"
}
trap cleanup EXIT INT TERM
cleanup
: > "$PIDS_FILE"
: > "$TUNNEL_LOG"

cd "$ROOT_DIR"
echo "Building root MCP/API server..."
npm run build >/dev/null
if [[ -n "${MOCK:-}" ]]; then
  echo "Server mode: MOCK (bundled sample data)"
else
  echo "Server mode: LIVE (Azure) — use 'MOCK=1 ./start-poc.sh' for offline."
  if [[ -z "${SUBSCRIPTION_IDS:-}" ]]; then
    echo "  ⚠  SUBSCRIPTION_IDS is unset → tenant fork will skip Service Health enrichment."
    echo "     export SUBSCRIPTION_IDS=<sub-guid> before running for the full Public⟷Tenant story."
  else
    echo "  SUBSCRIPTION_IDS set → tenant fork includes Service Health."
  fi
fi
MOCK="${MOCK:-}" node dist/server.js &
echo $! >> "$PIDS_FILE"

cd "$ROOT_DIR/teams-agent"
if [[ ! -d node_modules ]]; then
  npm install
fi
npm run build >/dev/null
MCP_URL="${MCP_URL:-http://localhost:8080/mcp}" PORT="${PORT:-3978}" npm start &
echo $! >> "$PIDS_FILE"

if ! command -v devtunnel >/dev/null 2>&1; then
  echo "devtunnel CLI not found. Install/sign in, then run: devtunnel host csa-azstatus"
  echo "Bot endpoint to configure: https://<TUNNEL_HOST>/api/messages"
  wait
fi

# Host the PERSISTENT named tunnel so the messaging-endpoint URL stays stable
# (matches the Azure Bot endpoint configured at provisioning time).
devtunnel host csa-azstatus > "$TUNNEL_LOG" 2>&1 &
echo $! >> "$PIDS_FILE"

sleep 8
TUNNEL_URL="${TUNNEL_URL:-$(grep -Eo 'https://[^[:space:]]+devtunnels[^[:space:]]+' "$TUNNEL_LOG" | head -n 1 || true)}"
TUNNEL_HOST="${TUNNEL_HOST:-${TUNNEL_URL#https://}}"
TUNNEL_HOST="${TUNNEL_HOST%%/*}"

if [[ -n "$TUNNEL_HOST" ]]; then
  echo "Tunnel URL: https://$TUNNEL_HOST"
  echo "Azure Bot messaging endpoint: https://$TUNNEL_HOST/api/messages"
  echo "Manifest replacements:"
  echo "  \${{BOT_ID}}      = <Azure Bot / Entra app client ID>"
  echo "  \${{TUNNEL_HOST}} = $TUNNEL_HOST"
else
  echo "Could not parse tunnel URL yet. Watch $TUNNEL_LOG for the devtunnel host."
fi

echo "Processes are running. Press Ctrl-C to stop."
(
  while true; do
    if [[ -n "$TUNNEL_HOST" ]]; then
      curl -fsS -X POST "https://$TUNNEL_HOST/api/messages" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 || true
    fi
    sleep 30
  done
) &
echo $! >> "$PIDS_FILE"

wait
