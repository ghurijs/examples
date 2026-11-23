// Plan limits: a workspace's plan (BILLING.PLANS) caps its agent tokens per day (AGENTS.USAGE_LIMITS with billing's
// usageLimits('agentTokens')) and its number of documents. Each question costs 240 tokens with the offline model.
import { clearEntitlementsCache } from '@ghuri/billing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Conversation } from '../src/support/models'
import { as, drain, makeUser, makeWorkspace, runAsTenant, upload, useHarness, using } from './helpers'

describe(`plan limits (${using})`, () => {
  const h = useHarness()
  const plans = () => (h.ctx.settings.BILLING as any).PLANS
  let saved: unknown

  function setFreeLimits(limits: Record<string, unknown>) {
    saved ??= structuredClone(plans().free.limits)
    plans().free.limits = { ...plans().free.limits, ...limits }
    clearEntitlementsCache()
  }

  afterEach(() => {
    if (saved) plans().free.limits = saved
    saved = undefined
    clearEntitlementsCache()
  })

  it("refuses a run once the workspace's daily token budget is spent (429, Retry-After)", async () => {
    setFreeLimits({ agentTokens: { day: 200, month: 10_000 } })
    const alice = await makeUser('alice')
    const acme = await makeWorkspace('acme', [{ user: alice }])
    const headers = await as(alice, acme)

    const first = await h.api.post('/agents/support/chat', { message: 'hello' }, { headers })
    expect(first.status).toBe(200)

    const second = await h.api.post('/agents/support/chat', { message: 'again' }, { headers })
    expect(second.status).toBe(429)
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(second.data.detail).toMatch(/Token usage limit reached for this day/)
    // A refused run creates no conversation.
    expect(await runAsTenant(acme, () => Conversation.objects.count())).toBe(1)

    // Streaming is refused before the stream starts, with the same JSON answer.
    const stream = await h.api.post('/agents/support/chat?stream=1', { message: 'again' }, { headers })
    expect(stream.status).toBe(429)
    expect(stream.headers.get('content-type')).toContain('application/json')

    // Background runs are refused before anything is queued.
    const ask = await h.api.post('/api/ask/', { message: 'again' }, { headers })
    expect(ask.status).toBe(429)
    expect(ask.data.detail).toMatch(/Token usage limit reached/)
    expect(await drain()).toBe(0)

    // The workspace's usage, as the app and the agents' usage endpoint report it.
    const ws = await h.api.get('/api/workspace/', undefined, { headers })
    expect(ws.data.plan).toBe('free')
    const day = ws.data.usage.find((u: any) => u.period === 'day')
    expect(day).toMatchObject({ scope: 'tenant', key: String(acme.pk), used: 240, limit: 200, remaining: 0 })
    const usage = await h.api.get('/agents/usage/', undefined, { headers })
    expect(usage.data.results.find((u: any) => u.scope === 'tenant' && u.period === 'day').used).toBe(240)
  })

  it('counts tokens per workspace, not per user', async () => {
    setFreeLimits({ agentTokens: { day: 200 } })
    const alice = await makeUser('alice')
    const bob = await makeUser('bob')
    const acme = await makeWorkspace('acme', [{ user: alice }, { user: bob }])
    const globex = await makeWorkspace('globex', [{ user: alice }])

    expect((await h.api.post('/agents/support/chat', { message: 'hi' }, { headers: await as(alice, acme) })).status).toBe(200)
    // Bob shares Acme's budget…
    expect((await h.api.post('/agents/support/chat', { message: 'hi' }, { headers: await as(bob, acme) })).status).toBe(429)
    // …and Alice still has Globex's.
    expect((await h.api.post('/agents/support/chat', { message: 'hi' }, { headers: await as(alice, globex) })).status).toBe(200)
  })

  it('stops a queued run that would go over the budget', async () => {
    setFreeLimits({ agentTokens: { day: 200 } })
    const alice = await makeUser('alice')
    const acme = await makeWorkspace('acme', [{ user: alice }])
    const headers = await as(alice, acme)
    // Two background questions pass the check at enqueue time (nothing used yet)…
    const one = await h.api.post('/api/ask/', { message: 'one' }, { headers })
    const two = await h.api.post('/api/ask/', { message: 'two' }, { headers })
    expect([one.status, two.status]).toEqual([202, 202])
    // …the first spends the budget, the second is refused when it runs (the task fails, after its retries).
    // Retries wait (2 s, 4 s): move the clock instead of sleeping.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      for (let i = 0; i < 4; i++) {
        await drain()
        vi.setSystemTime(Date.now() + 10_000)
      }
    } finally {
      vi.useRealTimers()
    }
    const r1 = await h.api.get(`/api/ask/${one.data.task}/`, undefined, { headers })
    const r2 = await h.api.get(`/api/ask/${two.data.task}/`, undefined, { headers })
    expect(r1.data.status).toBe('SUCCESSFUL')
    expect(r2.data.status).toBe('FAILED')
    expect(r2.data.errors).toContain('UsageLimitExceeded')
  })

  it("caps the number of documents by the workspace's plan", async () => {
    setFreeLimits({ documents: 1 })
    const alice = await makeUser('alice')
    const acme = await makeWorkspace('acme', [{ user: alice }])
    const headers = await as(alice, acme)
    expect((await upload(h, headers, 'one.txt', 'one')).status).toBe(201)
    const second = await upload(h, headers, 'two.txt', 'two')
    expect(second.status).toBe(403)
    expect(second.data.detail).toBe('The free plan allows 1 documents. Upgrade to add more.')
  })
})
