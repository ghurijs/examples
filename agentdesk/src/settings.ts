// Project settings (Django's settings.py). `env` holds Worker bindings and vars (wrangler.jsonc, .dev.vars) on
// Cloudflare, or process.env on Node. App code never reads env.DB / env.MEDIA / env.VECTORIZE / Stripe keys:
// databases, storage, vector stores, task queues and the billing provider are chosen here, so the same code runs on
// Workers + D1 + R2 + Queues + Vectorize and on Node + Postgres + pgvector.
import { AdminConfig } from '@ghuri/admin'
import { AgentsConfig } from '@ghuri/agents'
import {
  AuthConfig,
  AuthenticationMiddleware,
  AuthTokenConfig,
  ContentTypesConfig,
  SessionMiddleware,
  SessionsConfig,
} from '@ghuri/auth'
import { SessionAuthentication, TokenAuthentication } from '@ghuri/auth/rest'
import { BillingConfig, stripe, usageLimits } from '@ghuri/billing'
import {
  CommonMiddleware,
  CsrfMiddleware,
  defineSettings,
  type Env,
  kvCache,
  memoryCache,
  SecurityMiddleware,
  XFrameOptionsMiddleware,
} from '@ghuri/core'
import { type DatabaseConfig, d1, postgres } from '@ghuri/orm'
import {
  AnonRateThrottle,
  PageNumberPagination,
  RestFrameworkConfig,
  ScopedRateThrottle,
  UserRateThrottle,
} from '@ghuri/rest'
import { r2 } from '@ghuri/storage'
import { fileSystemStorage } from '@ghuri/storage/fs'
import { cloudflareQueues, database, TasksConfig } from '@ghuri/tasks'
import { HeaderResolver } from '@ghuri/tenants'
import { databaseStore, pgvector, vectorize, VectorsConfig } from '@ghuri/vectors'
import { KnowledgeConfig } from './knowledge/app'
import { SupportConfig } from './support/app'
import { urlpatterns } from './urls'
import { WorkspacesConfig } from './workspaces/app'
import { billingSubscriber } from './workspaces/billing'
import { WorkspaceMiddleware } from './workspaces/middleware'

/**
 * PostgreSQL in-process (PGlite) with the pgvector extension, for running on Node without a Postgres server.
 * Loaded lazily (the specifiers are not literals) so the Worker bundle never includes PGlite.
 */
function pgliteWithVector(dataDir: string): DatabaseConfig {
  let conn: Promise<unknown> | undefined
  return {
    vendor: 'pglite',
    dialect: 'postgresql',
    options: { dataDir },
    async connect() {
      conn ??= (async () => {
        const [{ PGlite, types }, { vector }, { PGliteConnection }] = await Promise.all([
          import(/* @vite-ignore */ ['@electric-sql', 'pglite'].join('/')),
          import(/* @vite-ignore */ ['@electric-sql', 'pglite-pgvector'].join('/')),
          import(/* @vite-ignore */ ['@ghuri', 'orm', 'pglite'].join('/')),
        ])
        const { mkdir } = await import(/* @vite-ignore */ ['node:fs', 'promises'].join('/'))
        await mkdir(dataDir, { recursive: true })
        const pg = new PGlite(dataDir, {
          extensions: { vector },
          parsers: { [types.INT8]: (v: string) => Number(v) },
        })
        await pg.waitReady
        await pg.exec('CREATE EXTENSION IF NOT EXISTS vector')
        return new PGliteConnection(pg)
      })()
      return (await conn) as never
    },
  }
}

/** Running on PostgreSQL (Node, a VPS, Hyperdrive) rather than D1. */
function onPostgres(env: Env): boolean {
  return env.DATABASE_ENGINE === 'pglite' || !!env.DATABASE_URL
}

/**
 * - Cloudflare (default): D1, binding "DB" in wrangler.jsonc.
 * - DATABASE_URL: PostgreSQL with the pgvector extension (a VPS, Neon, RDS, Hyperdrive …).
 * - DATABASE_ENGINE=pglite: PostgreSQL + pgvector in-process (PGlite, data in PGLITE_DIR).
 */
