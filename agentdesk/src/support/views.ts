// Background questions: `POST /api/ask/ { message, conversationId? }` enqueues the support agent on @ghuri/tasks
// (Cloudflare Queues on Workers, the database on Node) and answers 202 at once. The client polls the task, or the
// conversation (`GET /agents/support/conversations/<id>/`).
import { agentRunTask, UsageLimitExceeded, usageThrottled } from '@ghuri/agents'
import type { User } from '@ghuri/auth'
import { kwargs } from '@ghuri/core'
import { type APIRequest, APIResponse, APIView, IsAuthenticated, NotFound, ValidationError } from '@ghuri/rest'
import { IsWorkspaceMember } from '../workspaces/permissions'
import { Conversation } from './models'
import { agentRouter } from './router'

export class AskView extends APIView {
  permissionClasses = [IsAuthenticated, IsWorkspaceMember]
  throttleScope = 'agent'

  async post(request: APIRequest) {
    const data = (request.data ?? {}) as { message?: unknown; conversationId?: unknown }
    if (typeof data.message !== 'string' || !data.message.trim())
      throw new ValidationError({ message: ['This field is required.'] })
    const conversationId = typeof data.conversationId === 'string' ? data.conversationId : undefined
    // Another workspace's (or user's) conversation is a 404, as in the chat view.
    if (conversationId && !(await Conversation.objects.filter({ pk: conversationId, user: (request.user as User).pk }).exists()))
      throw new NotFound('Conversation not found.')
    const agent = agentRouter.create('support')
    let result: Awaited<ReturnType<typeof agent.enqueue>>
    try {
      result = await agent.enqueue(data.message, { user: request.user as User, conversationId })
    } catch (err) {
      // Over the workspace's token budget: 429 with Retry-After, like the chat view. (UsageLimitExceeded is not an
      // HTTP error, so outside the agents' own views it would be a 500.)
      if (err instanceof UsageLimitExceeded) throw usageThrottled(err)
      throw err
    }
    return new APIResponse({ conversationId: result.conversationId, task: result.taskResultId ?? null }, 202)
  }
}

/** `GET /api/ask/<task id>/`: the background run's status and, once finished, its answer. */
export class AskResultView extends APIView {
  permissionClasses = [IsAuthenticated, IsWorkspaceMember]

  async get(_request: APIRequest) {
    const id = String(kwargs(this.c).id)
    const task = agentRunTask()
    if (!task) throw new NotFound()
    let result: any
    try {
      result = await (task as any).getResult(id)
    } catch {
      throw new NotFound('No such task.')
    }
    // The run belongs to a conversation of this workspace; another workspace's task id is a 404.
    const conversationId = result.args?.[0]?.conversationId
    if (!conversationId || !(await Conversation.objects.filter({ pk: conversationId }).exists()))
      throw new NotFound('No such task.')
    return {
      id: result.id,
      status: result.status,
      conversationId,
      answer: result.status === 'SUCCESSFUL' ? result.returnValue : null,
      errors: result.errors?.map((e: any) => e.exceptionClassPath) ?? [],
    }
  }
}
