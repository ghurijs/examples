import { AppConfig, tryGetContext } from '@ghuri/core'
import { preDelete } from '@ghuri/orm'
import { runAsTenant } from '@ghuri/tenants'
import { Workspace } from '../workspaces/models'
import * as admin from './admin'
import { registerFakeEmbeddings } from './fake-embedding'
import * as migrations from './migrations'
import * as models from './models'
import * as tasks from './tasks'
import * as vectors from './vectors'

export class KnowledgeConfig extends AppConfig {
  name = 'knowledge'
  verboseName = 'Knowledge base'
  path = import.meta.dirname
  models = models
  migrations = migrations
  admin = admin
  tasks = tasks
  modules = { vectors }

  ready() {
    // Offline embeddings for development (EMBEDDING_MODEL=fake:agentdesk); never in production.
    if (tryGetContext()?.settings.DEBUG) registerFakeEmbeddings()
    // Deleting a workspace cascades its rows, but not its vectors (Vectorize / pgvector) or the vectors manifest,
    // which hold the documents' text. Clear its namespace first.
    preDelete.connect(
      async ({ instance }) => {
        await runAsTenant(instance as Workspace, () => vectors.documents.clear())
      },
      { sender: Workspace, uid: 'knowledge.clearWorkspaceVectors' },
    )
  }
}
