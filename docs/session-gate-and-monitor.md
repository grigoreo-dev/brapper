# SessionGate, SessionMonitor, and PageGuards

Three complementary mechanisms that keep the browser session healthy and protect request processing from broken states.

---

## SessionGate — global pause

A promise-based barrier. All lane operations (`withPersistentPage`, `withSpawnedPage`) pass through `gate.wait()` before touching the browser. When the gate is closed, new callers suspend. When it opens, they all resume simultaneously.

```
gate.close()  →  new lane calls suspend (await gate.wait())
gate.open()   →  all suspended callers resume simultaneously
gate.degrade() → all waiters receive an error (503-equivalent)
```

### State machine

```
OPEN ──(close)──▶ CLOSED ──(openGate)──▶ OPEN
                       └──(degrade)──▶ DEGRADED
```

Closing an already-closed gate is a no-op — existing waiters keep waiting.

### Session states

```
STARTING    gate open (server not yet ready, warmUp running or not called)
READY       gate open, normal operation
RECOVERING  gate closed, recovery in progress
DEGRADED    recovery failed, gate permanently closed until process restart
```

Note: the gate starts **open** (`READY`) at construction. `markStarting()` closes it and is only useful if you need to manually pause before explicit readiness. `createBrap` no longer calls `markStarting()` during warmUp — warmUp runs while the gate is open because the HTTP server hasn't started yet at that point.

### /health response

```json
{ "ok": true,  "state": "ready",      "browser_connected": true,
  "warm": true, "persistent_pages": { "total": 1, "healthy": 1, "restarting": 0 },
  "spawned_inflight": 2, "queue_depth": 0 }

{ "ok": false, "state": "recovering", "browser_connected": true, ... }
{ "ok": false, "state": "degraded",   "browser_connected": false, ... }
```

Returns `200` when `ok: true`, `503` otherwise.

---

## SessionMonitor — recovery orchestration

`SessionMonitor` drives the session state machine. It receives failure events from three sources and runs the recovery pipeline.

### Failure sources

| Source | How it arrives |
|--------|---------------|
| Browser disconnect | `BrowserSupervisor.onDisconnected` fires when the CDP connection drops |
| Page crash / close | `page.on('close')` event on a spawned page |
| Guard trip | `PageGuard` attached to a page signals a problem |

### Recovery pipeline

```
failure event received
        │
        ▼
already recovering? → yes → skip (single-flight)
        │
        ▼ no
gate.close()             ← new lane calls start queueing
        │
        ▼
for each RecoveryStrategy:
    strategy.detect(page) → true?
        │
        ▼
    strategy.recover(worker) → 'ok' | 'failed'
        │
   'ok' → gate.open() → queue drains → done
        │
   'failed' (or no strategy matched) → try recoverBrowser()
        │
   success → gate.open() → done
        │
   error → gate.degrade() → all waiters get error
```

If `monitor.abort()` is called (during graceful shutdown) the pipeline exits immediately and does not open or degrade the gate.

### RecoveryStrategy interface

```typescript
import type { RecoveryStrategy } from 'brapper'
import type { Page } from 'puppeteer-core'

export const reloginStrategy: RecoveryStrategy = {
  name: 'relogin',

  detect: (page: Page) => page.url().includes('/login'),

  recover: async (worker) => {
    await worker.page.goto('https://app.example.com/login')
    await worker.page.fill('#email', process.env.APP_EMAIL!)
    await worker.page.fill('#password', process.env.APP_PASSWORD!)
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
  recoveryStrategies: [reloginStrategy, captchaStrategy],
  routes: registerRoutes,
})
```

---

## PageGuards — per-page condition detectors

Guards are optional detectors attached to individual pages (persistent or spawned). When a guard trips, it signals `SessionMonitor` which runs the recovery pipeline.

### Guard interface

```typescript
import type { PageGuard, GuardSignal } from 'brapper'

export const authGuard: PageGuard = {
  name: 'auth',
  severity: 'recoverable',   // 'warn' | 'recoverable' | 'fatal'

  // Called once when the page is created, returns cleanup fn
  attach(worker, signal: GuardSignal) {
    const unsubscribe = worker.onResponse(
      (url) => url.includes('/api/'),
      (res) => {
        if (res.status === 401) signal.emit('401 on API response')
      },
    )
    return unsubscribe
  },

  // Optional: called before each lane invocation as a pre-flight check
  check: async (worker) => {
    const url = worker.page.url()
    return url.includes('/login') || url.includes('/captcha')
  },
}
```

- `severity: 'warn'` — logs only, no recovery
- `severity: 'recoverable'` — closes gate, runs recovery pipeline, reopens on success
- `severity: 'fatal'` — closes gate, skips strategies, goes straight to browser reconnect

### Attaching guards

Default guards apply to every page in both lanes:

```typescript
await createBrap({
  env,
  defaultGuards: [authGuard],
  routes: registerRoutes,
})
```

Per-call guards apply only to that specific invocation:

```typescript
// Persistent page with extra guard
session.withPersistentPage(fn, { key: 'main', guards: [captchaGuard] })

// Spawned page with extra guard
session.withSpawnedPage(fn, { guards: [rateLimitGuard] })
```

---

## Graceful shutdown

`session.disconnect()` performs a clean shutdown in three steps:

1. `monitor.abort()` — stops any in-progress recovery immediately.
2. `await persistentLane.invalidateAll()` — closes all persistent pages via CDP before dropping the connection.
3. `await supervisor.disconnect()` — sets `closing = true` to silence the `'disconnected'` event, then drops the CDP connection.

The `closing` flag also causes any in-progress reconnect loop to exit at its next iteration, preventing the process from staying alive past `SIGINT`/`SIGTERM`.
