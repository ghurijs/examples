// The project's conversation model (AGENTS.CONVERSATION_MODEL = 'support.Conversation'): the agents fields plus a
// `workspace` foreign key, so conversations are scoped to the request's workspace. Another workspace's
// conversation id answers 404 even for a user who belongs to both.
import { conversationFields } from '@ghuri/agents'
import type { Manager } from '@ghuri/orm'
import { WorkspaceModel } from '../workspaces/models'

export class Conversation extends WorkspaceModel({ ...conversationFields }) {
  declare static objects: Manager<Conversation>
  declare static unscoped: Manager<Conversation>
  static Meta = { ordering: ['-updatedAt'] }

  toString(): string {
    return this.title || String(this.id)
  }
}
