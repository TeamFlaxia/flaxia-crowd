import { describe, it, expect, beforeEach } from 'vitest';
import { hasConsent, saveConsent, hasDenial, saveDenial, safeLocalStorageGet } from '../storage';

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

  it('should manage denial state correctly', () => {
    expect(hasDenial()).toBe(false);
    saveDenial();
    expect(hasDenial()).toBe(true);
  });

  it('should not throw when saving denial with localStorage blocked', () => {
    const original = (window as any).localStorage;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    try {
      expect(() => saveDenial()).not.toThrow();
      expect(() => hasDenial()).not.toThrow();
      // Persisted via the in-memory fallback when localStorage is unavailable.
      expect(safeLocalStorageGet('flaxia_consent_denied')).toBe('true');
      expect(hasDenial()).toBe(true);
    } finally {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: original });
    }
  });
});
