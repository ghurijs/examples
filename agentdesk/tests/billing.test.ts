// Billing (@ghuri/billing over a fake Stripe): workspace owners check out, Stripe's webhook (which carries no
// X-Workspace) is processed under TENANTS.REQUIRED, and the new plan's limits apply to the agent at once.
import { clearEntitlementsCache, Event, getPlan, getSubscription, type Subscription } from '@ghuri/billing'
import { afterEach, describe, expect, it } from 'vitest'
import { as, deliver, makeUser, makeWorkspace, seedStripe, useHarness, using } from './helpers'

describe(`billing (${using})`, () => {
  const h = useHarness()
  const plans = () => (h.ctx.settings.BILLING as any).PLANS
  let saved: unknown
  afterEach(() => {
    if (saved) plans().free.limits = saved
    saved = undefined
    clearEntitlementsCache()
  })

  it('lets only owners start a checkout, for the request workspace', async () => {
    await seedStripe(h)
    const alice = await makeUser('alice')
    const bob = await makeUser('bob')
    const acme = await makeWorkspace('acme', [
      { user: alice, role: 'owner' },
      { user: bob, role: 'member' },
    ])

    expect((await h.api.post('/billing/checkout/', { plan: 'pro' }, { headers: await as(alice) })).status).toBe(404)
    const member = await h.api.post('/billing/checkout/', { plan: 'pro' }, { headers: await as(bob, acme) })
    expect(member.status).toBe(403)
    const anon = await h.api.post('/billing/checkout/', { plan: 'pro' }, { headers: { 'X-Workspace': 'acme' } })
    expect(anon.status).toBe(401)

    const res = await h.api.post('/billing/checkout/', { plan: 'pro' }, { headers: await as(alice, acme) })
    expect(res.status).toBe(200)
    expect(res.data.url).toMatch(/^https:\/\//)
    // Prices outside BILLING.PLANS cannot be bought.
    const other = h.stripe.createPrice({ unit_amount: 1 })
    const bad = await h.api.post('/billing/checkout/', { price: other.id }, { headers: await as(alice, acme) })
    expect(bad.status).toBe(400)
  })

  it('processes the signed webhook without a workspace header and upgrades the plan', async () => {
    await seedStripe(h)
    saved = structuredClone(plans().free.limits)
    plans().free.limits = { ...plans().free.limits, agentTokens: { day: 200 } }
    clearEntitlementsCache()
    const alice = await makeUser('alice')
    const acme = await makeWorkspace('acme', [{ user: alice, role: 'owner' }])
    const headers = await as(alice, acme)

    // Free plan: the second question is over the budget.
    expect((await h.api.post('/agents/support/chat', { message: 'hi' }, { headers })).status).toBe(200)
    expect((await h.api.post('/agents/support/chat', { message: 'hi' }, { headers })).status).toBe(429)

    const checkout = await h.api.post('/billing/checkout/', { plan: 'pro' }, { headers })
    const session = h.stripe.completeCheckout(checkout.data.id)
    const delivered = await deliver(h, h.stripe.event('checkout.session.completed', session))
    expect(delivered.status).toBe(200)
    expect(await delivered.json()).toMatchObject({ received: true, result: 'processed' })

    expect(((await getSubscription(acme)) as Subscription).status).toBe('active')
    expect((await getPlan(acme)).key).toBe('pro')
    const ws = await h.api.get('/api/workspace/', undefined, { headers })
    expect(ws.data).toMatchObject({ plan: 'pro', active: true, features: ['background_runs'] })
    // The pro plan's token budget applies to the next run (the webhook cleared the entitlements cache).
    expect((await h.api.post('/agents/support/chat', { message: 'hi' }, { headers })).status).toBe(200)

    // A repeated delivery is acknowledged without processing it again.
    const again = await deliver(h, h.stripe.event('checkout.session.completed', session, { id: (await Event.objects.first())!.providerId }))
    expect(await again.json()).toMatchObject({ result: 'duplicate' })
  })

  it('drops back to the free plan when the subscription is cancelled', async () => {
    await seedStripe(h)
    const alice = await makeUser('alice')
    const acme = await makeWorkspace('acme', [{ user: alice, role: 'owner' }])
    const headers = await as(alice, acme)
    const checkout = await h.api.post('/billing/checkout/', { plan: 'pro' }, { headers })
    const session = h.stripe.completeCheckout(checkout.data.id)
    await deliver(h, h.stripe.event('checkout.session.completed', session))
    expect((await getPlan(acme)).key).toBe('pro')

    const cancelled = h.stripe.cancelSubscription(session.subscription)
    expect((await deliver(h, h.stripe.event('customer.subscription.deleted', cancelled))).status).toBe(200)
    expect((await getPlan(acme)).key).toBe('free')
    expect((await h.api.get('/api/workspace/', undefined, { headers })).data.plan).toBe('free')
  })

  it('refuses unsigned or forged webhooks', async () => {
    await seedStripe(h)
    const forged = await deliver(h, h.stripe.event('customer.updated', { id: 'cus_x' }), { secret: 'whsec_wrong' })
    expect(forged.status).toBe(400)
    const unsigned = await h.api.client.post('/billing/webhook/', {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      csrf: false,
    } as any)
    expect(unsigned.status).toBe(400)
    // An unknown workspace header is still a 404, on the webhook too.
    const { body, headers } = await h.stripe.webhook(h.stripe.event('customer.updated', { id: 'cus_x' }))
    const unknown = await h.api.client.post('/billing/webhook/', {
      body,
      headers: { ...headers, 'X-Workspace': 'nope' },
      csrf: false,
    } as any)
    expect(unknown.status).toBe(404)
  })

  it('opens the customer portal for owners', async () => {
    await seedStripe(h)
    const alice = await makeUser('alice')
    const acme = await makeWorkspace('acme', [{ user: alice, role: 'owner' }])
    const headers = await as(alice, acme)
    const checkout = await h.api.post('/billing/checkout/', { plan: 'pro' }, { headers })
    await deliver(h, h.stripe.event('checkout.session.completed', h.stripe.completeCheckout(checkout.data.id)))
    const portal = await h.api.post('/billing/portal/', {}, { headers })
    expect(portal.status).toBe(200)
    expect(portal.data.url).toMatch(/^https:\/\//)
  })
})
