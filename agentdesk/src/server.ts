// Node.js / VPS entry point: `npm start` runs this file (`ghuri runserver --node` during development).
// The same settings work here; DATABASES / STORAGES pick Node-friendly backends from the environment.
import { createApp } from '@ghuri/core'
import { serve } from '@ghuri/core/node'
import settings from './settings'

serve(createApp(settings), {
  port: Number(process.env.PORT ?? 8000),
  env: process.env,
})
