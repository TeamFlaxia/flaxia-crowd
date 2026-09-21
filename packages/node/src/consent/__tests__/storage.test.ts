import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearConsent,
  getConsentState,
  hasConsent,
  hasDenial,
  safeLocalStorageGet,
  saveConsent,
  saveDenial,
} from '../storage';

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

  it('reports a single consent state for unset/granted/denied', () => {
    expect(getConsentState()).toBe('unset');
    saveConsent();
    expect(getConsentState()).toBe('granted');
    saveDenial();
    expect(getConsentState()).toBe('denied');
    clearConsent();
    expect(getConsentState()).toBe('unset');
  });

  it('keeps grant and denial mutually exclusive in both directions', () => {
    saveConsent();
    expect(hasConsent()).toBe(true);
    expect(hasDenial()).toBe(false);

    saveDenial();
    expect(hasConsent()).toBe(false);
    expect(hasDenial()).toBe(true);
    expect(localStorage.getItem('flaxia_consent_granted')).toBeNull();
    expect(localStorage.getItem('flaxia_consent_expiry')).toBeNull();

    saveConsent();
    expect(hasConsent()).toBe(true);
    expect(hasDenial()).toBe(false);
    expect(localStorage.getItem('flaxia_consent_denied')).toBeNull();
  });

  it('clearConsent forgets every consent key', () => {
    saveConsent();
    clearConsent();
    expect(localStorage.getItem('flaxia_consent_granted')).toBeNull();
    expect(localStorage.getItem('flaxia_consent_expiry')).toBeNull();
    expect(localStorage.getItem('flaxia_consent_denied')).toBeNull();
    expect(getConsentState()).toBe('unset');
  });
});
