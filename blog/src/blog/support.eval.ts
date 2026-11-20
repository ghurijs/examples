// Eval for the support agent: `npx ghuri eval`. It runs offline with the fake model; compare real models with
//   npx ghuri eval --models anthropic:claude-haiku-5-5,anthropic:claude-opus-5-5
// (that calls the providers and costs money). Like the tests, it runs against a fresh test database.
import { PBKDF2PasswordHasher, User } from '@ghuri/auth'
import { createApp } from '@ghuri/core'
import {
  answerMatches,
  calledTool,
  defineEval,
  formatEvalReport,
  maxSteps,
  noToolErrors,
  notCalledTool,
  runEval,
} from '@ghuri/agents/evals'
import { setupTestDatabase, type TestBackend, type TestDatabase } from '@ghuri/orm/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import settings from '../settings'
import { SupportAgent } from './agents'
import { registerFakeProvider } from './fake-model'
import { Post } from './models'

const app = createApp(settings)
let db: TestDatabase

beforeAll(async () => {
  const ctx = await app.setup({ SECRET_KEY: 'test-secret-key', DEBUG: 'false' })
  ctx.settings.PASSWORD_HASHERS = [new PBKDF2PasswordHasher({ iterations: 1000 })]
  db = await setupTestDatabase({ using: (process.env.GHURI_TEST_DB as TestBackend) ?? 'd1' })
  registerFakeProvider()
}, 60_000)

afterAll(async () => {
  await db?.teardown()
})

export const supportEval = defineEval({
  name: 'support',
  agent: SupportAgent,
  models: ['fake:blog'],
  // US dollars per million tokens, to report cost per model.
  prices: {
    'anthropic:claude-haiku-5-5': { input: 0.1, output: 0.5 },
    'anthropic:claude-opus-5-5': { input: 4, output: 20, cachedInput: 0.2 },
  },
  async setup() {
    const editor = await User.objects.createUser('editor', 'editor@example.com', 'pw-editor')
    await Post.objects.create({ title: 'Agents on Workers', slug: 'agents', body: 'Hello agents', author: editor })
    return { user: editor }
  },
  cases: [
    {
      name: 'lists the posts',
      input: 'Which posts are there?',
      checks: [
        calledTool('posts_list'),
        notCalledTool('posts_destroy'),
        noToolErrors(),
        answerMatches('Agents on Workers'),
        maxSteps(4),
      ],
    },
  ],
})

it('support agent eval', async () => {
  const report = await runEval(supportEval, { beforeEach: () => db.flush() })
  console.log(formatEvalReport(report))
  for (const summary of report.models) expect(summary.passRate, summary.model).toBeGreaterThanOrEqual(0.8)
})
