import type { Logger } from 'pino';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { loadCookies } from './cookies.js';
import { PageWorker } from './PageWorker.js';

/**
 * Static factory interface that App classes must satisfy to be used with `withApp`.
 *
 * @example
 * class MyApp implements AppFactory<MyApp> {
 *   static async create(worker: PageWorker): Promise<MyApp> { ... }
 * }
 */
export interface AppFactory<T> {
  create(worker: PageWorker): Promise<T>;
}

export interface BrowserSessionOptions {
  wsEndpoint: string;
  concurrency?: number;
  viewport?: { width: number; height: number };
  logger?: Logger;
  reconnect?: {
    maxRetries?: number;
    delayMs?: number;
  };
}

export class BrowserSession {
  private browser: Browser | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private warm = false;
  private retryCount = 0;

  readonly wsEndpoint: string;
  readonly concurrency: number;
  readonly viewport: { width: number; height: number };
  readonly logger: Logger | undefined;
  readonly reconnect: Required<NonNullable<BrowserSessionOptions['reconnect']>>;

  constructor(options: BrowserSessionOptions) {
    this.wsEndpoint = options.wsEndpoint;
    this.concurrency = options.concurrency ?? 1;
    this.viewport = options.viewport ?? { width: 1920, height: 1080 };
    this.logger = options.logger;
    this.reconnect = {
      maxRetries: options.reconnect?.maxRetries ?? 5,
      delayMs: options.reconnect?.delayMs ?? 2000,
    };
  }

  get isWarm(): boolean {
    return this.warm;
  }

  setWarm(value: boolean): void {
    this.warm = value;
  }

  async connect(): Promise<void> {
    this.browser = await puppeteer.connect({
      browserWSEndpoint: this.wsEndpoint,
      defaultViewport: this.viewport,
    });

    this.browser.on('disconnected', () => {
      this.warm = false;
      this.logger?.warn('Browser disconnected');
      this.browser = null;
    });

    this.logger?.info({ wsEndpoint: this.wsEndpoint }, 'Browser connected');
  }

  async disconnect(): Promise<void> {
    if (this.browser) {
      this.browser.disconnect();
      this.browser = null;
    }
  }

  /**
   * Load cookies from a JSON file and set them on the default browser context.
   * Must be called after `connect()`. Throws if the file is missing or invalid.
   */
  async applyCookies(cookiesPath: string): Promise<number> {
    if (!this.browser) throw new Error('BrowserSession not connected');
    const cookies = loadCookies(cookiesPath);
    // BrowserContext.setCookie uses Storage.setCookies which is unsupported in
    // CDP-attached mode (puppeteer.connect). Use page.setCookie() instead —
    // it uses Network.setCookies which works over CDP.
    const page = await this.browser.newPage();
    try {
      for (const cookie of cookies) {
        await page.setCookie(cookie);
      }
    } finally {
      await page.close();
    }
    return cookies.length;
  }

  /**
   * Open a new page and return a PageWorker without closing it.
   * The caller is responsible for calling `worker.page.close()` when done.
   * Use this for long-lived "session page" patterns where one page is kept
   * alive for the lifetime of the app.
   */
  async openPage(): Promise<PageWorker> {
    const page = await this.acquirePage();
    return new PageWorker(page);
  }

  /**
   * Acquire a tab, create an App instance via its static `create` factory,
   * run `fn`, then release the tab — even if `fn` throws.
   *
   * @example
   * app.post('/v1/items', async (c) => {
   *   return session.withApp(MyApp, async (myApp) => {
   *     const result = await myApp.listItems()
   *     return c.json(result)
   *   })
   * })
   */
  withApp<TApp, T>(factory: AppFactory<TApp>, fn: (app: TApp) => Promise<T>): Promise<T> {
    return this.withPage(async (worker) => {
      const app = await factory.create(worker);
      return fn(app);
    });
  }

  withPage<T>(fn: (worker: PageWorker) => Promise<T>): Promise<T> {
    const job = async (): Promise<T> => {
      const page = await this.acquirePage();
      const worker = new PageWorker(page);
      try {
        return await fn(worker);
      } finally {
        await page.close();
      }
    };

    if (this.concurrency === 1) {
      this.queue = this.queue.then(job);
      return this.queue as Promise<T>;
    }

    return job();
  }

  private async acquirePage(): Promise<Page> {
    if (!this.browser) {
      await this.reconnectWithRetry();
    }
    // biome-ignore lint/style/noNonNullAssertion: browser is guaranteed non-null after reconnect
    const page = await this.browser!.newPage();
    await page.setViewport(this.viewport);
    return page;
  }

  private async reconnectWithRetry(): Promise<void> {
    while (this.retryCount < this.reconnect.maxRetries) {
      this.retryCount++;
      const delay = this.reconnect.delayMs * this.retryCount;
      this.logger?.info({ attempt: this.retryCount, delayMs: delay }, 'Reconnecting browser...');
      await sleep(delay);
      try {
        await this.connect();
        this.retryCount = 0;
        return;
      } catch (err) {
        this.logger?.warn({ err }, 'Reconnect attempt failed');
      }
    }
    throw new Error(`Failed to reconnect after ${this.reconnect.maxRetries} attempts`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
