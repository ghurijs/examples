// Workspaces are the tenants (@ghuri/tenants, shared schema): every tenant-scoped row has a `workspace` foreign key,
// and `objects` managers only see the current workspace's rows. The request's workspace comes from the
// `X-Workspace: <slug>` header (TENANTS.RESOLVERS in src/settings.ts); `TENANTS.REQUIRED` answers 404 without one.
import { User } from '@ghuri/auth'
import { BooleanField, CASCADE, CharField, DateTimeField, ForeignKey, type Manager, Model, SlugField } from '@ghuri/orm'
import { tenantModel } from '@ghuri/tenants'

export class Workspace extends Model({
  name: new CharField({ maxLength: 100 }),
  slug: new SlugField({ unique: true }),
  isActive: new BooleanField({ default: true }),
  createdAt: new DateTimeField({ autoNowAdd: true }),
}) {
  declare static objects: Manager<Workspace>
  static Meta = { ordering: ['name'] }

  toString(): string {
    return this.name
  }
}

/** The project's tenant-scoped model factory: a `workspace` foreign key, and `objects` scoped to the current one. */
export const WorkspaceModel = tenantModel({ field: 'workspace', to: () => Workspace })

export const ROLES = [
  ['owner', 'Owner'],
  ['member', 'Member'],
] as const

/** Who may act in a workspace. Tenant-scoped: `Membership.objects` sees the current workspace's members only. */
export class Membership extends WorkspaceModel({
  user: new ForeignKey(() => User, { onDelete: CASCADE, relatedName: 'memberships' }),
  role: new CharField({ maxLength: 10, choices: ROLES as unknown as [string, string][], default: 'member' }),
  createdAt: new DateTimeField({ autoNowAdd: true }),
}) {
  declare static objects: Manager<Membership>
  declare static unscoped: Manager<Membership>
  static Meta = { uniqueTogether: [['workspace', 'user']] }
}
