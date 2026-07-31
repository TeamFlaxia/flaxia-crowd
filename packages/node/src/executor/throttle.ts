function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Estimates current CPU contention and throttles work accordingly.
 *
 * Runs inside the compute Worker (where the actual workload executes) rather
 * than on the main thread, so the measurement reflects the thread that does
 * the work. Load is estimated with a calibrated busy-loop: a fixed-iteration
 * loop takes longer to finish when the system is busy, and the ratio to the
 * idle baseline is the estimated load.
 *
 * There is no direct API for CPU usage in the browser, so this is a heuristic
 * used to (a) avoid starting work while the machine is already loaded and
 * (b) space out task starts so average CPU stays near `maxLoad`.
 */
export class CpuThrottle {
  private baselineMs: number | null = null;
  private lastLoad = 0;
  private readonly maxLoad: number;
  private readonly loopIterations: number;

  constructor(maxLoad = 0.15, loopIterations = 2_000_000) {
    this.maxLoad = Math.max(0.05, Math.min(0.3, maxLoad));
    this.loopIterations = loopIterations;
  }

  private busyLoop(): number {
    const iterations = this.loopIterations;
    const start = performance.now();
    let i = 0;
    while (i < iterations) i++;
    return performance.now() - start;
  }

  private sample(): number {
    const values = [this.busyLoop(), this.busyLoop(), this.busyLoop()].sort((a, b) => a - b);
    return values[1];
  }

  async calibrate(): Promise<void> {
    this.busyLoop(); // warm-up
    this.baselineMs = this.sample();
    this.lastLoad = 0;
  }

  async getCurrentLoad(): Promise<number> {
    if (this.baselineMs === null) {
      await this.calibrate();
      return 0;
    }
    const elapsed = this.sample();
    const load = Math.min(1, Math.max(0, elapsed / this.baselineMs - 1));
    this.lastLoad = load;
    return load;
  }

  async shouldPause(): Promise<boolean> {
    return (await this.getCurrentLoad()) > this.maxLoad;
  }

  /**
   * Waits until the system is calm enough to run a task.
   * Bounded by `maxWaitMs` so a persistently busy machine cannot stall
   * the queue forever.
   */
  async waitForSlot(maxWaitMs = 30000): Promise<void> {
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
