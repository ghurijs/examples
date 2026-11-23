// Manual check of @ghuri/billing's Stripe adapter against **Stripe test mode** (the tests use a fake Stripe).
// Keys are read from the environment only and are never printed or written anywhere. Live keys are refused.
//
//   STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRET=whsec_… npm run stripe:check
//   (or put them in your shell with `read -s`, a password manager's CLI, or `.dev.vars`, which is git-ignored)
//
// It does, in your Stripe *test* account:
//   1. makes sure the prices of BILLING.PLANS exist (product "agentdesk Pro", lookup keys agentdesk_pro_monthly /
//      agentdesk_pro_yearly); creates them when missing (idempotent);
//   2. lists prices through the adapter (what `ghuri billing_sync` does) and checks the lookup keys come back;
//   3. creates a test customer and a Checkout Session, and prints its URL — open it and pay with 4242 4242 4242 4242;
//   4. opens a Customer Portal session (needs the portal configured once in the dashboard: Settings → Billing);
//   5. verifies the webhook signature code with your endpoint secret (a locally signed payload), and with
//      `stripe listen` running, tells you how to see real events reach the app.
//   6. deletes the test customer again (pass --keep to keep it).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripe } from '@ghuri/billing'
import { signPayload } from '@ghuri/billing/testing'

const API = 'https://api.stripe.com'
const LOOKUP_KEYS = { agentdesk_pro_monthly: { amount: 2900, interval: 'month' }, agentdesk_pro_yearly: { amount: 29000, interval: 'year' } }

/** STRIPE_* from the environment, else from .dev.vars (git-ignored). Never printed. */
function secret(name: string): string | undefined {
  if (process.env[name]) return process.env[name]
  try {
    const text = readFileSync(join(import.meta.dirname, '..', '.dev.vars'), 'utf8')
    const line = text.split('\n').find((l: string) => l.startsWith(`${name}=`))
    return line?.slice(name.length + 1).trim() || undefined
  } catch {
    return undefined
  }
}

const secretKey = secret('STRIPE_SECRET_KEY')
const webhookSecret = secret('STRIPE_WEBHOOK_SECRET')
if (!secretKey || secretKey.includes('replace_me')) {
  console.error('Set STRIPE_SECRET_KEY to a Stripe *test* secret key (sk_test_… or rk_test_…).')
  process.exit(2)
}
if (!/^(sk|rk)_test_/.test(secretKey)) {
  console.error('Refusing to run: STRIPE_SECRET_KEY is not a test-mode key. This script only talks to test mode.')
  process.exit(2)
}

let failures = 0
function report(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures++
}

/** A raw form-encoded Stripe call, for what the adapter does not do (creating products and prices, cleanup). */
async function stripeApi(method: string, path: string, params: Record<string, string> = {}) {
  const body = new URLSearchParams(params).toString()
  const res = await fetch(`${API}${path}${method === 'GET' && body ? `?${body}` : ''}`, {
    method,
    headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
    ...(method === 'GET' ? {} : { body }),
  })
  const data = (await res.json()) as any
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data?.error?.message ?? ''}`)
  return data
}

const provider = stripe({ secretKey, webhookSecret: webhookSecret ?? 'whsec_unused' })

// 1. Prices.
const existing = await stripeApi('GET', '/v1/prices', {
  'lookup_keys[0]': 'agentdesk_pro_monthly',
  'lookup_keys[1]': 'agentdesk_pro_yearly',
  active: 'true',
})
const found = new Set<string>(existing.data.map((p: any) => p.lookup_key))
if (found.size < 2) {
  const product = await stripeApi('POST', '/v1/products', { name: 'agentdesk Pro', 'metadata[app]': 'agentdesk' })
  for (const [key, { amount, interval }] of Object.entries(LOOKUP_KEYS)) {
    if (found.has(key)) continue
    await stripeApi('POST', '/v1/prices', {
      product: product.id,
      currency: 'usd',
      unit_amount: String(amount),
      'recurring[interval]': interval,
      lookup_key: key,
    })
  }
}
report('plan prices exist in test mode', true, [...Object.keys(LOOKUP_KEYS)].join(', '))

// 2. The adapter's list (billing_sync).
const keys = new Set<string>()
let monthlyId: string | undefined
for await (const price of provider.list('price')) {
  if (price.lookupKey) keys.add(price.lookupKey)
  if (price.lookupKey === 'agentdesk_pro_monthly' && price.active) monthlyId = price.id
}
report('adapter lists the prices (billing_sync)', keys.has('agentdesk_pro_monthly') && keys.has('agentdesk_pro_yearly'))

// 3. Customer + Checkout Session.
const customer = await provider.createCustomer({
  email: 'agentdesk-check@example.com',
  name: 'agentdesk stripe-check',
  metadata: { ghuri_subscriber: 'workspaces.workspace:check' },
})
report('customer created', customer.id.startsWith('cus_'), customer.id)
try {
  const session = await provider.createCheckoutSession({
    customer: customer.id,
    lineItems: [{ price: monthlyId!, quantity: 1 }],
    mode: 'subscription',
    successUrl: 'http://localhost:8787/billing/thanks/?session={CHECKOUT_SESSION_ID}',
    cancelUrl: 'http://localhost:8787/',
    metadata: { ghuri_subscriber: 'workspaces.workspace:check' },
  })
  report('checkout session created', session.url.startsWith('https://checkout.stripe.com/'), session.url)
} catch (err) {
  report('checkout session created', false, (err as Error).message)
}

// 4. Portal.
try {
  const portal = await provider.createPortalSession({ customer: customer.id, returnUrl: 'http://localhost:8787/' })
  report('portal session created', portal.url.startsWith('https://'), portal.url)
} catch (err) {
  report('portal session created', false, `${(err as Error).message} (configure the portal in the dashboard once)`)
}

// 5. Webhook signatures.
if (webhookSecret && !webhookSecret.includes('replace_me')) {
  const body = JSON.stringify({
    id: 'evt_check',
    object: 'event',
    type: 'customer.updated',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object: { id: customer.id, object: 'customer', metadata: {} } },
  })
  const event = await provider.constructEvent(body, new Headers({ 'stripe-signature': await signPayload(body, webhookSecret) }))
  report('webhook signature verifies with STRIPE_WEBHOOK_SECRET', event.type === 'customer.updated')
  let forged = false
  try {
    await provider.constructEvent(body, new Headers({ 'stripe-signature': await signPayload(body, 'whsec_wrong') }))
  } catch {
    forged = true
  }
  report('a payload signed with another secret is refused', forged)
} else {
  console.log('- STRIPE_WEBHOOK_SECRET not set: skipped the signature check')
}
console.log(`
Real webhooks: run the app (npm run dev), then in another terminal
  stripe listen --forward-to localhost:8787/billing/webhook/
put the printed whsec_… in .dev.vars as STRIPE_WEBHOOK_SECRET, restart the app, start a checkout as a workspace owner
(POST /billing/checkout/ {"plan":"pro"} with X-Workspace), pay with 4242 4242 4242 4242, and GET /api/workspace/
shows "plan": "pro".`)

// 6. Cleanup.
if (!process.argv.includes('--keep')) {
  await stripeApi('DELETE', `/v1/customers/${customer.id}`)
  report('test customer deleted', true)
}

process.exit(failures ? 1 : 0)
