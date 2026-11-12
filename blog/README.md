# blog — the Ghuri example project

A small but complete [Ghuri](https://github.com/ghurijs/ghuri) project: a blog REST and GraphQL API with an admin,
an AI agent and an MCP server, running on **Cloudflare Workers (D1 + R2)** and — with the same code — on **Node.js with
PostgreSQL**. It was generated with the real CLI (`ghuri startproject blog` + `ghuri startapp blog`) and then
filled in.

| | Where |
|---|---|
| Models: `Post` (author FK → user, tags M2M, cover `ImageField`, timestamps), `Tag`, `Comment` | [`src/blog/models.ts`](src/blog/models.ts) |
| Migrations (written by `ghuri makemigrations blog`) | [`src/blog/migrations/`](src/blog/migrations) |
| Serializers, viewsets (permissions, search, ordering, filters, pagination, a `@action`) | [`src/blog/serializers.ts`](src/blog/serializers.ts), [`src/blog/views.ts`](src/blog/views.ts), [`src/blog/permissions.ts`](src/blog/permissions.ts) |
| GraphQL: `PostType` / `TagType` / `CommentType` (Relay nodes, filters, ordering), `BlogQuery`, `createPost` / `updatePost` (`SerializerMutation` over `PostSerializer` + `IsAuthorOrReadOnly`), `deletePost` (`ModelMutation`) | [`src/blog/schema.ts`](src/blog/schema.ts), [`src/schema.ts`](src/schema.ts) |
| Admin: list filters, search, date hierarchy, comment inline, actions, prepopulated slug | [`src/blog/admin.ts`](src/blog/admin.ts) |
| `SupportAgent` (`ModelTools(Post)` + `RouterTools`), `AgentRouter`, MCP endpoint | [`src/blog/agents.ts`](src/blog/agents.ts), [`src/urls.ts`](src/urls.ts) |
| Settings: D1 / PostgreSQL / PGlite, R2 / local disk, token + JWT auth | [`src/settings.ts`](src/settings.ts) |
| Tests (`@ghuri/orm/testing` + `@ghuri/rest/testing` + `@ghuri/graphql/testing`) | [`src/blog/tests.ts`](src/blog/tests.ts) |

## URLs

| URL | |
|---|---|
| `/admin/` | Django-style admin (`npx ghuri createsuperuser` first) |
| `/api/` | API root (`DefaultRouter`): `posts/`, `tags/`, `comments/`; `posts/<slug>/publish/` |
| `/api/auth/token/` | `{username, password}` → `{token}` (use `Authorization: Token …`) |
| `/api/auth/jwt/`, `/api/auth/jwt/refresh/`, `/api/auth/jwt/verify/` | JWT pair (use `Authorization: Bearer …`) |
| `/api/schema/`, `/api/docs/` | OpenAPI 3.1 and Swagger UI |
| `/graphql/` | GraphQL over HTTP (`GET` / `POST`); GraphiQL in the browser when `DEBUG=true` |
| `/agents/support/chat` | The support agent (JSON, or SSE with `?stream=1`); `/agents/support/conversations/` |
| `/mcp/` | MCP (Streamable HTTP): the API tools + `ask_support`, authenticated with a token |
| `/media/<path>` | Uploaded files from the default storage |

## Run it on Cloudflare (locally)

Packages are published under the `next` tag; in the Ghuri workspace they are linked automatically.

```bash
npm install
cp .dev.vars.example .dev.vars        # then set SECRET_KEY
npx ghuri migrate                     # local D1 (wrangler's Miniflare state in .wrangler/state)
npx ghuri createsuperuser             # or: GHURI_SUPERUSER_PASSWORD=… npx ghuri createsuperuser --no-input --username admin --email admin@example.com
npm run dev                           # wrangler dev → http://localhost:8787
```

```bash
TOKEN=$(curl -s -X POST localhost:8787/api/auth/token/ -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"…"}' | jq -r .token)
curl -X POST localhost:8787/api/tags/ -H "Authorization: Token $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Cloudflare","slug":"cloudflare"}'
curl -X POST localhost:8787/api/posts/ -H "Authorization: Token $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Hello","slug":"hello","body":"From Workers","published":true,"tags":["cloudflare"]}'
curl 'localhost:8787/api/posts/?search=hello&ordering=-createdAt&pageSize=5'
curl -X PATCH localhost:8787/api/posts/hello/ -H "Authorization: Token $TOKEN" -F cover=@cover.png   # → R2
curl -X POST localhost:8787/mcp/ -H "Authorization: Token $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### GraphQL

`GraphQLView` at `/graphql/` serves the schema from `GRAPHQL.SCHEMA` (`src/schema.ts`). Open
<http://localhost:8787/graphql/> in a browser for GraphiQL (`DEBUG=true` in `.dev.vars`). Authentication is the
same as the REST API (`GRAPHQL.AUTHENTICATION_CLASSES`): token / JWT clients need no CSRF token; session
`POST`s (GraphiQL while logged in to the admin) send it automatically.

```bash
curl -s localhost:8787/graphql/ -H 'Content-Type: application/json' -d '{"query": "{ allPosts(first: 5, filter: { title: { icontains: \"hello\" } }, orderBy: [\"-createdAt\"]) { totalCount pageInfo { hasNextPage endCursor } edges { node { id title excerpt author { username } tags { edges { node { slug } } } comments { totalCount } } } } }"}'

curl -s localhost:8787/graphql/ -H "Authorization: Token $TOKEN" -H 'Content-Type: application/json' -d '{"query": "mutation ($input: CreatePostInput!) { createPost(input: $input) { id slug authorName errors { field messages } } }", "variables": {"input": {"title": "Via GraphQL", "slug": "via-graphql", "tags": ["cloudflare"], "published": true}}}'
# {"data":{"createPost":{"id":"2","slug":"via-graphql","authorName":"admin","errors":[]}}}
# validation errors come back in `errors` ([{"field":"slug","messages":["Post with this Slug already exists."]}]);
# without credentials: errors[0].extensions.code = "UNAUTHENTICATED".
```

- Queries: `allPosts` (Relay connection: `first` / `after` / `last` / `before`, `filter`, `orderBy`), `allTags`,
  `post(id:)` and `node(id:)` with global IDs (`base64("PostType:1")`), `me`.
- Mutations: `createPost` and `updatePost(input: { id, … })` validate and save through the REST `PostSerializer`;
  `updatePost` / `deletePost` check `IsAuthorOrReadOnly` like the viewset. Cover images are uploaded through REST.
- Drafts are hidden the same way as in the REST API (`PostType.getQueryset`), and only approved comments are
  returned (`CommentType.getQueryset`). Relations are batched (DataLoaders), so nested queries don't cause N+1.
- `npx ghuri graphql_schema --out schema.graphql` writes the SDL (from `GraphQLConfig` in `INSTALLED_APPS`).

### The agent

`DEFAULT_MODEL` is Workers AI. Add `"ai": { "binding": "AI" }` to `wrangler.jsonc` to use it (Workers AI
runs on Cloudflare, so local dev needs `wrangler login`). Without a model the chat answers
`503 {"detail": "The agent's language model is not available."}`.

For offline development there is a fake model (no network, no key) — only registered when `DEBUG=true`:

```bash
npx ghuri runserver -- --var AGENT_MODEL:fake:blog      # or AGENT_MODEL=fake:blog in .dev.vars
curl -X POST localhost:8787/agents/support/chat -H "Authorization: Token $TOKEN" \
  -H 'Content-Type: application/json' -d '{"message":"Which posts are there?"}'
# {"conversationId":"…","text":"I can see 1 post(s): Hello.","toolCalls":[{"toolName":"posts_list",…}],…}
```

Connect Claude Code to the MCP endpoint:
`claude mcp add --transport http blog http://localhost:8787/mcp/ --header "Authorization: Token $TOKEN"`.

### Deploy

```bash
npx wrangler d1 create blog-db          # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create blog-media
npx wrangler secret put SECRET_KEY
npx ghuri deploy --migrate              # ghuri migrate --remote, then wrangler deploy
```

## Move it to PostgreSQL on Node — same code

`src/settings.ts` picks the backends from the environment; nothing in `src/blog/` changes:

| Environment | `DATABASES.default` | `STORAGES.default` |
|---|---|---|
| Cloudflare (`env.DB`, `env.MEDIA` bindings) | `d1('DB')` | `r2('MEDIA')` |
| `DATABASE_URL=postgres://…` | `postgres({ url })` | local disk (`MEDIA_ROOT`) — or `s3({...})` |
| `DATABASE_ENGINE=pglite` | PGlite (PostgreSQL in-process, `PGLITE_DIR`) | local disk |

A second alias, `pg`, always points at PostgreSQL (`DATABASE_URL`, else PGlite in `.data/pglite`), so you can
move the data while the default is still D1:

```bash
npx ghuri migrate --database pg                  # create the schema in PostgreSQL
npx ghuri copydata --from default --to pg        # copy every row from local D1 (or --remote D1)
# equivalent: npx ghuri dumpdata > data.json && npx ghuri loaddata data.json --database pg

DATABASE_ENGINE=pglite SECRET_KEY=… npm start    # Node server (src/server.ts) on PostgreSQL
# with a real server: DATABASE_URL=postgres://user:pw@host/blog SECRET_KEY=… npm start
curl localhost:8000/api/posts/                   # the same posts, users, passwords and tokens
```

`bash scripts/portability.sh` runs exactly this end to end (fresh D1 → PGlite → Node → REST and GraphQL checks).
Files in R2 are not copied by `copydata`; copy the bucket with `rclone` / `aws s3 sync` (R2 has an S3 API) or point
`STORAGES` at R2 through `s3({...})` from Node.

## Tests

```bash
npx ghuri test                       # D1 (Miniflare) test database
GHURI_TEST_DB=pglite npx ghuri test  # PostgreSQL semantics
```

The tests use the real settings and migrations (like Django's test runner), the `APIClient` from
`@ghuri/rest/testing`, `graphqlQuery()` from `@ghuri/graphql/testing`, `forceLogin` for the admin, the offline
model for the agent and in-memory storage.

## Notes

- Decorators (`@action`, `@admin.register`, `@display`, `@tool`) work under `wrangler dev` / `wrangler deploy`
  (esbuild, standard decorators), under `ghuri` commands and `npm start` (jiti), and in tests
  (`vitest.config.ts` enables oxc's legacy decorators). Each also has a decorator-free form.
- PGlite is imported lazily with a non-literal specifier in `src/settings.ts`, so it never ends up in the
  Worker bundle.
