// Tests for the blog app — `npx ghuri test` (vitest). They run the real project settings against a fresh test
// database (D1 through Miniflare by default; GHURI_TEST_DB=pglite or sqlite for the others), with the
// migrations applied like Django's test runner does.
import { PBKDF2PasswordHasher, Token, User } from '@ghuri/auth'
import { createApp, type GhuriContext } from '@ghuri/core'
import { toGlobalId } from '@ghuri/graphql'
import {
  assertResponseHasErrors,
  assertResponseNoErrors,
  graphqlQuery,
  payloadErrors,
} from '@ghuri/graphql/testing'
import { setupTestDatabase, type TestBackend, type TestDatabase } from '@ghuri/orm/testing'
import { APIClient } from '@ghuri/rest/testing'
import { memoryStorage } from '@ghuri/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import settings from '../settings'
import { SupportAgent } from './agents'
import { registerFakeProvider } from './fake-model'
import { Comment, Post, Tag } from './models'

const env: Record<string, unknown> = { SECRET_KEY: 'test-secret-key', DEBUG: 'false' }
const app = createApp(settings)
let ctx: GhuriContext
let db: TestDatabase
let api: APIClient

// A 1x1 PNG.
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (ch) => ch.charCodeAt(0),
)

beforeAll(async () => {
  ctx = await app.setup(env)
  ctx.settings.PASSWORD_HASHERS = [new PBKDF2PasswordHasher({ iterations: 1000 })]
  ctx.settings.STORAGES = { default: memoryStorage() }
  db = await setupTestDatabase({ using: (process.env.GHURI_TEST_DB as TestBackend) ?? 'd1' })
  api = new APIClient(app, { env, defaultFormat: 'json' })
}, 60_000)

afterAll(async () => {
  await db?.teardown()
})

beforeEach(async () => {
  await db.flush() // also recreates content types and permissions (postMigrate)
  api.forceAuthenticate(null)
  api.credentials()
  api.client.clearCookies()
})

async function makeUser(username: string, extra: Partial<{ isStaff: boolean; isSuperuser: boolean }> = {}) {
  const user = await User.objects.createUser(username, `${username}@example.com`, `pw-${username}`)
  if (Object.keys(extra).length) {
    Object.assign(user, extra)
    await user.save()
  }
  return user
}

async function tokenFor(user: User): Promise<string> {
  const [token] = await Token.objects.getOrCreate({ user })
  return (token as Token).key
}

async function makePost(author: User, data: Partial<{ title: string; slug: string; published: boolean; body: string }>) {
  return Post.objects.create({
    title: data.title ?? 'Hello',
    slug: data.slug ?? 'hello',
    body: data.body ?? 'Body text',
    published: data.published ?? true,
    author,
  })
}

