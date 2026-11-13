import { describe, it, expect, vi, afterEach } from 'vitest';
import { LightPreloader } from '../light-preloader';

describe('LightPreloader', () => {
  it('does nothing when consent is not granted', async () => {
    const preload = vi.fn().mockResolvedValue(undefined);
    const preloader = new LightPreloader(() => 'denied', {}, () => false, preload);
    preloader.start();
    // idle path uses setTimeout fallback in non-browser env; stop before it fires
    preloader.stop();
    expect(preload).not.toHaveBeenCalled();
  });

  it('skips when already preloaded', () => {
    const preload = vi.fn().mockResolvedValue(undefined);
    const preloader = new LightPreloader(() => 'granted', {}, () => true, preload);
    preloader.start();
    preloader.stop();
    expect(preload).not.toHaveBeenCalled();
  });

  it('preloads every target that is not ready yet', async () => {
    vi.useFakeTimers();
    const preload = vi.fn().mockResolvedValue(undefined);
    const isPreloaded = vi.fn((target: { model: string }) => target.model === 'ready-model');
    const preloader = new LightPreloader(
      () => 'granted',
      {
        targets: [
          { model: 'ready-model', task: 'translation', dtype: 'q4f16' },
          { model: 'cold-model', task: 'text-generation', dtype: 'q4f16' },
        ],
      },
      isPreloaded,
      preload,
    );
    preloader.start();
    // Non-browser env schedules the idle run via setTimeout fallback.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(preload).toHaveBeenCalledTimes(1);
    expect(preload).toHaveBeenCalledWith({
      task: 'text-generation',
      model: 'cold-model',
      dtype: 'q4f16',
    });
    preloader.stop();
    vi.useRealTimers();
  });

  it('skips entirely when every target is already ready', () => {
    const preload = vi.fn().mockResolvedValue(undefined);
    const preloader = new LightPreloader(
      () => 'granted',
      {
        targets: [
          { model: 'a-model', task: 'translation', dtype: 'q4f16' },
          { model: 'b-model', task: 'text-generation', dtype: 'q4f16' },
        ],
      },
      () => true,
      preload,
    );
    preloader.start();
    preloader.stop();
    expect(preload).not.toHaveBeenCalled();
  });

  it('does not preload when the device has no memory headroom', () => {
    const preload = vi.fn().mockResolvedValue(undefined);
    const preloader = new LightPreloader(
      () => 'granted',
      { hasMemoryHeadroom: () => false },
      () => false,
      preload,
    );
    preloader.start();
    preloader.stop();
    expect(preload).not.toHaveBeenCalled();
  });

  it('preloads when the device has memory headroom', async () => {
    vi.useFakeTimers();
    const preload = vi.fn().mockResolvedValue(undefined);
    const preloader = new LightPreloader(
      () => 'granted',
      { hasMemoryHeadroom: () => true },
      () => false,
      preload,
    );
    preloader.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(preload).toHaveBeenCalledTimes(1);
    preloader.stop();
    vi.useRealTimers();
  });

  it('treats a throwing memory probe as no headroom instead of crashing', () => {
    const preload = vi.fn().mockResolvedValue(undefined);
    const preloader = new LightPreloader(
      () => 'granted',
      { hasMemoryHeadroom: () => { throw new Error('probe unavailable'); } },
      () => false,
      preload,
    );
    preloader.start();
    preloader.stop();
    expect(preload).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
