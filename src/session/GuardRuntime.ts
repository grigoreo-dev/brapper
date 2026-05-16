import type { Logger } from 'pino';
import type { PageWorker } from '../browser/PageWorker.js';
import type { GuardTripEvent, PageGuard } from './PageGuard.js';

export class GuardRuntime {
  private cleanups = new Map<string, Array<() => void>>();

  constructor(
    private readonly onTrip: (event: GuardTripEvent) => void,
    private readonly logger?: Logger,
  ) {}

  attach(pageId: string, worker: PageWorker, guards: PageGuard[]): void {
    if (guards.length === 0) return;

    const fns: Array<() => void> = [];

    for (const guard of guards) {
      const signal = {
        emit: (reason: string, severity = guard.severity ?? 'recoverable') => {
          this.logger?.warn({ pageId, guard: guard.name, reason, severity }, 'Guard tripped');
          this.onTrip({ guard: guard.name, reason, severity, pageId, worker });
        },
      };

      const cleanup = guard.attach(worker, signal);
      fns.push(cleanup);
    }

    this.cleanups.set(pageId, fns);
  }

  detach(pageId: string): void {
    const fns = this.cleanups.get(pageId);
    if (fns) {
      for (const fn of fns) fn();
      this.cleanups.delete(pageId);
    }
  }

  async probe(pageId: string, worker: PageWorker, guards: PageGuard[]): Promise<void> {
    for (const guard of guards) {
      if (!guard.check) continue;
      const tripped = await guard.check(worker);
      if (tripped) {
        this.onTrip({
          guard: guard.name,
          reason: 'check failed',
          severity: guard.severity ?? 'recoverable',
          pageId,
          worker,
        });
      }
    }
  }
}