describe('posts API', () => {
  it('lists only published posts to anonymous users, paginated', async () => {
    const alice = await makeUser('alice')
    for (let i = 1; i <= 12; i++) await makePost(alice, { title: `Post ${i}`, slug: `post-${i}` })
    await makePost(alice, { title: 'Draft', slug: 'draft', published: false })

    const res = await api.get('/api/posts/')
    expect(res.status).toBe(200)
    expect(res.data.count).toBe(12)
    expect(res.data.results).toHaveLength(10)
    expect(res.data.next).toContain('page=2')
    expect(res.data.results[0]).toMatchObject({ authorName: 'alice', published: true, commentCount: 0 })

    const page2 = await api.get('/api/posts/', { page: 2, pageSize: 5 })
    expect(page2.data.results).toHaveLength(5)
    expect((await api.get('/api/posts/draft/')).status).toBe(404)
  })

  it('searches, orders and filters', async () => {
    const alice = await makeUser('alice')
    await makePost(alice, { title: 'Workers and D1', slug: 'workers', body: 'edge' })
    await makePost(alice, { title: 'Postgres on a VPS', slug: 'postgres', body: 'portable' })
    const search = await api.get('/api/posts/', { search: 'postgres' })
    expect(search.data.results.map((p: any) => p.slug)).toEqual(['postgres'])
    const ordered = await api.get('/api/posts/', { ordering: 'title' })
    expect(ordered.data.results.map((p: any) => p.slug)).toEqual(['postgres', 'workers'])
  })

  it('requires authentication to create; the author is the request user', async () => {
    const bob = await makeUser('bob')
    await Tag.objects.create({ name: 'News', slug: 'news' })
    const anon = await api.post('/api/posts/', { title: 'Nope', slug: 'nope' })
    expect(anon.status).toBe(401)

    api.credentials({ Authorization: `Token ${await tokenFor(bob)}` })
    const res = await api.post('/api/posts/', { title: 'Mine', slug: 'mine', body: 'Hi', tags: ['news'] })
    expect(res.status).toBe(201)
    expect(res.data).toMatchObject({ slug: 'mine', author: bob.pk, authorName: 'bob', tags: ['news'] })
    const post = await Post.objects.get({ slug: 'mine' })
    expect(await post.tags.count()).toBe(1)
  })

  it('obtains a JWT pair and uses it', async () => {
    await makeUser('carol')
    const pair = await api.post('/api/auth/jwt/', { username: 'carol', password: 'pw-carol' })
    expect(pair.status).toBe(200)
    api.credentials({ Authorization: `Bearer ${pair.data.access}` })
    const res = await api.post('/api/posts/', { title: 'JWT', slug: 'jwt' })
    expect(res.status).toBe(201)
  })

  it('lets only the author change a post, and publish it with the @action', async () => {
    const alice = await makeUser('alice')
    const mallory = await makeUser('mallory')
    await makePost(alice, { slug: 'draft', published: false })

    api.forceAuthenticate(mallory)
    expect((await api.patch('/api/posts/draft/', { title: 'Hacked' })).status).toBe(404) // drafts are hidden
    await Post.objects.filter({ slug: 'draft' }).update({ published: true })
    expect((await api.patch('/api/posts/draft/', { title: 'Hacked' })).status).toBe(403)

    await Post.objects.filter({ slug: 'draft' }).update({ published: false })
    api.forceAuthenticate(alice)
    const res = await api.post('/api/posts/draft/publish/')
    expect(res.status).toBe(200)
    expect(res.data).toEqual({ status: 'published', slug: 'draft' })
    expect((await Post.objects.get({ slug: 'draft' })).published).toBe(true)
  })

  it('uploads a cover image to the default storage', async () => {
    const alice = await makeUser('alice')
    await makePost(alice, { slug: 'pic' })
    api.forceAuthenticate(alice)
    const file = new File([PNG], 'cover.png', { type: 'image/png' })
    const res = await api.patch('/api/posts/pic/', { cover: file }, { format: 'multipart' })
    expect(res.status).toBe(200)
    expect(res.data.cover).toMatch(/covers\/\d{4}\/\d{2}\/cover.*\.png$/)
    expect(res.data.coverWidth).toBe(1)
    const media = await api.client.get(new URL(res.data.cover, 'http://testserver').pathname)
    expect(media.status).toBe(200)
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(PNG)
  })

  it('creates comments and counts them on the post', async () => {
    const alice = await makeUser('alice')
    const post = await makePost(alice, { slug: 'c' })
    api.forceAuthenticate(alice)
    const res = await api.post('/api/comments/', { post: post.pk, name: 'Ann', email: 'ann@example.com', body: 'Nice' })
    expect(res.status).toBe(201)
    expect(res.data.email).toBeUndefined() // write-only
    expect((await api.get('/api/posts/c/')).data.commentCount).toBe(1)
    expect(await Comment.objects.filter({ post }).count()).toBe(1)
  })
})

describe('OpenAPI', () => {
  it('describes the API', async () => {
    const res = await api.get('/api/schema/', {}, { headers: { Accept: 'application/json' } })
    expect(res.status).toBe(200)
    expect(Object.keys(res.data.paths)).toEqual(
      expect.arrayContaining(['/api/posts/', '/api/posts/{slug}/', '/api/posts/{slug}/publish/']),
    )
    expect(Object.keys(res.data.components.securitySchemes)).toEqual(
      expect.arrayContaining(['tokenAuth', 'jwtAuth']),
    )
  })
})

