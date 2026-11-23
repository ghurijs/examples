// Test harness for agentdesk: the real project settings (src/settings.ts) on a fresh test database, with the
// external services replaced by in-process fakes — no network, no keys:
//
//   GHURI_TEST_DB=d1 (default)  D1 (Miniflare) + vectorize() over a fake Vectorize binding (as on Workers)
//   GHURI_TEST_DB=pglite        PostgreSQL (PGlite) + pgvector() with the pgvector extension (as on Node)
//   GHURI_TEST_DB=sqlite        SQLite + databaseStore()
//
// Stripe is @ghuri/billing's fakeStripe(); the agent model and the embeddings are the offline fakes of
// src/support/fake-model.ts and src/knowledge/fake-embedding.ts. Tasks use the settings' database() backend, so
// tests drain them with runWorker() like `ghuri db_worker` would.
import { PBKDF2PasswordHasher, Token, User } from '@ghuri/auth'
import { fakeStripe, type FakeStripe } from '@ghuri/billing/testing'
import { clearEntitlementsCache, syncProductsAndPrices } from '@ghuri/billing'
import { caches, createApp, type Env, type GhuriContext, tryGetContext } from '@ghuri/core'
import { connections, type DatabaseConfig } from '@ghuri/orm'
import {
  emitPostMigrate,
  migrateOrCreateTables,
  setupTestDatabase,
  type TestBackend,
  type TestDatabase,
} from '@ghuri/orm/testing'
import { APIClient } from '@ghuri/rest/testing'
import { memoryStorage } from '@ghuri/storage'
import { runWorker } from '@ghuri/tasks'
import { runAsTenant, withoutTenant } from '@ghuri/tenants'
import { vectorStores } from '@ghuri/vectors'
import { type FakeVectorize, fakeVectorize } from '@ghuri/vectors/testing'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import settings from '../src/settings'
import { registerFakeEmbeddings } from '../src/knowledge/fake-embedding'
import { registerFakeProvider } from '../src/support/fake-model'
import { Membership, Workspace } from '../src/workspaces/models'

export const using = (process.env.GHURI_TEST_DB as TestBackend | undefined) ?? 'd1'

