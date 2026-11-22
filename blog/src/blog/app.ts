import { AppConfig, tryGetContext } from '@ghuri/core'
import { periodicTask } from '@ghuri/tasks'
import * as admin from './admin'
import { registerFakeProvider } from './fake-model'
import * as migrations from './migrations'
import * as models from './models'
import * as tasks from './tasks'

export class BlogConfig extends AppConfig {
  name = 'blog'
  verboseName = 'Blog'
  path = import.meta.dirname
  models = models
  migrations = migrations
  admin = admin
  tasks = tasks

  ready() {
    // Offline agent model for development only (AGENT_MODEL=fake:blog).
    if (tryGetContext()?.settings.DEBUG) registerFakeProvider()
    // Nightly at 03:00 UTC; the cron is listed in wrangler.jsonc "triggers" (and fired by `ghuri db_worker --beat`
    // on Node).
    periodicTask('0 3 * * *', tasks.purgeRejectedComments)
  }
}
