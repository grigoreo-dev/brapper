/**
 * Promise-based barrier. All page operations pass through `wait()` before
 * touching the browser. When closed, callers suspend until `open()`.
 */
export class SessionGate {
  private open = true;
  private degraded = false;
  private waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  get isOpen(): boolean {
    return this.open && !this.degraded;
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  async wait(): Promise<void> {
    if (this.open && !this.degraded) return;

    if (this.degraded) {
      throw new Error('Session is degraded — browser recovery failed');
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
  }

  openGate(): void {
    this.open = true;
    this.degraded = false;
    const pending = this.waiters.splice(0);
    for (const w of pending) w.resolve();
  }

  degrade(): void {
    this.degraded = true;
    this.open = false;
    const pending = this.waiters.splice(0);
    const err = new Error('Session is degraded — browser recovery failed');
    for (const w of pending) w.reject(err);
  }
}
