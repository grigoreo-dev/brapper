# Creating a brap

A step-by-step guide to building a new browser wrapper project with brapper.

---

## 1. Initialize the project

```bash
mkdir my-brap && cd my-brap
pnpm init
pnpm add brapper
pnpm add -D typescript tsx @types/node
```

`package.json` — set type, scripts, and optional bin:

```json
{
  "name": "@my-org/my-brap",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev":       "node --env-file=.env --import tsx/esm --watch src/server.ts",
    "build":     "tsc",
    "typecheck": "tsc --noEmit"
  }
}
```

---

## 2. Define the env schema

```typescript
// src/config.ts
import { z } from 'zod'
import { baseEnvSchema, parseEnv } from 'brapper'

export const envSchema = baseEnvSchema.extend({
  MY_APP_TOKEN: z.string().optional(),
})

export const env = parseEnv(envSchema)
export type Env = typeof env
```

---

## 3. Build the App class

The App class is the adapter for your target web application. It is **session-bound**: it holds a `BrowserSession` reference and each method decides independently which execution lane to use.

```typescript
// src/app/MyApp.ts
import type { BrowserSession } from 'brapper'

const APP_URL = 'https://target-app.com'
const PERSISTENT_KEY = 'main'

export class MyApp {
  private constructor(private readonly session: BrowserSession) {}

  static async create(session: BrowserSession): Promise<MyApp> {
    const app = new MyApp(session)
    // Warm up the persistent page: navigate and wait for ready state
    await session.withPersistentPage(async (worker) => {
      await worker.page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
      await worker.page.waitForSelector('#app-ready')
    }, { key: PERSISTENT_KEY })
    return app
  }

  // Fast: reuses the warm persistent page — no navigation overhead
  async search(query: string): Promise<SearchResult[]> {
    return this.session.withPersistentPage(async (worker) => {
      const res = await worker.browserFetch('/api/search?q=' + query, {
        credentials: 'include',
      })
      return res.json<SearchResult[]>()
    }, { key: PERSISTENT_KEY })
  }

  // Isolated: opens a fresh tab per call
  async exportReport(id: string): Promise<string> {
    return this.session.withSpawnedPage(async (worker) => {
      await worker.page.goto(APP_URL + '/reports/' + id)
      await worker.page.click('#export-btn')
      const response = await worker.waitForResponse(
        (url) => url.includes('/api/export'),
      )
      return response.text()
    })
  }
}
```

### Key design rule

Each method owns its lane choice:
- Use `withPersistentPage` for API calls (`browserFetch`, `evaluate`) that only need the page's session context.
- Use `withSpawnedPage` for multi-step navigations or flows that must not share state between concurrent requests.

---

## 4. HTTP server entry point

```typescript
// src/server.ts
import { createBrap } from 'brapper'
import { env } from './config.js'
import { MyApp } from './app/MyApp.js'
import { registerRoutes } from './http/routes.js'

let myApp: MyApp

const { start } = await createBrap({
  env,
  cookiesPath: env.COOKIES_PATH,     // optional: load cookies on startup
  warmUp: async (session) => {
    myApp = await MyApp.create(session)
  },
  routes(app) {
    registerRoutes(app, myApp)
  },
})

await start()
```

`warmUp` runs before `markReady()` is called. The gate stays open during warmUp because the HTTP server has not started yet — no requests can arrive.

---

## 5. Define HTTP routes

Routes receive the App instance directly and call its methods:

```typescript
// src/http/routes.ts
import type { Hono } from 'brapper'
import type { MyApp } from '../app/MyApp.js'

export function registerRoutes(app: Hono, myApp: MyApp): void {
  app.get('/v1/search', async (c) => {
    const query = c.req.query('q') ?? ''
    return c.json(await myApp.search(query))
  })

  app.post('/v1/reports/:id/export', async (c) => {
    const id = c.req.param('id')
    const csv = await myApp.exportReport(id)
    return c.text(csv)
  })
}
```

---

## 6. Add recovery strategies (optional)

Recovery strategies automatically handle auth expiry, captcha, or other mid-session failures.

```typescript
// src/recovery/reloginStrategy.ts
import type { RecoveryStrategy } from 'brapper'

export const reloginStrategy: RecoveryStrategy = {
  name: 'relogin',
  detect: (page) => page.url().includes('/login'),
  recover: async (worker) => {
    await worker.page.type('#email', process.env.APP_EMAIL!)
    await worker.page.type('#password', process.env.APP_PASSWORD!)
    await worker.page.click('[type=submit]')
    await worker.page.waitForNavigation()
    return worker.page.url().includes('/login') ? 'failed' : 'ok'
  },
}
```

Register in `createBrap`:

```typescript
await createBrap({
  env,
  recoveryStrategies: [reloginStrategy],
  routes(app) { registerRoutes(app, myApp) },
})
```

---

## 7. Add page guards (optional)

Guards are per-page detectors that signal `SessionMonitor` when a condition is met.

```typescript
// src/guards/authGuard.ts
import type { PageGuard } from 'brapper'

export const authGuard: PageGuard = {
  name: 'auth',
  severity: 'recoverable',
  attach(worker, signal) {
    return worker.onResponse(
      (url) => url.startsWith('https://target-app.com/api/'),
      (res) => { if (res.status === 401) signal.emit('401 on API') },
    )
  },
}
```

Pass as `defaultGuards` to apply to every page:

```typescript
await createBrap({
  env,
  defaultGuards: [authGuard],
  recoveryStrategies: [reloginStrategy],
  routes(app) { registerRoutes(app, myApp) },
})
```

---

## 8. Health check

`GET /health` returns the full session state:

```json
{
  "ok": true,
  "state": "ready",
  "browser_connected": true,
  "warm": true,
  "persistent_pages": { "total": 1, "healthy": 1, "restarting": 0 },
  "spawned_inflight": 0,
  "queue_depth": 0,
  "timestamp": "2026-05-16T..."
}
```

Returns `200` when `ok: true`, `503` during `recovering` or `degraded`.

---

## 9. Add the Dockerfile

Copy the base Dockerfile from brapper:

```bash
cp node_modules/brapper/deploy/Dockerfile ./Dockerfile
```

---

## Using the logger inside your App

`BrowserSession` exposes `logger` (pino instance, or `undefined` if none was passed):

```typescript
export class MyApp {
  private readonly logger

  private constructor(private readonly session: BrowserSession) {
    this.logger = session.logger
  }

  async search(query: string) {
    return this.session.withPersistentPage(async (worker) => {
      this.logger?.debug({ query }, 'Fetching search results')
      const res = await worker.browserFetch('/api/search?q=' + query)
      return res.json<SearchResult[]>()
    }, { key: 'main' })
  }
}
```
