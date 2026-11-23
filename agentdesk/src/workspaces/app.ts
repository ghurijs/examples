import { AppConfig } from '@ghuri/core'
import * as admin from './admin'
import * as migrations from './migrations'
import * as models from './models'

export class WorkspacesConfig extends AppConfig {
  name = 'workspaces'
  verboseName = 'Workspaces'
  path = import.meta.dirname
  models = models
  migrations = migrations
  admin = admin
}
