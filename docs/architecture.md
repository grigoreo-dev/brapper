# Architecture

## Layer overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Consumer / AI Agent                       │
│           (Cursor, Claude Desktop, scripts, CI, etc.)            │
└────────────┬────────────────────────────────┬────────────────────┘
             │ import { MyClient }             │ MCP tools
             │                                 │ (stdio)
┌────────────▼────────────┐   ┌───────────────▼──────────────────┐
│     MyClient            │   │      MCP stdio binary             │
│  (typed Hono RPC)       │   │   (npx @my-org/my-brap-mcp)       │
└────────────┬────────────┘   └───────────────┬──────────────────┘
             │ HTTP                            │ HTTP
             │                                 │
┌────────────▼─────────────────────────────────▼──────────────────┐
│                      HTTP API Server                             │
│               Hono + brapper infrastructure                      │
│                                                                  │
│   GET /health    POST /v1/...    GET /openapi.json    /mcp       │
└─────────────────────────────┬────────────────────────────────────┘
                              │ app.authorize() / app.getPayment()
┌─────────────────────────────▼────────────────────────────────────┐
│                  Session-bound App (MyApp)                        │
│                                                                  │
│   holds BrowserSession reference                                 │
│   each method picks its own execution lane                       │
│                                                                  │
│   method A ──▶ session.withPersistentPage(...)  ← reuses tab    │
│   method B ──▶ session.withSpawnedPage(...)     ← fresh tab     │
└─────────────────────────────┬────────────────────────────────────┘
                              │
┌─────────────────────────────▼────────────────────────────────────┐
│                    BrowserSession                                 │
│                                                                  │
│  ┌──────────────────────┐   ┌──────────────────────────────────┐ │
│  │  Persistent lane     │   │  Spawned lane                    │ │
│  │  one tab per key,    │   │  new tab per call, closed after  │ │
│  │  kept alive, mutex   │   │  handler returns, parallelism N  │ │
│  └──────────────────────┘   └──────────────────────────────────┘ │
│                                                                  │
│  SessionGate ── SessionMonitor ── BrowserSupervisor              │
│  (pause barrier)  (recovery)      (CDP connect/reconnect)        │
└─────────────────────────────┬────────────────────────────────────┘
                              │ CDP / puppeteer-core
┌─────────────────────────────▼────────────────────────────────────┐
│              Chrome / Chromium (remote debugging)                │
│                   --remote-debugging-port=9222                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## The session-bound App pattern

An App class is the adapter for a specific web application. It holds a reference to the `BrowserSession` and each method decides independently whether to run on a persistent page or a fresh spawned page.

```typescript
// src/app/MyApp.ts
import type { BrowserSession } from 'brapper'

export class MyApp {
  private constructor(private readonly session: BrowserSession) {}

  static async create(session: BrowserSession): Promise<MyApp> {
    const app = new MyApp(session)
    // Warm up the persistent page on first use
    await session.withPersistentPage(async (worker) => {
      await worker.page.goto('https://target-app.com', { waitUntil: 'domcontentloaded' })
    }, { key: 'main' })
    return app
  }

  // Fast: reuses the warm persistent page — no navigation overhead
  async doSomething(query: string) {
    return this.session.withPersistentPage(async (worker) => {
      const res = await worker.browserFetch('/api/search?q=' + query)
      return res.json<SearchResult[]>()
    }, { key: 'main' })
  }

  // Isolated: opens a fresh tab, closes it after handler returns
  async scrapeIsolated(url: string) {
    return this.session.withSpawnedPage(async (worker) => {
      await worker.page.goto(url)
      return worker.evaluate(() => document.title)
    })
  }
}
```

### Why session-bound instead of page-bound

The previous pattern (`create(worker: PageWorker)`) was page-bound: the App held a single page and all methods ran on it. This meant brapper had to pick the execution mode before creating the App.

The session-bound pattern inverts control: the App holds the session and each method selects its own lane. This makes sense because:

- Different methods have different requirements: `browserFetch` calls are fast and re-entrant; DOM automation may need isolation.
- The App author knows best which operations are safe to share a page and which need isolation.
- One App instance can use a persistent page for quick API calls and spawn fresh pages for complex flows — simultaneously.

