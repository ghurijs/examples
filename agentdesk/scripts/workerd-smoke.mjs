#!/usr/bin/env node
// End-to-end smoke test of the real Worker bundle in workerd (Miniflare): D1, R2 and Cloudflare Queues are local,
// the agent model and the embeddings are the offline fakes (DEBUG=true), and Vectorize is replaced by the
// databaseStore() fallback (Miniflare has no Vectorize). No network, no keys, no Cloudflare account.
//
//   node scripts/workerd-smoke.mjs
//
// Steps: bundle with `wrangler deploy --dry-run`, apply every migration (`ghuri sqlmigrate --all`), then over HTTP:
// create a workspace, upload a document, wait for the queue consumer to embed it, ask the agent (JSON and SSE), ask
// in the background, and deliver a signed Stripe webhook without a workspace header.
import { execFileSync } from 'node:child_process'
import { createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const require = createRequire(join(root, 'package.json'))
const { Miniflare, convertV4MiniflareOptions } = require('miniflare')

const work = mkdtempSync(join(tmpdir(), 'agentdesk-smoke-'))
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

const WEBHOOK_SECRET = 'whsec_smoke_only'
const vars = {
  SECRET_KEY: randomBytes(32).toString('hex'),
  DEBUG: 'true',
  ALLOWED_HOSTS: 'localhost',
  AGENT_MODEL: 'fake:agentdesk',
  EMBEDDING_MODEL: 'fake:agentdesk',
  STRIPE_SECRET_KEY: 'sk_test_smoke_only',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
}

console.log('Bundling the Worker…')
run('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', join(work, 'bundle')])
console.log('Writing migrations…')
run('npx', ['ghuri', 'sqlmigrate', '--all', '--dialect', 'sqlite', '--out', join(work, 'sql')])

const script = readFileSync(join(work, 'bundle', 'index.js'), 'utf8')

const options = {
  modules: true,
  script,
  compatibilityDate: '2026-11-01',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'agentdesk-smoke' },
  r2Buckets: ['MEDIA'],
  queueProducers: { TASKS_QUEUE: 'agentdesk-tasks' },
  queueConsumers: { 'agentdesk-tasks': { maxBatchTimeout: 1, maxRetries: 3 } },
  bindings: vars,
}
// Miniflare 5 (pinned by wrangler 4.160+) takes a new options shape and ships a converter for the v4 shape.
const mf = new Miniflare(
  typeof convertV4MiniflareOptions === 'function' ? convertV4MiniflareOptions(options) : options,
)

