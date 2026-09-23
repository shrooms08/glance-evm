/**
 * One at a time: while a run is in flight, any further call is ignored (returns null) instead of starting a second
 * one. Owner transactions and Get started's runs go through this, so a double click can never send twice. Plain
 * mutable state, not React state: a second click lands before React has re-rendered the disabled button.
 */
export class SingleFlight {
  private running = false;

  get busy(): boolean {
    return this.running;
  }

  async run<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await fn();
    } finally {
      this.running = false;
    }
  }
}
