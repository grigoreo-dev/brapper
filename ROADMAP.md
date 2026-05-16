# Roadmap

brapper is an open-source framework under the [grigoreo-dev](https://github.com/grigoreo-dev) organization.

This roadmap reflects the current direction. Priorities may shift based on community feedback and real-world brap projects.

---

## v0.1 — Foundation ✦ current

Core infrastructure. Everything needed to build a working brap.

- [x] `BrowserSession` — CDP connect, page pool, reconnect with backoff
- [x] `PageWorker` — `browserFetch`, `waitForResponse`, `onResponse`, `injectScript`
- [x] `createApp` — base Hono app with CORS, timing, auth, `/health`, error shape
- [x] `createMcpHandler` — HTTP MCP via `WebStandardStreamableHTTPServerTransport`
- [x] `createLogger` — pino + pino-pretty in dev
- [x] `parseEnv` / `baseEnvSchema` — Zod env parsing + WS endpoint resolution
- [x] `createServer` — top-level orchestrator (was `createBotApp`)
- [x] `withApp` on `BrowserSession` — App class pattern with pool + queue
- [x] `hc` re-export from `hono/client` — Hono RPC typed client factory
- [x] `deploy/Dockerfile` — base image template

---

## v0.2 — Session lifecycle

Make sessions production-ready: warm-up gating, runtime recovery, clean shutdown, and dual page execution lanes.

- [ ] `SessionGate` — promise-based open/close barrier; `wait`, `open`, `close`, `degrade`
- [ ] `SessionMonitor` — attaches `RecoveryStrategy` detectors to pages, drives gate state
- [ ] `RecoveryStrategy` interface — `detect(page)` + `recover(worker)` → `'ok' | 'failed'`
- [ ] `SessionState` enum — `starting / ready / recovering / degraded`
- [ ] `/health` reflects session state
- [ ] Graceful shutdown — drain active `withApp` jobs before process exit
- [ ] Persistent page lane — single long-lived page (or keyed pages) for low-latency `evaluate`/`browserFetch` calls
- [ ] Spawned page lane — existing per-call page lifecycle, available concurrently with persistent lane
- [ ] Unified browser-failure recovery — full browser disconnect/crash recovery works for both lanes simultaneously
- [ ] Persistent page self-healing — auto-recreate persistent page after page close/crash without process restart
- [ ] Page guards — optional per-page guard set on new pages to monitor auth/captcha/session integrity
- [ ] Guard-triggered recovery orchestration — guard failures close gate, recover, and reopen/degrade
- [x] `withApp` on `BrowserSession` — App class pattern with pool + queue *(shipped in v0.1)*

---

## v0.3 — stdio MCP + typed client

Complete the dual-target architecture.

- [ ] `createStdioApp` — stdio MCP entry point factory (`StdioServerTransport`)
- [ ] `stdioBaseEnvSchema` — `SERVER_URL`, `API_TOKEN`, `LOG_LEVEL`
- [ ] `HttpClient` — typed fetch wrapper: `get`, `post`, `postFormData`, `postBinary`
- [x] `hc` re-export from `hono/client` — Hono RPC typed client factory *(shipped in v0.1)*
- [ ] `AppContext` type (replaces `BotContext`) — generic over env schema
- [ ] Shebang + `postbuild chmod` guidance in `deploy/`

---

## v0.4 — Browser toolkit

Helpers that every brap needs but nobody wants to write from scratch.

- [ ] Cookie manager — `loadCookies(path)`, `saveCookies(path)` on `BrowserSession`
- [ ] Request modifier — `worker.modifyRequest(match, transform)` for outgoing requests
- [ ] Navigation helpers — `waitForUrl(pattern)`, `waitForNetworkIdle`, sensible timeout defaults
- [ ] Stealth options — hide `navigator.webdriver`, randomize viewport, `extraHTTPHeaders` preset

---

## v0.5 — HTTP hardening

Production HTTP layer.

- [ ] Rate limiter middleware — `rateLimit: { max, windowMs }` in `createServer`
- [ ] Request timeout middleware — auto-abort hanging requests
- [ ] OpenAPI generation — `@hono/zod-openapi` integration; no more hand-maintained specs
- [ ] Queue timeout — reject requests waiting too long with `503`

---

## v0.6 — Observability

Make brapper deployments monitorable.

- [ ] Prometheus `/metrics` endpoint — active tabs, queue depth, recovery count, request latency
- [ ] Lane-level metrics — persistent lane usage, spawned lane usage, and persistent page restart counts
- [ ] Structured request IDs — propagate `x-request-id` through logs and MCP tool calls
- [ ] Session event hooks — `onReady`, `onRecovering`, `onDegraded` callbacks in `createServer`

---

## v0.7 — Testing utilities

Make braps testable without a real browser.

- [ ] `MockPageWorker` — in-memory fake for unit testing App classes
- [ ] `MockHttpClient` — response fixtures for testing stdio MCP tools
- [ ] `createTestServer` — spin up a brapper HTTP server with a mock session for integration tests
- [ ] Unit tests for `SessionGate`, `SessionMonitor`, `parseEnv`, `HttpClient`
- [ ] Crash-recovery tests — validate full browser failure recovery for both persistent and spawned lanes
- [ ] Guard tests — validate per-page guard attach/detach and recovery trigger semantics

---

## v0.8 — Deploy templates

One-command deployment for any brap.

- [ ] `docker-compose.yml` template — brap server + Chrome (`browserless/chrome`) + env
- [ ] GitHub Actions workflow — build, typecheck, publish to npm
- [ ] `fly.toml` template — Fly.io deployment

---

## v1.0 — DX and ecosystem

Polish, tooling, community.

- [ ] `create-brap` CLI — `pnpm create @grigoreo-dev/brap my-project` scaffolds a new brap
- [ ] `brapper` website / docs site
- [ ] Stable public API with semver guarantees
- [ ] First official brap published under `@grigoreo-dev`

---

## Ideas backlog (not scheduled)

- **Multi-browser support** — attach to Firefox via CDP or Playwright instead of Puppeteer
- **Browser pool across processes** — multiple Chrome instances, not just multiple tabs
- **Auth session persistence** — encrypted cookie store with expiry tracking
- **Webhook support** — emit events when session state changes (for external monitoring)
- **MCP tool streaming** — progress notifications for long-running operations
- **`BrapTester`** — high-level test harness: spin up server, make typed requests, assert responses

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
