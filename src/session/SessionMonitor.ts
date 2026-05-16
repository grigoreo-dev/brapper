import type { Logger } from 'pino';
import type { PageWorker } from '../browser/PageWorker.js';
import type { GuardTripEvent } from './PageGuard.js';
import type { RecoveryStrategy } from './RecoveryStrategy.js';
import type { SessionGate } from './SessionGate.js';
import type { SessionState } from './SessionState.js';

export interface SessionMonitorOptions {
  strategies: RecoveryStrategy[];
  gate: SessionGate;
  logger?: Logger;
  onStateChange?: (state: SessionState) => void;
  recoverBrowser: () => Promise<void>;
  invalidatePages: () => void;
}

export class SessionMonitor {
  private state: SessionState = 'starting';
  private recovering = false;
  private aborted = false;

  constructor(private readonly options: SessionMonitorOptions) {}

  abort(): void {
    this.aborted = true;
    this.recovering = false;
  }

  get currentState(): SessionState {
    return this.state;
  }

  setState(state: SessionState): void {
    this.state = state;
    this.options.onStateChange?.(state);
  }

  markReady(): void {
    this.setState('ready');
    this.options.gate.openGate();
  }

  markStarting(): void {
    this.setState('starting');
    this.options.gate.close();
  }

  async handleGuardTrip(event: GuardTripEvent, worker: PageWorker): Promise<void> {
    if (event.severity === 'warn') return;
    await this.runRecovery(worker, `guard:${event.guard}:${event.reason}`);
  }

  async handlePageCrash(pageId: string, worker: PageWorker | null): Promise<void> {
    this.options.logger?.warn({ pageId }, 'Page crash detected');
    if (worker) {
      await this.runRecovery(worker, 'page_crash');
    } else {
      await this.runRecovery(null, 'page_crash');
    }
  }

  async handleBrowserDisconnect(): Promise<void> {
    this.options.invalidatePages();
    await this.runRecovery(null, 'browser_disconnect');
  }

  private async runRecovery(worker: PageWorker | null, reason: string): Promise<void> {
    if (this.aborted) return;
    if (this.recovering) {
      this.options.logger?.debug({ reason }, 'Recovery already in progress, skipping');
      return;
    }

    this.recovering = true;
    this.setState('recovering');
    this.options.gate.close();
    this.options.logger?.info({ reason }, 'Starting session recovery');

    try {
      if (!worker) {
        await this.options.recoverBrowser();
        if (this.aborted) return;
        this.setState('ready');
        this.options.gate.openGate();
        return;
      }

      for (const strategy of this.options.strategies) {
        const needsRecovery = await strategy.detect(worker.page);
        if (!needsRecovery) continue;

        this.options.logger?.info({ strategy: strategy.name }, 'Running recovery strategy');
        const result = await strategy.recover(worker);
        if (result === 'ok') {
          this.setState('ready');
          this.options.gate.openGate();
          return;
        }
      }

      // No strategy matched or all failed — try browser reconnect
      await this.options.recoverBrowser();
      this.setState('ready');
      this.options.gate.openGate();
    } catch (err) {
      this.options.logger?.error({ err, reason }, 'Recovery failed');
      this.setState('degraded');
      this.options.gate.degrade();
    } finally {
      this.recovering = false;
    }
  }
}
