# Ghuri examples

Example projects for [Ghuri](https://github.com/ghurijs/ghuri) — Django for TypeScript on Cloudflare Workers
(Hono + Drizzle + D1 + R2), portable to PostgreSQL / Node. They double as the end-to-end tests of the
framework: CI installs the published `@ghuri/*` packages (`next` tag) and runs every project.

| Project | Shows |
|---|---|
| [`blog/`](blog) | Models with FK / M2M / `ImageField`, migrations, a DRF-style API (token + JWT auth, permissions, search, ordering, filters, pagination, `@action`), OpenAPI + Swagger UI, the admin (filters, inlines, actions), an AI agent built from the API, an MCP server, and the same code on Node + PostgreSQL (`copydata` from D1). |

## Running an example

```bash
cd blog
npm install
npx ghuri migrate
npx ghuri createsuperuser
npm run dev            # wrangler dev
npx ghuri test         # vitest
```

Each project's README has the details. Inside the Ghuri development workspace (`ghurijs/ghuri`, which clones this
repository into `examples/`), the `@ghuri/*` packages resolve to the local clones through npm workspaces.

## Starting your own

```bash
npm create ghuri@latest mysite      # or: npx @ghuri/cli@next startproject mysite
cd mysite && npx ghuri startapp blog
```

## License

MIT
