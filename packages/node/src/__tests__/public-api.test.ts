import { beforeEach, describe, expect, it } from 'vitest';
import {
  getFlaxiaNodeConsentState,
  initFlaxiaNodeConsent,
  setFlaxiaNodeHostManagedConsent,
} from '../index';
import {
  __consentTestHooks,
  clearConsent,
  markUserGestureConsent,
  saveConsent,
  saveDenial,
} from '../consent/storage';

describe('@flaxia/node public API', () => {
  beforeEach(() => {
    localStorage.clear();
    __consentTestHooks.reset();
    setFlaxiaNodeHostManagedConsent(false);
  });

  it('exposes the persisted consent state without initialising the node', () => {
    expect(getFlaxiaNodeConsentState()).toBe('unset');

    markUserGestureConsent();
    saveConsent();
    expect(getFlaxiaNodeConsentState()).toBe('granted');

    saveDenial();
    expect(getFlaxiaNodeConsentState()).toBe('denied');

    clearConsent();
    expect(getFlaxiaNodeConsentState()).toBe('unset');
  });

  it('exposes an async initialiser that verifies the stored record', async () => {
    expect(typeof initFlaxiaNodeConsent).toBe('function');
    await expect(initFlaxiaNodeConsent()).resolves.toBe('unset');
  });

  it('fails closed for a plaintext localStorage flag', async () => {
    localStorage.setItem('flaxia_consent_granted', 'true');
    expect(getFlaxiaNodeConsentState()).toBe('unset');
    await initFlaxiaNodeConsent();
    expect(getFlaxiaNodeConsentState()).toBe('unset');
  });

  it('exposes the host-managed consent opt-in', () => {
    expect(typeof setFlaxiaNodeHostManagedConsent).toBe('function');
  });
});