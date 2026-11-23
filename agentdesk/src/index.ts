// Worker entry point (Django's wsgi.py): `wrangler dev` / `wrangler deploy` run this file. Its `queue()` handler
// runs @ghuri/tasks messages (document embedding, background agent runs, billing webhooks with WEBHOOK_TASKS).
import { createApp } from '@ghuri/core'
import settings from './settings'

export default createApp(settings)
