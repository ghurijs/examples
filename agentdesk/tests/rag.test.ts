// Upload → embed → ask: a member uploads a document, the `knowledge.embedDocument` task chunks and embeds it into the
// workspace's vector index, and the support agent answers from it (JSON, SSE, with memory, and in the background).
import { describe, expect, it } from 'vitest'
import { Document } from '../src/knowledge/models'
import { documents } from '../src/knowledge/vectors'
import { Conversation } from '../src/support/models'
import { as, drain, makeUser, makeWorkspace, runAsTenant, upload, useHarness, using } from './helpers'

const REFUNDS = `# Refund policy

Customers can ask for a refund within 30 days of purchase. Refunds go back to the original card and take five
business days. Annual plans are refunded pro rata after the first month.

# Shipping

We ship worldwide with DHL. Orders leave the warehouse within two days.`

describe(`upload → embed → ask (${using})`, () => {
  const h = useHarness()

  it('embeds an upload in the background, then the agent answers from it', async () => {
    const alice = await makeUser('alice')
    const acme = await makeWorkspace('acme', [{ user: alice, role: 'owner' }])
    const headers = await as(alice, acme)

    const res = await upload(h, headers, 'refunds.md', REFUNDS, { drain: false })
    expect(res.status).toBe(201)
    expect(res.data).toMatchObject({ title: 'refunds.md', status: 'pending', size: REFUNDS.length })
    // The stored name, not a public URL: uploads are private to the workspace.
    expect(res.data.fileName).toMatch(/^documents\/\d{4}\/\d{2}\/refunds.*\.md$/)
    expect(res.data.file).toBeUndefined()
    expect(await drain()).toBe(1)

    const doc = await h.api.get(`/api/documents/${res.data.id}/`, undefined, { headers })
    expect(doc.data).toMatchObject({ status: 'ready', error: '' })
    expect(doc.data.chunks).toBeGreaterThan(0)
    expect(await runAsTenant(acme, () => documents.keys())).toEqual([res.data.id])

    const chat = await h.api.post('/agents/support/chat', { message: 'How long do refunds take?' }, { headers })
    expect(chat.status).toBe(200)
    expect(chat.data.text).toContain('According to "refunds.md"')
    expect(chat.data.text).toContain('five')
    expect(chat.data.toolCalls.map((c: any) => c.toolName)).toEqual(['search_knowledge_documents'])
    expect(chat.data.usage.totalTokens).toBe(240)
  })

  it('keeps conversation memory, scoped to the workspace', async () => {
    const alice = await makeUser('alice')
    const acme = await makeWorkspace('acme', [{ user: alice }])
    const headers = await as(alice, acme)
    await upload(h, headers, 'refunds.md', REFUNDS)

    const first = await h.api.post('/agents/support/chat', { message: 'refund card' }, { headers })
    const conversationId = first.data.conversationId
    const second = await h.api.post(
      '/agents/support/chat',
      { message: 'shipping DHL warehouse', conversationId },
      { headers },
    )
    expect(second.status).toBe(200)
    expect(second.data.conversationId).toBe(conversationId)
    expect(second.data.text).toContain('DHL')

    const detail = await h.api.get(`/agents/support/conversations/${conversationId}/`, undefined, { headers })
    expect(detail.status).toBe(200)
    const roles = detail.data.messages.map((m: any) => m.role)
    expect(roles.filter((r: string) => r === 'user')).toHaveLength(2)
    expect(roles.filter((r: string) => r === 'assistant').length).toBeGreaterThanOrEqual(2)
    const conv = await runAsTenant(acme, () => Conversation.objects.get({ pk: conversationId }))
    expect(conv.workspaceId).toBe(acme.pk)
  })

  it('streams the answer as server-sent events', async () => {
    const alice = await makeUser('alice')
    const acme = await makeWorkspace('acme', [{ user: alice }])
    const headers = await as(alice, acme)
    await upload(h, headers, 'refunds.md', REFUNDS)

    const res = await h.api.post('/agents/support/chat?stream=1', { message: 'refund days' }, { headers })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const conversationId = res.headers.get('x-conversation-id')
    expect(conversationId).toBeTruthy()
    const body = await res.text()
    expect(body).toContain('"type":"tool-input-available"')
    expect(body).toContain('search_knowledge_documents')
    expect(body).toContain('According to')
    expect(body.trim().endsWith('data: [DONE]')).toBe(true)
    // The stream closes after the conversation was saved.
    expect(await runAsTenant(acme, () => Conversation.objects.filter({ pk: conversationId! }).exists())).toBe(true)
  })

  it('answers in the background with agent.enqueue() on @ghuri/tasks', async () => {
    const alice = await makeUser('alice')
    const acme = await makeWorkspace('acme', [{ user: alice }])
    const headers = await as(alice, acme)
    await upload(h, headers, 'refunds.md', REFUNDS)

    const res = await h.api.post('/api/ask/', { message: 'How long do refunds take?' }, { headers })
    expect(res.status).toBe(202)
    const { conversationId, task } = res.data
    expect(conversationId).toBeTruthy()
    expect(task).toBeTruthy()
    const pending = await h.api.get(`/api/ask/${task}/`, undefined, { headers })
    expect(pending.data).toMatchObject({ status: 'READY', answer: null })

    expect(await drain()).toBe(1)
    const done = await h.api.get(`/api/ask/${task}/`, undefined, { headers })
    expect(done.data.status).toBe('SUCCESSFUL')
    expect(done.data.answer.text).toContain('take five')
    // The queued run kept its workspace (carried tenant) and wrote to the conversation created up front.
    const conv = await h.api.get(`/agents/support/conversations/${conversationId}/`, undefined, { headers })
    expect(conv.data.messages.map((m: any) => m.role)).toContain('assistant')
  })

  it('re-embeds only changed documents and forgets deleted ones', async () => {
    const alice = await makeUser('alice')
    const acme = await makeWorkspace('acme', [{ user: alice }])
    const headers = await as(alice, acme)
    const res = await upload(h, headers, 'refunds.md', REFUNDS)
    const id = res.data.id

    const again = await h.api.post(`/api/documents/${id}/reindex/`, undefined, { headers })
    expect(again.status).toBe(200)
    await drain()
    const doc = await runAsTenant(acme, () => Document.objects.get({ pk: id }))
    expect(doc.status).toBe('ready')

    const del = await h.api.delete(`/api/documents/${id}/`, undefined, { headers })
    expect(del.status).toBe(204)
    await drain()
    expect(await runAsTenant(acme, () => documents.keys())).toEqual([])
    const chat = await h.api.post('/agents/support/chat', { message: 'refund days' }, { headers })
    expect(chat.data.text).toContain("couldn't find")
  })

  it('refuses files it cannot read', async () => {
    const alice = await makeUser('alice')
    const acme = await makeWorkspace('acme', [{ user: alice }])
    const headers = await as(alice, acme)
    const pdf = await upload(h, headers, 'scan.pdf', '%PDF-1.7', { drain: false })
    expect(pdf.status).toBe(400)
    expect(pdf.data.file).toBeDefined()
    const empty = await upload(h, headers, 'empty.txt', '   ')
    expect(empty.status).toBe(201)
    const doc = await h.api.get(`/api/documents/${empty.data.id}/`, undefined, { headers })
    expect(doc.data).toMatchObject({ status: 'failed', error: 'The document has no text.' })
  })
})
