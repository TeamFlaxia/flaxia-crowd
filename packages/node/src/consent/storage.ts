import type { ConsentState } from '@flaxia/sdk';
import { CONSENT_NOTICE_VERSION } from './notice';

/**
 * Maximum lifetime of a stored consent grant: 180 days.
 *
 * The lifetime is bounded on purpose — consent is not permanent, and the
 * disclosure shown to the visitor describes what the node does *today*, so a
 * grant must be renewed periodically. Records that claim a longer lifetime are
 * rejected (see `isRecordFresh`).
 */
export const CONSENT_MAX_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** Signed record holding the grant. Never a bare `true` flag. */
const RECORD_KEY = 'flaxia_consent_record';
/** Pre-#7 keys: a plain boolean plus a separate expiry. Removed on sight. */
const LEGACY_GRANTED_KEY = 'flaxia_consent_granted';
const LEGACY_EXPIRY_KEY = 'flaxia_consent_expiry';
/** Denial is not a security boundary (it only reduces capability), so it stays
 * a plain flag: forging it can only stop the node, never start it. */
const DENIAL_KEY = 'flaxia_consent_denied';

/** Bump when the persisted record shape changes. */
const RECORD_VERSION = 1;

/** A banner-minted gesture token is single-use and short-lived. */
const GESTURE_TTL_MS = 10_000;

/** Bound the time we are willing to wait for IndexedDB before degrading. */
const KEY_STORE_TIMEOUT_MS = 2_000;

const IDB_NAME = 'flaxia-consent-integrity';
const IDB_VERSION = 1;
const IDB_STORE = 'keys';
const IDB_KEY = 'consent-hmac-sha256-v1';

const logWarn = (...args: unknown[]) => console.warn('[flaxia-node]', ...args);

/**
 * In-memory fallback used when `localStorage` is unavailable — e.g. privacy-
 * restricted contexts, blocked site-data, embedded webviews, or non-secure
 * contexts. Accessing `localStorage` can throw (SecurityError / QuotaExceeded)
 * on mobile Chrome, which would otherwise crash node initialization. Mutations
 * are also mirrored here so a previously-granted consent survives the failure.
 */
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

/**
 * Integrity-protected consent record. `mac` is an HMAC-SHA-256 (base64url)
 * over the canonical payload — a same-origin script that only writes
 * `localStorage` strings cannot produce a record that verifies.
 */
interface ConsentRecord {
  /** Record format version. */
  v: number;
  /** Version of the disclosure text the visitor actually saw. */
  noticeVersion: number;
  /** Page origin the grant was made on. */
  origin: string;
  /** Grant time (ms epoch). */
  grantedAt: number;
  /** Expiry time (ms epoch). Required — a missing expiry is never granted. */
  expiry: number;
  /** HMAC over the canonical payload; empty while a grant is being sealed. */
  mac: string;
}

type ConsentPayload = Pick<
  ConsentRecord,
  'v' | 'noticeVersion' | 'origin' | 'grantedAt' | 'expiry'
>;

/**
 * Persistent store for the non-extractable HMAC key. The key is a `CryptoKey`,
 * so it cannot be exported as raw bytes; persisting it in IndexedDB (which
 * structured-clones `CryptoKey` objects) keeps forgery out of reach of scripts
 * that can only write strings into `localStorage`.
 */
export interface ConsentKeyStore {
  load(): Promise<CryptoKey | null>;
  save(key: CryptoKey): Promise<void>;
  clear(): Promise<void>;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openConsentDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let factory: IDBFactory | undefined;
    try {
      factory = globalThis.indexedDB;
    } catch {
      factory = undefined;
    }
    if (!factory) {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(IDB_NAME, IDB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

/** Duck-typed check: `CryptoKey` is not defined in every environment. */
function isCryptoKey(value: unknown): value is CryptoKey {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as CryptoKey;
  return candidate.type === 'secret' && candidate.algorithm?.name === 'HMAC';
}

const indexedDbKeyStore: ConsentKeyStore = {
  async load() {
    const db = await openConsentDb();
    try {
      const store = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE);
      const value = await requestToPromise(store.get(IDB_KEY));
      return isCryptoKey(value) ? value : null;
    } finally {
      db.close();
    }
  },
  async save(key) {
    const db = await openConsentDb();
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(key, IDB_KEY);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
      });
    } finally {
      db.close();
    }
  },
  async clear() {
    const db = await openConsentDb();
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB delete aborted'));
      });
    } finally {
      db.close();
    }
  },
};

