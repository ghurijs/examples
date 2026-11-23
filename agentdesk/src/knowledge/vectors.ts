// The workspace knowledge base (@ghuri/vectors). `tenant: 'auto'` (the default) scopes the index to the current
// workspace: the tenant goes into the store namespace, and searching without one raises `TenantRequired`.
import { VectorIndex } from '@ghuri/vectors'

export const documents = new VectorIndex('knowledge.documents', {
  chunk: { size: 800, overlap: 120 },
})
