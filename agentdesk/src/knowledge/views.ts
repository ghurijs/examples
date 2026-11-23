// Documents API: members upload text documents; each upload is embedded in the background.
import { User } from '@ghuri/auth'
import { getEntitlements } from '@ghuri/billing'
import { onCommit } from '@ghuri/orm'
import {
  type APIRequest,
  action,
  CreateModelMixin,
  DestroyModelMixin,
  GenericViewSet,
  IsAuthenticated,
  ListModelMixin,
  PermissionDenied,
  RetrieveModelMixin,
  ValidationError,
} from '@ghuri/rest'
import { requireTenant } from '@ghuri/tenants'
import { IsWorkspaceMember } from '../workspaces/permissions'
import { Document } from './models'
import { DocumentSerializer } from './serializers'
import { embedDocument, forgetDocument } from './tasks'

/** Largest upload accepted (bytes). */
export const MAX_UPLOAD = 1_000_000

/**
 * `GET /api/documents/`, `POST /api/documents/` (multipart: `file`, optional `title`), `GET|DELETE
 * /api/documents/<id>/`, `POST /api/documents/<id>/reindex/`. Throttled with the `uploads` scope.
 */
export class DocumentViewSet extends CreateModelMixin(
  DestroyModelMixin(RetrieveModelMixin(ListModelMixin(GenericViewSet))),
) {
  queryset = Document.objects.all()
  serializerClass = DocumentSerializer
  permissionClasses = [IsAuthenticated, IsWorkspaceMember]

  /** The `uploads` rate applies to uploads only (DRF applies a view's throttle scope to every method). */
  getThrottles() {
    ;(this as { throttleScope?: string }).throttleScope = this.action === 'create' ? 'uploads' : undefined
    return super.getThrottles()
  }

  async performCreate(serializer: DocumentSerializer): Promise<void> {
    const file = (this.request.data as Record<string, unknown> | undefined)?.file
    if (!(file instanceof Blob)) throw new ValidationError({ file: ['No file was submitted.'] })
    if (file.size > MAX_UPLOAD) throw new ValidationError({ file: [`The file is larger than ${MAX_UPLOAD} bytes.`] })

    // The plan caps the number of documents (BILLING.PLANS[…].limits.documents).
    const { limits, plan } = await getEntitlements(requireTenant())
    const max = limits.documents as number | undefined
    if (max !== undefined && (await Document.objects.count()) >= max)
      throw new PermissionDenied(`The ${plan} plan allows ${max} documents. Upgrade to add more.`)

    const name = file instanceof File ? file.name : 'document.txt'
    const title = (serializer.validatedData.title as string | undefined) || name
    const doc = (await serializer.save({ title, size: file.size, uploadedBy: this.request.user as User })) as Document
    // Embed after the row is committed, in the background (Queues on Workers, `ghuri db_worker` on Node).
    await onCommit(() => embedDocument.enqueue(String(doc.pk)))
  }

  async performDestroy(instance: Document): Promise<void> {
    const id = String(instance.pk)
    await instance.file.delete({ save: false })
    await instance.delete()
    await onCommit(() => forgetDocument.enqueue(id))
  }

  @action({ detail: true, methods: ['post'] })
  async reindex(_request: APIRequest) {
    const doc = (await this.getObject()) as Document
    await Document.objects.filter({ pk: doc.pk }).update({ status: 'pending' })
    const result = await embedDocument.enqueue(String(doc.pk))
    return { id: doc.pk, task: result.id }
  }
}
