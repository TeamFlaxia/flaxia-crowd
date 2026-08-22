import { describe, it, expect, beforeEach } from 'vitest';
import { hasConsent, saveConsent } from '../storage';

describe('consent/storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should manage consent state correctly', () => {
    expect(hasConsent()).toBe(false);
    saveConsent();
    expect(hasConsent()).toBe(true);
  });

  it('should not throw and treats as no-consent when localStorage is blocked', () => {
    const original = (window as any).localStorage;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    try {
      expect(() => hasConsent()).not.toThrow();
      expect(hasConsent()).toBe(false);
      expect(() => saveConsent()).not.toThrow();
    } finally {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: original });
    }
  });
});
