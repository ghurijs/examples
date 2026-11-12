// An offline "language model" for local development and demos (no API key, no network): it lists posts
// with the agent's `posts_list` tool and summarizes the result. Registered as the `fake` provider when
// DEBUG is on (see BlogConfig.ready); select it with AGENT_MODEL=fake:blog.
import { registerProvider } from '@ghuri/agents'

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
}

function lastToolResult(prompt: any[]): any {
  const last = prompt.at(-1)
  if (last?.role !== 'tool') return undefined
  const part = last.content.find((p: any) => p.type === 'tool-result')
  return part?.output?.value ?? part?.output
}

let calls = 0

/** One step: call `posts_list` first, then answer from its result. */
function step(prompt: any[]): { content: any[]; finishReason: any } {
  const result = lastToolResult(prompt)
  if (result === undefined) {
    const call = { type: 'tool-call', toolCallId: `call_${++calls}`, toolName: 'posts_list', input: '{}' }
    return { content: [call], finishReason: { unified: 'tool-calls', raw: undefined } }
  }
  const posts = (result.results ?? []).map((p: any) => p.title)
  const text = `I can see ${result.count ?? posts.length} post(s): ${posts.join(', ') || 'none'}.`
  return { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: undefined } }
}

export function registerFakeProvider(): void {
  registerProvider('fake', async (modelId) => {
    const { MockLanguageModelV4, convertArrayToReadableStream } = await import('ai/test')
    return new MockLanguageModelV4({
      provider: 'fake',
      modelId,
      doGenerate: async ({ prompt }: any) => ({ ...step(prompt), usage, warnings: [] }),
      doStream: async ({ prompt }: any) => {
        const { content, finishReason } = step(prompt)
        const chunks: any[] = [{ type: 'stream-start', warnings: [] }]
        for (const part of content) {
          if (part.type !== 'text') chunks.push(part)
          else chunks.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: part.text }, { type: 'text-end', id: 't' })
        }
        chunks.push({ type: 'finish', finishReason, usage })
        return { stream: convertArrayToReadableStream(chunks) }
      },
    }) as any
  })
}
