// Offline embeddings for local development and tests: a deterministic bag-of-words embedder from
// @ghuri/vectors/testing, registered as the `fake` embedding provider (EMBEDDING_MODEL=fake:agentdesk) when DEBUG is on.
import { registerEmbeddingProvider } from '@ghuri/vectors'
import { fakeEmbedding } from '@ghuri/vectors/testing'

export function registerFakeEmbeddings(): void {
  registerEmbeddingProvider('fake', (modelId) => fakeEmbedding({ modelId: `fake:${modelId}`, dimensions: 256 }))
}
