// Uploaded documents of a workspace. The file goes to the default storage (R2 on Workers, the disk on Node); the
// `knowledge.embedDocument` task chunks and embeds its text into the `knowledge.documents` vector index.
import { User } from '@ghuri/auth'
import {
  CharField,
  DateTimeField,
  ForeignKey,
  IntegerField,
  type Manager,
  SET_NULL,
  TextField,
  UUIDField,
} from '@ghuri/orm'
import { FileExtensionValidator, FileField } from '@ghuri/storage'
import { uuid7 } from '@ghuri/tenants'
import { WorkspaceModel } from '../workspaces/models'

export const STATUSES = [
  ['pending', 'Pending'],
  ['indexing', 'Indexing'],
  ['ready', 'Ready'],
  ['failed', 'Failed'],
] as const

/** Text formats the embed task can read without a parser (PDF / DOCX extraction is out of scope here). */
export const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'csv', 'json', 'html']

export class Document extends WorkspaceModel({
  id: new UUIDField({ primaryKey: true, default: uuid7, editable: false }),
  title: new CharField({ maxLength: 200, blank: true }),
  file: new FileField({
    uploadTo: 'documents/%Y/%m/',
    maxLength: 255,
    validators: [new FileExtensionValidator(TEXT_EXTENSIONS)],
  }),
  size: new IntegerField({ default: 0 }),
  status: new CharField({
    maxLength: 10,
    choices: STATUSES as unknown as [string, string][],
    default: 'pending',
    dbIndex: true,
  }),
  chunks: new IntegerField({ default: 0 }),
  error: new TextField({ blank: true, default: '' }),
  uploadedBy: new ForeignKey(() => User, { null: true, blank: true, onDelete: SET_NULL, relatedName: '+' }),
  createdAt: new DateTimeField({ autoNowAdd: true }),
  indexedAt: new DateTimeField({ null: true, blank: true }),
}) {
  declare static objects: Manager<Document>
  declare static unscoped: Manager<Document>
  static Meta = { ordering: ['-createdAt'] }

  toString(): string {
    return this.title || String(this.file)
  }
}
