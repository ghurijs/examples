#!/usr/bin/env bash
# The same project on Node + PostgreSQL + pgvector, end to end and offline: PGlite with the pgvector extension
# (or a real server with DATABASE_URL), the offline model and embeddings, tasks in the database run by
# `ghuri db_worker`, uploads on the local disk.
#   1. migrate, create the pgvector table (`ghuri createvectortable`) and a user;
#   2. serve src/server.ts on Node; create a workspace, upload a document;
#   3. run the queued embedding with `ghuri db_worker --batch`, then ask the agent (JSON) and in the background.
# Usage: bash scripts/node-smoke.sh   (from examples/agentdesk; needs `npm install`)
# PGlite is one process per data directory, so the server is stopped while `ghuri db_worker` runs. With a real
# PostgreSQL (DATABASE_URL=… bash scripts/node-smoke.sh) they would run side by side.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8766}"
STATE="$(mktemp -d)"
export SECRET_KEY="node-smoke-secret"
export DEBUG=true
export AGENT_MODEL=fake:agentdesk EMBEDDING_MODEL=fake:agentdesk EMBEDDING_DIMENSIONS=256
export STRIPE_SECRET_KEY=sk_test_smoke_only STRIPE_WEBHOOK_SECRET=whsec_smoke_only
export MEDIA_ROOT="$STATE/media"
if [ -z "${DATABASE_URL:-}" ]; then
  export DATABASE_ENGINE=pglite PGLITE_DIR="$STATE/pglite"
fi
trap 'kill "${SERVER_PID:-0}" 2>/dev/null || true; rm -rf "$STATE"' EXIT
BASE="http://127.0.0.1:$PORT"

echo "== 1. migrate, createvectortable, a user"
npx ghuri migrate --persist-to "$STATE/wrangler" > /dev/null
npx ghuri createvectortable --persist-to "$STATE/wrangler"
npx ghuri shell --persist-to "$STATE/wrangler" -c "
  await User.objects.createUser('alice', 'alice@example.com', 'pw-alice')
  await User.objects.count()
"

start_server() {
  PORT="$PORT" node --import jiti/register src/server.ts >> "$STATE/server.log" 2>&1 &
  SERVER_PID=$!
  curl -s --retry 30 --retry-connrefused --retry-delay 1 "$BASE/" > /dev/null
}
stop_server() {
  kill "$SERVER_PID" && wait "$SERVER_PID" 2>/dev/null || true
}
worker() {
  stop_server
  npx ghuri db_worker --batch --persist-to "$STATE/wrangler"
  start_server
}

echo "== 2. serve on Node, create a workspace, upload"
start_server
TOKEN="$(curl -s -X POST "$BASE/api/auth/token/" -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"pw-alice"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')"
AUTH="Authorization: Token $TOKEN"
curl -sf -X POST "$BASE/api/workspaces/" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"Acme","slug":"acme"}' > /dev/null
printf 'Refunds take five business days and go back to the original card.\n' > "$STATE/refunds.md"
DOC="$(curl -sf -X POST "$BASE/api/documents/" -H "$AUTH" -H 'X-Workspace: acme' -F "file=@$STATE/refunds.md")"
echo "$DOC"
DOC_ID="$(echo "$DOC" | sed 's/.*"id":"\([^"]*\)".*/\1/')"

echo "== 3. embed with db_worker, ask"
worker
curl -s "$BASE/api/documents/$DOC_ID/" -H "$AUTH" -H 'X-Workspace: acme' | tee /dev/stderr | grep -q '"status":"ready"'
echo
ANSWER="$(curl -s -X POST "$BASE/agents/support/chat" -H "$AUTH" -H 'X-Workspace: acme' \
  -H 'Content-Type: application/json' -d '{"message":"How long do refunds take?"}')"
echo "$ANSWER"
echo "$ANSWER" | grep -q 'five business days'
ASK="$(curl -s -X POST "$BASE/api/ask/" -H "$AUTH" -H 'X-Workspace: acme' \
  -H 'Content-Type: application/json' -d '{"message":"refund card"}')"
TASK="$(echo "$ASK" | sed 's/.*"task":"\([^"]*\)".*/\1/')"
worker
RESULT="$(curl -s "$BASE/api/ask/$TASK/" -H "$AUTH" -H 'X-Workspace: acme')"
echo "$RESULT"
echo "$RESULT" | grep -q '"status":"SUCCESSFUL"'
echo "OK: Node + PostgreSQL + pgvector"