try {
  const db = await mf.getD1Database('DB')
  for (const file of readdirSync(join(work, 'sql')).sort()) {
    const sql = readFileSync(join(work, 'sql', file), 'utf8')
      .split('\n')
      .filter((l) => !l.startsWith('--'))
      .join('\n')
    const statements = sql
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    await db.batch(statements.map((s) => db.prepare(s)))
  }
  check('migrations applied to D1', true)

  // A user and an API token (Django's PBKDF2 hash format), straight into D1.
  const salt = randomBytes(8).toString('hex')
  const hash = pbkdf2Sync('pw-alice', salt, 1000, 32, 'sha256').toString('base64')
  await db
    .prepare(
      "INSERT INTO auth_user (password, is_superuser, username, first_name, last_name, email, is_staff, is_active, date_joined) VALUES (?, 0, 'alice', '', '', 'alice@example.com', 0, 1, ?)",
    )
    .bind(`pbkdf2_sha256$1000$${salt}$${hash}`, new Date().toISOString())
    .run()

  const base = 'http://localhost'
  const call = async (method, path, { headers = {}, json, body } = {}) => {
    const init = { method, headers: { ...headers } }
    if (json !== undefined) {
      init.body = JSON.stringify(json)
      init.headers['content-type'] = 'application/json'
    } else if (body instanceof FormData) {
      // Encode multipart here: Miniflare's dispatchFetch does not serialize Node's FormData.
      const req = new Request('http://encode/', { method: 'POST', body })
      init.headers['content-type'] = req.headers.get('content-type')
      init.body = new Uint8Array(await req.arrayBuffer())
    } else if (body !== undefined) init.body = body
    const res = await mf.dispatchFetch(base + path, init)
    const text = await res.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    return { status: res.status, data, headers: res.headers }
  }

  const login = await call('POST', '/api/auth/token/', { json: { username: 'alice', password: 'pw-alice' } })
  check('token login without a workspace', login.status === 200, JSON.stringify(login.data))
  const auth = { authorization: `Token ${login.data.token}` }

  const created = await call('POST', '/api/workspaces/', { headers: auth, json: { name: 'Acme', slug: 'acme' } })
  check('workspace created', created.status === 201, JSON.stringify(created.data))
  const inAcme = { ...auth, 'x-workspace': 'acme' }

  const noWorkspace = await call('GET', '/api/documents/', { headers: auth })
  check('workspace routes need X-Workspace (404)', noWorkspace.status === 404, String(noWorkspace.status))

  const form = new FormData()
  form.append(
    'file',
    new File(['Refunds take five business days and go back to the original card.'], 'refunds.md', {
      type: 'text/markdown',
    }),
  )
  const uploaded = await call('POST', '/api/documents/', { headers: inAcme, body: form })
  check('document uploaded to R2', uploaded.status === 201, JSON.stringify(uploaded.data))

  let doc
  for (let i = 0; i < 40; i++) {
    doc = (await call('GET', `/api/documents/${uploaded.data.id}/`, { headers: inAcme })).data
    if (doc.status === 'ready' || doc.status === 'failed') break
    await new Promise((r) => setTimeout(r, 250))
  }
  check('queue consumer embedded the document', doc?.status === 'ready' && doc.chunks > 0, JSON.stringify(doc))

  const chat = await call('POST', '/agents/support/chat', { headers: inAcme, json: { message: 'refund days' } })
  check(
    'agent answers from the document (JSON)',
    chat.status === 200 && String(chat.data.text).includes('five business days'),
    JSON.stringify(chat.data),
  )

  const stream = await call('POST', '/agents/support/chat?stream=1', {
    headers: inAcme,
    json: { message: 'refund card', conversationId: chat.data.conversationId },
  })
  check(
    'agent streams with memory (SSE)',
    stream.status === 200 && String(stream.data).includes('According to') && String(stream.data).includes('[DONE]'),
    String(stream.data).slice(0, 300),
  )

  const ask = await call('POST', '/api/ask/', { headers: inAcme, json: { message: 'refund days' } })
  check('background question accepted (202)', ask.status === 202, JSON.stringify(ask.data))
  let answer
  for (let i = 0; i < 40; i++) {
    answer = (await call('GET', `/api/ask/${ask.data.task}/`, { headers: inAcme })).data
    if (answer.status === 'SUCCESSFUL' || answer.status === 'FAILED') break
    await new Promise((r) => setTimeout(r, 250))
  }
  check(
    'background run finished on Queues as the workspace',
    answer?.status === 'SUCCESSFUL' && String(answer.answer?.text).includes('five'),
    JSON.stringify(answer),
  )

  const usage = await call('GET', '/api/workspace/', { headers: inAcme })
  const day = usage.data.usage?.find((u) => u.period === 'day')
  check('token usage counted for the workspace', day?.used > 0, JSON.stringify(usage.data))

  const event = JSON.stringify({
    id: 'evt_smoke_1',
    object: 'event',
    type: 'product.created',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object: { id: 'prod_smoke', object: 'product', name: 'Pro', active: true, metadata: {}, created: 1 } },
  })
  const t = Math.floor(Date.now() / 1000)
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${event}`).digest('hex')
  const hook = await call('POST', '/billing/webhook/', {
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` },
    body: event,
  })
  check('signed Stripe webhook processed without a workspace', hook.status === 200, JSON.stringify(hook.data))
  const forged = await call('POST', '/billing/webhook/', {
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${'0'.repeat(64)}` },
    body: event,
  })
  check('forged webhook refused (400)', forged.status === 400, String(forged.status))
} catch (err) {
  console.error(err)
  failures++
} finally {
  await mf.dispose()
  rmSync(work, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
