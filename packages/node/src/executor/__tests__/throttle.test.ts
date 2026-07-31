import { describe, it, expect, vi, afterEach } from 'vitest';
import { CpuThrottle } from '../throttle';

/**
 * The throttle estimates load via a calibrated busy-loop. Tests drive the
 * estimation with a controllable `performance.now` mock: with `step` set to 1,
 * each loop reports elapsed == baseline (idle); with a larger step, the loop
 * reports a larger elapsed time, which reads as high load.
 */
function mockPerformanceNow(stepRef: { value: number }) {
  let tick = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => {
    tick += stepRef.value;
    return tick;
  });
}

describe('CpuThrottle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should clamp maxLoad between 0.05 and 0.30', () => {
    const t1 = new CpuThrottle(0.01, 1000);
    expect(t1.maxLoadValue).toBe(0.05);

    const t2 = new CpuThrottle(0.5, 1000);
    expect(t2.maxLoadValue).toBe(0.30);

    const t3 = new CpuThrottle(0.15, 1000);
    expect(t3.maxLoadValue).toBe(0.15);
  });

  it('should return 0 as initial lastMeasuredLoad', () => {
    const t = new CpuThrottle();
    expect(t.lastMeasuredLoad).toBe(0);
  });

  it('should calibrate on first getCurrentLoad and report idle load', async () => {
    const step = { value: 1 };
    mockPerformanceNow(step);

    const t = new CpuThrottle(0.5, 1000);
    const load = await t.getCurrentLoad();
    expect(load).toBe(0);
    expect(t.lastMeasuredLoad).toBe(0);
  });

  it('should report high load when the busy loop is slower than baseline', async () => {
    const step = { value: 1 };
    mockPerformanceNow(step);

    const t = new CpuThrottle(0.1, 1000);
    await t.calibrate();

    step.value = 5;
    const load = await t.getCurrentLoad();
    expect(load).toBe(1);
  });

  it('should indicate pause when load exceeds threshold', async () => {
    const step = { value: 1 };
    mockPerformanceNow(step);

    const t = new CpuThrottle(0.1, 1000);
    await t.calibrate();

    step.value = 5;
    expect(await t.shouldPause()).toBe(true);
  });

  it('should not pause when load is below threshold', async () => {
    const step = { value: 1 };
    mockPerformanceNow(step);

    const t = new CpuThrottle(0.5, 1000);
    await t.calibrate();

    expect(await t.shouldPause()).toBe(false);
  });

  it('should wait for slot while busy and proceed when load drops', async () => {
    vi.useFakeTimers();
    const step = { value: 1 };
    mockPerformanceNow(step);

    const t = new CpuThrottle(0.1, 1000);
    await t.calibrate();

    step.value = 5;
    const promise = t.waitForSlot(10000);
    step.value = 1;
    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('should give up waiting after maxWaitMs on a persistently busy machine', async () => {
    const step = { value: 1 };
    mockPerformanceNow(step);

    const t = new CpuThrottle(0.1, 1000);
    await t.calibrate();

    step.value = 5;
    const promise = t.waitForSlot(1);
    await expect(promise).resolves.toBeUndefined();
  });
});