---

## Execution lanes

### Persistent page lane

`session.withPersistentPage(fn, { key })` runs `fn` on a long-lived tab identified by `key`.

- Tab is created lazily on first use, then kept alive.
- Calls with the same `key` are serialised via a per-key mutex.
- Calls with different keys run in parallel (each key has its own tab).
- If the page closes or crashes, it is recreated automatically before the next call.
- On full browser disconnect, all persistent pages are invalidated and recreated after reconnect.

### Spawned page lane

`session.withSpawnedPage(fn)` opens a fresh tab, runs `fn`, then closes the tab — even if `fn` throws.

- Up to `concurrency` calls run in parallel (default: `1`, serial queue).
- Each call gets a completely isolated tab with no shared state.
- On browser disconnect, in-flight spawned calls receive an error and the tab is discarded.

Both lanes pass through `SessionGate` so recovery pauses all new work uniformly.

---

## Request flow

```
HTTP request arrives
        │
        ▼
route handler calls app.someMethod()
        │
        ▼
method calls session.withPersistentPage(fn, { key: 'main' })
        │
        ▼
SessionGate.wait()          ← suspends if recovering
        │
        ▼
PersistentPageLane.withPage(key, fn)
        │
        ├── key exists and page healthy → acquire mutex → run fn
        │
        └── page missing or closed → recreate → acquire mutex → run fn
        │
        ▼
fn runs → result returned → mutex released
```

---

## Session internals

| Subsystem | Responsibility |
|-----------|---------------|
| `BrowserSupervisor` | CDP connect/reconnect with backoff, `closing` flag suppresses reconnect on shutdown |
| `SessionGate` | Promise barrier: `wait()`, `close()`, `openGate()`, `degrade()` |
| `SessionMonitor` | Detects failures, runs `RecoveryStrategy` chain, drives gate state |
| `PersistentPageLane` | Per-key page leases, per-key mutex, auto-recreate |
| `PageRegistry` | Tracks all live pages and their health for `/health` metrics |
| `GuardRuntime` | Attaches optional `PageGuard` detectors to pages, routes trips to monitor |

---

## Package topology

```
npm registry
├── brapper                    framework (infrastructure only)
├── @my-org/app-one-brap       adapter for app-one.example.com
│   ├── dist/server.js         HTTP server
│   └── dist/mcp.js            stdio MCP binary (bin: app-one-brap-mcp)
└── @my-org/app-two-brap       adapter for app-two.example.com

each brap exports:
  - XxxClient    typed HTTP client (hc<AppType> wrapper)
  - XxxApp       session-bound App class
```

---

## What brapper owns vs what a brap owns

| Concern | brapper | brap |
|---------|---------|------|
| CDP connection, reconnect | ✓ | |
| Persistent page lane (per-key lease + mutex) | ✓ | |
| Spawned page lane (pool + queue) | ✓ | |
| `withApp` — session-bound App lifecycle | ✓ | |
| `PageWorker` helpers | ✓ | |
| Cookie manager | ✓ | |
| `SessionGate` — global pause barrier | ✓ | |
| `SessionMonitor` — recovery orchestration | ✓ | |
| `RecoveryStrategy` interface | ✓ | |
| `PageGuard` interface + `GuardRuntime` | ✓ | |
| `BrowserSupervisor` — connect/reconnect/shutdown | ✓ | |
| `PageRegistry` — live page tracking | ✓ | |
| Hono base app, /health, CORS | ✓ | |
| `hc` re-export (Hono RPC) | ✓ | |
| Env parsing base schema | ✓ | |
| Logger | ✓ | |
| Graceful shutdown (close persistent pages, disconnect) | ✓ | |
| Target app URL, selectors | | ✓ |
| Auth / login flow | | ✓ |
| Script injection | | ✓ |
| Recovery strategy implementations | | ✓ |
| Page guard implementations | | ✓ |
| Business logic App class methods | | ✓ |
| Route definitions | | ✓ |
| MCP tool definitions | | ✓ |
| Typed client class | | ✓ |
