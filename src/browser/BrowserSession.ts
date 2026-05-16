import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Page } from 'puppeteer-core';
import { BrowserSupervisor } from '../session/BrowserSupervisor.js';
import { GuardRuntime } from '../session/GuardRuntime.js';
import type { PageGuard } from '../session/PageGuard.js';
import { PageRegistry } from '../session/PageRegistry.js';
import { PersistentPageLane } from '../session/PersistentPageLane.js';
import type { RecoveryStrategy } from '../session/RecoveryStrategy.js';
import { SessionGate } from '../session/SessionGate.js';
import { SessionMonitor } from '../session/SessionMonitor.js';
import type { SessionState } from '../session/SessionState.js';
import { loadCookies } from './cookies.js';
import { PageWorker } from './PageWorker.js';

/**
 * Static factory interface for session-bound App classes used with `withApp`.
 * The App receives the full BrowserSession and decides internally whether each
 * method runs on a persistent or spawned page.
 *
 * @example
 * class MyApp {
 *   static async create(session: BrowserSession): Promise<MyApp> { ... }
 * }
 */
export interface AppFactory<T> {
  create(session: BrowserSession): Promise<T>;
}

export interface ExecutionOptions {
  key?: string;
  guards?: PageGuard[];
}

export interface BrowserSessionOptions {
  wsEndpoint: string;
  concurrency?: number;
  viewport?: { width: number; height: number };
  logger: Logger;
  reconnect?: {
    maxRetries?: number;
    delayMs?: number;
  };
  recoveryStrategies?: RecoveryStrategy[];
  defaultGuards?: PageGuard[];
}

export interface SessionHealthSnapshot {
  state: SessionState;
  browser_connected: boolean;
  warm: boolean;
  persistent_pages: { total: number; healthy: number; restarting: number };
  spawned_inflight: number;
  queue_depth: number;
}

export class BrowserSession {
  private readonly supervisor: BrowserSupervisor;
  private readonly gate = new SessionGate();
  private readonly registry = new PageRegistry();
  private readonly guardRuntime: GuardRuntime;
  private readonly monitor: SessionMonitor;
  private readonly persistentLane: PersistentPageLane;

  private queue: Promise<unknown> = Promise.resolve();
  private queueDepth = 0;
  private warm = false;
  private defaultGuards: PageGuard[];

  readonly wsEndpoint: string;
  readonly concurrency: number;
  readonly viewport: { width: number; height: number };
  readonly logger: Logger;
  readonly reconnect: Required<NonNullable<BrowserSessionOptions['reconnect']>>;

  constructor(options: BrowserSessionOptions) {
    this.wsEndpoint = options.wsEndpoint;
    this.concurrency = options.concurrency ?? 1;
    this.viewport = options.viewport ?? { width: 1920, height: 1080 };
    this.logger = options.logger;
    this.defaultGuards = options.defaultGuards ?? [];
    this.reconnect = {
      maxRetries: options.reconnect?.maxRetries ?? 5,
      delayMs: options.reconnect?.delayMs ?? 2000,
    };

    this.supervisor = new BrowserSupervisor({
      wsEndpoint: this.wsEndpoint,
      viewport: this.viewport,
      logger: this.logger,
      reconnect: this.reconnect,
    });

    this.monitor = new SessionMonitor({
      strategies: options.recoveryStrategies ?? [],
      gate: this.gate,
      logger: this.logger,
      onStateChange: (state) => this.logger?.info({ state }, 'Session state changed'),
      recoverBrowser: async () => {
        this.supervisor.invalidate();
        await this.supervisor.ensureBrowser();
        await this.persistentLane.invalidateAll();
      },
      invalidatePages: () => {
        this.registry.invalidateAll();
        void this.persistentLane.invalidateAll();
      },
    });

    this.guardRuntime = new GuardRuntime((event) => {
      void this.monitor.handleGuardTrip(event, event.worker);
    }, this.logger);

    this.persistentLane = new PersistentPageLane({
      supervisor: this.supervisor,
      registry: this.registry,
      guardRuntime: this.guardRuntime,
      viewport: this.viewport,
      logger: this.logger,
      onPageClosed: (key) => {
        this.logger?.warn({ key }, 'Persistent page closed unexpectedly');
      },
    });

    this.supervisor.setOnDisconnected(() => {
      this.warm = false;
      this.registry.invalidateAll();
      void this.persistentLane.invalidateAll();
      this.monitor.handleBrowserDisconnect().catch((err) => {
        this.logger?.error({ err }, 'Browser disconnect recovery failed');
      });
    });
  }

