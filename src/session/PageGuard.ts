import type { PageWorker } from '../browser/PageWorker.js';

export type GuardSeverity = 'warn' | 'recoverable' | 'fatal';

export interface GuardSignal {
  emit(reason: string, severity?: GuardSeverity): void;
}

export interface PageGuard {
  name: string;
  severity?: GuardSeverity;
  attach(worker: PageWorker, signal: GuardSignal): () => void;
  check?(worker: PageWorker): boolean | Promise<boolean>;
}

export interface GuardTripEvent {
  guard: string;
  reason: string;
  severity: GuardSeverity;
  pageId: string;
  worker: import('../browser/PageWorker.js').PageWorker;
}
