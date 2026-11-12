import { AppConfig, tryGetContext } from '@ghuri/core'
import * as admin from './admin'
import { registerFakeProvider } from './fake-model'
import * as migrations from './migrations'
import * as models from './models'

export class BlogConfig extends AppConfig {
  name = 'blog'
  verboseName = 'Blog'
  path = import.meta.dirname
  models = models
  migrations = migrations
  admin = admin

  ready() {
    // Offline agent model for development only (AGENT_MODEL=fake:blog).
    if (tryGetContext()?.settings.DEBUG) registerFakeProvider()
  }
}
