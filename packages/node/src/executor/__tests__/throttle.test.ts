import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CpuThrottle,
  DUTY_CYCLE_BUDGET_MS,
  THROTTLE_WINDOW_MS,
  ThrottleBusyError,
} from '../throttle';

/**
 * The throttle tracks a rolling busy ratio computed from `markTaskComplete()`
 * and `performance.now()`. Tests drive the estimation with a controllable
 * `performance.now` mock: call `markTaskComplete(x)` to charge busy time, then
 * set the clock forward so the busy/elapsed ratio rises or decays as needed.
 */
function mockPerformanceNow(ref: { now: number }) {
  vi.spyOn(performance, 'now').mockImplementation(() => ref.now);
}

describe('CpuThrottle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should clamp maxLoad between 0.05 and 0.30', () => {
    const t1 = new CpuThrottle(0.01);
    expect(t1.maxLoadValue).toBe(0.05);

    const t2 = new CpuThrottle(0.5);
    expect(t2.maxLoadValue).toBe(0.30);

    const t3 = new CpuThrottle(0.15);
    expect(t3.maxLoadValue).toBe(0.15);
  });

  it('should return 0 as initial lastMeasuredLoad', () => {
    const t = new CpuThrottle();
    expect(t.lastMeasuredLoad).toBe(0);
  });

  it('should report idle load (0) before any task completes', async () => {
    const ref = { now: 1000 };
    mockPerformanceNow(ref);

    const t = new CpuThrottle(0.15);
    expect(await t.shouldPause()).toBe(false);
    expect(t.lastMeasuredLoad).toBe(0);
  });

  it('should report high load right after a long task', async () => {
    const ref = { now: 1000 };
    mockPerformanceNow(ref);

    const t = new CpuThrottle(0.15);
    t.markTaskComplete(9000); // 9s busy
    ref.now = 10000; // 9s elapsed → 100% busy
    expect(await t.shouldPause()).toBe(true);
  });

  it('should not pause when busy time stays within the budget', async () => {
    const ref = { now: 1000 };
    mockPerformanceNow(ref);

    const t = new CpuThrottle(0.5);
    t.markTaskComplete(1000); // 1s busy
    ref.now = 20000; // 19s elapsed → ~5% busy
    expect(await t.shouldPause()).toBe(false);
  });

  it('should decay load as wall time passes without new work', async () => {
    const ref = { now: 1000 };
    mockPerformanceNow(ref);

    const t = new CpuThrottle(0.15);
    t.markTaskComplete(9000);
    ref.now = 10000;
    expect(await t.shouldPause()).toBe(true);

    ref.now = 70000; // busy ratio now 9000/69000 ≈ 0.13 < 0.15
    expect(await t.shouldPause()).toBe(false);
  });

  it('should reset the window after WINDOW_MS passes', async () => {
    const ref = { now: 1000 };
    mockPerformanceNow(ref);

    const t = new CpuThrottle(0.15);
    t.markTaskComplete(9000);
    ref.now = 2000;
    expect(await t.shouldPause()).toBe(true);

    // A long idle stretch rolls the window over; the old 9s of busy time is
    // forgotten and the load estimate reflects only newly charged work.
    ref.now = 40000;
    t.markTaskComplete(0);
    expect(await t.shouldPause()).toBe(false);
  });

  it('should wait for a slot while busy and proceed once load drops', async () => {
    vi.useFakeTimers();
    const ref = { now: 1000 };
    mockPerformanceNow(ref);

    const t = new CpuThrottle(0.15);
    t.markTaskComplete(1900);
    ref.now = 2000; // busy ratio clamped at 1 → pauses

    const promise = t.waitForSlot(30000);
    // Load decays below budget once enough wall time passes.
    ref.now = 20000; // 1900/19000 = 0.1 < 0.15
    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('should fail with a retryable error after maxWaitMs on a persistently busy machine', async () => {
    vi.useFakeTimers();
    const ref = { now: 1000 };
    mockPerformanceNow(ref);

    const t = new CpuThrottle(0.15);
    t.markTaskComplete(9000); // 9s busy charged into a fresh window
    ref.now = 1100; // elapsed 100ms → busy ratio clamps at 1 → pauses
    expect(await t.shouldPause()).toBe(true);

    const promise = t.waitForSlot(1200);
    const settled = promise.catch((err) => err);
    // Each sleep is 500ms. Load stays at ~100% (wall time grows but nothing is
    // recharged), so the wait must fail instead of starting the task anyway.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(500);
      ref.now += 500;
    }

    const err = await settled;
    expect(err).toBeInstanceOf(ThrottleBusyError);
    expect((err as ThrottleBusyError).retryable).toBe(true);
    expect((err as ThrottleBusyError).message).toMatch(/task not started/);
    vi.useRealTimers();
  });

  it('should never force-start a task while over budget (#10-2)', async () => {
    vi.useFakeTimers();
    const ref = { now: 1000 };
    mockPerformanceNow(ref);

    const t = new CpuThrottle(0.15);
    t.markTaskComplete(30_000); // a full window of busy time
    ref.now = 2000;

    let started = false;
    const promise = t.waitForSlot(1000).then(() => {
      started = true;
    });
    const settled = promise.catch(() => undefined);

    // Even after the budget has elapsed and the device stays saturated, the
    // task must not start.
    for (let i = 0; i < 6; i++) {
      ref.now += 500;
      await vi.advanceTimersByTimeAsync(500);
    }
    await settled;

    expect(started).toBe(false);
    vi.useRealTimers();
  });

  it('should reject a negative wait budget instead of starting anyway', async () => {
    const t = new CpuThrottle(0.15);
    await expect(t.waitForSlot(-1)).rejects.toThrow(/maxWaitMs must be a non-negative number/);
  });
});