/** Session-only fallback for environments without IndexedDB. */
let sessionKey: CryptoKey | null = null;
const memoryKeyStore: ConsentKeyStore = {
  async load() {
    return sessionKey;
  },
  async save(key) {
    sessionKey = key;
  },
  async clear() {
    sessionKey = null;
  },
};

function withTimeout<T>(promise: Promise<T>, fallback: T, ms: number): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(fallback), ms);
    promise.then((value) => finish(value), () => finish(fallback));
  });
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let keyStore: ConsentKeyStore = indexedDbKeyStore;
let hmacKey: CryptoKey | null = null;
/** Grant that currently counts: verified from storage, or made in this document. */
let activeGrant: ConsentRecord | null = null;
/** Whether `activeGrant` came from an authorized grant or a verified record. */
let activeGrantTrusted = false;
/** A grant was just made and is still being HMAC-sealed. */
let pendingSeal = false;
let initPromise: Promise<ConsentState> | null = null;
/** Invalidates in-flight init work after a revoke / test reset. */
let initGeneration = 0;
/** Bumped by every state mutation so stale init work cannot resurrect a grant. */
let stateEpoch = 0;
let pendingGesture: { noticeVersion: number; at: number } | null = null;
let hostManagedConsentAllowed = false;

function defaultOrigin(): string {
  try {
    const origin = globalThis.location?.origin;
    if (typeof origin === 'string' && origin.length > 0) return origin;
  } catch {
    // fall through
  }
  return 'unknown';
}

let originProvider: () => string = defaultOrigin;
const currentOrigin = (): string => originProvider();

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

const KEY_ALGORITHM: HmacKeyGenParams = { name: 'HMAC', hash: 'SHA-256' };

function getSubtle(): SubtleCrypto | null {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (
      subtle &&
      typeof subtle.generateKey === 'function' &&
      typeof subtle.sign === 'function' &&
      typeof subtle.verify === 'function'
    ) {
      return subtle;
    }
  } catch {
    // Non-secure contexts do not expose `crypto.subtle` at all.
  }
  return null;
}

/** Canonical, order-stable encoding of the fields covered by the MAC. */
function canonicalPayload(payload: ConsentPayload): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(
    JSON.stringify([
      payload.v,
      payload.noticeVersion,
      payload.origin,
      payload.grantedAt,
      payload.expiry,
    ]),
  );
  // Copy into a plain ArrayBuffer-backed view: `BufferSource` rejects
  // `ArrayBufferLike` (SharedArrayBuffer) in strict TS lib definitions.
  const bytes = new Uint8Array(encoded.byteLength);
  bytes.set(encoded);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function loadOrCreateKey(): Promise<CryptoKey | null> {
  const stored = await withTimeout(keyStore.load(), null, KEY_STORE_TIMEOUT_MS);
  if (stored) return stored;

  const subtle = getSubtle();
  if (!subtle) return null;
  try {
    // `extractable: false` — the raw key bytes can never leave the browser.
    const key = await subtle.generateKey(KEY_ALGORITHM, false, ['sign', 'verify']);
    await withTimeout(keyStore.save(key), undefined, KEY_STORE_TIMEOUT_MS);
    return key;
  } catch {
    return null;
  }
}

async function signRecord(record: ConsentPayload): Promise<string | null> {
  const subtle = getSubtle();
  if (!subtle || !hmacKey) return null;
  try {
    const signature = await subtle.sign('HMAC', hmacKey, canonicalPayload(record));
    return toBase64Url(new Uint8Array(signature));
  } catch {
    return null;
  }
}