  get isWarm(): boolean {
    return this.warm;
  }

  get sessionState(): SessionState {
    return this.monitor.currentState;
  }

  setWarm(value: boolean): void {
    this.warm = value;
    if (value) this.monitor.markReady();
    else this.monitor.markStarting();
  }

  getHealthSnapshot(): SessionHealthSnapshot {
    const persistent = this.registry.persistentStats;
    return {
      state: this.monitor.currentState,
      browser_connected: this.supervisor.connected,
      warm: this.warm,
      persistent_pages: persistent,
      spawned_inflight: this.registry.spawnedInflightCount,
      queue_depth: this.queueDepth,
    };
  }

  markStarting(): void {
    this.monitor.markStarting();
  }

  markReady(): void {
    this.warm = true;
    this.monitor.markReady();
  }

  async connect(): Promise<void> {
    await this.supervisor.connect();
  }

  async disconnect(): Promise<void> {
    this.monitor.abort();
    await this.persistentLane.invalidateAll();
    await this.supervisor.disconnect();
  }

  async applyCookies(cookiesPath: string): Promise<number> {
    const browser = await this.supervisor.ensureBrowser();
    const cookies = loadCookies(cookiesPath);
    const page = await browser.newPage();
    try {
      for (const cookie of cookies) {
        await page.setCookie(cookie);
      }
    } finally {
      await page.close();
    }
    return cookies.length;
  }

  withSpawnedPage<T>(
    fn: (worker: PageWorker) => Promise<T>,
    options?: ExecutionOptions,
  ): Promise<T> {
    const guards = this.mergeGuards(options?.guards);

    const job = async (): Promise<T> => {
      await this.gate.wait();
      const pageId = randomUUID();
      const page = await this.createSpawnedPage();
      const worker = new PageWorker(page);

      this.registry.register({ id: pageId, page, mode: 'spawned', healthy: true });
      this.guardRuntime.attach(pageId, worker, guards);

      page.on('close', () => {
        this.registry.markUnhealthy(pageId);
        void this.monitor.handlePageCrash(pageId, worker);
      });

      this.logger?.debug({ pageId, mode: 'spawned' }, 'Spawned page acquired');

      try {
        await this.guardRuntime.probe(pageId, worker, guards);
        return await fn(worker);
      } catch (err) {
        if (isPageClosedError(err)) {
          await this.monitor.handlePageCrash(pageId, worker);
        }
        throw err;
      } finally {
        this.guardRuntime.detach(pageId);
        this.registry.unregister(pageId);
        if (!page.isClosed()) await page.close();
      }
    };

    if (this.concurrency === 1) {
      this.queueDepth++;
      this.queue = this.queue.then(job).finally(() => {
        this.queueDepth--;
      });
      return this.queue as Promise<T>;
    }

    return job();
  }

  withPersistentPage<T>(
    fn: (worker: PageWorker) => Promise<T>,
    options?: ExecutionOptions,
  ): Promise<T> {
    const key = options?.key ?? 'default';
    const guards = this.mergeGuards(options?.guards);

    const job = async (): Promise<T> => {
      await this.gate.wait();
      this.logger?.debug({ key, mode: 'persistent' }, 'Persistent page acquired');

      try {
        return await this.persistentLane.withPage(key, guards, async (worker, pageId) => {
          await this.guardRuntime.probe(pageId, worker, guards);
          return fn(worker);
        });
      } catch (err) {
        if (isPageClosedError(err)) {
          await this.monitor.handlePageCrash(key, null);
        }
        throw err;
      }
    };

    return job();
  }

  private async createSpawnedPage(): Promise<Page> {
    const browser = await this.supervisor.ensureBrowser();
    const page = await browser.newPage();
    await page.setViewport(this.viewport);
    return page;
  }

  private mergeGuards(extra?: PageGuard[]): PageGuard[] {
    return [...this.defaultGuards, ...(extra ?? [])];
  }
}

function isPageClosedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('closed') || msg.includes('target closed') || msg.includes('session closed');
}
