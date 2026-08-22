function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Keeps the Worker's average CPU usage within `maxLoad` without busy-waiting.
 *
 * The previous implementation estimated load with a calibrated busy-loop
 * (millions of empty iterations, sampled repeatedly). On slow mobile CPUs that
 * busy-loop itself burned significant CPU and made `waitForSlot()` spin hard —
 * i.e. the worker "ran away" while it was supposed to be throttled. Instead of
 * measuring load by spinning, this version records how long each task actually
 * ran (`markTaskComplete`) and compares the busy time against elapsed wall time
 * over a rolling window. `waitForSlot()` simply sleeps (yielding the event loop)
 * until the recent busy ratio drops back under `maxLoad`.
 */
const WINDOW_MS = 30_000;
const MAX_WAIT_SLOT_MS = 30_000;

export class CpuThrottle {
  private readonly maxLoad: number;
  private windowStart = performance.now();
  private windowBusyMs = 0;
  private lastLoad = 0;

  constructor(maxLoad = 0.15) {
    this.maxLoad = Math.max(0.05, Math.min(0.3, maxLoad));
  }

  /**
   * Charge a completed task's wall-clock duration (in ms) against the CPU budget.
   * Call this from the worker once a workload has finished (incl. errors/timeouts).
   */
  markTaskComplete(durationMs: number): void {
    const now = performance.now();
    if (now - this.windowStart > WINDOW_MS) {
      this.windowStart = now;
      this.windowBusyMs = 0;
    }
    this.windowBusyMs += Math.max(0, durationMs);
    this.lastLoad = this.estimate();
  }

  private estimate(): number {
    const elapsed = performance.now() - this.windowStart;
    if (elapsed <= 0) return 0;
    return Math.min(1, Math.max(0, this.windowBusyMs / elapsed));
  }

  async shouldPause(): Promise<boolean> {
    return this.estimate() > this.maxLoad;
  }

  /**
   * Waits until the rolling busy ratio is back under `maxLoad`.
   * Bounded by `maxWaitMs` so a sustained heavy device cannot stall the queue
   * forever.
   */
  async waitForSlot(maxWaitMs = MAX_WAIT_SLOT_MS): Promise<void> {
    const start = performance.now();
    while (await this.shouldPause()) {
      if (performance.now() - start > maxWaitMs) break;
      await sleep(500);
    }
  }

  get lastMeasuredLoad(): number {
    return this.lastLoad;
  }

  get maxLoadValue(): number {
    return this.maxLoad;
  }
}