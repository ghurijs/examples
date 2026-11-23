// Background tasks of the knowledge app (@ghuri/tasks). Named 'knowledge.<export name>'. They run with the
// workspace that enqueued them (the tenant is a carried context), so `Document.objects` and the vector index are
// scoped to it.
import { task } from '@ghuri/tasks'
import { Document } from './models'
import { documents } from './vectors'

/** Largest text we embed per document (characters); the rest is cut off. */
export const MAX_TEXT = 200_000

/** Read an uploaded document, chunk and embed it into the workspace's vector index. */
export const embedDocument = task(
  async (documentId: string) => {
    const doc = await Document.objects.filter({ pk: documentId }).first()
    if (!doc) return { documentId, skipped: 'deleted' }
    await Document.objects.filter({ pk: doc.pk }).update({ status: 'indexing', error: '' })
    try {
      const stored = await doc.file.open()
      if (!stored) throw new Error(`The file '${doc.file.name}' is missing from storage.`)
      const text = (await stored.text()).slice(0, MAX_TEXT)
      if (!text.trim()) throw new Error('The document has no text.')
      const result = await documents.index({
        key: String(doc.pk),
        text,
        metadata: { title: doc.title || String(doc.file.name) },
      })
      const chunks = result.chunks || doc.chunks
      await Document.objects
        .filter({ pk: doc.pk })
        .update({ status: 'ready', chunks, indexedAt: new Date() })
      return { documentId, chunks, skipped: result.skipped > 0 }
    } catch (err) {
      await Document.objects
        .filter({ pk: doc.pk })
        .update({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  },
  { maxAttempts: 3 },
)

/** Remove a deleted document's chunks from the index. */
export const forgetDocument = task(async (documentId: string) => {
  await documents.delete(documentId)
  return { documentId }
})
