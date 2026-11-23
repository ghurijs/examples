// TenantMiddleware with TENANTS.REQUIRED, except under platform path prefixes (the admin), which run without tenant
// scoping.
//
// tenantNotRequired() marks single view functions. The admin's URLs are built lazily (admin.site.urls is a Proxy
// that builds its views when the app registry is ready), so there are no view functions to mark when src/urls.ts is
// evaluated, and marking a View class or an include() list silently does nothing. Exempting by path prefix is the
// workaround until @ghuri/tenants can exempt an include().
import { TenantMiddleware, withoutTenant } from '@ghuri/tenants'
import type { Context, Next } from 'hono'

/** Paths whose requests may arrive without a workspace. */
export const PLATFORM_PREFIXES = ['/admin/']

const optional = new TenantMiddleware({ required: false })

export class WorkspaceMiddleware extends TenantMiddleware {
  async handle(c: Context, next: Next): Promise<Response | void> {
    // The admin is a staff-only platform tool: it sees every workspace's rows. Without withoutTenant(), the
    // changelist of a tenant-scoped model (Document, Membership) fails with TenantNotSet.
    if (PLATFORM_PREFIXES.some((p) => c.req.path.startsWith(p))) return withoutTenant(() => optional.handle(c, next))
    return super.handle(c, next)
  }
}
