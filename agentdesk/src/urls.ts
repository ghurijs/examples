// URL configuration (Django's urls.py).
//
// TENANTS.REQUIRED is on: every request needs `X-Workspace: <slug>`, or it answers 404. Platform routes that have no
// workspace (log in, list / create workspaces, the OpenAPI docs) are wrapped in `platform()`, which marks
// their views with tenantNotRequired(). Billing's webhook is marked by @ghuri/billing itself.
import { admin } from '@ghuri/admin'
import { billingUrls } from '@ghuri/billing'
import { include, path, type UrlEntry, type UrlPatterns } from '@ghuri/core'
import { DefaultRouter, ScalarView, SchemaView, SimpleRouter, SwaggerUIView } from '@ghuri/rest'
import { tenantNotRequired } from '@ghuri/tenants'
import type { Context } from 'hono'
import { DocumentViewSet } from './knowledge/views'
import { agentRouter } from './support/router'
import { AskResultView, AskView } from './support/views'
import { CurrentWorkspaceView, LoginView, MemberViewSet, WorkspaceViewSet } from './workspaces/views'

/**
 * Mark every view under `entries` (recursively) with tenantNotRequired(). tenantNotRequired() marks one view
 * function; it has no effect on a View class, a ViewSet or an include()d list, so walk the patterns.
 */
function platform<T extends UrlEntry | UrlPatterns>(entries: T): T {
  const walk = (e: UrlEntry) => {
    if (e.view) tenantNotRequired(e.view)
    if (e.app) tenantNotRequired(e.app)
    for (const child of e.children ?? []) walk(child)
  }
  if (Array.isArray(entries)) entries.forEach(walk)
  else walk(entries as UrlEntry)
  return entries
}

/** Workspace API (needs X-Workspace). */
export const router = new DefaultRouter()
router.register('documents', DocumentViewSet)
router.register('members', MemberViewSet)

/** Platform API (no workspace). */
export const platformRouter = new SimpleRouter()
platformRouter.register('workspaces', WorkspaceViewSet, { basename: 'workspace' })

function home(c: Context) {
  return c.json({
    project: 'agentdesk',
    admin: '/admin/',
    api: '/api/',
    docs: '/api/docs/',
    workspaces: '/api/workspaces/',
    chat: '/agents/support/chat',
    note: 'Workspace routes need the X-Workspace: <slug> header.',
  })
}

export const urlpatterns = [
  platform(path('', home, { name: 'home' })),
  // The admin is exempted by WorkspaceMiddleware (its lazily built views cannot be marked here).
  path('admin/', admin.site.urls),
  // DRF-style token login: `{username, password}` → `{token}`; use `Authorization: Token …`. Throttled.
  platform(path('api/auth/token/', LoginView.asView(), { name: 'api-token' })),
  platform(path('api/schema/', SchemaView.asView({ title: 'agentdesk API', version: '0.1.0' }), { name: 'schema' })),
  platform(path('api/docs/', SwaggerUIView.asView({ urlName: 'schema' }), { name: 'swagger-ui' })),
  platform(path('api/reference/', ScalarView.asView({ urlName: 'schema' }), { name: 'scalar' })),
  platform(path('api/', include(platformRouter.urls))),
  // Workspace-scoped API.
  path('api/workspace/', CurrentWorkspaceView.asView(), { name: 'current-workspace' }),
  path('api/ask/', AskView.asView(), { name: 'ask' }),
  path('api/ask/<str:id>/', AskResultView.asView(), { name: 'ask-result' }),
  path('api/', include(router.urls)),
  // The support agent: POST agents/support/chat (JSON or SSE), conversations, GET agents/usage/.
  path('agents/', include(agentRouter.urls)),
  // Stripe: checkout/ and portal/ (workspace owners), webhook/ (no workspace; signed by Stripe).
  path('billing/', include(billingUrls)),
  // Uploaded files are private to a workspace: they are not served publicly (no serveMedia() route).
]
