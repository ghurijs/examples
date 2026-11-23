import { CharField, ModelSerializer } from '@ghuri/rest'
import { Document } from './models'

export class DocumentSerializer extends ModelSerializer<Document> {
  /** The stored name. Uploads are private to the workspace, so no public URL is returned (no serveMedia() route). */
  fileName = new CharField({ source: 'file.name', readOnly: true })

  static Meta = {
    model: Document,
    fields: ['id', 'title', 'file', 'fileName', 'size', 'status', 'chunks', 'error', 'createdAt', 'indexedAt'],
    readOnlyFields: ['size', 'status', 'chunks', 'error', 'indexedAt'],
    extraKwargs: { file: { writeOnly: true } },
  }
}