describe('CpuThrottle mid-execution duty cycle (#10-1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should not pause before a full duty-cycle burst has elapsed', async () => {
    const ref = { now: 1000 };
    mockPerformanceNow(ref);
    vi.useFakeTimers();

    const t = new CpuThrottle(0.15);
    t.beginWork();
    ref.now += DUTY_CYCLE_BUDGET_MS - 1;

    expect(await t.yieldIfOverloaded()).toBe(0);
  });

  it('should pause so a long task cannot pin the CPU at 100%', async () => {
    const ref = { now: 1000 };
    // Fake timers replace performance.now with their own clock, so the spy has
    // to be installed afterwards to keep driving the throttle deterministically.
    vi.useFakeTimers();
    mockPerformanceNow(ref);

    const t = new CpuThrottle(0.3);
    t.beginWork();
    ref.now += DUTY_CYCLE_BUDGET_MS;

    const pausePromise = t.yieldIfOverloaded();
    // maxLoad is clamped to 0.3 → a 200ms burst needs ~467ms of pause.
    await vi.advanceTimersByTimeAsync(600);
    const pauseMs = await pausePromise;
    expect(pauseMs).toBe(Math.ceil(DUTY_CYCLE_BUDGET_MS * (1 / 0.3 - 1)));
    expect(pauseMs).toBeGreaterThan(DUTY_CYCLE_BUDGET_MS);
  });

  it('should keep the reported load at or below maxLoad after a duty-cycle pause', async () => {
    const ref = { now: 1000 };
    // Fake timers replace performance.now with their own clock, so the spy has
    // to be installed afterwards to keep driving the throttle deterministically.
    vi.useFakeTimers();
    mockPerformanceNow(ref);

    const t = new CpuThrottle(0.3);
    t.beginWork();
    ref.now += DUTY_CYCLE_BUDGET_MS;

    const pausePromise = t.yieldIfOverloaded();
    await vi.advanceTimersByTimeAsync(600);
    const pauseMs = await pausePromise;
    expect(pauseMs).toBeGreaterThan(0);
    // The pause is charged as wall time, so the rolling estimate stays bounded.
    expect(t.lastMeasuredLoad).toBeLessThanOrEqual(t.maxLoadValue + 0.001);
  });

  it('should reset the duty cycle when a new task begins', async () => {
    const ref = { now: 1000 };
    mockPerformanceNow(ref);
    vi.useFakeTimers();

    const t = new CpuThrottle(0.5);
    t.beginWork();
    ref.now += DUTY_CYCLE_BUDGET_MS;
    const first = t.yieldIfOverloaded();
    await vi.advanceTimersByTimeAsync(600);
    await first;

    t.beginWork();
    ref.now += DUTY_CYCLE_BUDGET_MS - 1;
    expect(await t.yieldIfOverloaded()).toBe(0);
  });

  it('should roll the window over after THROTTLE_WINDOW_MS of idle time', async () => {
    const ref = { now: 1000 };
    mockPerformanceNow(ref);

    const t = new CpuThrottle(0.15);
    t.markTaskComplete(20_000);
    ref.now = 2000;
    expect(await t.shouldPause()).toBe(true);

    ref.now = 1000 + THROTTLE_WINDOW_MS + 1;
    expect(await t.shouldPause()).toBe(false);
  });
});
