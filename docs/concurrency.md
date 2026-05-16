# Execution lanes

`BrowserSession` offers two execution modes that can run simultaneously.

---

## Persistent page lane

`session.withPersistentPage(fn, { key })` runs work on a long-lived tab identified by `key`.

```
key: 'main'

request A ──▶ acquire mutex ──▶ fn(worker) ──▶ release mutex
request B ──▶ waits for mutex ─────────────▶ acquire ──▶ fn(worker) ──▶ release
request C ──▶ waits for mutex ──────────────────────────▶ acquire ──▶ fn(worker)
```

- Tab is created on first use, then kept alive indefinitely.
- Calls with the same key are **serialised** (per-key mutex). The tab is never shared concurrently.
- Multiple keys run **in parallel** — each key owns its own tab.
- If the tab closes or crashes it is recreated automatically before the next call.
- On full browser disconnect, all tabs are invalidated. After reconnect they are recreated lazily.

### When to use

- `browserFetch` / `evaluate` calls that only need the page's session context (cookies, auth).
- High-frequency, low-latency operations where navigation overhead matters.
- Any operation that is safe to run serially and benefits from a warm tab.

```typescript
// Inside a session-bound App method
getPayment(id: string) {
  return this.session.withPersistentPage(async (worker) => {
    const res = await worker.browserFetch('/api/payment/' + id, { credentials: 'include' })
    return res.json<Payment>()
  }, { key: 'main' })
}
```

---

## Spawned page lane

`session.withSpawnedPage(fn)` opens a fresh tab, runs `fn`, then closes the tab — even if `fn` throws.

```
concurrency: 3

request A ──▶ tab 1 opens ──▶ fn(worker) ──▶ tab 1 closes
request B ──▶ tab 2 opens ──▶ fn(worker) ──▶ tab 2 closes
request C ──▶ tab 3 opens ──▶ fn(worker) ──▶ tab 3 closes
request D ──▶ waits in queue ───────────▶ tab 1 freed ──▶ tab 4 opens ──▶ ...
```

- Up to `concurrency` calls run in parallel (default: `1`, fully serial).
- Each call gets an isolated tab with no shared state across requests.
- Tabs are always closed after the handler returns, whether it succeeded or threw.

### When to use

- Multi-step navigations or DOM automation that modifies page state.
- Operations that must not interfere with each other (e.g. checkout flows, file uploads).
- Any work where isolation is more important than latency.

```typescript
// Inside a session-bound App method
async scrapeReport(url: string) {
  return this.session.withSpawnedPage(async (worker) => {
    await worker.page.goto(url, { waitUntil: 'networkidle0' })
    return worker.evaluate(() => document.body.innerText)
  })
}
```

---

## Using both from one App

A single App method set can freely mix lanes:

```typescript
export class MyApp {
  private constructor(private readonly session: BrowserSession) {}

  static async create(session: BrowserSession): Promise<MyApp> {
    const app = new MyApp(session)
    await session.withPersistentPage(async (worker) => {
      await worker.page.goto('https://target-app.com', { waitUntil: 'domcontentloaded' })
    }, { key: 'main' })
    return app
  }

  // Fast API call on persistent page
  getUser(id: string) {
    return this.session.withPersistentPage(
      (worker) => worker.browserFetch('/api/users/' + id).then(r => r.json<User>()),
      { key: 'main' },
    )
  }

  // Isolated multi-step flow on spawned page
  checkout(cartId: string) {
    return this.session.withSpawnedPage(async (worker) => {
      await worker.page.goto('/checkout/' + cartId)
      await worker.page.click('#confirm-button')
      await worker.page.waitForNavigation()
      return worker.evaluate(() => window.__ORDER_ID__)
    })
  }
}
```

---

## Configuring the spawned lane

Pass `concurrency` to `BrowserSession` (or via `createBrap`):

```typescript
const session = new BrowserSession({
  wsEndpoint: '...',
  concurrency: 3,   // up to 3 parallel spawned tabs (default: 1)
})
```

| Target app | Recommended | Notes |
|------------|-------------|-------|
| Apps with per-account rate limits | 1–2 | Too many tabs = rate limit / ban |
| Apps where each tab is independent | 3–5 | Safe for most |
| Scraping static/public data | 5–10 | Monitor for bans |

---

## Gate interaction

Both lanes pass through `SessionGate.wait()` before touching the browser. During recovery, the gate is closed: new calls in both lanes suspend and resume automatically once recovery succeeds.
