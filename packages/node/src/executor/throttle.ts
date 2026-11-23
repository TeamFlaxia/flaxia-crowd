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
  /** Work accumulated in the current burst, since the last pause. */
  private burstWorkMs = 0;
  /** `performance.now()` of the previous yield, or null at a burst boundary. */
  private lastYieldAt: number | null = null;
  /** Time this task slept in the duty cycle, excluded from its work charge. */
  private taskSleepMs = 0;

  constructor(maxLoad = 0.15) {
    this.maxLoad = Math.max(0.05, Math.min(0.3, maxLoad));
  }

  /**
   * Charge a completed task's *work* time (wall time minus the duty-cycle
   * pauses this instance inserted) against the rolling CPU budget.
   */
  markTaskComplete(durationMs: number): void {
    const now = performance.now();
    this.rollWindow(now);
    const work = Math.max(0, durationMs - this.taskSleepMs);
    this.windowBusyMs += work;
    this.taskSleepMs = 0;
    this.burstWorkMs = 0;
    this.lastYieldAt = null;
    this.estimate(now);
  }

  /** Start a fresh burst before executing a task. */
  beginWork(): void {
    this.burstWorkMs = 0;
    this.lastYieldAt = performance.now();
    this.taskSleepMs = 0;
  }

  private rollWindow(now: number): void {
    if (now - this.windowStart > THROTTLE_WINDOW_MS) {
      this.windowStart = now;
      this.windowBusyMs = 0;
    }
  }

  /** Recompute the rolling busy ratio from the work charged so far. */
  private estimate(now = performance.now()): number {
    this.rollWindow(now);
    const elapsed = now - this.windowStart;
    if (elapsed <= 0) return 0;
    this.lastLoad = Math.min(1, Math.max(0, this.windowBusyMs / elapsed));
    return this.lastLoad;
  }

  async shouldPause(): Promise<boolean> {
    return this.estimate() > this.maxLoad;
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
   * Cooperative mid-execution limiting: accumulate real work time and, once a
   * burst reaches `DUTY_CYCLE_BUDGET_MS`, sleep long enough that the burst's
   * share of wall time matches `maxLoad`.
   *
   * The accumulator is the important part: the previous version slept after
   * *every* token, which turned the average into one long stall per token
   * instead of a periodic pause. Call it between streaming tokens or batch
   * iterations; it returns 0 while the current burst is still under budget.
   */
  async yieldIfOverloaded(): Promise<number> {
    const now = performance.now();
    this.rollWindow(now);
    if (this.lastYieldAt === null) this.lastYieldAt = now;

    this.burstWorkMs += Math.max(0, now - this.lastYieldAt);
    this.lastYieldAt = now;
    if (this.burstWorkMs < DUTY_CYCLE_BUDGET_MS) return 0;

    // Sleep so that work / (work + pause) <= maxLoad. The pause is not charged
    // as work when the task completes, so the rolling estimate reflects the
    // duty cycle instead of the full wall time.
    const work = this.burstWorkMs;
    const pauseMs = Math.ceil(work * (1 / this.maxLoad - 1));
    this.burstWorkMs = 0;
    this.taskSleepMs += pauseMs;
    if (pauseMs > 0) await sleep(pauseMs);
    this.lastYieldAt = performance.now();
    return pauseMs;
  }

  get lastMeasuredLoad(): number {
    return this.lastLoad;
  }

  get maxLoadValue(): number {
    return this.maxLoad;
  }
}