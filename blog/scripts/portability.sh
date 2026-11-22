#!/usr/bin/env bash
# "Start on Cloudflare, move to Postgres without a rewrite" — end to end, locally:
#   1. migrate the local D1 database (wrangler's Miniflare state) and add data through the API on Workers
#      semantics (here: through the CLI, which talks to the same local D1);
#   2. migrate a PostgreSQL database (PGlite, in-process — or DATABASE_URL) and copy every row into it;
#   3. run a background task on PostgreSQL: enqueue it into the database and run it with `ghuri db_worker`;
#   4. serve the same project on Node against PostgreSQL and read the data back over HTTP (REST and GraphQL).
# Usage: bash scripts/portability.sh   (from examples/blog; needs `npm install`)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8765}"
export SECRET_KEY="${SECRET_KEY:-portability-secret}"
export GHURI_SUPERUSER_PASSWORD="${GHURI_SUPERUSER_PASSWORD:-portability-pass}"
STATE="$(mktemp -d)"
export PGLITE_DIR="$STATE/pglite"
trap 'kill "${SERVER_PID:-0}" 2>/dev/null || true; rm -rf "$STATE"' EXIT

echo "== 1. D1 (local): migrate + seed"
npx ghuri migrate --persist-to "$STATE/wrangler" > /dev/null
npx ghuri createsuperuser --no-input --username editor --email editor@example.com --persist-to "$STATE/wrangler"
npx ghuri shell --persist-to "$STATE/wrangler" -c "
  const user = await User.objects.get({ username: 'editor' })
  const tag = await Tag.objects.create({ name: 'Portability', slug: 'portability' })
  const post = await Post.objects.create({ title: 'Written on D1', slug: 'written-on-d1', body: 'Moved to Postgres.', published: true, author: user })
  await post.tags.add(tag)
  await Post.objects.count()
"

echo "== 2. PostgreSQL (PGlite at \$PGLITE_DIR): migrate + copy"
npx ghuri migrate --database pg --persist-to "$STATE/wrangler" > /dev/null
npx ghuri copydata --from default --to pg --persist-to "$STATE/wrangler"

echo "== 3. Background task on PostgreSQL: enqueue, then ghuri db_worker --batch"
DATABASE_ENGINE=pglite npx ghuri shell --persist-to "$STATE/wrangler" -c "
  const user = await User.objects.get({ username: 'editor' })
  const draft = await Post.objects.create({ title: 'Published by a task', slug: 'published-by-a-task', published: false, author: user })
  const { getTask } = await import('@ghuri/tasks')
  const result = await getTask('blog.publishPost').enqueue(draft.pk)
  result.status
"
DATABASE_ENGINE=pglite npx ghuri db_worker --batch --persist-to "$STATE/wrangler"

echo "== 4. Node + PostgreSQL: serve and read back"
DATABASE_ENGINE=pglite PORT="$PORT" node --import jiti/register src/server.ts > "$STATE/server.log" 2>&1 &
SERVER_PID=$!
curl -s --retry 30 --retry-connrefused --retry-delay 1 "http://127.0.0.1:$PORT/" > /dev/null
BODY="$(curl -s "http://127.0.0.1:$PORT/api/posts/?search=postgres")"
echo "$BODY"
echo "$BODY" | grep -q '"slug":"written-on-d1"' && echo "$BODY" | grep -q '"tags":\["portability"\]'
GQL="$(curl -s -X POST "http://127.0.0.1:$PORT/graphql/" -H 'Content-Type: application/json' \
  -d '{"query":"{ allPosts(filter: { title: { icontains: \"d1\" } }) { totalCount edges { node { slug author { username } } } } }"}')"
echo "$GQL"
echo "$GQL" | grep -q '"slug":"written-on-d1"' && echo "$GQL" | grep -q '"username":"editor"'
TOKEN="$(curl -s -X POST "http://127.0.0.1:$PORT/api/auth/token/" -H 'Content-Type: application/json' \
  -d "{\"username\":\"editor\",\"password\":\"$GHURI_SUPERUSER_PASSWORD\"}" | sed 's/.*"token":"\([^"]*\)".*/\1/')"
STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/posts/" \
  -H "Authorization: Token $TOKEN" -H 'Content-Type: application/json' -d '{"title":"Written on Node","slug":"written-on-node"}')"
test "$STATUS" = 201
TASKED="$(curl -s "http://127.0.0.1:$PORT/api/posts/?search=task")"
echo "$TASKED"
echo "$TASKED" | grep -q '"slug":"published-by-a-task"'
echo "OK: data written on D1 is served by Node + PostgreSQL (REST and GraphQL), the same password logs in, and a task run by db_worker published a post."
