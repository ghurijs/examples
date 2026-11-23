// Workspace API. `WorkspaceViewSet` is platform-level (no X-Workspace header: the user lists and creates
// workspaces), everything else runs inside the request's workspace.
import { User } from '@ghuri/auth'
import { obtainAuthToken } from '@ghuri/auth/rest'
import { getUsage } from '@ghuri/agents'
import { getEntitlements } from '@ghuri/billing'
import {
  AllowAny,
  type APIRequest,
  APIView,
  CreateModelMixin,
  DestroyModelMixin,
  GenericViewSet,
  IsAuthenticated,
  ListModelMixin,
  APIResponse,
  ScopedRateThrottle,
  ValidationError,
} from '@ghuri/rest'
import { requireTenant, runAsTenant } from '@ghuri/tenants'
import { Membership, Workspace } from './models'
import { IsOwnerOrReadOnly, IsWorkspaceMember } from './permissions'
import { MembershipSerializer, WorkspaceSerializer } from './serializers'

/** `GET /api/workspaces/` (mine), `POST /api/workspaces/` (create one; the creator becomes its owner). */
export class WorkspaceViewSet extends CreateModelMixin(ListModelMixin(GenericViewSet)) {
  serializerClass = WorkspaceSerializer
  permissionClasses = [IsAuthenticated]
  // No pagination class: a user has a handful of workspaces.
  paginationClass = null

  getQueryset() {
    const user = this.request.user as User
    // Membership is tenant-scoped; this platform view has no tenant, so it reads memberships through `unscoped`.
    return Workspace.objects.filter({
      isActive: true,
      pk__in: Membership.unscoped.filter({ user: user.pk }).values('workspace'),
    })
  }

  async performCreate(serializer: WorkspaceSerializer): Promise<void> {
    const workspace = (await serializer.save()) as Workspace
    await runAsTenant(workspace, () => Membership.objects.create({ user: this.request.user as User, role: 'owner' }))
  }
}

/**
 * `GET /api/members/`, `POST /api/members/ { username, role }` (owners), `DELETE /api/members/<id>/` (owners).
 * Scoped to the request's workspace by `Membership.objects`.
 */
export class MemberViewSet extends CreateModelMixin(DestroyModelMixin(ListModelMixin(GenericViewSet))) {
  queryset = Membership.objects.all().orderBy('createdAt')
  serializerClass = MembershipSerializer
  permissionClasses = [IsAuthenticated, IsOwnerOrReadOnly]

  async create(request: APIRequest) {
    const data = (request.data ?? {}) as { username?: string; role?: string }
    const user = data.username ? await User.objects.filter({ username: data.username }).first() : null
    if (!user) throw new ValidationError({ username: ['No user with this username.'] })
    if (await Membership.objects.filter({ user: user.pk }).exists())
      throw new ValidationError({ username: ['Already a member of this workspace.'] })
    const membership = await Membership.objects.create({ user, role: data.role === 'owner' ? 'owner' : 'member' })
    return new APIResponse(await new MembershipSerializer(membership).getData(), 201)
  }
}

/** `GET /api/workspace/`: the request's workspace, its plan (@ghuri/billing) and its token usage (@ghuri/agents). */
export class CurrentWorkspaceView extends APIView {
  permissionClasses = [IsAuthenticated, IsWorkspaceMember]

  async get(request: APIRequest) {
    const workspace = requireTenant() as Workspace
    const { plan, features, limits, active } = await getEntitlements(workspace)
    const usage = await getUsage({ user: request.user as User, tenant: workspace.pk as number })
    return new APIResponse({
      workspace: await new WorkspaceSerializer(workspace).getData(),
      plan,
      active,
      features,
      limits,
      usage: usage.filter((u) => u.scope === 'tenant'),
    })
  }
}

/**
 * `POST /api/auth/token/ { username, password }` → `{ token }`, throttled per client address (`login` rate).
 * @ghuri/auth's obtainAuthToken is a plain View, so REST_FRAMEWORK throttles do not reach it (DRF's ObtainAuthToken
 * is an APIView and is throttled); this APIView wraps it.
 */
export class LoginView extends APIView {
  authenticationClasses = []
  permissionClasses = [AllowAny]
  throttleClasses = [ScopedRateThrottle]
  throttleScope = 'login'

  async post(_request: APIRequest) {
    return obtainAuthToken(this.c)
  }
}
