// Platform routes (no workspace): token login, creating and listing workspaces, the admin and the API docs; plus
// members management and request throttling.
import { User } from '@ghuri/auth'
import { describe, expect, it } from 'vitest'
import { Membership } from '../src/workspaces/models'
import { as, makeUser, makeWorkspace, runAsTenant, upload, useHarness, using } from './helpers'

describe(`platform (${using})`, () => {
  const h = useHarness()

  it('logs in and creates a workspace without a workspace header', async () => {
    await makeUser('alice')
    const login = await h.api.post('/api/auth/token/', { username: 'alice', password: 'pw-alice' })
    expect(login.status).toBe(200)
    const headers = { Authorization: `Token ${login.data.token}` }

    const created = await h.api.post('/api/workspaces/', { name: 'Acme', slug: 'acme' }, { headers })
    expect(created.status).toBe(201)
    expect(created.data).toMatchObject({ name: 'Acme', slug: 'acme' })
    const list = await h.api.get('/api/workspaces/', undefined, { headers })
    expect(list.data.map((w: any) => w.slug)).toEqual(['acme'])

    // The creator owns it and can use it right away.
    const ws = await h.api.get('/api/workspace/', undefined, { headers: { ...headers, 'X-Workspace': 'acme' } })
    expect(ws.status).toBe(200)
    expect(ws.data).toMatchObject({ plan: 'free', workspace: { slug: 'acme' } })
  })

  it("lists only the user's workspaces", async () => {
    const alice = await makeUser('alice')
    const bob = await makeUser('bob')
    await makeWorkspace('acme', [{ user: alice }])
    await makeWorkspace('globex', [{ user: bob }])
    const list = await h.api.get('/api/workspaces/', undefined, { headers: await as(alice) })
    expect(list.data.map((w: any) => w.slug)).toEqual(['acme'])
  })

  it('lets owners manage members; members only read', async () => {
    const alice = await makeUser('alice')
    const bob = await makeUser('bob')
    await makeUser('carol')
    const acme = await makeWorkspace('acme', [
      { user: alice, role: 'owner' },
      { user: bob, role: 'member' },
    ])
    const add = await h.api.post('/api/members/', { username: 'carol' }, { headers: await as(alice, acme) })
    expect(add.status).toBe(201)
    expect(add.data).toMatchObject({ username: 'carol', role: 'member' })
    const byMember = await h.api.post('/api/members/', { username: 'carol' }, { headers: await as(bob, acme) })
    expect(byMember.status).toBe(403)
    const list = await h.api.get('/api/members/', undefined, { headers: await as(bob, acme) })
    expect(list.data.results.map((m: any) => m.username)).toEqual(['alice', 'bob', 'carol'])
    const carol = await User.objects.get({ username: 'carol' })
    const m = await runAsTenant(acme, () => Membership.objects.get({ user: carol.pk }))
    expect((await h.api.delete(`/api/members/${m.pk}/`, undefined, { headers: await as(alice, acme) })).status).toBe(204)
  })

  it('serves the admin and the API docs without a workspace', async () => {
    const admin = await User.objects.createSuperuser('admin', 'admin@example.com', 'pw-admin')
    const alice = await makeUser('alice')
    const acme = await makeWorkspace('acme', [{ user: alice }])
    await upload(h, await as(alice, acme), 'notes.md', 'Hello from Acme.')

    expect((await h.api.client.get('/admin/login/')).status).toBe(200)
    await h.api.client.forceLogin(admin)
    expect((await h.api.client.get('/admin/')).status).toBe(200)
    expect((await h.api.client.get('/admin/workspaces/workspace/')).status).toBe(200)
    // Tenant-scoped models in the platform admin: every workspace's rows.
    const docs = await h.api.client.get('/admin/knowledge/document/')
    expect(docs.status).toBe(200)
    expect(await docs.text()).toContain('notes.md')
    expect((await h.api.client.get('/admin/workspaces/membership/')).status).toBe(200)
    for (const page of ['agents/usage', 'agents/run', 'billing/subscription', 'billing/event', 'tasks/dbtaskresult'])
      expect((await h.api.client.get(`/admin/${page}/`)).status, page).toBe(200)

    expect((await h.api.get('/api/schema/', { format: 'json' })).status).toBe(200)
    expect((await h.api.get('/')).status).toBe(200)
  })

  it('throttles uploads per user (DRF ScopedRateThrottle)', async () => {
    const rates = (h.ctx.settings.REST_FRAMEWORK as any).DEFAULT_THROTTLE_RATES
    const previous = rates.uploads
    rates.uploads = '2/min'
    try {
      const alice = await makeUser('alice')
      const acme = await makeWorkspace('acme', [{ user: alice }])
      const headers = await as(alice, acme)
      expect((await upload(h, headers, 'a.txt', 'a', { drain: false })).status).toBe(201)
      expect((await upload(h, headers, 'b.txt', 'b', { drain: false })).status).toBe(201)
      const third = await upload(h, headers, 'c.txt', 'c', { drain: false })
      expect(third.status).toBe(429)
      expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0)
      // Reading is not an upload.
      expect((await h.api.get('/api/documents/', undefined, { headers })).status).toBe(200)
    } finally {
      rates.uploads = previous
    }
  })

  it('throttles token logins per client address (brute force)', async () => {
    const rates = (h.ctx.settings.REST_FRAMEWORK as any).DEFAULT_THROTTLE_RATES
    const previous = rates.login
    rates.login = '2/min'
    try {
      await makeUser('alice')
      const statuses: number[] = []
      for (const password of ['nope', 'wrong', 'pw-alice'])
        statuses.push((await h.api.post('/api/auth/token/', { username: 'alice', password })).status)
      expect(statuses).toEqual([400, 400, 429])
    } finally {
      rates.login = previous
    }
  })
})