async function verifyRecordMac(record: ConsentRecord): Promise<boolean> {
  const subtle = getSubtle();
  if (!subtle || !hmacKey || !record.mac) return false;
  const signature = fromBase64Url(record.mac);
  if (!signature) return false;
  try {
    return await subtle.verify('HMAC', hmacKey, signature, canonicalPayload(record));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Record helpers
// ---------------------------------------------------------------------------

function parseRecord(raw: string | null): ConsentRecord | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.origin !== 'string') return null;
    // A missing or non-numeric expiry is *not* an unlimited grant.
    if (typeof value.expiry !== 'number') return null;
    if (typeof value.grantedAt !== 'number') return null;
    return {
      v: typeof value.v === 'number' ? value.v : 0,
      noticeVersion: typeof value.noticeVersion === 'number' ? value.noticeVersion : 0,
      origin: value.origin,
      grantedAt: value.grantedAt,
      expiry: value.expiry,
      mac: typeof value.mac === 'string' ? value.mac : '',
    };
  } catch {
    return null;
  }
}

function isRecordFresh(record: ConsentRecord, now: number): boolean {
  if (!Number.isFinite(record.grantedAt) || !Number.isFinite(record.expiry)) return false;
  if (record.expiry <= now) return false;
  if (record.grantedAt > record.expiry) return false;
  // A record claiming more than the bounded TTL is not trustworthy.
  if (record.expiry - record.grantedAt > CONSENT_MAX_TTL_MS) return false;
  return true;
}

function isRecordBound(record: ConsentRecord): boolean {
  return (
    record.v === RECORD_VERSION &&
    record.noticeVersion === CONSENT_NOTICE_VERSION &&
    record.origin === currentOrigin()
  );
}

function readRecord(): ConsentRecord | null {
  return parseRecord(safeGet(RECORD_KEY));
}

function writeRecord(record: ConsentRecord): void {
  safeSet(RECORD_KEY, JSON.stringify(record));
}

function removeRecord(): void {
  safeRemove(RECORD_KEY);
}

function dropLegacyKeys(): void {
  safeRemove(LEGACY_GRANTED_KEY);
  safeRemove(LEGACY_EXPIRY_KEY);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const hasConsent = (): boolean => {
  const record = activeGrant;
  if (!record || !activeGrantTrusted) return false;
  return isRecordFresh(record, Date.now()) && isRecordBound(record);
};

export const hasDenial = (): boolean => {
  return safeGet(DENIAL_KEY) === 'true';
};

/**
 * Resolve the persisted consent state.
 *
 * Synchronous and fail-closed: until {@link initConsentIntegrity} has verified
 * the stored record (or a grant is made in this document) the answer is not
 * `'granted'`. A stored grant still wins over a stored denial, but the two are
 * kept mutually exclusive by the save helpers.
 */
export const getConsentState = (): ConsentState => {
  if (hasConsent()) return 'granted';
  if (hasDenial()) return 'denied';
  return 'unset';
};

/**
 * Load (or create) the non-extractable HMAC key and verify the stored consent
 * record. Idempotent and never rejects. Hosts should await this before relying
 * on {@link getConsentState}; callers that cannot wait still fail closed.
 */
export const initConsentIntegrity = (): Promise<ConsentState> => {
  if (!initPromise) initPromise = runIntegrityInit();
  return initPromise;
};

async function runIntegrityInit(): Promise<ConsentState> {
  const generation = ++initGeneration;
  const epoch = stateEpoch;

  let key: CryptoKey | null = null;
  try {
    key = await loadOrCreateKey();
  } catch {
    key = null;
  }
  if (generation !== initGeneration) return getConsentState();
  hmacKey = key;

  dropLegacyKeys();

  const stored = readRecord();
  const verified =
    stored !== null &&
    (await verifyRecordMac(stored)) &&
    isRecordFresh(stored, Date.now()) &&
    isRecordBound(stored);

  if (verified && stored) {
    if (epoch === stateEpoch && generation === initGeneration) {
      activeGrant = stored;
      activeGrantTrusted = true;
    }
  } else if (stored && !pendingSeal) {
    // Malformed, tampered, expired, foreign-origin or stale-notice record:
    // never granted, and not kept around to be replayed.
    removeRecord();
    if (epoch === stateEpoch && generation === initGeneration) {
      activeGrant = null;
      activeGrantTrusted = false;
    }
  }

  return getConsentState();
}

interface GrantAuthorization {
  noticeVersion: number;
  source: 'user-gesture' | 'host-managed';
}

function consumeAuthorization(): GrantAuthorization | null {
  const gesture = pendingGesture;
  pendingGesture = null;
  if (gesture && Date.now() - gesture.at <= GESTURE_TTL_MS) {
    return { noticeVersion: gesture.noticeVersion, source: 'user-gesture' };
  }
  if (hostManagedConsentAllowed) {
    return { noticeVersion: CONSENT_NOTICE_VERSION, source: 'host-managed' };
  }
  return null;
}

function clampTtl(ttlMs?: number): number {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return CONSENT_MAX_TTL_MS;
  }
  return Math.min(Math.floor(ttlMs), CONSENT_MAX_TTL_MS);
}

