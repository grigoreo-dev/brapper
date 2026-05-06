# brapper

[![npm](https://img.shields.io/npm/v/brapper?label=brapper)](https://www.npmjs.com/package/brapper)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**brapper** — *browser app wrapper* — framework for building MCP/HTTP API wrappers around browser-based web applications.

Each project built with brapper is a **brap** — a *browser app wrap* — a disposable adapter that wraps one specific web app and exposes it as an API.

---

## The internet wasn't built for agents. Yet.

AI agents are here. They reason, plan, and act. But the internet they're trying to act on was built for humans — login screens, CAPTCHAs, JavaScript-rendered UIs, and zero machine-readable APIs for most of its surface area.

The gap is real: **millions of useful web applications have no API**. No MCP endpoint. No way for an agent to just call them. You either reverse-engineer private APIs (fragile, breaks on every deploy) or you give up and do it manually.

**brapper is the bridge for this transition era.**

Attach to a real browser running the app, expose its functionality as MCP + HTTP, and let your agents use it today — without reverse-engineering or reimplementing anything. The browser does all the work; brapper just orchestrates it.

Projects built with brapper are called **braps** — pragmatic adapters for the pre-agent web. Each one is a thin layer meant to become unnecessary. When the web catches up and apps start shipping native MCP support, you won't need your brap anymore. Until then: wrap it, ship it, move on.

brapper and braps are **not forever solutions** — they are the scaffolding that gets us from here to there.

---

## Core concepts

### The problem it solves

Many web applications have rich functionality accessible only through their UI, with no public API. Building integrations means either:

- Reverse-engineering their private APIs (fragile, needs maintenance)
- Using a real browser and automating it (robust, uses the app as intended)

Brapper takes the second path and provides the infrastructure to do it cleanly and consistently across projects.

### The brapper project (a "brap")

A project built with brapper is called a **brap**. Each brap is a standalone npm package that:

1. Contains an **App class** — the core adapter for one specific target web app (`MyApp`, etc.)
2. Exposes an **HTTP API server** (REST + optional HTTP MCP) for network access
3. Optionally ships an **MCP stdio binary** for direct AI agent integration (Cursor, Claude Desktop)
4. Exports a typed **client** (`MyClient`, etc.) so other projects can consume the API with full TypeScript types

```
@my-org/app-one-brap   # a brap: wraps app-one.example.com
@my-org/app-two-brap   # a brap: wraps app-two.example.com
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        brap project                     │
│                                                         │
│   ┌─────────────┐      ┌────────────────────────────┐   │
│   │   MyApp     │─────▶│    HTTP API Server         │   │
│   │  (adapter)  │      │  (Hono routes + MCP HTTP)  │   │
│   │             │      └────────────────────────────┘   │
│   │  - session  │      ┌────────────────────────────┐   │
│   │  - warmUp   │      │    MCP stdio binary        │   │
│   │  - methods  │      │ (npx @my-org/my-brap-mcp)  │   │
│   └──────┬──────┘      └────────────────────────────┘   │
│          │                                              │
│   ┌──────▼──────┐                                       │
│   │  Browser    │   Chrome with remote debugging        │
│   │  Session    │   (CDP / puppeteer-core)              │
│   └─────────────┘                                       │
└─────────────────────────────────────────────────────────┘
```

### Two deployment targets from one project

Every brap can produce two separate runnable artifacts:

| Artifact | Entry point | How it runs | Purpose |
|----------|-------------|-------------|---------|
| HTTP server | `src/server.ts` | Docker / process | REST API + HTTP MCP |
| MCP stdio | `src/mcp.ts` | `npx` locally | AI agent integration |

The stdio MCP is a **smart local client** to the HTTP server. It has access to the local filesystem (can read files by path), composes multiple HTTP calls into high-level tools, and is configured in Cursor/Claude Desktop via `mcpServers`.

```json
// .cursor/mcp.json
{
  "mcpServers": {
    "my-brap": {
      "command": "npx",
      "args": ["-y", "@my-org/my-brap-mcp"],
      "env": { "SERVER_URL": "https://my-brap.example.com", "AUTH_TOKEN": "secret" }
    }
  }
}
```

---

## The App class pattern

The App class is the heart of each brap. It encapsulates everything specific to one target web application: browser setup, warm-up, authentication, and all scraping/automation methods.

```typescript
// In @my-org/my-brap
export class MyApp {
  constructor(private worker: PageWorker) {}

  static async create(worker: PageWorker): Promise<MyApp> {
    await worker.injectScript(customHookSource)
    await worker.page.goto('https://target.example.com')
    await waitForLogin(worker)
    return new MyApp(worker)
  }

  async listItems(params?: ListParams) {
    return this.worker.evaluateExpression('window.__api.listItems(...)')
  }

  async createItem(payload: ItemPayload) { ... }
  async uploadFile(path: string) { ... }
}
```

### Concurrency and the instance pool

Each HTTP request can spin up a **separate `MyApp` instance** on its own browser tab, run its task, and release. `BrowserSession` manages the pool with a configurable concurrency limit and a queue for excess requests:

```typescript
// In server route
app.post('/v1/items', async (c) => {
  return session.withApp(MyApp, async (app) => {
    const result = await app.createItem(body)
    return c.json(result)
  })
})
```

`withApp` handles:
- acquiring a tab from the pool (waiting in queue if all are busy)
- creating the App instance on that tab
- releasing the tab back to the pool after the handler completes (or throws)

```typescript
// BrowserSession config
const session = new BrowserSession({
  wsEndpoint: env.BROWSER_WS_ENDPOINT,
  concurrency: 3,          // up to 3 parallel tabs
  queueTimeout: 30_000,    // reject if waiting > 30s
})
```

---

## Type-safe HTTP client via Hono RPC

Routes defined in the server are automatically available as a typed client — no code generation step:

```typescript
// @my-org/my-brap/src/http/routes.ts
const app = new Hono()
  .post('/items', ...)
  .get('/items', ...)

export type AppType = typeof app
```

```typescript
// @my-org/my-brap/src/client/MyClient.ts
import { hc } from 'brapper'
import type { AppType } from '../http/routes.js'

export class MyClient {
  private rpc = hc<AppType>(this.serverUrl, {
    headers: { Authorization: `Bearer ${this.token}` },
  })

  constructor(private serverUrl: string, private token: string) {}

  async createItem(payload: ItemPayload) {
    const res = await this.rpc.items.$post({ json: payload })
    return res.json()
  }
}
```

Consumer:

```typescript
import { MyClient } from '@my-org/my-brap'

const client = new MyClient('https://my-brap.example.com', process.env.AUTH_TOKEN)
const item = await client.createItem({ title: 'Hello' })
```

Full autocomplete, typed responses, zero maintenance overhead.

---

## Binary files

Brapper's approach to binary data:

- **HTTP API**: handles multipart uploads and binary responses natively — this is where files belong
- **MCP tools** (both HTTP and stdio): return `fileId` / URL references, not raw binary
- **MCP stdio** has the unique advantage of filesystem access — tools accept a local `path`, read the file, and POST it to the HTTP API

```typescript
// MCP stdio tool
server.tool('upload_file', { path: z.string() }, async ({ path }) => {
  const bytes = await fs.readFile(path)
  const { fileId } = await client.post('/v1/upload', bytes)
  return { content: [{ type: 'text', text: fileId }] }
})
```

---

## What brapper provides

| Module | Export | Purpose |
|--------|--------|---------|
| `browser/BrowserSession` | `BrowserSession` | CDP connection, reconnect, `withPage`, `withApp`, `openPage`, `applyCookies` |
| `browser/PageWorker` | `PageWorker` | `browserFetch`, `waitForResponse`, `onResponse`, `injectScript`, `evaluate` |
| `http/createApp` | `createApp` | Base Hono app: CORS, auth, `/health`, error shape |
| `mcp/createMcpServer` | `createMcpHandler` | HTTP MCP factory |
| `config/parseEnv` | `parseEnv`, `baseEnvSchema` | Zod env parsing + WS endpoint resolution |
| `logging/createLogger` | `createLogger` | pino + pino-pretty in dev |
| `createBrap` | `createBrap` | Top-level orchestrator: connect → cookies → warm-up → serve |
| — | `hc` (re-export from hono/client) | Hono RPC typed client factory |
| — | `z` (re-export from zod) | Extend `baseEnvSchema` in brap configs |
| — | `Logger`, `Hono` (type re-exports) | Type-only convenience imports |

> **Coming in v0.2–v0.3:** `SessionGate`, `SessionMonitor`, `RecoveryStrategy`, `createStdioApp`, `HttpClient`, `stdioBaseEnvSchema`

---

## What brapper does NOT provide

- Target-specific logic (selectors, URLs, auth flows, scraping patterns)
- Captcha solver implementations (strategy interface is provided; implementations live in brap)
- Any knowledge of specific web applications

All of that lives in each individual brap project.

---

## Project layout of a brap

```
@my-org/my-brap/
├── src/
│   ├── server.ts              # HTTP server entry point
│   ├── mcp.ts                 # stdio MCP entry point (#!/usr/bin/env node)
│   ├── config.ts              # Zod env schema (extends baseEnvSchema)
│   ├── app/
│   │   └── MyApp.ts           # the App class — all target-specific logic
│   ├── http/
│   │   └── routes.ts          # Hono routes + export type AppType
│   ├── mcp/
│   │   ├── http-tools.ts      # thin MCP tools for HTTP transport
│   │   └── stdio-tools.ts     # rich MCP tools for stdio (filesystem access)
│   └── client/
│       └── MyClient.ts        # typed client (hc<AppType> wrapper)
├── index.ts                   # export { MyClient, MyApp }
├── deploy/
│   └── Dockerfile             # copied from brapper/deploy/
├── package.json               # bin: { "my-brap-mcp": "dist/mcp.js" }
└── tsconfig.json
```

---

## Getting started

```bash
pnpm add brapper puppeteer-core hono @hono/node-server
```

See [`docs/creating-a-brap.md`](docs/creating-a-brap.md) for a step-by-step guide.


---

## Links

- [Roadmap](ROADMAP.md)
- [Contributing](CONTRIBUTING.md)
- [Architecture](docs/architecture.md)
- [Creating a brap](docs/creating-a-brap.md)
- [Concurrency model](docs/concurrency.md)
- [Session gate and monitor](docs/session-gate-and-monitor.md)

---

## License

MIT © [grigoreo-dev](https://github.com/grigoreo-dev)
