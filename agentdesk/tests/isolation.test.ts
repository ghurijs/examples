// Tenant isolation: documents, vectors, conversations and background runs of one workspace are invisible to another,
// also for a user who belongs to both. Requests without a workspace are 404 (TENANTS.REQUIRED).
import { assertTenantIsolation } from '@ghuri/tenants/testing'
import { VectorDocument } from '@ghuri/vectors'
import { describe, expect, it } from 'vitest'
import { Document } from '../src/knowledge/models'
import { documents } from '../src/knowledge/vectors'
import { Conversation } from '../src/support/models'
import { Workspace } from '../src/workspaces/models'
import { as, drain, makeUser, makeWorkspace, runAsTenant, upload, useHarness, using } from './helpers'

describe(`tenant isolation (${using})`, () => {
  const h = useHarness()

  async function twoWorkspaces() {
    const alice = await makeUser('alice') // member of both
    const bob = await makeUser('bob') // member of B only
    const a = await makeWorkspace('acme', [{ user: alice, role: 'owner' }])
    const b = await makeWorkspace('globex', [
      { user: bob, role: 'owner' },
      { user: alice, role: 'member' },
    ])
    const inA = await as(alice, a)
    const inB = await as(alice, b)
    const docA = await upload(h, inA, 'acme.md', 'Acme refunds take ten days. The Acme vault code is rosebud.')
    const docB = await upload(h, inB, 'globex.md', 'Globex refunds take three days. Globex ships by sea.')
    return { alice, bob, a, b, inA, inB, docA: docA.data, docB: docB.data }
  }

  it('requires a workspace, and membership in it', async () => {
    const { alice, bob, a, docA } = await twoWorkspaces()
    expect((await h.api.get('/api/documents/', undefined, { headers: await as(alice) })).status).toBe(404)
    expect((await h.api.get('/api/documents/', undefined, { headers: await as(alice, 'nope') })).status).toBe(404)
    const bobInA = await as(bob, a)
    expect((await h.api.get('/api/documents/', undefined, { headers: bobInA })).status).toBe(403)
    expect((await h.api.get(`/api/documents/${docA.id}/`, undefined, { headers: bobInA })).status).toBe(403)
    expect((await h.api.post('/agents/support/chat', { message: 'vault code?' }, { headers: bobInA })).status).toBe(
      403,
    )
    const anonymous = await h.api.get('/api/documents/', undefined, { headers: { 'X-Workspace': 'acme' } })
    expect(anonymous.status).toBe(401)
  })

  it("keeps each workspace's documents to itself", async () => {
    const { a, b, inA, inB, docA, docB } = await twoWorkspaces()
    const listA = await h.api.get('/api/documents/', undefined, { headers: inA })
    expect(listA.data.results.map((d: any) => d.id)).toEqual([docA.id])
    const listB = await h.api.get('/api/documents/', undefined, { headers: inB })
    expect(listB.data.results.map((d: any) => d.id)).toEqual([docB.id])
    // Another workspace's document is a 404, even for a member of both.
    expect((await h.api.get(`/api/documents/${docB.id}/`, undefined, { headers: inA })).status).toBe(404)
    expect((await h.api.delete(`/api/documents/${docB.id}/`, undefined, { headers: inA })).status).toBe(404)
    expect((await h.api.post(`/api/documents/${docB.id}/reindex/`, undefined, { headers: inA })).status).toBe(404)

    await assertTenantIsolation({
      tenants: [a, b],
      models: [Document, Conversation],
      run: async () => (await Document.objects.all().fetch()).map((d) => d.pk),
    })
  })

  it('searches only the current workspace’s vectors', async () => {
    const { a, b } = await twoWorkspaces()
    const hitsA = await runAsTenant(a, () => documents.search('refunds days vault', { k: 10 }))
    const hitsB = await runAsTenant(b, () => documents.search('refunds days vault', { k: 10 }))
    expect(hitsA.length).toBeGreaterThan(0)
    expect(hitsA.every((x) => x.text?.includes('Acme'))).toBe(true)
    expect(hitsB.every((x) => x.text?.includes('Globex'))).toBe(true)
    // Each workspace has its own namespace in the store.
    const namespaces = new Set((await VectorDocument.objects.all().fetch()).map((r) => r.namespace))
    expect(namespaces.size).toBe(2)
    // No workspace, no search (fail closed).
    await expect(documents.search('refunds')).rejects.toThrow(/tenant/i)
  })

  it("never lets the agent read another workspace's documents", async () => {
    const { inA, inB } = await twoWorkspaces()
    const inGlobex = await h.api.post('/agents/support/chat', { message: 'vault code rosebud' }, { headers: inB })
    expect(inGlobex.status).toBe(200)
    expect(inGlobex.data.text).not.toContain('rosebud')
    expect(inGlobex.data.text).toContain('Globex')
    const inAcme = await h.api.post('/agents/support/chat', { message: 'vault code' }, { headers: inA })
    expect(inAcme.data.text).toContain('rosebud')
  })

  it("keeps conversations in their workspace: another workspace's id is a 404", async () => {
    const { inA, inB } = await twoWorkspaces()
    const chatA = await h.api.post('/agents/support/chat', { message: 'refunds' }, { headers: inA })
    const idA = chatA.data.conversationId
    const chatB = await h.api.post('/agents/support/chat', { message: 'refunds' }, { headers: inB })
    const idB = chatB.data.conversationId

    const listA = await h.api.get('/agents/support/conversations/', undefined, { headers: inA })
    expect(listA.data.results.map((c: any) => c.id)).toEqual([idA])
    const listB = await h.api.get('/agents/support/conversations/', undefined, { headers: inB })
    expect(listB.data.results.map((c: any) => c.id)).toEqual([idB])

    expect((await h.api.get(`/agents/support/conversations/${idA}/`, undefined, { headers: inB })).status).toBe(404)
    expect(
      (await h.api.post('/agents/support/chat', { message: 'more', conversationId: idA }, { headers: inB })).status,
    ).toBe(404)
    expect((await h.api.delete(`/agents/support/conversations/${idA}/`, undefined, { headers: inB })).status).toBe(
      404,
    )
    // Background runs too: a conversation id of another workspace is refused before anything is queued.
    const ask = await h.api.post('/api/ask/', { message: 'more', conversationId: idA }, { headers: inB })
    expect(ask.status).toBe(404)
    expect(await drain()).toBe(0)
  })

  it("keeps a background run's results in its workspace", async () => {
    const { inA, inB } = await twoWorkspaces()
    const ask = await h.api.post('/api/ask/', { message: 'vault code' }, { headers: inA })
    expect(ask.status).toBe(202)
    await drain()
    const own = await h.api.get(`/api/ask/${ask.data.task}/`, undefined, { headers: inA })
    expect(own.data.answer.text).toContain('rosebud')
    expect((await h.api.get(`/api/ask/${ask.data.task}/`, undefined, { headers: inB })).status).toBe(404)
  })

  it("deletes a workspace's vectors with the workspace", async () => {
    const { a, b } = await twoWorkspaces()
    await Workspace.objects.filter({ pk: a.pk }).delete()
    const left = (await VectorDocument.objects.all().fetch()).map((r) => r.namespace)
    expect(left).toHaveLength(1)
    expect(await runAsTenant(b, () => documents.keys())).toHaveLength(1)
    const fake = h.env.VECTORIZE as { vectors: Map<string, { namespace?: string }> } | undefined
    if (fake) expect(new Set([...fake.vectors.values()].map((v) => v.namespace))).toEqual(new Set(left))
  })
})
