import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getFlaxiaNodeConsentState, initFlaxiaNode, setFlaxiaNodeHostManagedConsent } from '../index';
import { __consentTestHooks } from '../consent/storage';
import { CONSENT_NOTICE_VERSION } from '../consent/notice';

// Capability probes are irrelevant here; keep them off the real hardware.
const { probeWebGpuMock } = vi.hoisted(() => ({ probeWebGpuMock: vi.fn() }));
vi.mock('../executor/webgpuProbe', () => ({ probeWebGpu: probeWebGpuMock }));
vi.mock('../executor/memoryProbe', () => ({
  HEAVY_WORKLOAD_WASM_MEMORY_BYTES: 2 * 1024 ** 3,
  probeMaxWasmMemoryBytes: () => 4 * 1024 ** 3,
  hasEnoughWasmMemoryForHeavy: () => true,
}));

class MockWorker {
  terminate = vi.fn();
  postMessage = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  onerror = null;
  onmessageerror = null;
}

function mockFetchToken() {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      token: 'test-token',
      nodeId: 'node-1',
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    }),
  });
}

/** Capture closed shadow roots: `attachShadow` returns them to the caller. */
function captureShadowRoots(): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  const original = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ) {
    const root = original.call(this, init);
    roots.push(root);
    return root;
  });
  return roots;
}

/** Real timer, captured before any test installs fake timers. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

const settle = async () => {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
  }
};

/** WebCrypto work resolves off the timer queue, so poll for the sealed record. */
async function waitFor(predicate: () => boolean, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
  }
  throw new Error('condition was not met in time');
}

const readRecord = (): Record<string, unknown> | null =>
  JSON.parse(localStorage.getItem('flaxia_consent_record') ?? 'null');

describe('consent policy (initFlaxiaNode integration)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    __consentTestHooks.reset();
    __consentTestHooks.setKeyStore({
      load: async () => null,
      save: async () => {},
      clear: async () => {},
    });
    vi.restoreAllMocks();
    vi.useRealTimers();
    probeWebGpuMock.mockResolvedValue({
      webgpu: false,
      gpuArchitecture: undefined,
      maxStorageBufferBindingSize: undefined,
    });
    (globalThis as any).Worker = MockWorker as any;
    globalThis.WebSocket = vi.fn() as any;
    mockFetchToken();
    delete (window as any).__flaxia_node_init_started;
    delete (window as any).__flaxia_node_signal_client;
    delete (window as any).__flaxia_node_controller;
  });

  afterEach(() => {
    setFlaxiaNodeHostManagedConsent(false);
    vi.useRealTimers();
    vi.restoreAllMocks();
    __consentTestHooks.reset();
  });

  it('does not grant consent when a host calls accept() headlessly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onConsentRequired = vi.fn();

    const controller = initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right', onConsentRequired },
    });

    // No banner was rendered and no gesture happened.
    expect(document.getElementById('flaxia-consent-container')).toBeNull();

    onConsentRequired.mock.calls[0][0].accept();
    await settle();

    expect(controller.getConsentState()).toBe('unset');
    expect(getFlaxiaNodeConsentState()).toBe('unset');
    expect(localStorage.getItem('flaxia_consent_record')).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[flaxia-node]',
      expect.stringContaining('refusing programmatic consent grant'),
    );
  });

  it('grants consent from a host-managed UI only after an explicit opt-in', async () => {
    const onConsentRequired = vi.fn();
    setFlaxiaNodeHostManagedConsent(true);

    const controller = initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right', onConsentRequired },
    });

    onConsentRequired.mock.calls[0][0].accept();
    await settle();

    expect(controller.getConsentState()).toBe('granted');
    const record = JSON.parse(localStorage.getItem('flaxia_consent_record') ?? 'null');
    expect(record?.noticeVersion).toBe(CONSENT_NOTICE_VERSION);
  });

  it('grants consent after a real click on the banner once the notice has been visible', async () => {
    vi.useFakeTimers();
    const roots = captureShadowRoots();

    const controller = initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
    });

    expect(controller.getConsentState()).toBe('unset');

    const container = document.getElementById('flaxia-consent-container') as HTMLElement;
    expect(container).not.toBeNull();
    // The banner lives in a closed shadow root: host-page scripts cannot reach
    // the buttons to drive them programmatically.
    expect(container.shadowRoot).toBeNull();

    const root = roots[0];
    const accept = root?.querySelector('#consent-btn') as HTMLButtonElement;
    expect(accept).toBeDefined();

    // Too early: the click is ignored.
    accept.click();
    await settle();
    expect(controller.getConsentState()).toBe('unset');

    await vi.advanceTimersByTimeAsync(1600);
    accept.click();
    await settle();

    expect(controller.getConsentState()).toBe('granted');
    expect(getFlaxiaNodeConsentState()).toBe('granted');

    await waitFor(() => ((readRecord()?.mac as string) ?? '').length > 0);
    const record = readRecord();
    expect(record?.noticeVersion).toBe(CONSENT_NOTICE_VERSION);
    expect(record?.origin).toBe(window.location.origin);
    expect(typeof record?.mac).toBe('string');
    expect((record?.mac as string).length).toBeGreaterThan(0);
  });

  it('does not count a record from an older notice version', async () => {
    // A visitor who accepted v1 must see the current disclosure again.
    __consentTestHooks.seedGrantedConsent(CONSENT_NOTICE_VERSION - 1);
    __consentTestHooks.resetIntegrityCache();

    const controller = initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
    });
    await settle();

    expect(controller.getConsentState()).toBe('unset');
  });
});