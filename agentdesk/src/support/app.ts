import { AppConfig, tryGetContext } from '@ghuri/core'
import * as migrations from './migrations'
import * as models from './models'
import { registerFakeProvider } from './fake-model'
import * as router from './router'

export class SupportConfig extends AppConfig {
  name = 'support'
  verboseName = 'Support'
  path = import.meta.dirname
  models = models
  migrations = migrations
  modules = { router }

  ready() {
    // Offline agent model for development (AGENT_MODEL=fake:agentdesk); never in production.
    if (tryGetContext()?.settings.DEBUG) registerFakeProvider()
  }
}
