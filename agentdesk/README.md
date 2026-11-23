# agentdesk — a multi-tenant AI support desk on Ghuri

A reference SaaS built with [Ghuri](https://github.com/ghurijs/ghuri) that uses every piece an AI-agent product
needs, together: **workspaces** (tenants), members who **upload documents**, a **support agent that answers from
those documents** (RAG), and **plans that cap each workspace's agent tokens** (Stripe). The same code runs on
**Cloudflare Workers + D1 + R2 + Queues + Vectorize + Workers AI** and on **Node + PostgreSQL + pgvector**.

It exists to prove the framework works as a whole, and the list of bugs it found is in [Findings](#findings).

| Package | Used for | Where |
|---|---|---|
| `@ghuri/tenants` | `Workspace` is the tenant; `X-Workspace: <slug>` header; `TENANTS.REQUIRED: true` | [`src/workspaces/models.ts`](src/workspaces/models.ts), [`src/workspaces/middleware.ts`](src/workspaces/middleware.ts) |
| `@ghuri/auth` | token login (throttled), sessions for the admin | [`src/workspaces/views.ts`](src/workspaces/views.ts) |
| `@ghuri/rest` | workspaces, members, documents APIs; membership permissions; DRF throttling | [`src/workspaces/permissions.ts`](src/workspaces/permissions.ts), [`src/knowledge/views.ts`](src/knowledge/views.ts) |
| `@ghuri/storage` | uploads (`FileField`) in R2 / on disk | [`src/knowledge/models.ts`](src/knowledge/models.ts) |
| `@ghuri/tasks` | `knowledge.embedDocument` (chunk + embed an upload), `agents.run` (background questions) | [`src/knowledge/tasks.ts`](src/knowledge/tasks.ts) |
| `@ghuri/vectors` | the per-workspace `knowledge.documents` index: Vectorize / pgvector / D1 | [`src/knowledge/vectors.ts`](src/knowledge/vectors.ts) |
| `@ghuri/agents` | `SupportAgent` with `searchTool()`, tenant-scoped conversation memory (`support.Conversation`), SSE streaming, `enqueue()`, usage limits | [`src/support/`](src/support) |
| `@ghuri/billing` | Stripe checkout / portal / webhook; workspaces are the subscribers; `usageLimits('agentTokens')` | [`src/settings.ts`](src/settings.ts), [`src/workspaces/billing.ts`](src/workspaces/billing.ts) |
| `@ghuri/admin` | workspaces, documents, plus the agents / billing / tasks admins | [`src/workspaces/admin.ts`](src/workspaces/admin.ts) |

Plans (`BILLING.PLANS` in [`src/settings.ts`](src/settings.ts)):

| Plan | Agent tokens | Documents | Price |
|---|---|---|---|
| `free` (default) | 20,000 / day, 200,000 / month | 20 | — |
| `pro` | 1,000,000 / day, 10,000,000 / month | 1,000 | `agentdesk_pro_monthly`, `agentdesk_pro_yearly` (Stripe lookup keys) |

## API

Workspace routes need `X-Workspace: <slug>` (404 without it: `TENANTS.REQUIRED`) and membership (403 otherwise).
Authenticate with `Authorization: Token <key>`.

| | Workspace | |
|---|---|---|
| `POST /api/auth/token/` | — | `{username, password}` → `{token}` (throttled: `login` rate) |
| `GET, POST /api/workspaces/` | — | your workspaces; create one (you become its owner) |
| `GET /api/workspace/` | ✓ | the workspace, its plan, features, limits and token usage |
| `GET, POST /api/members/`, `DELETE /api/members/<id>/` | ✓ | members; owners add (`{username, role}`) and remove |
| `GET, POST /api/documents/`, `GET, DELETE /api/documents/<id>/` | ✓ | upload a text file (multipart `file`, optional `title`): `.txt .md .markdown .csv .json .html`, ≤ 1 MB, `uploads` rate |
| `POST /api/documents/<id>/reindex/` | ✓ | embed again (unchanged documents are skipped by the vectors manifest) |
| `POST /agents/support/chat` | ✓ | ask the agent: `{message, conversationId?}` → JSON, or SSE with `?stream=1` (AI SDK UI message stream) |
| `GET, DELETE /agents/support/conversations/[<id>/]` | ✓ | your conversations in this workspace, with messages |
| `POST /api/ask/`, `GET /api/ask/<task>/` | ✓ | ask in the background (`agent.enqueue()` → 202 `{conversationId, task}`), then poll |
| `GET /agents/usage/` | ✓ | token usage and limits (user and workspace windows) |
| `POST /billing/checkout/`, `POST /billing/portal/` | ✓ (owners) | Stripe Checkout `{plan: 'pro', interval?}` / Customer Portal → `{id?, url}` |
| `POST /billing/webhook/` | — | Stripe webhook (signed; carries no workspace) |
| `/admin/` | — | admin (all workspaces) · `/api/docs/` Swagger UI · `/api/schema/` OpenAPI |

```bash
TOKEN=$(curl -s -X POST localhost:8787/api/auth/token/ -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"…"}' | jq -r .token)
curl -X POST localhost:8787/api/workspaces/ -H "Authorization: Token $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Acme","slug":"acme"}'
curl -X POST localhost:8787/api/documents/ -H "Authorization: Token $TOKEN" -H 'X-Workspace: acme' -F file=@refunds.md
curl -X POST localhost:8787/agents/support/chat -H "Authorization: Token $TOKEN" -H 'X-Workspace: acme' \
  -H 'Content-Type: application/json' -d '{"message":"How long do refunds take?"}'
```

How a question is answered: the upload is saved to storage and `knowledge.embedDocument` is enqueued after commit;
the task reads the file, chunks it (800 characters, 120 overlap) and embeds it into the workspace's namespace of
`knowledge.documents` (the tenant comes from the carried task context). The agent's `search_knowledge_documents`
tool searches that namespace only; every run is checked against the workspace's plan before it starts and counted
after it ends (`agents_usage`). Over the budget, chat answers `429` with `Retry-After`, and `enqueue()` refuses
before anything is queued.

## Run it offline (no Cloudflare account, no API keys)

```bash
npm install                      # in the Ghuri workspace: npm install at the repository root
cp .dev.vars.example .dev.vars   # then set SECRET_KEY; AGENT_MODEL / EMBEDDING_MODEL=fake:agentdesk are offline fakes
npx ghuri migrate
npx ghuri createsuperuser
npm run dev                      # wrangler dev → http://localhost:8787
```

With `DEBUG=true`, `fake:agentdesk` is an offline model that searches the documents and quotes the best passage
([`src/support/fake-model.ts`](src/support/fake-model.ts)), and an offline bag-of-words embedder
([`src/knowledge/fake-embedding.ts`](src/knowledge/fake-embedding.ts)). `wrangler dev` needs a Cloudflare login for
the Workers AI and Vectorize bindings (they are always remote); remove them from `wrangler.jsonc` to stay fully
offline: the settings then use `databaseStore()` (exact search in D1).

## Deploy on Cloudflare Workers

```bash
npx wrangler login
npx wrangler d1 create agentdesk-db                    # paste the database_id into wrangler.jsonc
npx wrangler r2 bucket create agentdesk-media
npx wrangler queues create agentdesk-tasks
npx wrangler vectorize create agentdesk-documents --dimensions=768 --metric=cosine   # bge-base-en-v1.5
npx wrangler secret put SECRET_KEY
npx wrangler secret put STRIPE_SECRET_KEY              # sk_test_… first
npx wrangler secret put STRIPE_WEBHOOK_SECRET          # the endpoint's whsec_…
npx ghuri deploy --migrate                             # remote migrations, then wrangler deploy
npx ghuri billing_sync --remote                        # import the Stripe products and prices
```

Bindings ([`wrangler.jsonc`](wrangler.jsonc)): `DB` (D1), `MEDIA` (R2), `TASKS_QUEUE` (Queues producer and consumer,
`max_retries: 3`), `VECTORIZE` (Vectorize, `@cf/baai/bge-base-en-v1.5`, 768 dimensions), `AI` (Workers AI: the
agent's model `@cf/meta/llama-3.3-70b-instruct-fp8-fast` and the embeddings). Optional `CACHE` (KV) keeps throttle
history across isolates. In Stripe, add a webhook endpoint `https://<worker>/billing/webhook/` with
`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.*`, `customer.subscription.*`,
`product.*`, `price.*`, `invoice.*`.

## Run it on Node + PostgreSQL

The database needs the [pgvector](https://github.com/pgvector/pgvector) extension.

```bash
export DATABASE_URL=postgres://user:pass@host:5432/agentdesk SECRET_KEY=… OPENAI_API_KEY=…   # embeddings
export AGENT_MODEL=anthropic:claude-sonnet-5-5 ANTHROPIC_API_KEY=…   # or openai:…, or fake:agentdesk with DEBUG=true
export STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRET=whsec_…
npx ghuri migrate
npx ghuri createvectortable                  # CREATE EXTENSION vector + the vectors_pgembedding table and HNSW index
npm start                                    # src/server.ts on :8000
npm run worker                               # ghuri db_worker: embedding and background runs (a second process)
```

Without a Postgres server, `DATABASE_ENGINE=pglite` uses PostgreSQL in-process (PGlite with pgvector, data in
`PGLITE_DIR`); PGlite is one process per data directory, so run the worker while the server is stopped.
`EMBEDDING_MODEL` picks any embedding model (`openai:text-embedding-3-large`, an OpenAI-compatible API through
`OPENAI_BASE_URL`, `workers-ai:…`); set `EMBEDDING_DIMENSIONS` for models Ghuri does not know.

## Stripe test mode

Tests use `@ghuri/billing`'s in-memory fake Stripe. To check the real Stripe adapter against your **test** account:

```bash
STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRET=whsec_… npm run stripe:check
```

[`scripts/stripe-check.ts`](scripts/stripe-check.ts) reads the keys from the environment (or the git-ignored
`.dev.vars`), refuses anything but a test-mode key and never prints them. It creates the plan prices when missing
(idempotent), lists them through the adapter, creates a customer and a Checkout Session (open the printed URL and pay
with `4242 4242 4242 4242`), opens a portal session, verifies webhook signatures with your secret, and deletes the
customer. For real webhooks: `stripe listen --forward-to localhost:8787/billing/webhook/`.

## Tests

```bash
npx ghuri test                         # D1 (Miniflare) + vectorize() over a fake Vectorize binding — as on Workers
GHURI_TEST_DB=pglite npx ghuri test    # PostgreSQL (PGlite) + pgvector() with the real extension — as on Node
GHURI_TEST_DB=sqlite npx ghuri test    # SQLite + databaseStore()
npx ghuri check && npx ghuri makemigrations --check && npm run typecheck
node scripts/workerd-smoke.mjs         # the real Worker bundle in workerd: D1, R2, Queues consumer, webhook
bash scripts/node-smoke.sh             # the real Node server + PGlite/pgvector + ghuri db_worker
```

28 tests in [`tests/`](tests), on all three backends: upload → embed → ask (JSON, SSE, memory, background,
re-index, delete) in [`rag.test.ts`](tests/rag.test.ts); token and document limits (429 / `Retry-After`, per
workspace, queued runs over budget) in [`limits.test.ts`](tests/limits.test.ts); tenant isolation of documents,
vectors, conversations and background results in [`isolation.test.ts`](tests/isolation.test.ts); checkout, the
webhook under `TENANTS.REQUIRED`, upgrade and cancellation in [`billing.test.ts`](tests/billing.test.ts); login,
workspaces, members, admin and throttling in [`platform.test.ts`](tests/platform.test.ts). The model, embeddings and
Stripe are in-process fakes ([`tests/helpers.ts`](tests/helpers.ts)): no network, no keys.

## Findings

Framework bugs and rough edges found while building this app, against the published packages (tenants
0.1.0-alpha.4, billing 0.1.0-alpha.1, agents 0.1.0-alpha.6, tasks 0.1.0-alpha.0, vectors 0.1.0-alpha.0, core
0.1.0-alpha.5, orm 0.1.0-alpha.6, auth 0.1.0-alpha.4, rest 0.1.0-alpha.2). None is fixed here; the app works around
each one and says so in a comment. Fixed since in the packages: finding 1 (`@ghuri/tasks` 0.1.0-alpha.1, which this
app now requires).

### Bugs

1. **Fixed in `@ghuri/tasks` 0.1.0-alpha.1 — a Worker that imports `@ghuri/tasks` did not start (critical).**
   `backends/cloudflare.ts`, `dummy.ts` and `immediate.ts` ran `const WORKER_ID = newWorkerId()` at module scope,
   and `newWorkerId()` calls `crypto.getRandomValues()`, which workerd forbids outside a handler: *"Disallowed
   operation called within global scope … generating random values are not allowed within global scope"*.
   `examples/blog` and every `startproject` app failed the same way. The id is now made on first use, and the
   package has a workerd test with a real Miniflare Queue (ghurijs/tasks#3). New projects get it from
   `@ghuri/cli` 0.1.0-alpha.8.
2. **agents — `UsageLimitExceeded` from `enqueue()` / `run()` in an app view is a 500.** Only the agents' own views
   map it (`modelCallError()`); it is not an HTTP error and no exception handler is registered, so a project view
   that calls `agent.enqueue()` answers 500 when the plan's budget is spent. Repro: `POST /api/ask/` over budget
   without the `try/catch` in [`src/support/views.ts`](src/support/views.ts). Fix: register an exception handler
   (`registerExceptionHandler(UsageLimitExceeded, …)` → `usageThrottled()`) in `AgentsConfig.ready()`, or make it a
   `Throttled` subclass.
3. **agents (security) — password hashes in logs.** `UsageLimitExceeded.subject.user` is the full user instance.
   Anything that inspects the error prints it, including `@ghuri/tasks`' retry log
   (`console.warn('[ghuri.tasks] agents.run … attempt 1/3 failed; …', error)` prints `user: User { password:
   'pbkdf2_sha256$…' }`). Repro: `GHURI_TEST_DB=sqlite npx vitest run tests/limits.test.ts --silent=false | grep
   pbkdf2`. Fix: keep only `{ scope, key }` (and the user's pk) on the error, or make `user` non-enumerable; consider
   an `[inspect.custom]` on `AbstractBaseUser` that omits `password`.
4. **auth — token login and the JWT views are not throttled.** `ObtainAuthTokenView`, `TokenObtainPairView`,
   `TokenRefreshView`, `TokenVerifyView` and `TokenBlacklistView` extend a plain core `View` (`TokenEndpoint`), so
   `REST_FRAMEWORK.DEFAULT_THROTTLE_CLASSES` never reaches them; in DRF, `ObtainAuthToken` is an `APIView` and is
   throttled. Password guessing is unlimited. Repro: an app with `DEFAULT_THROTTLE_CLASSES: [AnonRateThrottle]`,
   `anon: '2/min'`, routing `obtainAuthToken` and an `APIView`: four POSTs answer 400, 400, 400, 400 on the token
   view and 200, 200, 429, 429 on the `APIView`. Workaround: [`LoginView`](src/workspaces/views.ts) (an `APIView` with a
   `login` scope) wraps it. Fix: make `TokenEndpoint` an `APIView` (or run the configured throttles in it).
5. **tenants — `tenantNotRequired()` silently does nothing on a View class, an `include()` or the admin.** It marks
   the object it is given, and `View.asView()` copies only the CSRF / X-Frame-Options markers, so
   `path('healthz/', tenantNotRequired(HealthView))` still answers 404 under `TENANTS.REQUIRED`
   (`tenantNotRequired(HealthView.asView())` works). A list of patterns or `include()` cannot be marked at all, and
   `admin.site.urls` is a lazy Proxy whose views do not exist when `urls.ts` runs. Repro: a three-route app with
   `path('a/', tenantNotRequired(Health))`, `path('b/', tenantNotRequired(Health.asView()))`,
   `path('c/', tenantNotRequired(fn))` answers 404 / 200 / 200. Workarounds: `platform()` in
   [`src/urls.ts`](src/urls.ts) walks patterns, and [`WorkspaceMiddleware`](src/workspaces/middleware.ts) exempts
   `/admin/` by path. Fix: copy the marker in `asView()` (like `csrfExempt`), accept `include()` results, and/or add
   a `TENANTS.NOT_REQUIRED_PATHS` setting; at least throw when given something it cannot mark.
6. **tenants + admin — a tenant-scoped model's changelist is a 500 (`TenantNotSet`).** The admin has no tenant, so
   `/admin/knowledge/document/` fails closed with an unhandled error. (Admin integration is listed as "not yet" in
   §14; this is what it costs today.) Workaround: `WorkspaceMiddleware` runs `/admin/` inside `withoutTenant()`.
   Fix: have tenant-scoped `ModelAdmin`s read through `unscoped` / `withoutTenant()` for superusers, and show the
   tenant column.
7. **vectors — deleting a tenant leaves its vectors behind.** The vectors and the `vectors_vectordocument` manifest
   are keyed by the tenant pk in a namespace string, with no foreign key, so deleting a workspace cascades its rows but
   keeps its embeddings and chunk text (in Vectorize metadata, `vectors_pgembedding` or `vectors_vectorembedding`).
   That is a data-retention problem (a deleted customer's documents stay searchable to anyone who can reach that
   namespace, and stay stored). Workaround: a `preDelete` receiver on `Workspace` in
   [`src/knowledge/app.ts`](src/knowledge/app.ts) runs `documents.clear()` as the workspace. Fix: let tenants signal
   deletion (or document the receiver) and offer `clear_index --tenant` for every index at once.

### Rough edges

8. **orm — no PGlite extensions.** `pglite({ dataDir })` and `setupTestDatabase({ using: 'pglite' })` take no
   `extensions`, so pgvector on PGlite (which `@ghuri/vectors` documents as supported) needs a hand-built
   `PGliteConnection` in settings ([`pgliteWithVector()`](src/settings.ts)) and tests (`setupPgvectorDatabase()` in
   [`tests/helpers.ts`](tests/helpers.ts), copied from vectors' own test helper). Fix: `pglite({ extensions,
   setup: 'CREATE EXTENSION …' })` and the same on `setupTestDatabase`.
9. **cli — every command sees wrangler's local bindings, the Node server does not.** `ghuri db_worker` (and every
   other command) gets `MEDIA`, `TASKS_QUEUE`, … from wrangler's platform proxy even when the project runs on Node +
   Postgres, so settings written as `env.MEDIA ? r2('MEDIA') : fileSystemStorage(…)` (the blog's and the
   `startproject` template's pattern) pick R2 in the worker and the disk in `node src/server.ts`: the worker cannot
   find uploaded files (`FileNotFoundError`). Repro: `bash scripts/node-smoke.sh` with the `!onPostgres(env)` guard
   removed from `STORAGES` in [`src/settings.ts`](src/settings.ts). Fix: a CLI switch (`--node` / `GHURI_RUNTIME=node`)
   that skips the wrangler bindings, or document the guard.
10. **orm / tasks docs — `onCommit()` must be awaited, and the tasks README does not.** `onCommit()` is async (it
    runs the callback at once outside a transaction). Written Django-style without `await`, as the `@ghuri/tasks`
    README shows (`onCommit(() => notifySubscribers.enqueue(post.pk))`), the enqueue is a floating promise: it works
    on Node, and on Workers it is dropped after the response, so the task is never queued. The docs site has the
    `await`; the README does not. Fix the README; consider returning the callback's result and a lint note.
11. **agents — no typed way to read a background run's result.** `EnqueueResult.taskResultId` says "for
    `getResult()` later", but `agentRunTask()` is typed as a `TaskLike` without `getResult()`, so
    [`AskResultView`](src/support/views.ts) casts to `any`. Fix: `getRunResult(id)` in `@ghuri/agents`, or type
    `getResult` on the interop.
12. **agents — a queued run that is over budget is retried.** A refused `agents.run` attempt is retried twice (with
    backoff) before it ends `FAILED`, though nothing changes until the window resets (known: §22.8 "a way for a task
    to fail without retries"). Tested in `limits.test.ts`.
13. **vectors — `pgvector()` with a custom embedding provider needs `dimensions` even though the `Embedder` knows
    them.** `createvectortable` raises "needs `dimensions` (the embedding model's are not known)" for a
    `registerEmbeddingProvider()` model whose embedder reports `dimensions: 256`. Workaround: `EMBEDDING_DIMENSIONS`.
    Fix: resolve the embedder in `setupSql()` before giving up.
14. **billing — `ghuri check` fails in a fresh checkout without Stripe keys.** `billing.E002` / `E003` are errors even
    with `DEBUG = true`, so a new contributor's `check` fails until they invent placeholders
    (`.dev.vars.example` ships `sk_test_replace_me`). Consider warnings under `DEBUG` and errors with `--deploy`.
15. **tenants — no membership permission.** Every multi-tenant app needs "the user belongs to the request's tenant"
    (listed as "not yet" in §14); this app writes [`IsWorkspaceMember` / `IsWorkspaceOwner`](src/workspaces/permissions.ts)
    and a `BILLING.SUBSCRIBER` that checks ownership itself ([`src/workspaces/billing.ts`](src/workspaces/billing.ts)).
16. **agents — `enqueue()` does not check an explicit `conversationId` up front.** Another user's or workspace's
    conversation id is accepted and queued; the run then fails with `ConversationNotFound` three times. The app
    checks it before enqueueing ([`AskView`](src/support/views.ts)).

### Verified working (beyond the packages' own tests)

- `vectorize()` with tenant namespaces through the real settings, `pgvector()` on PGlite with the extension, and
  `databaseStore()` on SQLite and D1: indexing, digest skip on re-index, delete, search isolation.
- The tenant carried through `@ghuri/tasks` into `knowledge.embedDocument` and `agents.run`, on the database backend
  (Node) and on Cloudflare Queues (workerd smoke test).
- `support.Conversation` swapped in for `agents.Conversation` (tenant-scoped), through chat, SSE, the conversations
  API and queued runs; another workspace's conversation is a 404 everywhere.
- `usageLimits('agentTokens')` from billing as `AGENTS.USAGE_LIMITS.tenant`, refusing JSON, SSE and `enqueue()`;
  the webhook's subscription signals clear the entitlements cache, so an upgrade applies to the next run.
- The billing webhook under `TENANTS.REQUIRED` (no tenant header), forged signatures refused, unknown tenant 404.
- DRF throttling on viewsets and the agents' chat views (`APIView`s).
