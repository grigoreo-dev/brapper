import type { Page } from 'puppeteer-core';
import type { PageWorker } from '../browser/PageWorker.js';

export interface RecoveryStrategy {
  name: string;
  detect(page: Page): boolean | Promise<boolean>;
  recover(worker: PageWorker): Promise<'ok' | 'failed'>;
}
