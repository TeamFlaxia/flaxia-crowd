import { describe, expect, it } from 'vitest';
import { evaluateMobileLifecycle } from '../mobile-lifecycle';

describe('mobile lifecycle policy', () => {
  it('suspends while hidden or offline and resumes when those signals clear', () => {
    expect(evaluateMobileLifecycle({ hidden: false, pageHidden: false, online: false }).suspend).toBe(true);
    expect(evaluateMobileLifecycle({ hidden: true, pageHidden: false, online: true }).suspend).toBe(true);
    expect(evaluateMobileLifecycle({ hidden: false, pageHidden: false, online: true }).suspend).toBe(false);
  });

  it('uses Battery API signals only when present and avoids work at critical charge', () => {
    expect(evaluateMobileLifecycle({ hidden: false, pageHidden: false, online: true }).suspend).toBe(false);
    expect(evaluateMobileLifecycle({
      hidden: false, pageHidden: false, online: true, batteryLevel: 0.05, batteryCharging: false,
    }).suspend).toBe(true);
    expect(evaluateMobileLifecycle({
      hidden: false, pageHidden: false, online: true, batteryLevel: 0.05, batteryCharging: true,
    }).suspend).toBe(false);
  });

  it('reduces the future task CPU budget on slow or data-saving connections', () => {
    expect(evaluateMobileLifecycle({
      hidden: false, pageHidden: false, online: true, effectiveType: '2g',
    }, 0.9).maxCpuLoad).toBe(0.45);
    expect(evaluateMobileLifecycle({
      hidden: false, pageHidden: false, online: true, saveData: true,
    }, 0.3).maxCpuLoad).toBe(0.3);
    expect(evaluateMobileLifecycle({
      hidden: false, pageHidden: false, online: true,
    }, 0.7).maxCpuLoad).toBe(0.7);
  });
});
