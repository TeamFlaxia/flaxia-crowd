import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CONSENT_MAX_TTL_MS,
  __consentTestHooks,
  clearConsent,
  getConsentState,
  grantConsent,
  hasConsent,
  hasDenial,
  initConsentIntegrity,
  markUserGestureConsent,
  safeLocalStorageGet,
  saveConsent,
  saveDenial,
  setHostManagedConsentAllowed,
} from '../storage';
import { CONSENT_NOTICE_VERSION } from '../notice';

const RECORD_KEY = 'flaxia_consent_record';

/** In-memory stand-in for the IndexedDB key store, so tests can simulate reloads. */
function createMemoryKeyStore() {
  let key: CryptoKey | null = null;
  return {
    load: async () => key,
    save: async (stored: CryptoKey) => {
      key = stored;
    },
    clear: async () => {
      key = null;
    },
  };
}

function readStoredRecord(): Record<string, unknown> | null {
  const raw = localStorage.getItem(RECORD_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

describe('consent/storage', () => {
  beforeEach(() => {
    localStorage.clear();
    __consentTestHooks.reset();
    __consentTestHooks.setKeyStore(createMemoryKeyStore());
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __consentTestHooks.reset();
  });

  it('should manage consent state correctly', async () => {
    expect(hasConsent()).toBe(false);
    markUserGestureConsent();
    await grantConsent();
    expect(hasConsent()).toBe(true);
    expect(getConsentState()).toBe('granted');
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
      markUserGestureConsent();
      expect(() => saveConsent()).not.toThrow();
      // The grant survives via the in-memory fallback.
      expect(hasConsent()).toBe(true);
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

  it('reports a single consent state for unset/granted/denied', async () => {
    expect(getConsentState()).toBe('unset');
    markUserGestureConsent();
    await grantConsent();
    expect(getConsentState()).toBe('granted');
    saveDenial();
    expect(getConsentState()).toBe('denied');
    clearConsent();
    expect(getConsentState()).toBe('unset');
  });

  it('keeps grant and denial mutually exclusive in both directions', async () => {
    markUserGestureConsent();
    await grantConsent();
    expect(hasConsent()).toBe(true);
    expect(hasDenial()).toBe(false);

    saveDenial();
    expect(hasConsent()).toBe(false);
    expect(hasDenial()).toBe(true);
    expect(localStorage.getItem(RECORD_KEY)).toBeNull();
    expect(localStorage.getItem('flaxia_consent_granted')).toBeNull();
    expect(localStorage.getItem('flaxia_consent_expiry')).toBeNull();

    markUserGestureConsent();
    await grantConsent();
    expect(hasConsent()).toBe(true);
    expect(hasDenial()).toBe(false);
    expect(localStorage.getItem('flaxia_consent_denied')).toBeNull();
  });

  it('clearConsent forgets every consent key', async () => {
    markUserGestureConsent();
    await grantConsent();
    clearConsent();
    expect(localStorage.getItem(RECORD_KEY)).toBeNull();
    expect(localStorage.getItem('flaxia_consent_granted')).toBeNull();
    expect(localStorage.getItem('flaxia_consent_expiry')).toBeNull();
    expect(localStorage.getItem('flaxia_consent_denied')).toBeNull();
    expect(getConsentState()).toBe('unset');
    expect(hasConsent()).toBe(false);
  });

  it('persists the notice version, origin and a bounded expiry in the record', async () => {
    markUserGestureConsent();
    await grantConsent();

    const record = readStoredRecord();
    expect(record).not.toBeNull();
    expect(record?.noticeVersion).toBe(CONSENT_NOTICE_VERSION);
    expect(record?.origin).toBe(window.location.origin);
    expect(typeof record?.mac).toBe('string');
    expect((record?.mac as string).length).toBeGreaterThan(0);
    expect(record?.expiry).toBe((record?.grantedAt as number) + CONSENT_MAX_TTL_MS);
  });

  it('persists a non-extractable HMAC key', async () => {
    let stored: CryptoKey | null = null;
    __consentTestHooks.setKeyStore({
      load: async () => stored,
      save: async (key) => {
        stored = key;
      },
      clear: async () => {
        stored = null;
      },
    });

    markUserGestureConsent();
    await grantConsent();

    expect(stored).not.toBeNull();
    // Non-extractable: the raw key bytes can never leave the browser, so a
    // script that can only write localStorage strings cannot re-sign a record.
    expect(stored?.extractable).toBe(false);
    expect(stored?.type).toBe('secret');
    expect(stored?.algorithm?.name).toBe('HMAC');
  });

  it('does not treat a legacy plaintext flag as consent', async () => {
    localStorage.setItem('flaxia_consent_granted', 'true');
    await initConsentIntegrity();
    expect(hasConsent()).toBe(false);
    expect(getConsentState()).toBe('unset');
    // The legacy keys are cleaned up so host code cannot keep reading them.
    expect(localStorage.getItem('flaxia_consent_granted')).toBeNull();
  });

  it('does not treat a record without an expiry as permanent consent', async () => {
    localStorage.setItem(
      RECORD_KEY,
      JSON.stringify({
        v: 1,
        noticeVersion: CONSENT_NOTICE_VERSION,
        origin: window.location.origin,
        grantedAt: Date.now(),
        mac: 'forged',
      }),
    );
    await initConsentIntegrity();
    expect(hasConsent()).toBe(false);
    expect(getConsentState()).toBe('unset');
  });

  it('does not treat an expired record as consent', async () => {
    const now = Date.now();
    markUserGestureConsent();
    await grantConsent();
    expect(hasConsent()).toBe(true);

    // Simulate the clock moving past the record's expiry and a page reload.
    vi.spyOn(Date, 'now').mockReturnValue(now + CONSENT_MAX_TTL_MS + 1_000);
    __consentTestHooks.resetIntegrityCache();
    await initConsentIntegrity();

    expect(hasConsent()).toBe(false);
    expect(getConsentState()).toBe('unset');
    expect(localStorage.getItem(RECORD_KEY)).toBeNull();
  });

  it('rejects a tampered record after a reload', async () => {
    markUserGestureConsent();
    await grantConsent();

    const record = readStoredRecord();
    expect(record).not.toBeNull();
    // Attacker extends the expiry without being able to re-sign the payload.
    localStorage.setItem(
      RECORD_KEY,
      JSON.stringify({ ...record, expiry: (record?.expiry as number) + 365 * 24 * 60 * 60 * 1000 }),
    );

    __consentTestHooks.resetIntegrityCache();
    await initConsentIntegrity();

    expect(hasConsent()).toBe(false);
    expect(getConsentState()).toBe('unset');
    expect(localStorage.getItem(RECORD_KEY)).toBeNull();
  });

  it('rejects a record whose signature was stripped', async () => {
    markUserGestureConsent();
    await grantConsent();

    const record = readStoredRecord();
    localStorage.setItem(RECORD_KEY, JSON.stringify({ ...record, mac: '' }));

    __consentTestHooks.resetIntegrityCache();
    await initConsentIntegrity();

    expect(hasConsent()).toBe(false);
  });

  it('binds the record to the page origin', async () => {
    __consentTestHooks.setOrigin('https://evil.example');
    markUserGestureConsent();
    await grantConsent();
    expect(hasConsent()).toBe(true);

    // A record copied to (or from) another origin never counts.
    __consentTestHooks.setOrigin(null);
    __consentTestHooks.resetIntegrityCache();
    await initConsentIntegrity();

    expect(hasConsent()).toBe(false);
    expect(getConsentState()).toBe('unset');
  });

  it('binds the record to the notice version the visitor saw', async () => {
    // A record sealed against an older disclosure is not consent for the
    // current one, even though its HMAC is valid.
    __consentTestHooks.seedGrantedConsent(CONSENT_NOTICE_VERSION - 1);
    __consentTestHooks.resetIntegrityCache();
    await initConsentIntegrity();

    expect(hasConsent()).toBe(false);
    expect(getConsentState()).toBe('unset');
  });

  it('accepts a valid record again after a reload', async () => {
    const keyStore = createMemoryKeyStore();
    __consentTestHooks.setKeyStore(keyStore);
    markUserGestureConsent();
    await grantConsent();

    // Same origin, same notice version, same key store: a reload must keep the
    // visitor's decision.
    __consentTestHooks.resetIntegrityCache();
    const state = await initConsentIntegrity();

    expect(state).toBe('granted');
    expect(hasConsent()).toBe(true);
    expect(getConsentState()).toBe('granted');
  });

  it('refuses programmatic grants without a gesture or host opt-in', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    saveConsent();

    expect(hasConsent()).toBe(false);
    expect(getConsentState()).toBe('unset');
    expect(localStorage.getItem(RECORD_KEY)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('allows host-managed grants only after an explicit opt-in', async () => {
    setHostManagedConsentAllowed(true);
    await grantConsent();
    expect(getConsentState()).toBe('granted');

    __consentTestHooks.reset();
    __consentTestHooks.setKeyStore(createMemoryKeyStore());
    clearConsent();
    expect(getConsentState()).toBe('unset');
    saveConsent();
    expect(getConsentState()).toBe('unset');
  });

  it('consumes a gesture token only once', async () => {
    markUserGestureConsent();
    await grantConsent();
    clearConsent();

    // The token minted for the first grant cannot authorize a later one.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    saveConsent();
    expect(getConsentState()).toBe('unset');
    expect(warn).toHaveBeenCalled();
  });

  it('rejects a record that claims more than the bounded TTL', async () => {
    markUserGestureConsent();
    await grantConsent();

    const record = readStoredRecord();
    localStorage.setItem(
      RECORD_KEY,
      JSON.stringify({
        ...record,
        // Same MAC-visible fields except the lifetime: verification must reject
        // the over-long claim even before the signature is checked.
        expiry: (record?.grantedAt as number) + CONSENT_MAX_TTL_MS * 10,
      }),
    );

    __consentTestHooks.resetIntegrityCache();
    await initConsentIntegrity();
    expect(hasConsent()).toBe(false);
  });
});