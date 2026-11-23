// Admin for workspaces (@ghuri/admin). Importing this module (WorkspacesConfig.admin) registers them.
import { admin, ModelAdmin, TabularInline } from '@ghuri/admin'
// The framework apps' admins: token usage and run traces, Stripe mirrors and events, task results.
import '@ghuri/agents/admin'
import '@ghuri/billing/admin'
import '@ghuri/tasks/admin'
import { Membership, Workspace } from './models'

class MembershipInline extends TabularInline<Membership> {
  model = Membership
  extra = 0
  fields = ['user', 'role']
}

@admin.register(Workspace)
export class WorkspaceAdmin extends ModelAdmin<Workspace> {
  listDisplay = ['name', 'slug', 'isActive', 'createdAt']
  searchFields = ['name', 'slug']
  prepopulatedFields = { slug: ['name'] }
  inlines = [MembershipInline]
}

@admin.register(Membership)
export class MembershipAdmin extends ModelAdmin<Membership> {
  listDisplay = ['user', 'workspace', 'role', 'createdAt']
  listFilter = ['role']
}
