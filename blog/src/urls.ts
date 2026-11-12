// URL configuration (Django's urls.py).
import { admin } from '@ghuri/admin'
import { AgentRouter } from '@ghuri/agents'
import {
  obtainAuthToken,
  TokenObtainPairView,
  TokenRefreshView,
  TokenVerifyView,
} from '@ghuri/auth/rest'
import { include, path } from '@ghuri/core'
import { GraphQLView } from '@ghuri/graphql'
import { SchemaView, SwaggerUIView } from '@ghuri/rest'
import { serveMedia } from '@ghuri/storage'
import type { Context } from 'hono'
import { blogTools, SupportAgent } from './blog/agents'
import { router } from './router'

export { router }

/** AI agents over HTTP (`POST /agents/support/chat`) and MCP (`/mcp/`). */
export const agents = new AgentRouter()
agents.register('support', SupportAgent)

function home(c: Context) {
  return c.json({
    project: 'blog',
    admin: '/admin/',
    api: '/api/',
    docs: '/api/docs/',
    graphql: '/graphql/',
    mcp: '/mcp/',
  })
}

export const urlpatterns = [
  path('', home, { name: 'home' }),
  path('admin/', admin.site.urls),
  // Auth: DRF-style token and JWT pair (simplejwt semantics).
  path('api/auth/token/', obtainAuthToken, { name: 'api-token' }),
  path('api/auth/jwt/', TokenObtainPairView.asView(), { name: 'jwt-obtain' }),
  path('api/auth/jwt/refresh/', TokenRefreshView.asView(), { name: 'jwt-refresh' }),
  path('api/auth/jwt/verify/', TokenVerifyView.asView(), { name: 'jwt-verify' }),
  // OpenAPI 3.1 + Swagger UI.
  path('api/schema/', SchemaView.asView({ title: 'Blog API', version: '1.0.0' }), { name: 'schema' }),
  path('api/docs/', SwaggerUIView.asView({ urlName: 'schema' }), { name: 'swagger-ui' }),
  path('api/', include(router.urls)),
  // GraphQL (schema: GRAPHQL.SCHEMA in settings); GraphiQL for browsers when DEBUG=true.
  path('graphql/', GraphQLView.asView(), { name: 'graphql' }),
  // Agents and MCP.
  path('agents/', include(agents.urls)),
  // MCP (Streamable HTTP): the API tools plus `ask_support` (the agent itself).
  path(
    'mcp/',
    agents.mcp({
      name: 'blog',
      version: '1.0.0',
      instructions: 'Tools for the Ghuri example blog.',
      tools: blogTools(),
      agents: true,
    }),
  ),
  // Uploaded files (R2 on Cloudflare, the local disk on Node).
  path('media/<path:name>', serveMedia(), { name: 'media' }),
]
