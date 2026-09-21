import type { ConsentState } from '@flaxia/sdk';

const STORAGE_KEY = 'flaxia_consent_granted';
const STORAGE_EXPIRY_KEY = 'flaxia_consent_expiry';
const DENIAL_KEY = 'flaxia_consent_denied';
const CONSENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日
// In-memory fallback used when `localStorage` is unavailable — e.g. privacy-
// restricted contexts, blocked site-data, embedded webviews, or non-secure
// contexts. Accessing `localStorage` can throw (SecurityError / QuotaExceeded)
// on mobile Chrome, which would otherwise crash node initialization. Mutations
// are also mirrored here so a previously-granted consent survives the failure.
const memoryFallback = new Map<string, string>();

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return memoryFallback.get(key) ?? null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    memoryFallback.set(key, value);
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    memoryFallback.delete(key);
  }
}

export const hasConsent = (): boolean => {
  const granted = safeGet(STORAGE_KEY) === 'true';
  if (!granted) return false;

  const expiry = safeGet(STORAGE_EXPIRY_KEY);
  if (expiry) {
    const expiryMs = parseInt(expiry, 10);
    // Treat a missing/garbage expiry as expired (and clean up).
    if (!Number.isFinite(expiryMs) || Date.now() > expiryMs) {
      safeRemove(STORAGE_KEY);
      safeRemove(STORAGE_EXPIRY_KEY);
      return false;
    }
  }

  return true;
};

/** Persist consent. Clears any previous denial so the two never co-exist. */
export const saveConsent = (): void => {
  safeRemove(DENIAL_KEY);
  safeSet(STORAGE_KEY, 'true');
  safeSet(STORAGE_EXPIRY_KEY, String(Date.now() + CONSENT_TTL_MS));
};

export const hasDenial = (): boolean => {
  return safeGet(DENIAL_KEY) === 'true';
};

/** Persist denial. Clears any previous consent/expiry so the two never co-exist. */
export const saveDenial = (): void => {
  safeRemove(STORAGE_KEY);
  safeRemove(STORAGE_EXPIRY_KEY);
  safeSet(DENIAL_KEY, 'true');
};

/** Forget the consent decision entirely (granted + expiry + denial). */
export const clearConsent = (): void => {
  safeRemove(STORAGE_KEY);
  safeRemove(STORAGE_EXPIRY_KEY);
  safeRemove(DENIAL_KEY);
};

/**
 * Resolve the persisted consent state. A stored grant wins over a stored
 * denial, but the two are kept mutually exclusive by the save helpers.
 */
export const getConsentState = (): ConsentState => {
  if (hasConsent()) return 'granted';
  if (hasDenial()) return 'denied';
  return 'unset';
};

export const safeLocalStorageGet = safeGet;
export const safeLocalStorageSet = safeSet;
export const safeLocalStorageRemove = safeRemove;

/**
 * Returns a UUID, falling back to a random v4 when `crypto.randomUUID` is
 * unavailable (older browsers, or non-secure contexts where `crypto.randomUUID`
 * is undefined on mobile Chrome). Never throws.
 */
export const safeRandomUUID = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to fallback
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};