function databases(env: Env): Record<string, DatabaseConfig> {
  if (env.DATABASE_URL) return { default: postgres({ url: env.DATABASE_URL }) }
  if (env.DATABASE_ENGINE === 'pglite') return { default: pgliteWithVector(env.PGLITE_DIR ?? '.data/pglite') }
  return { default: d1('DB') }
}

/**
 * Embedding model: Workers AI on Cloudflare (the "AI" binding), OpenAI (or any OpenAI-compatible API through
 * OPENAI_BASE_URL) elsewhere. EMBEDDING_MODEL overrides it, e.g. `fake:agentdesk` offline with DEBUG=true.
 */
function embeddingModel(env: Env): string {
  if (env.EMBEDDING_MODEL) return String(env.EMBEDDING_MODEL)
  return onPostgres(env) ? 'openai:text-embedding-3-small' : 'workers-ai:@cf/baai/bge-base-en-v1.5'
}

/**
 * Vector store: Vectorize on Workers (binding "VECTORIZE"), pgvector on Postgres (`npx ghuri createvectortable`),
 * and the database store (exact search in D1) for local `wrangler dev` without a remote Vectorize index.
 */
function vectorStores(env: Env) {
  const embedding = embeddingModel(env)
  // pgvector needs the vector size up front for `vector(n)`; it is known for built-in models, else EMBEDDING_DIMENSIONS.
  const dimensions = env.EMBEDDING_DIMENSIONS ? Number(env.EMBEDDING_DIMENSIONS) : undefined
  if (onPostgres(env)) return { default: pgvector({ database: 'default', embedding, dimensions }) }
  if (env.VECTORIZE) return { default: vectorize('VECTORIZE', { embedding }) }
  return { default: databaseStore({ database: 'default', embedding }) }
}

