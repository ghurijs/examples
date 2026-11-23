// Membership checks. A tenant resolver only says which workspace a request is for (X-Workspace); whether the user
// may act in it is a permission (@ghuri/tenants has no membership permission class yet).
import { type APIRequest, BasePermission } from '@ghuri/rest'
import { currentTenant } from '@ghuri/tenants'
import { Membership } from './models'

async function role(request: APIRequest): Promise<string | null> {
  const user = request.user as { isAuthenticated?: boolean; pk?: unknown } | undefined
  if (!user?.isAuthenticated || !currentTenant()) return null
  const m = await Membership.objects.filter({ user: user.pk as number }).first()
  return m?.role ?? null
}

/** The user belongs to the request's workspace. */
export class IsWorkspaceMember extends BasePermission {
  message = 'You are not a member of this workspace.'
  async hasPermission(request: APIRequest): Promise<boolean> {
    return (await role(request)) !== null
  }
}

/** The user owns the request's workspace (billing, members). */
export class IsWorkspaceOwner extends BasePermission {
  message = 'Only the workspace owner can do this.'
  async hasPermission(request: APIRequest): Promise<boolean> {
    return (await role(request)) === 'owner'
  }
}

/** Owners may write, members may read. */
export class IsOwnerOrReadOnly extends BasePermission {
  message = 'Only the workspace owner can do this.'
  async hasPermission(request: APIRequest): Promise<boolean> {
    const r = await role(request)
    if (r === null) return false
    return r === 'owner' || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)
  }
}
