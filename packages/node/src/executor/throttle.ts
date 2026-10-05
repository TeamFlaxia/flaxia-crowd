function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Rolling window over which the busy ratio is estimated. */
export const THROTTLE_WINDOW_MS = 30_000;
/** How long `waitForSlot()` waits for the rolling load to drop. */
export const DEFAULT_WAIT_SLOT_MS = 30_000;
/** Poll interval while waiting for a slot. */
const WAIT_POLL_MS = 500;
/** Continuous work allowed between two mid-execution duty-cycle pauses. */
export const DUTY_CYCLE_BUDGET_MS = 200;

/**
 * Thrown when `waitForSlot()` cannot find a slot within its budget.
 *
 * It replaces the old behaviour of starting the task anyway: a node that is
 * already over its CPU budget must not force-start a heavy task at 100% CPU.
 * The worker turns this into a retryable task error so the orchestrator can
 * move the task to an idle node.
 */
export class ThrottleBusyError extends Error {
  readonly retryable = true;
  constructor(
    readonly load: number,
    readonly maxLoad: number,
    readonly waitedMs: number,
  ) {
    super(
      `device is over its CPU budget (load ${load.toFixed(2)} > max ${maxLoad.toFixed(2)}) after waiting ${Math.round(waitedMs)}ms; task not started`,
    );
    this.name = 'ThrottleBusyError';
  }
}

/**
 * Keeps the Worker's average CPU usage within `maxLoad` without busy-waiting.
 *
 * Load is estimated from the work the worker charges over a rolling window
 * (`markTaskComplete` plus the duty-cycle pauses below) rather than from a
 * calibrated busy-loop, which itself burned CPU on slow devices.
 *
 * Two controls exist:
 *  - `waitForSlot()` gates the *start* of a task. When the budget is exhausted
 *    it throws `ThrottleBusyError` instead of starting the task anyway.
 *  - `yieldIfOverloaded()` limits the *execution* of a long task. Workloads
 *    call it between streaming tokens/batches; after `DUTY_CYCLE_BUDGET_MS` of
 *    continuous work it sleeps for the time needed to hold the configured duty
 *    cycle, so a 10-minute generation cannot pin a core at 100%.
 */
export class CpuThrottle {
  private readonly maxLoad: number;
  private windowStart = performance.now();
  private windowBusyMs = 0;
  private lastLoad = 0;
  /** Timestamp of the first unpaused work unit of the current duty cycle. */
  private dutyStartedAt: number | null = null;

  constructor(maxLoad = 0.15) {
    this.maxLoad = Math.max(0.05, Math.min(0.3, maxLoad));
  }

  /**
   * Charge a completed task's wall-clock duration (in ms) against the CPU
   * budget. Call this from the worker once a workload has finished (incl.
   * errors/timeouts).
   */
  markTaskComplete(durationMs: number): void {
    this.estimate(this.windowBusyMs + Math.max(0, durationMs));
    this.resetDutyCycle();
  }

  /** Start a fresh duty cycle before executing a task. */
  beginWork(): void {
    this.dutyStartedAt = performance.now();
  }

  private resetDutyCycle(): void {
    this.dutyStartedAt = null;
  }

  private rollWindow(now: number): void {
    if (now - this.windowStart > THROTTLE_WINDOW_MS) {
      this.windowStart = now;
      this.windowBusyMs = 0;
      this.resetDutyCycle();
    }
  }

  /**
   * Recompute the rolling busy ratio, treating `work` ms as the work charged
   * into the current window. Returns the ratio (0..1).
   */
  private estimate(work: number): number {
    const now = performance.now();
    this.rollWindow(now);
    this.windowBusyMs = work;
    const elapsed = now - this.windowStart;
    if (elapsed <= 0) return 0;
    const load = work / elapsed;
    this.lastLoad = Math.min(1, Math.max(0, load));
    return this.lastLoad;
  }

  async shouldPause(): Promise<boolean> {
    this.rollWindow(performance.now());
    return this.estimate(this.windowBusyMs) > this.maxLoad;
  }

  /**
   * Waits until the rolling busy ratio is back under `maxLoad`.
   *
   * @throws ThrottleBusyError when the budget is exhausted while the device is
   * still over budget. Starting the task anyway is what made the previous
   * implementation a no-op, so this is deliberately fail-closed.
   */
  async waitForSlot(maxWaitMs = DEFAULT_WAIT_SLOT_MS): Promise<void> {
    if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0) {
      throw new Error(`waitForSlot: maxWaitMs must be a non-negative number, got ${String(maxWaitMs)}`);
    }
    const startedAt = performance.now();
    while (await this.shouldPause()) {
      const waited = performance.now() - startedAt;
      if (waited >= maxWaitMs) {
        throw new ThrottleBusyError(this.lastLoad, this.maxLoad, waited);
      }
      await sleep(Math.min(WAIT_POLL_MS, Math.max(1, maxWaitMs - waited)));
    }
  }

  /**
   * Cooperative mid-execution limiting: after a continuous burst of
   * `DUTY_CYCLE_BUDGET_MS`, sleep long enough that the burst's share of wall
   * time matches `maxLoad`. Call between streaming tokens or batch iterations.
   *
   * Returns the number of ms slept (0 when the caller is inside its duty
   * cycle), which makes the behaviour directly testable.
   */
  async yieldIfOverloaded(): Promise<number> {
    const now = performance.now();
    this.rollWindow(now);
    if (this.dutyStartedAt === null) this.dutyStartedAt = now;

    const elapsed = Math.max(0, now - this.dutyStartedAt);
    if (elapsed < DUTY_CYCLE_BUDGET_MS) return 0;

    // Sleep so that work / (work + pause) <= maxLoad. The pause is charged back
    // into the window as "not busy" wall time, which is what keeps the reported
    // load (heartbeats) and the slot gate consistent with the duty cycle.
    const pauseMs = Math.ceil(elapsed * (1 / this.maxLoad - 1));
    this.dutyStartedAt = null;
    if (pauseMs > 0) await sleep(pauseMs);
    this.estimate(this.windowBusyMs);
    return pauseMs;
  }

  get lastMeasuredLoad(): number {
    return this.lastLoad;
  }

  get maxLoadValue(): number {
    return this.maxLoad;
  }
}