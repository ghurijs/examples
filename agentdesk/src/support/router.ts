// The project's agents (@ghuri/agents), registered by name: HTTP routes, MCP `ask_support` and `agents.run` tasks
// find them here. Its own module so views and URLs can import it without a cycle.
import { AgentRouter } from '@ghuri/agents'
import { SupportAgent } from './agents'

export const agentRouter = new AgentRouter()
agentRouter.register('support', SupportAgent)