function buildRecord(noticeVersion: number, ttlMs?: number): ConsentRecord {
  const now = Date.now();
  return {
    v: RECORD_VERSION,
    noticeVersion,
    origin: currentOrigin(),
    grantedAt: now,
    expiry: now + clampTtl(ttlMs),
    mac: '',
  };
}

function startGrant(authorization: GrantAuthorization, ttlMs?: number): ConsentRecord {
  safeRemove(DENIAL_KEY);
  dropLegacyKeys();
  const record = buildRecord(authorization.noticeVersion, ttlMs);
  activeGrant = record;
  activeGrantTrusted = true;
  pendingSeal = true;
  stateEpoch += 1;
  writeRecord(record);
  return record;
}

async function sealActiveGrant(record: ConsentRecord): Promise<void> {
  try {
    await initConsentIntegrity();
    if (activeGrant !== record) return;
    const mac = await signRecord(record);
    if (activeGrant !== record) return;
    if (!mac) {
      // No WebCrypto (non-secure context) or no usable key: the grant stays
      // valid for this document only, and nothing unverifiable is persisted.
      removeRecord();
      pendingSeal = false;
      return;
    }
    const sealed: ConsentRecord = { ...record, mac };
    activeGrant = sealed;
    activeGrantTrusted = true;
    writeRecord(sealed);
    pendingSeal = false;
  } catch {
    if (activeGrant === record) {
      removeRecord();
      pendingSeal = false;
    }
  }
}

/**
 * Persist consent (clears any previous denial). Synchronous, as required by the
 * controller and by host consent callbacks.
 *
 * The grant is only accepted when it is authorized:
 * - `ConsentUI` minted a one-shot gesture token from a click on the accept
 *   button (the visitor saw the banner and acted), or
 * - the host explicitly opted in via {@link setHostManagedConsentAllowed}.
 *
 * Otherwise the call is refused with a warning and the state stays not-granted,
 * so a host that calls `accept()` without rendering a banner cannot silently
 * consent. When WebCrypto is unavailable the grant is limited to the current
 * document (nothing unverifiable is written to storage).
 */
export const saveConsent = (): void => {
  const authorization = consumeAuthorization();
  if (!authorization) {
    logWarn(
      'refusing programmatic consent grant: consent requires the built-in banner to be rendered and accepted by the visitor (see setHostManagedConsentAllowed for host-managed UIs)',
    );
    return;
  }
  const record = startGrant(authorization);
  void sealActiveGrant(record);
};

/**
 * Async variant of {@link saveConsent} that resolves once the record is sealed
 * and readable again. Same authorization requirements.
 */
export const grantConsent = async (options?: { ttlMs?: number }): Promise<ConsentState> => {
  const authorization = consumeAuthorization();
  if (!authorization) {
    logWarn(
      'refusing programmatic consent grant: consent requires the built-in banner to be rendered and accepted by the visitor (see setHostManagedConsentAllowed for host-managed UIs)',
    );
    return getConsentState();
  }
  const record = startGrant(authorization, options?.ttlMs);
  await sealActiveGrant(record);
  return getConsentState();
};

/**
 * Mint the one-shot authorization consumed by the next {@link saveConsent} /
 * {@link grantConsent} call. Only the built-in `ConsentUI` accept button calls
 * this, from a click handler that runs after the minimum-visible duration.
 */
export const markUserGestureConsent = (
  noticeVersion: number = CONSENT_NOTICE_VERSION,
): void => {
  pendingGesture = { noticeVersion, at: Date.now() };
};

/**
 * Opt in to host-managed consent (default: disabled).
 *
 * Disabled by default so a host-supplied `onConsentRequired` callback cannot
 * grant consent headlessly. Hosts that render their own disclosure UI must call
 * this before granting, and remain responsible for showing the current
 * disclosure text to the visitor.
 */
