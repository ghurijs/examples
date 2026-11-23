// The support agent: answers questions over the workspace's documents (RAG). Mounted in src/urls.ts:
//   POST /agents/support/chat (JSON, or SSE with ?stream=1)   GET /agents/support/conversations/
//   POST /api/ask/ (background run on @ghuri/tasks)            GET /agents/usage/
import { Agent, type AgentRunContext } from '@ghuri/agents'
import { IsAuthenticated } from '@ghuri/rest'
import { searchTool } from '@ghuri/vectors/agents'
import { documents } from '../knowledge/vectors'
import type { Workspace } from '../workspaces/models'
import { IsWorkspaceMember } from '../workspaces/permissions'
import { currentTenant } from '@ghuri/tenants'

export class SupportAgent extends Agent {
  static agentName = 'support'

  instructions = (_ctx: AgentRunContext) => {
    const workspace = currentTenant() as Workspace | null
    return [
      `You are the support assistant of the "${workspace?.name ?? 'unknown'}" workspace.`,
      'Answer only from the workspace documents: call search_knowledge_documents first, then answer briefly and',
      'name the document titles you used. If the documents do not cover the question, say so.',
    ].join(' ')
  }

  tools = [
    searchTool(documents, {
      name: 'search_knowledge_documents',
      description: "Search this workspace's uploaded documents. Returns the best matching passages with titles.",
      k: 4,
      maxChars: 1500,
    }),
  ]

  permissionClasses = [IsAuthenticated, IsWorkspaceMember]
  maxSteps = 4
}
