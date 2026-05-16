import type { Page } from 'puppeteer-core';

export interface PageEntry {
  id: string;
  page: Page;
  mode: 'persistent' | 'spawned';
  key?: string;
  healthy: boolean;
}

export class PageRegistry {
  private entries = new Map<string, PageEntry>();
  private spawnedInflight = 0;

  register(entry: PageEntry): void {
    this.entries.set(entry.id, entry);
    if (entry.mode === 'spawned') this.spawnedInflight++;
  }

  unregister(id: string): void {
    const entry = this.entries.get(id);
    if (entry?.mode === 'spawned') {
      this.spawnedInflight = Math.max(0, this.spawnedInflight - 1);
    }
    this.entries.delete(id);
  }

  markUnhealthy(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.healthy = false;
  }

  invalidateAll(): void {
    for (const entry of this.entries.values()) {
      entry.healthy = false;
    }
    this.entries.clear();
    this.spawnedInflight = 0;
  }

  get spawnedInflightCount(): number {
    return this.spawnedInflight;
  }

  get persistentStats(): { total: number; healthy: number; restarting: number } {
    const persistent = [...this.entries.values()].filter((e) => e.mode === 'persistent');
    const healthy = persistent.filter((e) => e.healthy).length;
    return {
      total: persistent.length,
      healthy,
      restarting: persistent.length - healthy,
    };
  }
}
