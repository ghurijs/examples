// Project settings (Django's settings.py). `env` holds Worker bindings and vars (wrangler.jsonc,
// .dev.vars) on Cloudflare, or process.env on Node. Never read env.DB / env.MEDIA in app code:
// databases, storage and caches are configured here so the project stays portable.
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
import { JWTAuthentication, SessionAuthentication, TokenAuthentication } from '@ghuri/auth/rest'
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
import { GraphQLConfig } from '@ghuri/graphql'
import { type DatabaseConfig, d1, postgres } from '@ghuri/orm'
import { IsAuthenticatedOrReadOnly, PageNumberPagination, RestFrameworkConfig } from '@ghuri/rest'
import { r2 } from '@ghuri/storage'
import { fileSystemStorage } from '@ghuri/storage/fs'
import { BlogConfig } from './blog/app'
import { schema } from './schema'
import { urlpatterns } from './urls'

/**
 * PostgreSQL in-process (PGlite) — for running this project on Node without a Postgres server. Loaded
 * lazily (the specifier is not a literal) so the Worker bundle never includes PGlite.
 */
function pgliteDatabase(dataDir: string): DatabaseConfig {
  const specifier = '@ghuri/orm/pglite'
  let config: Promise<DatabaseConfig> | undefined
  return {
    vendor: 'pglite',
    dialect: 'postgresql',
    options: { dataDir },
    async connect(env: Env) {
      config ??= import(/* @vite-ignore */ specifier).then((m) => m.pglite({ dataDir }))
      return (await config).connect(env)
    },
  }
}

/**
 * Databases:
 * - Cloudflare (default): D1, binding "DB" in wrangler.jsonc.
 * - DATABASE_URL set: PostgreSQL (a VPS, Neon, RDS, … — or Hyperdrive on Workers).
 * - DATABASE_ENGINE=pglite: PostgreSQL semantics in-process (PGlite, data in PGLITE_DIR).
 * `pg` is the PostgreSQL target used to move data: `ghuri migrate --database pg`,
 * `ghuri copydata --from default --to pg`.
 */
function databases(env: Env): Record<string, DatabaseConfig> {
  const postgresDb = env.DATABASE_URL
    ? postgres({ url: env.DATABASE_URL })
    : pgliteDatabase(env.PGLITE_DIR ?? '.data/pglite')
  const defaultDb =
    env.DATABASE_ENGINE === 'pglite' || env.DATABASE_URL ? postgresDb : d1('DB')
  return { default: defaultDb, pg: postgresDb }
}

export default defineSettings((env) => ({
  SECRET_KEY: env.SECRET_KEY,
  DEBUG: env.DEBUG === 'true',
  ALLOWED_HOSTS: env.ALLOWED_HOSTS ? String(env.ALLOWED_HOSTS).split(',') : ['*'],

  INSTALLED_APPS: [
    ContentTypesConfig,
    AuthConfig,
    SessionsConfig,
    AuthTokenConfig,
    AdminConfig,
    AgentsConfig,
    GraphQLConfig,
    RestFrameworkConfig,
    BlogConfig,
  ],

  MIDDLEWARE: [
    SecurityMiddleware,
    CommonMiddleware,
    SessionMiddleware,
    CsrfMiddleware,
    AuthenticationMiddleware,
    XFrameOptionsMiddleware,
  ],

  ROOT_URLCONF: urlpatterns,

  DATABASES: databases(env),

  STORAGES: {
    // R2 (binding "MEDIA") on Cloudflare; the local disk elsewhere. Use s3({ ... }) for S3 / MinIO.
    default: env.MEDIA
      ? r2('MEDIA')
      : fileSystemStorage({ location: env.MEDIA_ROOT ?? '.data/media', baseUrl: '/media/' }),
  },
  MEDIA_URL: '/media/',

  CACHES: {
    // Workers KV when the CACHE binding exists, otherwise an in-memory cache.
    default: env.CACHE ? kvCache('CACHE') : memoryCache(),
  },

  AUTH_USER_MODEL: 'auth.User',

  REST_FRAMEWORK: {
    // Token / JWT first: unauthenticated API requests get 401 with WWW-Authenticate (403 with session first).
    DEFAULT_AUTHENTICATION_CLASSES: [TokenAuthentication, JWTAuthentication, SessionAuthentication],
    DEFAULT_PERMISSION_CLASSES: [IsAuthenticatedOrReadOnly],
    DEFAULT_PAGINATION_CLASS: PageNumberPagination,
    PAGE_SIZE: 20,
  },

  JWT: {
    ACCESS_TOKEN_LIFETIME: 15 * 60,
    REFRESH_TOKEN_LIFETIME: 7 * 24 * 60 * 60,
  },

  GRAPHQL: {
    // Default schema of GraphQLView (/graphql/) and `ghuri graphql_schema`.
    SCHEMA: schema,
    // Same authentication as the REST API: token / JWT clients skip CSRF; session POSTs need the CSRF token.
    AUTHENTICATION_CLASSES: [TokenAuthentication, JWTAuthentication, SessionAuthentication],
    // GraphiQL in the browser: defaults to DEBUG.
    MAX_DEPTH: 10,
    RELAY_CONNECTION_MAX_LIMIT: 50,
  },

  AGENTS: {
    // Workers AI needs an "ai" binding (wrangler.jsonc) and a Cloudflare login, even locally. With
    // DEBUG=true, AGENT_MODEL=fake:blog uses the offline model from src/blog/fake-model.ts.
    DEFAULT_MODEL: env.AGENT_MODEL ?? 'workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    AUTHENTICATION_CLASSES: [TokenAuthentication, JWTAuthentication, SessionAuthentication],
    MAX_STEPS: 5,
  },

  TIME_ZONE: 'UTC',
  USE_TZ: true,
}))
