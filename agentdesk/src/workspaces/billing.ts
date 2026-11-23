// Billing glue (@ghuri/billing): workspaces are the subscribers. Checkout and the portal run inside the request's
// workspace (X-Workspace), and only its owners may start them.
import { getUser, PermissionDenied } from '@ghuri/core'
import { currentTenant } from '@ghuri/tenants'
import type { Context } from 'hono'
import { Membership, type Workspace } from './models'

/** BILLING.SUBSCRIBER: the request's workspace, when the authenticated user owns it. */
export async function billingSubscriber(c: Context): Promise<Workspace | null> {
  const workspace = currentTenant() as Workspace | null
  const user = getUser(c)
  if (!workspace || !user?.isAuthenticated) return null
  const owner = await Membership.objects.filter({ user: user.pk as number, role: 'owner' }).exists()
  if (!owner) throw new PermissionDenied('Only the workspace owner can manage billing.')
  return workspace
}