export const settings = defineSettings((env) => ({
  SECRET_KEY: env.SECRET_KEY,
  DEBUG: env.DEBUG === 'true',
  ALLOWED_HOSTS: env.ALLOWED_HOSTS ? String(env.ALLOWED_HOSTS).split(',') : ['*'],

  INSTALLED_APPS: [
    ContentTypesConfig,
    AuthConfig,
    SessionsConfig,
    AuthTokenConfig,
    AdminConfig,
    RestFrameworkConfig,
    TasksConfig,
    VectorsConfig,
    BillingConfig,
    AgentsConfig,
    WorkspacesConfig,
    KnowledgeConfig,
    SupportConfig,
  ],

  MIDDLEWARE: [
    SecurityMiddleware,
    CommonMiddleware,
    // The request's workspace from `X-Workspace: <slug>`; 404 without one (TENANTS.REQUIRED), except for the
    // platform views marked with tenantNotRequired() in src/urls.ts, billing's webhook and /admin/
    // (WorkspaceMiddleware is TenantMiddleware with a path exemption for the admin).
    WorkspaceMiddleware,
    SessionMiddleware,
    CsrfMiddleware,
    AuthenticationMiddleware,
    XFrameOptionsMiddleware,
  ],

  ROOT_URLCONF: urlpatterns,

  DATABASES: databases(env),

  STORAGES: {
    // R2 (binding "MEDIA") on Cloudflare; the local disk on Node + Postgres. Use s3({ … }) for S3 / MinIO.
    // `!onPostgres(env)`: the ghuri CLI passes wrangler's local bindings to every command, so `ghuri db_worker` would
    // see MEDIA while `node src/server.ts` does not, and the two would use different storages.
    default: env.MEDIA && !onPostgres(env)
      ? r2('MEDIA')
      : fileSystemStorage({ location: env.MEDIA_ROOT ?? '.data/media', baseUrl: '/media/' }),
  },
  MEDIA_URL: '/media/',

  CACHES: {
    // Workers KV when the CACHE binding exists (throttle history survives isolates), otherwise in memory.
    default: env.CACHE ? kvCache('CACHE') : memoryCache(),
  },

  TASKS: {
    // Cloudflare Queues on Workers (binding TASKS_QUEUE); on Postgres / Node the tasks wait in the database until
    // `npm run worker` (ghuri db_worker) runs them.
    default:
      env.TASKS_QUEUE && !onPostgres(env)
        ? cloudflareQueues({ queues: { default: 'TASKS_QUEUE' } })
        : database(),
  },

  VECTORS: vectorStores(env),

  TENANTS: {
    MODEL: 'workspaces.Workspace',
    RESOLVERS: [new HeaderResolver({ header: 'X-Workspace', field: 'slug', filter: { isActive: true } })],
    REQUIRED: true,
  },

  AUTH_USER_MODEL: 'auth.User',

  REST_FRAMEWORK: {
    // Token first: API clients get 401 with WWW-Authenticate. Session auth is for the browser (admin).
    DEFAULT_AUTHENTICATION_CLASSES: [TokenAuthentication, SessionAuthentication],
    DEFAULT_PERMISSION_CLASSES: [],
    DEFAULT_PAGINATION_CLASS: PageNumberPagination,
    PAGE_SIZE: 20,
    // Request rates (DRF throttling); the agents' chat views are APIViews and get these too. Token budgets per
    // plan are separate: AGENTS.USAGE_LIMITS below.
    DEFAULT_THROTTLE_CLASSES: [AnonRateThrottle, UserRateThrottle, ScopedRateThrottle],
    DEFAULT_THROTTLE_RATES: {
      anon: env.THROTTLE_ANON ?? '30/min',
      user: env.THROTTLE_USER ?? '120/min',
      uploads: env.THROTTLE_UPLOADS ?? '20/hour',
      agent: env.THROTTLE_AGENT ?? '30/min',
      login: env.THROTTLE_LOGIN ?? '10/min',
    },
  },

  BILLING: {
    // Keys come from the environment only (.dev.vars / `wrangler secret put` / the process environment).
    PROVIDER: stripe({
      secretKey: env.STRIPE_SECRET_KEY ?? '',
      webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
    }),
    // Workspaces pay, not users: the subscriber is the request's workspace, and only its owners may buy.
    SUBSCRIBER_MODEL: 'workspaces.Workspace',
    SUBSCRIBER: billingSubscriber,
    PLANS: {
      free: { features: [], limits: { agentTokens: { day: 20_000, month: 200_000 }, documents: 20 } },
      pro: {
        // Stripe price lookup keys (create them with scripts/stripe-check.ts or in the dashboard).
        prices: ['agentdesk_pro_monthly', 'agentdesk_pro_yearly'],
        features: ['background_runs'],
        limits: { agentTokens: { day: 1_000_000, month: 10_000_000 }, documents: 1_000 },
      },
    },
    DEFAULT_PLAN: 'free',
    SUCCESS_URL: '/billing/thanks/?session={CHECKOUT_SESSION_ID}',
    CANCEL_URL: '/',
    RETURN_URL: '/',
  },

  AGENTS: {
    // Workers AI needs the "ai" binding (wrangler.jsonc). AGENT_MODEL=fake:agentdesk (with DEBUG=true) is the
    // offline model of src/support/fake-model.ts; any '<provider>:<model>' id works (anthropic:, openai:, …).
    DEFAULT_MODEL: env.AGENT_MODEL ?? 'workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    PROVIDERS: {
      ...(env.ANTHROPIC_API_KEY ? { anthropic: { apiKey: env.ANTHROPIC_API_KEY } } : {}),
      ...(env.OPENAI_API_KEY ? { openai: { apiKey: env.OPENAI_API_KEY } } : {}),
    },
    AUTHENTICATION_CLASSES: [TokenAuthentication, SessionAuthentication],
    // Conversations belong to a workspace (support.Conversation is tenant-scoped).
    CONVERSATION_MODEL: 'support.Conversation',
    // Each workspace's plan caps its tokens per UTC day and month (BILLING.PLANS[…].limits.agentTokens).
    USAGE_LIMITS: { tenant: usageLimits('agentTokens') },
    TRACE_RUNS: true,
    MAX_STEPS: 4,
  },

  TIME_ZONE: 'UTC',
  USE_TZ: true,
}))

export default settings
