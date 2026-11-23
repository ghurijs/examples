// Admin registrations for the knowledge app (@ghuri/admin).
import { admin, ModelAdmin } from '@ghuri/admin'
import { Document } from './models'

@admin.register(Document)
export class DocumentAdmin extends ModelAdmin<Document> {
  listDisplay = ['title', 'workspace', 'status', 'chunks', 'size', 'createdAt']
  listFilter = ['status']
  searchFields = ['title']
  readonlyFields = ['size', 'status', 'chunks', 'error', 'createdAt', 'indexedAt']
}
