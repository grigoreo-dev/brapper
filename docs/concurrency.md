# Concurrency model

## Overview

Each HTTP request to a brap server can run in its own browser tab, in parallel with other requests. `BrowserSession` manages a **bounded pool** with a **FIFO queue** for overflow.

```
concurrency: 3

request A ──▶ tab 1 opens ──▶ MyApp.create() ──▶ work ──▶ tab 1 closes
request B ──▶ tab 2 opens ──▶ MyApp.create() ──▶ work ──▶ tab 2 closes
request C ──▶ tab 3 opens ──▶ MyApp.create() ──▶ work ──▶ tab 3 closes
request D ──▶ waits... ─────────────────────▶ tab 1 freed ──▶ D starts
request E ──▶ waits... ─────────────────────▶ tab 2 freed ──▶ E starts
```

## Configuration

```typescript
const { start } = await createBotApp({
  env,
  routes: registerRoutes,
  sessionConcurrency: 3,       // max parallel tabs (default: 1)
  sessionQueueTimeout: 30_000, // ms to wait before rejecting (default: none)
})
```

## Choosing concurrency

| Target app | Recommended | Notes |
|------------|-------------|-------|
| Apps with per-account rate limits | 1–2 | Too many tabs = rate limit / ban |
| Apps where each tab is independent | 3–5 | Safe for most |
| Scraping static/public data | 5–10 | Monitor for bans |

## App class lifecycle

Each `withApp` call:
1. Opens a new `Page` from the connected browser
2. Calls `MyApp.create(worker)` — navigate, inject scripts, wait for ready state
3. Runs your handler with the app instance
4. Closes the tab (whether handler succeeded or threw)

```typescript
// withApp guarantees cleanup even on error
await session.withApp(MyApp, async (app) => {
  throw new Error('something went wrong')
  // tab still gets closed
})
```

## Warm-up vs per-request App

There are two patterns for using the App class:

### Pattern A: per-request App (default)

Each request creates and destroys its own App instance. Overhead: one navigation + warm-up per request.

```typescript
app.post('/v1/search', async (c) => {
  return session.withApp(MyApp, async (app) => {
    return c.json(await app.search(body.query))
  })
})
```

Good for: stateless operations, apps where login state is in cookies.

### Pattern B: persistent App pool (advanced)

Pre-warm N App instances at startup and reuse them across requests. Lower latency, but more complex lifecycle management.

```typescript
// startup
const appPool = await AppPool.create(MyApp, session, { size: 3 })

// per request
app.post('/v1/search', async (c) => {
  return appPool.withApp(async (app) => {
    return c.json(await app.search(body.query))
  })
})
```

> Note: `AppPool` is not yet in brapper — implement in your brap if needed.

## Queue behavior

When all tabs are busy, new requests wait in a FIFO queue:

- If `sessionQueueTimeout` is set: requests waiting longer than the timeout receive a `503 Service Unavailable`
- If not set: requests wait indefinitely

The queue is in-memory. On server restart, queued requests are lost. Design clients to retry on 503.
