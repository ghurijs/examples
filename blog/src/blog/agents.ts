// An AI agent whose tools are the blog's REST API (@ghuri/agents). Mounted in src/urls.ts:
//   POST /agents/support/chat   and the MCP endpoint at /mcp/
import { Agent, ModelTools, RouterTools, ToolError, tool } from '@ghuri/agents'
import { IsAuthenticated } from '@ghuri/rest'
import { z } from 'zod'
import { router } from '../router'
import { Post } from './models'
import { PostSerializer } from './serializers'

/** Tools generated from the REST API: shared by the agent and the MCP endpoint (src/urls.ts). */
export function blogTools() {
  return [
    // Read-only access to posts through the same serializer and scoping as the REST API.
    new ModelTools(Post, {
      actions: ['list', 'retrieve'],
      serializer: PostSerializer,
      searchFields: ['title', 'body'],
      orderingFields: ['createdAt'],
      filterFields: ['published'],
      pageSize: 10,
    }),
    // The rest of the API router, read-only (tags_list, comments_retrieve, …).
    new RouterTools(router, { include: ['tags', 'comments'], readOnly: true }),
  ]
}

export class SupportAgent extends Agent {
  static agentName = 'support'
  instructions =
    'You help the editors of this blog. Use the tools to look up posts, tags and comments. Be brief.'
  tools = blogTools()
  permissionClasses = [IsAuthenticated]

  @tool({
    description: 'Count the words of a post body',
    input: z.object({ slug: z.string().describe('The post slug') }),
  })
  async wordCount({ slug }: { slug: string }) {
    const post = await Post.objects.filter({ slug }).first()
    if (!post) throw new ToolError(`No post with slug '${slug}'.`)
    return { slug, words: post.body.split(/\s+/).filter(Boolean).length }
  }
}
