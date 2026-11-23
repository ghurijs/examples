// An offline "language model" for local development, demos and tests (no API key, no network): it searches the
// workspace's documents with the agent's retrieval tool, then answers with the best passage. Registered as the
// `fake` provider (AGENT_MODEL=fake:agentdesk) when DEBUG is on, and by the tests.
import { registerProvider } from '@ghuri/agents'

/** Tokens reported per model call (two calls per question: search, then answer). */
export const FAKE_USAGE = { input: 100, output: 20 }

const usage = {
  inputTokens: { total: FAKE_USAGE.input, noCache: FAKE_USAGE.input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: FAKE_USAGE.output, text: FAKE_USAGE.output, reasoning: undefined },
}

function lastToolResult(prompt: any[]): any {
  const last = prompt.at(-1)
  if (last?.role !== 'tool') return undefined
  const part = last.content.find((p: any) => p.type === 'tool-result')
  return part?.output?.value ?? part?.output
}

function lastUserText(prompt: any[]): string {
  const msg = [...prompt].reverse().find((m: any) => m.role === 'user')
  if (!msg) return ''
  if (typeof msg.content === 'string') return msg.content
  return msg.content
    .filter((p: any) => p.type === 'text')
    .map((p: any) => p.text)
    .join(' ')
}

let calls = 0

function step(prompt: any[], tools: any[] | undefined): { content: any[]; finishReason: any } {
  const result = lastToolResult(prompt)
  const search = tools?.find((t: any) => String(t.name).startsWith('search_'))
  if (result === undefined && search) {
    const input = JSON.stringify({ query: lastUserText(prompt) })
    const call = { type: 'tool-call', toolCallId: `call_${++calls}`, toolName: search.name, input }
    return { content: [call], finishReason: { unified: 'tool-calls', raw: undefined } }
  }
  const best = result?.results?.[0]
  const text = best
    ? `According to "${best.metadata?.title ?? best.key}": ${String(best.text ?? '').trim()}`
    : "I couldn't find anything about that in this workspace's documents."
  return { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: undefined } }
}

export function registerFakeProvider(): void {
  registerProvider('fake', async (modelId) => {
    const { MockLanguageModelV4, convertArrayToReadableStream } = await import('ai/test')
    return new MockLanguageModelV4({
      provider: 'fake',
      modelId,
      doGenerate: async ({ prompt, tools }: any) => ({ ...step(prompt, tools), usage, warnings: [] }),
      doStream: async ({ prompt, tools }: any) => {
        const { content, finishReason } = step(prompt, tools)
        const chunks: any[] = [{ type: 'stream-start', warnings: [] }]
        for (const part of content) {
          if (part.type !== 'text') chunks.push(part)
          else
            chunks.push(
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: part.text },
              { type: 'text-end', id: 't' },
            )
        }
        chunks.push({ type: 'finish', finishReason, usage })
        return { stream: convertArrayToReadableStream(chunks) }
      },
    }) as any
  })
}