export const setHostManagedConsentAllowed = (allowed: boolean): void => {
  hostManagedConsentAllowed = allowed === true;
};

export const isHostManagedConsentAllowed = (): boolean => hostManagedConsentAllowed;

/** Persist denial. Clears any previous consent/expiry so the two never co-exist. */
export const saveDenial = (): void => {
  removeRecord();
  dropLegacyKeys();
  activeGrant = null;
  activeGrantTrusted = false;
  pendingSeal = false;
  stateEpoch += 1;
  safeSet(DENIAL_KEY, 'true');
};

/**
 * Revoke consent: forget the decision entirely (granted + expiry + denial) and
 * drop the HMAC key so copies of the old record can no longer verify.
 */
export const clearConsent = (): void => {
  removeRecord();
  dropLegacyKeys();
  safeRemove(DENIAL_KEY);
  activeGrant = null;
  activeGrantTrusted = false;
  pendingSeal = false;
  pendingGesture = null;
  hmacKey = null;
  initGeneration += 1;
  stateEpoch += 1;
  initPromise = null;
  void withTimeout(keyStore.clear(), undefined, KEY_STORE_TIMEOUT_MS);
};

export const safeLocalStorageGet = safeGet;
export const safeLocalStorageSet = safeSet;
export const safeLocalStorageRemove = safeRemove;

/**
 * Re-verify the stored record after another tab changed it. The cached grant
 * must not outlive a cross-tab revoke, and a cross-tab grant must become
 * visible here — but only through the same HMAC/origin/notice/expiry checks,
 * never by trusting the raw value.
 */
async function refreshConsentFromStorage(): Promise<void> {
  const epoch = stateEpoch;
  const stored = readRecord();
  if (!stored) {
    activeGrant = null;
    activeGrantTrusted = false;
    return;
  }
  if (!getSubtle()) return; // Nothing can be verified in this context.
  if (!hmacKey) {
    // The key was never loaded (or was dropped by a revoke): re-run the init.
    initPromise = null;
    await initConsentIntegrity();
    return;
  }
  const validMac = await verifyRecordMac(stored);
  // A clear/revoke or a later storage event may have happened while WebCrypto
  // was pending. Never let this stale verification restore a previous grant.
  const current = readRecord();
  if (epoch !== stateEpoch || !current || JSON.stringify(current) !== JSON.stringify(stored)) return;
  const verified = validMac && isRecordFresh(stored, Date.now()) && isRecordBound(stored);
  activeGrant = verified ? stored : null;
  activeGrantTrusted = verified;
}

try {
  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('storage', (event: StorageEvent) => {
      if (event.key !== null && event.key !== RECORD_KEY && event.key !== DENIAL_KEY) return;
      stateEpoch += 1;
      void refreshConsentFromStorage();
    });
  }
} catch {
  // Environments without `window`/`storage` events keep the cached state.
}

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

/** @internal Drop every in-memory grant/key so the next read re-verifies. */
function resetIntegrityCache(): void {
  hmacKey = null;
  activeGrant = null;
  activeGrantTrusted = false;
  pendingSeal = false;
  pendingGesture = null;
  initGeneration += 1;
  stateEpoch += 1;
  initPromise = null;
}

/**
 * @internal Test-only seams. Production code never calls these; they exist so
 * unit tests can simulate a reload (key store), a foreign origin, or an
 * integrity-cache reset without weakening any production default.
 */
export const __consentTestHooks = {
  setKeyStore(store: ConsentKeyStore | null): void {
    keyStore = store ?? indexedDbKeyStore;
  },
  setOrigin(origin: string | null): void {
    originProvider = origin === null ? defaultOrigin : () => origin;
  },
  resetIntegrityCache,
  reset(): void {
    keyStore = indexedDbKeyStore;
    originProvider = defaultOrigin;
    hostManagedConsentAllowed = false;
    resetIntegrityCache();
  },
  /** Seed a valid grant as if the visitor had accepted the banner. */
  seedGrantedConsent(noticeVersion: number = CONSENT_NOTICE_VERSION): void {
    markUserGestureConsent(noticeVersion);
    saveConsent();
  },
};

// Warm the integrity cache as early as possible so a returning visitor's stored
// record is verified before the host reads the synchronous state. Readers that
// run before this resolves still fail closed.
void initConsentIntegrity();