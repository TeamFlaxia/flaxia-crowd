import { beforeEach, describe, expect, it } from 'vitest';
import { getFlaxiaNodeConsentState } from '../index';
import { clearConsent, saveConsent, saveDenial } from '../consent/storage';

describe('@flaxia/node public API', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('exposes the persisted consent state without initialising the node', () => {
    expect(getFlaxiaNodeConsentState()).toBe('unset');

    saveConsent();
    expect(getFlaxiaNodeConsentState()).toBe('granted');

    saveDenial();
    expect(getFlaxiaNodeConsentState()).toBe('denied');

    clearConsent();
    expect(getFlaxiaNodeConsentState()).toBe('unset');
  });
});
