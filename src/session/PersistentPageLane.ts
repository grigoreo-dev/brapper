import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Page } from 'puppeteer-core';
import { PageWorker } from '../browser/PageWorker.js';
import type { BrowserSupervisor } from './BrowserSupervisor.js';
import type { GuardRuntime } from './GuardRuntime.js';
import type { PageGuard } from './PageGuard.js';
import type { PageRegistry } from './PageRegistry.js';

interface PersistentLease {
  key: string;
  pageId: string;
  page: Page;
  worker: PageWorker;
  guards: PageGuard[];
  mutex: Promise<unknown>;
}

export interface PersistentPageLaneOptions {
  supervisor: BrowserSupervisor;
  registry: PageRegistry;
  guardRuntime: GuardRuntime;
  viewport: { width: number; height: number };
  logger?: Logger;
  onPageClosed?: (key: string, pageId: string) => void;
}

export class PersistentPageLane {
  private leases = new Map<string, PersistentLease>();

  constructor(private readonly options: PersistentPageLaneOptions) {}

  get restartingCount(): number {
    let count = 0;
    for (const lease of this.leases.values()) {
      if (lease.page.isClosed()) count++;
    }
    return count;
  }

  async withPage<T>(
    key: string,
    guards: PageGuard[],
    fn: (worker: PageWorker, pageId: string) => Promise<T>,
  ): Promise<T> {
    const lease = await this.ensureLease(key, guards);

    const run = async (): Promise<T> => {
      if (lease.page.isClosed()) {
        await this.recreateLease(key, guards);
        const fresh = this.leases.get(key);
        if (!fresh) throw new Error(`Persistent page "${key}" unavailable after recreate`);
        return fn(fresh.worker, fresh.pageId);
      }
      return fn(lease.worker, lease.pageId);
    };

    const prev = lease.mutex;
    let releaseMutex: () => void = () => {};
    lease.mutex = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });

    try {
      await prev;
      return await run();
    } finally {
      releaseMutex();
    }
  }

  async invalidateAll(): Promise<void> {
    const closes = [...this.leases.values()].map((lease) => {
      this.options.guardRuntime.detach(lease.pageId);
      return lease.page.isClosed() ? Promise.resolve() : lease.page.close().catch(() => {});
    });
    this.leases.clear();
    await Promise.all(closes);
  }

  private async ensureLease(key: string, guards: PageGuard[]): Promise<PersistentLease> {
    const existing = this.leases.get(key);
    if (existing && !existing.page.isClosed()) {
      return existing;
    }
    return this.recreateLease(key, guards);
  }

  private async recreateLease(key: string, guards: PageGuard[]): Promise<PersistentLease> {
    const old = this.leases.get(key);
    if (old) {
      this.options.guardRuntime.detach(old.pageId);
      this.options.registry.unregister(old.pageId);
    }

    const browser = await this.options.supervisor.ensureBrowser();
    const page = await browser.newPage();
    await page.setViewport(this.options.viewport);

    const pageId = randomUUID();
    const worker = new PageWorker(page);

    page.on('close', () => {
      this.options.logger?.warn({ key, pageId }, 'Persistent page closed');
      this.options.onPageClosed?.(key, pageId);
    });

    this.options.registry.register({
      id: pageId,
      page,
      mode: 'persistent',
      key,
      healthy: true,
    });

    const allGuards = [...(old?.guards ?? []), ...guards];
    this.options.guardRuntime.attach(pageId, worker, allGuards);

    const lease: PersistentLease = {
      key,
      pageId,
      page,
      worker,
      guards: allGuards,
      mutex: Promise.resolve(),
    };

    this.leases.set(key, lease);
    this.options.logger?.info({ key, pageId }, 'Persistent page created');
    return lease;
  }
}
