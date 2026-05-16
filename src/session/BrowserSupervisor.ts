import type { Logger } from 'pino';
import puppeteer, { type Browser } from 'puppeteer-core';

export interface BrowserSupervisorOptions {
  wsEndpoint: string;
  viewport: { width: number; height: number };
  logger?: Logger;
  reconnect: { maxRetries: number; delayMs: number };
  onDisconnected?: () => void;
}

export class BrowserSupervisor {
  private browser: Browser | null = null;
  private retryCount = 0;
  private onDisconnected?: () => void;
  private closing = false;

  constructor(private readonly options: BrowserSupervisorOptions) {
    this.onDisconnected = options.onDisconnected;
  }

  setOnDisconnected(handler: () => void): void {
    this.onDisconnected = handler;
  }

  get connected(): boolean {
    return this.browser?.connected ?? false;
  }

  getBrowser(): Browser | null {
    return this.browser;
  }

  async connect(): Promise<void> {
    this.browser = await puppeteer.connect({
      browserWSEndpoint: this.options.wsEndpoint,
      defaultViewport: this.options.viewport,
    });

    this.browser.on('disconnected', () => {
      this.browser = null;
      if (this.closing) return;
      this.options.logger?.warn('Browser disconnected');
      this.onDisconnected?.();
    });

    this.options.logger?.info({ wsEndpoint: this.options.wsEndpoint }, 'Browser connected');
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    if (this.browser) {
      this.browser.disconnect();
      this.browser = null;
    }
  }

  async ensureBrowser(): Promise<Browser> {
    if (!this.browser?.connected) {
      await this.reconnectWithRetry();
    }
    if (!this.browser) {
      throw new Error('Browser not available after reconnect');
    }
    return this.browser;
  }

  invalidate(): void {
    this.browser = null;
  }

  private async reconnectWithRetry(): Promise<void> {
    const { maxRetries, delayMs } = this.options.reconnect;

    while (this.retryCount < maxRetries) {
      if (this.closing) return;
      this.retryCount++;
      const delay = delayMs * this.retryCount;
      this.options.logger?.info(
        { attempt: this.retryCount, delayMs: delay },
        'Reconnecting browser...',
      );
      await sleep(delay);
      if (this.closing) return;
      try {
        await this.connect();
        this.retryCount = 0;
        return;
      } catch (err) {
        this.options.logger?.warn({ err }, 'Reconnect attempt failed');
      }
    }
    throw new Error(`Failed to reconnect after ${maxRetries} attempts`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
