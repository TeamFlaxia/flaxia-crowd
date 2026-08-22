import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initFlaxiaNode } from '../SignalingClient';

// Deterministic capability probe so obtainToken() never actually tries to
// allocate gigabytes of RAM in the test runner. This file simulates a capable
// device (>= 2GB commit). See SignalingClient.incapable.test.ts for the
// incapable-device case.
vi.mock('../../executor/memoryProbe', () => ({
  HEAVY_WORKLOAD_WASM_MEMORY_BYTES: 2 * 1024 ** 3,
  probeMaxWasmMemoryBytes: () => 4 * 1024 ** 3,
  hasEnoughWasmMemoryForHeavy: () => true,
}));

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

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('SignalingClient', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
    // Reset node init idempotency flags and any leaked Worker global between tests.
    delete (window as any).__flaxia_node_init_started;
    delete (window as any).__flaxia_node_signal_client;
    delete (globalThis as any).Worker;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should register the node and connect with a token after consent', async () => {
    const MockWebSocket = vi.fn();
    globalThis.WebSocket = MockWebSocket as any;
    mockFetchToken();

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: {
        brandName: 'Test Brand',
        position: 'bottom-right',
      },
    });

    const overlay = document.body.firstElementChild?.shadowRoot?.querySelector('#consent-btn') as HTMLButtonElement;
    overlay.click();
    await flush();
    await flush();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://flaxia.app/crowd/nodes/register',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(MockWebSocket).toHaveBeenCalledWith('wss://flaxia.app/crowd/signal?token=test-token');
  });

  it('should send siteId and capabilities when registering', async () => {
    globalThis.WebSocket = vi.fn() as any;
    mockFetchToken();
    localStorage.setItem('flaxia_consent_granted', 'true');

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
    });
    await flush();
    await flush();

    const [, init] = (global.fetch as any).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      siteId: 'test-site',
      nodeId: expect.any(String),
      capabilities: ['ai-inference', 'image-process'],
      wasmMemoryBytes: 4 * 1024 ** 3,
      deviceMemory: null, // jsdom / mobile WebViews do not expose navigator.deviceMemory
    });
  });

  it('should create consent container with correct id', () => {
    globalThis.WebSocket = vi.fn() as any;

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
    });

    const container = document.getElementById('flaxia-consent-container');
    expect(container).toBeDefined();
  });

  it('should skip consent UI if consent already given', async () => {
    localStorage.setItem('flaxia_consent_granted', 'true');
    localStorage.setItem('flaxia_consent_expiry', String(Date.now() + 100000));
    const MockWebSocket = vi.fn();
    globalThis.WebSocket = MockWebSocket as any;
    mockFetchToken();

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
    });
    await flush();
    await flush();

    const container = document.getElementById('flaxia-consent-container');
    expect(container).toBeNull();
    expect(MockWebSocket).toHaveBeenCalled();
  });

  it('should generate and persist nodeId in localStorage', async () => {
    const MockWebSocket = vi.fn();
    globalThis.WebSocket = MockWebSocket as any;
    mockFetchToken();
    localStorage.setItem('flaxia_consent_granted', 'true');
    localStorage.setItem('flaxia_consent_expiry', String(Date.now() + 100000));

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
    });
    await flush();
    await flush();

    const nodeId = localStorage.getItem('flaxia_node_id');
    expect(nodeId).toBeDefined();
    expect(nodeId!.length).toBeGreaterThan(0);
  });

  it('should suspend WebSocket and terminate worker when tab becomes hidden', async () => {
    const mockClose = vi.fn();
    const MockWebSocket = vi.fn().mockImplementation(function () {
      return { close: mockClose, send: vi.fn() };
    });
    globalThis.WebSocket = MockWebSocket as any;
    mockFetchToken();
    localStorage.setItem('flaxia_consent_granted', 'true');
    localStorage.setItem('flaxia_consent_expiry', String(Date.now() + 100000));

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
    });
    await flush();
    await flush();

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(mockClose).toHaveBeenCalled();
  });

  it('should reconnect WebSocket when tab becomes visible after suspend', async () => {
    const MockWebSocket = vi.fn().mockImplementation(function () {
      return { close: vi.fn(), send: vi.fn() };
    });
    globalThis.WebSocket = MockWebSocket as any;
    mockFetchToken();
    localStorage.setItem('flaxia_consent_granted', 'true');
    localStorage.setItem('flaxia_consent_expiry', String(Date.now() + 100000));

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
    });
    await flush();
    await flush();

    const afterInitCount = MockWebSocket.mock.calls.length;

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    await flush();

    expect(MockWebSocket.mock.calls.length).toBeGreaterThan(afterInitCount);
  });

  it('should not execute a task that is already in flight (duplicate delivery)', async () => {
    const send = vi.fn();
    let wsInstance: { close: () => void; send: typeof send; onmessage: ((e: MessageEvent) => void) | null; readyState?: number };
    const MockWebSocket = vi.fn().mockImplementation(function () {
      wsInstance = { close: vi.fn(), send, onmessage: null, readyState: 1 };
      return wsInstance;
    });
    globalThis.WebSocket = MockWebSocket as any;
    (globalThis.WebSocket as any).OPEN = 1;
    mockFetchToken();
    localStorage.setItem('flaxia_consent_granted', 'true');
    localStorage.setItem('flaxia_consent_expiry', String(Date.now() + 100000));

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
    });
    await flush();
    await flush();

    const onmessage = wsInstance!.onmessage as (e: MessageEvent) => void;
    expect(typeof onmessage).toBe('function');

    const task = {
      type: 'task',
      taskId: 'task-dup-1',
      workload: 'ai-inference',
      payload: { task: 'text-classification', model: 'm', input: 'hello' },
    };
    const event = { data: JSON.stringify(task) } as MessageEvent;

    onmessage(event);
    onmessage(event);
    await flush();
    await flush();

    const taskMessages = send.mock.calls.map(([m]) => JSON.parse(m as string)).filter((m) => m.type !== 'pong');
    expect(taskMessages).toHaveLength(1);
    expect(taskMessages[0].taskId).toBe('task-dup-1');
  });

  it('should not spawn multiple Web Workers when initialized repeatedly (mobile re-exec)', async () => {
    const terminate = vi.fn();
    let workerCtorCalls = 0;
    class MockWorker {
      constructor() {
        workerCtorCalls++;
      }
      terminate = terminate;
      postMessage = vi.fn();
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      onerror = null;
      onmessageerror = null;
    }
    (globalThis as any).Worker = MockWorker as any;
    globalThis.WebSocket = vi.fn() as any;
    mockFetchToken();
    localStorage.setItem('flaxia_consent_granted', 'true');
    localStorage.setItem('flaxia_consent_expiry', String(Date.now() + 100000));

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
    });
    // Simulate the embed script re-executing (common on mobile Chrome).
    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
    });
    await flush();
    await flush();

    // Idempotency guard prevents a second client/worker from ever being created.
    expect(workerCtorCalls).toBe(1);
  });

  it('should terminate its Web Worker on disconnect', async () => {
    const terminate = vi.fn();
    class MockWorker {
      terminate = terminate;
      postMessage = vi.fn();
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      onerror = null;
      onmessageerror = null;
    }
    (globalThis as any).Worker = MockWorker as any;
    globalThis.WebSocket = vi.fn() as any;
    mockFetchToken();
    localStorage.setItem('flaxia_consent_granted', 'true');
    localStorage.setItem('flaxia_consent_expiry', String(Date.now() + 100000));

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
    });
    await flush();
    await flush();

    const client = (window as any).__flaxia_node_signal_client as any;
    client.disconnect();

    expect(terminate).toHaveBeenCalled();
  });
});