describe('admin', () => {
  it('shows the post changelist to a superuser', async () => {
    const admin = await makeUser('admin', { isStaff: true, isSuperuser: true })
    await makePost(admin, { title: 'In the admin', slug: 'in-admin' })
    await api.client.forceLogin(admin)
    const res = await api.client.get('/admin/blog/post/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('In the admin')
  })
})

describe('agents and MCP', () => {
  it('runs the support agent with the offline model', async () => {
    registerFakeProvider()
    const alice = await makeUser('alice')
    await makePost(alice, { title: 'Agents on Workers', slug: 'agents' })
    class OfflineAgent extends SupportAgent {
      model = 'fake:blog'
    }
    const result = await new OfflineAgent().run('Which posts are there?', { user: alice })
    expect(result.text).toBe('I can see 1 post(s): Agents on Workers.')
    expect(result.toolCalls.map((c) => c.toolName)).toEqual(['posts_list'])
  })

  it('serves the tools over MCP to token holders', async () => {
    const alice = await makeUser('alice')
    const rpc = (method: string, id: number) => ({ jsonrpc: '2.0', id, method, params: {} })
    expect((await api.post('/mcp/', rpc('tools/list', 1))).status).toBe(401)
    api.credentials({ Authorization: `Token ${await tokenFor(alice)}` })
    const res = await api.post('/mcp/', rpc('tools/list', 2))
    expect(res.status).toBe(200)
    const names = res.data.result.tools.map((t: any) => t.name)
    expect(names).toEqual(expect.arrayContaining(['posts_list', 'posts_retrieve', 'tags_list', 'ask_support']))
  })
})

describe('GraphQL', () => {
  const gql = (query: string, opts: { variables?: Record<string, unknown>; token?: string } = {}) =>
    graphqlQuery(api.client, query, {
      variables: opts.variables,
      headers: opts.token ? { Authorization: `Token ${opts.token}` } : undefined,
    })

  it('queries posts with their author, tags and comments (drafts hidden)', async () => {
    const alice = await makeUser('alice')
    const news = await Tag.objects.create({ name: 'News', slug: 'news' })
    const post = await makePost(alice, { title: 'Hello GraphQL', slug: 'hello-graphql' })
    await post.tags.add(news)
    await Comment.objects.create({ post, name: 'Ann', body: 'Nice', email: 'ann@example.com' })
    await Comment.objects.create({ post, name: 'Spam', body: 'Buy now', approved: false })
    await makePost(alice, { title: 'Draft', slug: 'draft', published: false })

    const res = await gql(`{
      allPosts {
        totalCount
        edges { node { id title excerpt author { username } tags { edges { node { slug } } }
                       comments { totalCount edges { node { name body } } } } }
      }
    }`)
    assertResponseNoErrors(res)
    expect(res.data.allPosts.totalCount).toBe(1)
    const node = res.data.allPosts.edges[0].node
    expect(node).toMatchObject({ id: toGlobalId('PostType', post.pk), title: 'Hello GraphQL', author: { username: 'alice' } })
    expect(node.tags.edges.map((e: any) => e.node.slug)).toEqual(['news'])
    expect(node.comments.totalCount).toBe(1) // only approved comments
    expect(node.comments.edges[0].node).toEqual({ name: 'Ann', body: 'Nice' })

    const one = await gql('query ($id: ID!) { post(id: $id) { slug } node(id: $id) { ... on PostType { title } } }', {
      variables: { id: toGlobalId('PostType', post.pk) },
    })
    assertResponseNoErrors(one)
    expect(one.data).toEqual({ post: { slug: 'hello-graphql' }, node: { title: 'Hello GraphQL' } })
  })

  it('filters, orders and paginates allPosts', async () => {
    const alice = await makeUser('alice')
    for (let i = 1; i <= 5; i++) await makePost(alice, { title: `Workers ${i}`, slug: `workers-${i}` })
    await makePost(alice, { title: 'Postgres on a VPS', slug: 'postgres' })

    const filtered = await gql('{ allPosts(filter: { title: { icontains: "postgres" } }) { edges { node { slug } } } }')
    assertResponseNoErrors(filtered)
    expect(filtered.data.allPosts.edges.map((e: any) => e.node.slug)).toEqual(['postgres'])

    const query = `query ($after: String) {
      allPosts(first: 2, after: $after, filter: { title: { istartswith: "workers" } }, orderBy: ["title"]) {
        totalCount pageInfo { hasNextPage endCursor } edges { node { slug } }
      }
    }`
    const page1 = await gql(query)
    assertResponseNoErrors(page1)
    expect(page1.data.allPosts.totalCount).toBe(5)
    expect(page1.data.allPosts.edges.map((e: any) => e.node.slug)).toEqual(['workers-1', 'workers-2'])
    expect(page1.data.allPosts.pageInfo.hasNextPage).toBe(true)
    const page2 = await gql(query, { variables: { after: page1.data.allPosts.pageInfo.endCursor } })
    expect(page2.data.allPosts.edges.map((e: any) => e.node.slug)).toEqual(['workers-3', 'workers-4'])
  })

  it('requires authentication for mutations', async () => {
    const res = await gql('mutation { createPost(input: { title: "Nope", slug: "nope" }) { id } }')
    assertResponseHasErrors(res, { code: 'UNAUTHENTICATED' })
    expect(await Post.objects.count()).toBe(0)
    const me = await gql('{ me { username } }')
    expect(me.data).toEqual({ me: null })
  })

  it('creates a post through PostSerializer, with validation errors in the payload', async () => {
    const bob = await makeUser('bob')
    const token = await tokenFor(bob)
    await Tag.objects.create({ name: 'News', slug: 'news' })
    await makePost(bob, { slug: 'taken' })
    const mutation = `mutation ($input: CreatePostInput!) {
      createPost(input: $input) { id slug authorName tags errors { field messages } clientMutationId }
    }`

    const invalid = await gql(mutation, { token, variables: { input: { title: '', slug: 'taken' } } })
    assertResponseNoErrors(invalid)
    expect(Object.keys(payloadErrors(invalid.data.createPost)).sort()).toEqual(['slug', 'title'])

    const res = await gql(mutation, {
      token,
      variables: { input: { title: 'Mine', slug: 'mine', body: 'Hi', tags: ['news'], clientMutationId: 'c1' } },
    })
    assertResponseNoErrors(res)
    expect(res.data.createPost).toMatchObject({ slug: 'mine', authorName: 'bob', tags: ['news'], errors: [], clientMutationId: 'c1' })
    const post = await Post.objects.get({ slug: 'mine' })
    expect(post.authorId).toBe(bob.pk)
    expect(await post.tags.count()).toBe(1)
  })

  it('lets only the author update or delete a post', async () => {
    const alice = await makeUser('alice')
    const mallory = await makeUser('mallory')
    const post = await makePost(alice, { title: 'Original', slug: 'original' })
    const id = toGlobalId('PostType', post.pk)
    const update = 'mutation ($id: ID!) { updatePost(input: { id: $id, title: "Changed" }) { title errors { field messages } } }'
    const remove = 'mutation ($id: ID!) { deletePost(input: { id: $id }) { ok deletedId } }'

    const denied = await gql(update, { token: await tokenFor(mallory), variables: { id } })
    assertResponseHasErrors(denied, { code: 'PERMISSION_DENIED' })
    assertResponseHasErrors(await gql(remove, { token: await tokenFor(mallory), variables: { id } }), {
      code: 'PERMISSION_DENIED',
    })

    const aliceToken = await tokenFor(alice)
    const ok = await gql(update, { token: aliceToken, variables: { id } })
    assertResponseNoErrors(ok)
    expect(ok.data.updatePost).toEqual({ title: 'Changed', errors: [] })
    const deleted = await gql(remove, { token: aliceToken, variables: { id } })
    assertResponseNoErrors(deleted)
    expect(deleted.data.deletePost.ok).toBe(true)
    expect(await Post.objects.filter({ pk: post.pk }).exists()).toBe(false)
  })

  it('accepts session POSTs only with the CSRF token', async () => {
    const alice = await makeUser('alice')
    await api.client.forceLogin(alice)
    const me = await graphqlQuery(api.client, '{ me { username } }')
    expect(me.data).toEqual({ me: { username: 'alice' } })
    const noCsrf = await graphqlQuery(api.client, '{ me { username } }', { csrf: false })
    expect(noCsrf.status).toBe(403)
  })
})
