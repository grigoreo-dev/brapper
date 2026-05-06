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
│  (typed Hono RPC)       │   │   (npx @my-org/my-brap-mcp)               │
└────────────┬────────────┘   └───────────────┬──────────────────┘
             │ HTTP                            │ HTTP
             │                                 │
┌────────────▼─────────────────────────────────▼──────────────────┐
│                      HTTP API Server                             │
│               Hono + brapper infrastructure                │
│                                                                  │
│   GET /health    POST /v1/...    GET /openapi.json    /mcp       │
└─────────────────────────────┬────────────────────────────────────┘
                              │ session.withApp(MyApp, ...)
┌─────────────────────────────▼────────────────────────────────────┐
│                    BrowserSession (page pool)                     │
│                                                                  │
│   concurrency: N        queue: unlimited        reconnect: yes   │
│                                                                  │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐                      │
│   │  MyApp   │  │  MyApp   │  │  MyApp   │   ← one per tab      │
│   │ (tab 1)  │  │ (tab 2)  │  │ (tab 3)  │                      │
│   └──────────┘  └──────────┘  └──────────┘                      │
└─────────────────────────────┬────────────────────────────────────┘
                              │ CDP / puppeteer-core
┌─────────────────────────────▼────────────────────────────────────┐
│              Chrome / Chromium (remote debugging)                │
│                   --remote-debugging-port=9222                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## BrowserSession and the App class

`BrowserSession` manages the connection to one Chrome instance and a pool of tabs. When a request arrives, `withApp` picks (or waits for) a free tab, creates an App instance on it, runs the handler, then closes the tab.

```
HTTP request arrives
        │
        ▼
session.withApp(MyApp, async (app) => {
    ├─ if free tab available → open new tab immediately
    │         └─ MyApp.create(worker) → navigate, inject, warm-up
    │
    └─ if all tabs busy → wait in queue (FIFO)
              └─ when tab freed → same as above
})
        │
        ▼
handler runs → app.doSomething()
        │
        ▼
tab.close() → slot freed → next queued job starts
```

This means each request gets a **fresh, isolated browser context** (tab). There is no shared mutable state between concurrent requests.

---

## Two entry points, one codebase

```
src/
├── server.ts    →  HTTP API + optional HTTP MCP
│                   runs in Docker / on a server
│                   needs: Chrome with CDP
│
└── mcp.ts       →  MCP stdio
                    runs locally on the user's machine
                    needs: SERVER_URL pointing at the HTTP server
```

The stdio process never touches the browser directly. It is a smart HTTP client:
- reads files from the local filesystem
- composes multiple HTTP calls into single high-level MCP tools
- handles MCP protocol details (tool schemas, content types, streaming)

---

## Data flow for binary files

```
AI agent: "upload /Users/me/report.pdf"
    │
    ▼
MCP stdio tool: upload_file({ path: "/Users/me/report.pdf" })
    │
    ├─ fs.readFile(path)                    ← local disk access
    │
    ├─ POST /v1/upload (multipart)          ← HTTP to server
    │       │
    │       ▼
    │   HTTP server → session.withApp(MyApp, app => app.uploadFile(bytes))
    │       │
    │       ▼
    │   MyApp.uploadFile → browserFetch('/api/upload', bytes)
    │       │
    │       ▼
    │   Chrome tab executes fetch() with site cookies + session
    │       │
    │       ▼
    │   returns { fileId: "abc123" }
    │
    └─ returns { content: [{ type: "text", text: "abc123" }] }
    │
    ▼
AI agent receives fileId, uses it in subsequent calls
```

Binary data never travels through MCP's JSON-RPC layer as raw bytes — it goes through the HTTP API which handles it natively.

---

## HttpClient and typed client

```
brapper
└── HttpClient          generic typed fetch wrapper

@my-org/my-brap
├── http/routes.ts      Hono routes → export type AppType
└── client/MyClient.ts  hc<AppType> wrapper with named methods
                        ↑ types derived automatically from routes
                        ↑ no code generation, no manual sync
```

`hc<AppType>` from Hono RPC gives full TypeScript types for all routes at zero cost. Adding a new route to `routes.ts` makes it immediately available in `MyClient` with correct request/response types.

---

## Package topology

```
npm registry
├── brapper        framework (infrastructure only)
├── @my-org/app-one-brap         adapter for app-one.example.com
│   ├── dist/server.js           HTTP server
│   └── dist/mcp.js              stdio MCP binary (bin: app-one-brap-mcp)
└── @my-org/app-two-brap         adapter for app-two.example.com

each brap exports:
  - XxxClient    typed HTTP client (hc<AppType> wrapper)
  - XxxApp       browser App class (for embedding in other servers)
```

---

## What brapper owns vs what brap owns

| Concern | brapper | brap |
|---------|---------|------|
| CDP connection, reconnect | ✓ | |
| Page pool + queue | ✓ | |
| `withApp` — App class lifecycle | ✓ | |
| PageWorker helpers | ✓ | |
| Request modifier | ✓ | |
| Cookie manager | ✓ | |
| Navigation helpers | ✓ | |
| Stealth options | ✓ | |
| Hono base app, /health, CORS | ✓ | |
| Rate limiter, request timeout | ✓ | |
| OpenAPI generation | ✓ | |
| MCP HTTP transport | ✓ | |
| MCP stdio transport | ✓ | |
| `SessionGate` — global pause barrier | ✓ | |
| `SessionMonitor` — recovery orchestration | ✓ | |
| `RecoveryStrategy` interface | ✓ | |
| `HttpClient` typed fetch wrapper | ✓ | |
| `hc` re-export (Hono RPC) | ✓ | |
| Env parsing base schema | ✓ | |
| Logger | ✓ | |
| Prometheus `/metrics` | ✓ | |
| Graceful shutdown (drain) | ✓ | |
| Dockerfile + docker-compose templates | ✓ | |
| Target app URL, selectors | | ✓ |
| Auth / login flow | | ✓ |
| Script injection (e.g. Turbopack hook) | | ✓ |
| Captcha recovery strategy implementation | | ✓ |
| Business logic App class methods | | ✓ |
| Route definitions | | ✓ |
| MCP tool definitions | | ✓ |
| Typed client class | | ✓ |
