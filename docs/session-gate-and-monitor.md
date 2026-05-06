# SessionGate and SessionMonitor

Two complementary mechanisms that keep the browser session healthy and protect request processing from broken states.

---

## SessionGate — global pause

A promise-based barrier. All `withApp` calls pass through it before touching the browser. When the gate is closed, requests queue up and wait. When it opens, they all proceed.

```
gate.close()  →  incoming withApp calls suspend (await gate.wait())
gate.open()   →  all suspended calls resume simultaneously
```

### State machine

```
CLOSED ──(open)──▶ OPEN ──(close)──▶ CLOSED
```

Closing an already-closed gate is a no-op — the existing waiters just keep waiting.

### Lifecycle

| Event | Gate state | Effect |
|-------|------------|--------|
| Server starting, warmUp not done | closed | requests queue up |
| warmUp completes | open | queue drains |
| SessionMonitor detects a problem | closed | new requests queue up |
| Recovery succeeds | open | queue drains |
| Recovery fails / timeout | degraded | queued requests get 503 |

### In withApp

```typescript
// BrowserSession.withApp (internal flow)
async withApp<T>(AppClass, handler) {
  await this.gate.wait()       // ← blocks here if gate is closed
  const tab = await this.acquireTab()
  const app = await AppClass.create(tab)
  try {
    return await handler(app)
  } finally {
    await tab.close()
  }
}
```

Already-running handlers are not interrupted when the gate closes — only new incoming calls are held.

---

## SessionMonitor — background watchdog

Watches browser pages for problem conditions (captcha, auth expiry, error pages) and drives recovery. When a problem is detected it closes the gate, runs the recovery strategy, then opens the gate again.

### Recovery strategy interface

```typescript
interface RecoveryStrategy {
  name: string

  // Return true if this page needs recovery.
  // Receives the full Page — can check url, DOM, cookies, anything.
  detect(page: Page): boolean | Promise<boolean>

  // Attempt to fix the problem.
  // Return 'ok' if resolved, 'failed' if not.
  recover(worker: PageWorker): Promise<'ok' | 'failed'>
}
```

`page` carries everything needed — `page.url()` for URL checks, `page.evaluate()` for DOM inspection, `page.cookies()` for auth state.

### Registration

Strategies are registered per-brap and passed into `createServer`:

```typescript
// src/server.ts in a brap
await createServer({
  env,
  routes: registerRoutes,
  warmUp: async (session) => { ... },
  recoveryStrategies: [
    captchaStrategy,
    reloginStrategy,
  ],
})
```

`SessionMonitor` attaches the detectors to every page opened via `withApp`. If any page triggers a detector mid-request, the monitor takes over.

### Recovery flow

```
any page triggers detect(page) → true
          │
          ▼
gate.close()              ← new requests start queueing
          │
          ▼
strategy.recover(worker)
          │
     ┌────┴────┐
    'ok'    'failed'
     │          │
     ▼          ▼
gate.open()  gate.degrade()
(queue       (queue gets
 drains)      503 responses)
```

If multiple pages hit the same condition simultaneously, the monitor ensures only one recovery runs at a time — subsequent detections while recovery is in progress are ignored.

---

## Session states

```
STARTING    warmUp not yet complete, gate closed
READY       gate open, normal operation
RECOVERING  gate closed, recovery in progress
DEGRADED    recovery failed, gate permanently closed until restart
```

`GET /health` exposes current state:

```json
{ "ok": true,  "state": "ready",      "browser_connected": true }
{ "ok": false, "state": "recovering", "browser_connected": true }
{ "ok": false, "state": "degraded",   "browser_connected": true }
```

---

## Example: captcha strategy in a brap

```typescript
// src/monitor/captchaStrategy.ts
import type { RecoveryStrategy } from 'brapper'

export const captchaStrategy: RecoveryStrategy = {
  name: 'captcha',

  detect: (page) => page.url().includes('/showcaptcha'),

  recover: async (worker) => {
    const siteKey = await worker.evaluateExpression<string>(
      'window.__SSR_DATA__?.captcha?.siteKey ?? ""'
    )
    if (!siteKey) return 'failed'

    const token = await captchaSolver.solve({ siteKey, url: worker.page.url() })
    await worker.evaluateExpression(`submitCaptchaToken(${JSON.stringify(token)})`)
    await worker.page.waitForNavigation()

    return worker.page.url().includes('/showcaptcha') ? 'failed' : 'ok'
  },
}
```

---

## Manual recovery (no solver)

When no automatic recovery is possible, the strategy logs and waits for operator action:

```typescript
export const manualCaptchaStrategy: RecoveryStrategy = {
  name: 'captcha-manual',

  detect: (page) => page.url().includes('/captcha'),

  recover: async (worker) => {
    logger.warn({ url: worker.page.url() }, 'Captcha detected — resolve manually in the browser')
    // Poll until the captcha page is gone (operator solves it in Chrome)
    await waitUntil(() => !worker.page.url().includes('/captcha'), { timeout: 5 * 60_000 })
    return 'ok'
  },
}
```

The server stays alive and responsive to `/health` while recovery is pending. Clients can poll `/health` and retry when state returns to `ready`.

---

## What brapper provides

| Class | Responsibility |
|-------|----------------|
| `SessionGate` | Promise-based open/close barrier; `wait()`, `open()`, `close()`, `degrade()` |
| `SessionMonitor` | Attaches detectors to pages, runs recovery, drives gate state |
| `SessionState` | Enum: `starting / ready / recovering / degraded` |
| `RecoveryStrategy` | Interface for pluggable detect + recover logic |

`BrowserSession` wires `SessionGate` and `SessionMonitor` together internally. brap code only defines `RecoveryStrategy` implementations and passes them to `createServer`.
