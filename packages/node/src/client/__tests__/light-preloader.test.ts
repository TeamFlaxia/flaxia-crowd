import { describe, it, expect, vi } from 'vitest';
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
});
