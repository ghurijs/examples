// Worker entry point (Django's wsgi.py): `wrangler dev` / `wrangler deploy` run this file.
import { createApp } from '@ghuri/core'
import settings from './settings'

export default createApp(settings)