/** A PGlite database with the pgvector extension as DATABASES.default, migrated. */
async function setupPgvectorDatabase(ctx: GhuriContext): Promise<TestDatabase> {
  const [{ PGlite, types }, { vector }, { PGliteConnection }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('@electric-sql/pglite-pgvector'),
    import('@ghuri/orm/pglite'),
  ])
  const pg = new PGlite({ extensions: { vector }, parsers: { [types.INT8]: (v: string) => Number(v) } })
  await pg.waitReady
  await pg.exec('CREATE EXTENSION IF NOT EXISTS vector')
  const conn = new PGliteConnection(pg)
  conn.alias = 'default'
  const config: DatabaseConfig = { vendor: 'pglite', dialect: 'postgresql', connect: () => conn, options: { test: true } }
  const previous = ctx.settings.DATABASES
  ctx.settings.DATABASES = { ...(previous ?? {}), default: config }
  connections.reset('default')
  const { apps } = await import('@ghuri/core')
  const models = apps.getModels() as any[]
  await migrateOrCreateTables(conn, models)
  return {
    alias: 'default',
    using: 'pglite',
    connection: conn,
    models,
    async flush() {
      const rows = (await conn.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows
      const tables = rows
        .map((r: any) => String(r.tablename))
        .filter((t) => t !== 'ghuri_migrations' && t !== 'django_migrations')
      if (tables.length) await conn.execute(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`)
      await emitPostMigrate('default')
    },
    async teardown() {
      connections.reset('default')
      await conn.close()
      ctx.settings.DATABASES = previous
    },
  }
}

export interface Harness {
  app: ReturnType<typeof createApp>
  env: Env
  ctx: GhuriContext
  db: TestDatabase
  api: APIClient
  stripe: FakeStripe
}

/** The project's app with fakes, a fresh database per file, flushed before each test. */
export function useHarness(): Harness {
  const h = {} as Harness
  beforeAll(async () => {
    registerFakeProvider()
    registerFakeEmbeddings()
    const stripe = fakeStripe()
    h.env = {
      SECRET_KEY: 'test-secret-key',
      DEBUG: 'false',
      AGENT_MODEL: 'fake:agentdesk',
      EMBEDDING_MODEL: 'fake:agentdesk',
      EMBEDDING_DIMENSIONS: '256',
      STRIPE_SECRET_KEY: stripe.secretKey,
      STRIPE_WEBHOOK_SECRET: stripe.webhookSecret,
      // Generous request rates; the throttling test lowers one.
      THROTTLE_ANON: '1000/min',
      THROTTLE_USER: '1000/min',
      THROTTLE_UPLOADS: '1000/min',
      THROTTLE_AGENT: '1000/min',
      THROTTLE_LOGIN: '1000/min',
      // D1 runs like Workers: vectorize() over an in-memory Vectorize binding. PGlite runs like Node: pgvector().
      ...(using === 'd1' ? { VECTORIZE: fakeVectorize({ dimensions: 256 }) } : {}),
      ...(using === 'pglite' ? { DATABASE_ENGINE: 'pglite' } : {}),
    }
    h.app = createApp(settings)
    h.ctx = await h.app.setup(h.env)
    h.ctx.settings.PASSWORD_HASHERS = [new PBKDF2PasswordHasher({ iterations: 1000 })]
    h.ctx.settings.STORAGES = { default: memoryStorage() }
    ;(h.ctx.settings.BILLING as any).PROVIDER = stripe.provider()
    h.stripe = stripe
    h.db = using === 'pglite' ? await setupPgvectorDatabase(h.ctx) : await setupTestDatabase({ using })
    if (using === 'pglite') await vectorStores.get().setup?.() // `ghuri createvectortable`
    h.api = new APIClient(h.app, { env: h.env, defaultFormat: 'json' })
  }, 120_000)
  afterAll(async () => {
    await h.db?.teardown()
  })
  beforeEach(async () => {
    await h.db.flush()
    if (using === 'pglite') await vectorStores.get().setup?.()
    ;(h.env.VECTORIZE as FakeVectorize | undefined)?.vectors.clear() // the fake index outlives the database flush
    await caches.get('default').clear() // throttle history
    clearEntitlementsCache()
    h.stripe.reset()
    h.api.forceAuthenticate(null)
    h.api.credentials()
    h.api.client.clearCookies()
  })
  return h
}

export async function makeUser(username: string): Promise<User> {
  return User.objects.createUser(username, `${username}@example.com`, `pw-${username}`)
}

export async function tokenFor(user: User): Promise<string> {
  const [token] = await Token.objects.getOrCreate({ user })
  return (token as Token).key
}

/** A workspace with its members (`{ user, role }`). */
export async function makeWorkspace(
  slug: string,
  members: { user: User; role?: 'owner' | 'member' }[] = [],
): Promise<Workspace> {
  const ws = await Workspace.objects.create({ name: slug.toUpperCase(), slug })
  await runAsTenant(ws, async () => {
    for (const m of members) await Membership.objects.create({ user: m.user, role: m.role ?? 'member' })
  })
  return ws
}

/** Request headers for `user` in `workspace`. */
export async function as(user: User, workspace?: Workspace | string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Authorization: `Token ${await tokenFor(user)}` }
  if (workspace) headers['X-Workspace'] = typeof workspace === 'string' ? workspace : workspace.slug
  return headers
}

/** Upload a text document and run the queued embedding task. Returns the document's JSON. */
export async function upload(
  h: Harness,
  headers: Record<string, string>,
  name: string,
  text: string,
  opts: { drain?: boolean; title?: string } = {},
) {
  const file = new File([text], name, { type: 'text/plain' })
  const res = await h.api.post(
    '/api/documents/',
    { file, ...(opts.title ? { title: opts.title } : {}) },
    { format: 'multipart', headers },
  )
  if (opts.drain !== false) await drain()
  return res
}

/** Run every queued task (`ghuri db_worker --batch`). */
export async function drain(): Promise<number> {
  return (await runWorker({ batch: true })).processed
}

/** Products and prices for the plans in src/settings.ts, in the fake Stripe and synced locally. */
export async function seedStripe(h: Harness) {
  const product = h.stripe.createProduct({ name: 'agentdesk Pro' })
  const monthly = h.stripe.createPrice({ product: product.id, unit_amount: 2900, lookup_key: 'agentdesk_pro_monthly' })
  const yearly = h.stripe.createPrice({
    product: product.id,
    unit_amount: 29000,
    lookup_key: 'agentdesk_pro_yearly',
    recurring: { interval: 'year' },
  })
  await syncProductsAndPrices()
  return { product, monthly, yearly }
}

/** POST a signed Stripe event to the webhook (no X-Workspace: Stripe sends none). */
export async function deliver(h: Harness, event: Record<string, unknown>, opts: { secret?: string } = {}) {
  const { body, headers } = await h.stripe.webhook(event, opts)
  return h.api.client.post('/billing/webhook/', { body, headers, csrf: false } as any)
}

export { runAsTenant, tryGetContext, withoutTenant }
