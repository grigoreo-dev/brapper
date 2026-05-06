# Creating a brap

A step-by-step guide to building a new browser wrapper project with brapper.

---

## 1. Initialize the project

```bash
mkdir @grigoreo-dev/my-brap && cd @grigoreo-dev/my-brap
pnpm init
pnpm add brapper
pnpm add -D typescript tsx @types/node
```

`package.json` — set type, bin, and scripts:

```json
{
  "name": "@grigoreo-dev/my-brap",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types":  "./dist/index.d.ts"
    }
  },
  "bin": {
    "my-brap-mcp": "./dist/mcp.js"
  },
  "scripts": {
    "build":       "tsc",
    "postbuild":   "chmod +x dist/mcp.js",
    "start:server": "node dist/server.js",
    "start:mcp":    "node dist/mcp.js",
    "dev:server":   "tsx --import dotenv/config src/server.ts",
    "dev:mcp":      "tsx src/mcp.ts"
  }
}
```

---

## 2. Define the env schema

```typescript
// src/config.ts
import { z } from 'zod'
import { baseEnvSchema } from 'brapper'

export const envSchema = baseEnvSchema.extend({
  MY_APP_TOKEN: z.string().optional(),
  // add any target-specific env vars here
})

export type Env = z.infer<typeof envSchema>
```

---

## 3. Build the App class

The App class is the adapter for your target web application. One instance = one browser tab.

```typescript
// src/app/MyApp.ts
import type { PageWorker } from 'brapper'

export class MyApp {
  constructor(private worker: PageWorker) {}

  static async create(worker: PageWorker): Promise<MyApp> {
    // inject any scripts, navigate, wait for login, etc.
    await worker.page.goto('https://target-app.com')
    // await waitForLogin(worker)
    return new MyApp(worker)
  }

  // --- public methods (your actual functionality) ---

  async doSomething(params: { query: string }) {
    return this.worker.browserFetch('/api/search?q=' + params.query)
      .then(r => r.json<SearchResult[]>())
  }

  async uploadFile(path: string) {
    const { readFile } = await import('fs/promises')
    const bytes = await readFile(path)
    return this.worker.browserFetch('/api/upload', {
      method: 'POST',
      body: bytes,
    }).then(r => r.json<{ fileId: string }>())
  }
}
```

---

## 4. Define HTTP routes

```typescript
// src/http/routes.ts
import { Hono } from 'hono'
import type { AppContext } from 'brapper'
import type { Env } from '../config.js'
import { MyApp } from '../app/MyApp.js'

export function registerRoutes(app: Hono, ctx: AppContext<Env>) {
  app.get('/v1/search', async (c) => {
    const query = c.req.query('q') ?? ''
    const result = await ctx.session!.withApp(MyApp, app => app.doSomething({ query }))
    return c.json(result)
  })
}

// Export AppType for the typed client
const _routes = new Hono()
  .get('/v1/search', () => new Response())

export type AppType = typeof _routes
```

---

## 5. HTTP server entry point

```typescript
// src/server.ts
import 'dotenv/config'
import { createServer, parseEnv } from 'brapper'
import { envSchema } from './config.js'
import { registerRoutes } from './http/routes.js'

const env = parseEnv(envSchema)
const { start } = await createServer({ env, routes: registerRoutes })
await start()
```

---

## 6. MCP stdio entry point

```typescript
#!/usr/bin/env node
// src/mcp.ts
import 'dotenv/config'
import { createStdioApp, parseEnv, HttpClient } from 'brapper'
import { z } from 'zod'

const env = parseEnv(z.object({
  SERVER_URL: z.string().url(),
  AUTH_TOKEN:  z.string().optional(),
  LOG_LEVEL:  z.string().optional(),
}))

await createStdioApp({
  name: 'my-brap',
  version: '0.1.0',
  tools: (server) => {
    const client = new HttpClient({ baseUrl: env.SERVER_URL, token: env.AUTH_TOKEN })

    server.tool(
      'search',
      { query: z.string() },
      async ({ query }) => {
        const results = await client.get<SearchResult[]>('/v1/search', { q: query })
        return { content: [{ type: 'text', text: JSON.stringify(results) }] }
      }
    )

    server.tool(
      'upload_file',
      { path: z.string().describe('Absolute path to the file on disk') },
      async ({ path }) => {
        const { readFile } = await import('fs/promises')
        const bytes = await readFile(path)
        const { fileId } = await client.postBinary('/v1/upload', bytes)
        return { content: [{ type: 'text', text: fileId }] }
      }
    )
  },
}).start()
```

---

## 7. Typed client

```typescript
// src/client/MyClient.ts
import { hc } from 'brapper'
import type { AppType } from '../http/routes.js'

export class MyClient {
  private rpc: ReturnType<typeof hc<AppType>>

  constructor(serverUrl: string, token?: string) {
    this.rpc = hc<AppType>(serverUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
  }

  async search(query: string) {
    const res = await this.rpc['v1']['search'].$get({ query: { q: query } })
    return res.json()
  }
}
```

Export from the package root:

```typescript
// index.ts
export { MyClient } from './src/client/MyClient.js'
export { MyApp } from './src/app/MyApp.js'
```

---

## 8. Concurrency configuration

Control how many browser tabs run in parallel:

```typescript
// src/server.ts
const { start } = await createServer({
  env,
  routes: registerRoutes,
  sessionConcurrency: 3,    // up to 3 parallel tabs
})
```

With `concurrency: 3`:
- First 3 requests each get their own tab immediately
- Request 4 waits in queue until one tab finishes
- After the handler returns, the tab is closed and the next queued job starts

---

## 9. Add the Dockerfile

Copy the base Dockerfile from brapper:

```bash
cp node_modules/brapper/deploy/Dockerfile ./Dockerfile
```

The default `CMD` runs `dist/index.js` — update it to `dist/server.js` if needed.

---

## Cursor / Claude Desktop integration

Add to `.cursor/mcp.json` (or Claude Desktop config):

```json
{
  "mcpServers": {
    "my-brap": {
      "command": "npx",
      "args": ["-y", "@grigoreo-dev/my-brap-mcp"],
      "env": {
        "SERVER_URL": "https://my-brap.example.com",
        "AUTH_TOKEN":  "your-token-here"
      }
    }
  }
}
```

Or point directly to the local build during development:

```json
{
  "mcpServers": {
    "my-brap-dev": {
      "command": "node",
      "args": ["/absolute/path/to/my-brap/dist/mcp.js"],
      "env": {
        "SERVER_URL": "http://localhost:3000"
      }
    }
  }
}
```
