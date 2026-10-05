import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initFlaxiaNode } from '../SignalingClient';
import {
  decodeSwarmEnvelope,
  encodeSwarmEnvelope,
  encodeSwarmFrame,
  signSwarmEnvelope,
  verifySwarmEnvelope,
} from '@flaxia/sdk';
import { __consentTestHooks } from '../../consent/storage';
import { setFlaxiaNodeHostManagedConsent } from '../../index';

// Swarm capability advertisement is driven by the WebGPU probe; mock it so
// tests never touch a real adapter.
const { probeWebGpuMock } = vi.hoisted(() => ({ probeWebGpuMock: vi.fn() }));
vi.mock('../../executor/webgpuProbe', () => ({ probeWebGpu: probeWebGpuMock }));

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

/**
 * Seed a valid, HMAC-sealed consent record. Tests used to write the legacy
 * plaintext `flaxia_consent_granted` flag, which no longer counts as consent
 * (issue #7) — only a banner-minted gesture or a host opt-in can grant.
 */
function seedGrantedConsent() {
  __consentTestHooks.seedGrantedConsent();
}

describe('SignalingClient', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
    probeWebGpuMock.mockClear();
    vi.useRealTimers();
    __consentTestHooks.reset();
    setFlaxiaNodeHostManagedConsent(false);
    // Reset node init idempotency flags and any leaked Worker global between tests.
    delete (window as any).__flaxia_node_init_started;
    delete (window as any).__flaxia_node_signal_client;
    delete (window as any).__flaxia_node_controller;
    delete (globalThis as any).Worker;
  });

  afterEach(() => {
    vi.useRealTimers();
    setFlaxiaNodeHostManagedConsent(false);
  });

  it('should register the node and connect with a token after consent', async () => {
    const MockWebSocket = vi.fn();
    globalThis.WebSocket = MockWebSocket as any;
    mockFetchToken();

    // The banner lives in a closed shadow root (issue #8), so capture the root
    // through `attachShadow` and wait out the minimum-visible gate (issue #9)
    // before clicking the real accept button.
    const roots: ShadowRoot[] = [];
    const attachShadow = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
      this: Element,
      init: ShadowRootInit,
    ) {
      const root = attachShadow.call(this, init);
      roots.push(root);
      return root;
    });

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: {
        brandName: 'Test Brand',
        position: 'bottom-right',
      },
    });

    const accept = roots[0]?.querySelector('#consent-btn') as HTMLButtonElement;
    expect(accept).toBeDefined();
    expect(accept.disabled).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 1600));
    accept.click();
    await flush();
    await flush();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://flaxia.app/crowd/nodes/register',
      expect.objectContaining({ method: 'POST' }),
    );
    // The token travels in the subprotocol list, never in the query string.
    expect(MockWebSocket).toHaveBeenCalledWith(
      'wss://flaxia.app/crowd/signal',
      ['flaxia-node-v1', 'bearer.test-token'],
    );
  });

  it('should send siteId and capabilities when registering', async () => {
    globalThis.WebSocket = vi.fn() as any;
    mockFetchToken();
    seedGrantedConsent();

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
    });
    await flush();
    await flush();

    const [, init] = (global.fetch as any).mock.calls[0];
    // No client-chosen nodeId: the coordinator issues one and binds the token
    // to it, so a node cannot claim another node's identity.
    expect(JSON.parse(init.body)).toEqual({
      siteId: 'test-site',
      capabilities: ['ai-inference', 'image-process'],
      wasmMemoryBytes: 4 * 1024 ** 3,
      deviceMemory: null, // jsdom / mobile WebViews do not expose navigator.deviceMemory
    });
  });

  it('advertises swarm-inference with WebGPU details when the host opts in', async () => {
    globalThis.WebSocket = vi.fn() as any;
    mockFetchToken();
    seedGrantedConsent();
    probeWebGpuMock.mockResolvedValue({
      webgpu: true,
      gpuArchitecture: 'apple m1',
      maxStorageBufferBindingSize: 134217728,
    });

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
      capabilities: ['ai-inference', 'swarm-inference'],
      allowModelDownload: true,
    });
    await flush();
    await flush();

    const [, init] = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.capabilities).toEqual(['ai-inference', 'swarm-inference']);
    expect(body.swarm).toEqual({
      webgpu: true,
      gpuArchitecture: 'apple m1',
      maxStorageBufferBindingSize: 134217728,
    });
  });

  it('drops swarm-inference when the device has no WebGPU adapter', async () => {
    globalThis.WebSocket = vi.fn() as any;
    mockFetchToken();
    seedGrantedConsent();
    probeWebGpuMock.mockResolvedValue({ webgpu: false });

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
      capabilities: ['ai-inference', 'swarm-inference'],
      allowModelDownload: true,
    });
    await flush();
    await flush();

    const [, init] = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.capabilities).toEqual(['ai-inference']);
    expect(body.swarm).toBeUndefined();
  });

  it('never probes WebGPU without the model-download opt-in', async () => {
    globalThis.WebSocket = vi.fn() as any;
    mockFetchToken();
    seedGrantedConsent();

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
      capabilities: ['ai-inference', 'swarm-inference'],
    });
    await flush();
    await flush();

    const [, init] = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.capabilities).toEqual(['ai-inference']);
    expect(body.swarm).toBeUndefined();
    expect(probeWebGpuMock).not.toHaveBeenCalled();
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
    seedGrantedConsent();
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
    seedGrantedConsent();

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
    seedGrantedConsent();

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
    seedGrantedConsent();

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
    let wsInstance: {
      close: () => void;
      send: typeof send;
      onmessage: ((e: MessageEvent) => void) | null;
      readyState?: number;
    };
    const MockWebSocket = vi.fn().mockImplementation(function () {
      wsInstance = { close: vi.fn(), send, onmessage: null, readyState: 1 };
      return wsInstance;
    });
    globalThis.WebSocket = MockWebSocket as any;
    (globalThis.WebSocket as any).OPEN = 1;
    mockFetchToken();
    seedGrantedConsent();

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
    seedGrantedConsent();

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
    seedGrantedConsent();

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

  it('delegates consent to the host and never mounts the built-in UI', async () => {
    class MockWorker {
      terminate = vi.fn();
      postMessage = vi.fn();
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      onerror = null;
      onmessageerror = null;
    }
    (globalThis as any).Worker = MockWorker as any;
    globalThis.WebSocket = vi.fn() as any;
    mockFetchToken();

    const onConsentRequired = vi.fn();
    // Host-managed consent is opt-in: without this the accept() below is
    // refused and the state stays not-granted (issue #9).
    setFlaxiaNodeHostManagedConsent(true);
    const controller = initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right', onConsentRequired },
    });

    expect(onConsentRequired).toHaveBeenCalledTimes(1);
    expect(document.getElementById('flaxia-consent-container')).toBeNull();
    expect(controller.isRunning()).toBe(false);
    expect(controller.getConsentState()).toBe('unset');

    const controls = onConsentRequired.mock.calls[0][0];
    controls.accept();
    await flush();
    await flush();

    expect(controller.isRunning()).toBe(true);
    expect(controller.getConsentState()).toBe('granted');
  });

  it('revokes and re-grants consent from the controller (settings toggle)', async () => {
    class MockWorker {
      terminate = vi.fn();
      postMessage = vi.fn();
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      onerror = null;
      onmessageerror = null;
    }
    (globalThis as any).Worker = MockWorker as any;
    globalThis.WebSocket = vi.fn() as any;
    mockFetchToken();

    const controller = initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: {
        brandName: 'Test',
        position: 'bottom-right',
        onConsentRequired: ({ reject }) => reject(),
      },
    });

    // Host rejected immediately -> denied, nothing running, no consent stored.
    expect(controller.getConsentState()).toBe('denied');
    expect(controller.isRunning()).toBe(false);
    expect(localStorage.getItem('flaxia_consent_granted')).toBeNull();

    // Settings toggles it back on (the host owns this UI, so it opted in).
    setFlaxiaNodeHostManagedConsent(true);
    controller.grant();
    controller.start();
    await flush();
    await flush();
    expect(controller.getConsentState()).toBe('granted');
    expect(controller.isRunning()).toBe(true);
    expect(localStorage.getItem('flaxia_consent_denied')).toBeNull();

    // Settings toggles it off again.
    controller.deny();
    expect(controller.getConsentState()).toBe('denied');
    expect(controller.isRunning()).toBe(false);
    expect(localStorage.getItem('flaxia_consent_granted')).toBeNull();
  });

  it('does not open a socket if consent is revoked while token registration is pending', async () => {
    class MockWorker {
      terminate = vi.fn();
      postMessage = vi.fn();
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      onerror = null;
      onmessageerror = null;
    }
    (globalThis as any).Worker = MockWorker as any;
    globalThis.WebSocket = vi.fn() as any;
    seedGrantedConsent();

    let resolveRegistration!: (value: any) => void;
    global.fetch = vi.fn(() => new Promise((resolve) => { resolveRegistration = resolve; })) as any;
    const controller = initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
    });
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    controller.clearConsent();
    resolveRegistration({
      ok: true,
      json: async () => ({ token: 'late-token', nodeId: 'node-late', expiresAt: Date.now() + 60_000 }),
    });
    await flush();
    await flush();

    expect(controller.getConsentState()).toBe('unset');
    expect(globalThis.WebSocket).not.toHaveBeenCalled();
  });

  it('never connects when controller.start() is called without verified consent', async () => {
    globalThis.WebSocket = vi.fn() as any;
    mockFetchToken();
    const controller = initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right', onConsentRequired: () => {} },
    });

    controller.start();
    await flush();
    expect(controller.isRunning()).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(globalThis.WebSocket).not.toHaveBeenCalled();

    controller.deny();
    controller.start();
    await flush();
    expect(controller.getConsentState()).toBe('denied');
    expect(controller.isRunning()).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  /**
   * Boot a node against a fake socket and worker, and expose the hooks a test
   * needs to feed coordinator messages in and worker reports back.
   */
  async function bootNode() {
    const send = vi.fn();
    let wsInstance: {
      close: () => void;
      send: typeof send;
      onmessage: ((e: MessageEvent) => void) | null;
      readyState?: number;
    };
    const MockWebSocket = vi.fn().mockImplementation(function () {
      wsInstance = { close: vi.fn(), send, onmessage: null, readyState: 1 };
      return wsInstance;
    });
    globalThis.WebSocket = MockWebSocket as any;
    (globalThis.WebSocket as any).OPEN = 1;

    const postMessage = vi.fn();
    let workerHandler: ((event: { data: unknown }) => void) | undefined;
    class MockWorker {
      postMessage = postMessage;
      terminate = vi.fn();
      addEventListener = vi.fn((_event: string, handler: (event: { data: unknown }) => void) => {
        workerHandler = handler;
      });
      removeEventListener = vi.fn();
      onerror = null;
      onmessageerror = null;
    }
    (globalThis as any).Worker = MockWorker as any;

    mockFetchToken();
    seedGrantedConsent();

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
    });
    await flush();
    await flush();

    const onmessage = wsInstance!.onmessage as (e: MessageEvent) => void;
    return {
      onmessage,
      postMessage,
      coordinator: (message: Record<string, unknown>) => onmessage({ data: JSON.stringify(message) } as MessageEvent),
      workerReports: (id: string, type: string, error: string) =>
        workerHandler!({ data: { id, type, error } }),
      workerTokens: (id: string, token: string) =>
        workerHandler!({ data: { id, type: 'token', token } }),
      workerFrames: (id: string, frame: ArrayBuffer) =>
        workerHandler!({ data: { id, type: 'swarm-frame', frame } }),
      sentRaw: () => send.mock.calls.map(([m]) => m),
      sent: () =>
        send.mock.calls
          .map(([m]) => JSON.parse(m as string))
          .filter((m: Record<string, unknown>) => m.type !== 'pong'),
    };
  }

  it('never persists the node token and purges a legacy cached one', async () => {
    globalThis.WebSocket = vi.fn() as any;
    mockFetchToken();
    // A token cached by an older bundle must not survive startup.
    localStorage.setItem('flaxia_node_token', JSON.stringify({ token: 'stale', nodeId: 'n', expiresAt: Date.now() + 100000 }));
    seedGrantedConsent();
    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
    });
    await flush();
    await flush();
    // The bearer lives in memory only: an XSS on the host page cannot lift a
    // node identity out of persistent storage.
    expect(localStorage.getItem('flaxia_node_token')).toBeNull();
  });

  it('echoes the delivery attempt id on progress and result', async () => {
    const { coordinator, workerReports, workerTokens, sent } = await bootNode();

    coordinator({
      type: 'task',
      taskId: 'task-att-1',
      workload: 'ai-inference',
      payload: { task: 'text-generation', model: 'm', input: 'hi' },
      attemptId: 'attempt-1',
    });
    await flush();

    // A progress token is transport metadata plus payload: the attempt id must
    // ride along or the coordinator drops the message.
    workerTokens('task-att-1', 'hi');
    await flush();
    expect(sent()).toContainEqual(
      expect.objectContaining({ type: 'progress', taskId: 'task-att-1', token: 'hi', attemptId: 'attempt-1' }),
    );

    workerReports('task-att-1', 'done', '');
    await flush();
    await flush();
    expect(sent()).toContainEqual(
      expect.objectContaining({ type: 'result', taskId: 'task-att-1', attemptId: 'attempt-1' }),
    );
  });

  it('echoes the attempt id when reporting a task failure', async () => {
    const { coordinator, workerReports, sent } = await bootNode();

    coordinator({
      type: 'task',
      taskId: 'task-att-2',
      workload: 'ai-inference',
      payload: { task: 'text-generation', model: 'm', input: 'hi' },
      attemptId: 'attempt-2',
    });
    await flush();

    workerReports('task-att-2', 'error', 'boom');
    await flush();
    await flush();

    expect(sent()).toContainEqual(
      expect.objectContaining({ type: 'error', taskId: 'task-att-2', error: 'boom', attemptId: 'attempt-2' }),
    );
  });

  it('stops an aborted task locally and does not report its failure back', async () => {
    const { coordinator, postMessage, workerReports, sent } = await bootNode();

    coordinator({
      type: 'task',
      taskId: 'task-abort-1',
      workload: 'ai-inference',
      payload: { task: 'text-generation', model: 'm', input: 'hi' },
    });
    await flush();

    // The coordinator settled the task elsewhere and tells us to stop.
    coordinator({ type: 'abort', taskId: 'task-abort-1', error: 'peer failed' });
    await flush();
    expect(postMessage).toHaveBeenCalledWith({ id: 'task-abort-1', type: 'abort', reason: 'peer failed' });

    // The worker obeys and reports the abort as an error. The coordinator
    // already knows the task is over — and may have requeued it for a retry —
    // so echoing this back would race that attempt.
    workerReports('task-abort-1', 'error', 'peer failed');
    await flush();
    await flush();

    expect(sent().filter((m) => m.type === 'error')).toHaveLength(0);
  });

  it('still reports a task failure when the task was not aborted', async () => {
    const { coordinator, workerReports, sent } = await bootNode();

    coordinator({
      type: 'task',
      taskId: 'task-err-1',
      workload: 'ai-inference',
      payload: { task: 'text-generation', model: 'm', input: 'hi' },
    });
    await flush();

    workerReports('task-err-1', 'error', 'boom');
    await flush();
    await flush();

    expect(sent()).toContainEqual(
      expect.objectContaining({ type: 'error', taskId: 'task-err-1', error: 'boom' }),
    );
  });

  it('signs swarm frames per hop and drops unsigned or tampered inbound frames', async () => {
    const { coordinator, onmessage, postMessage, sentRaw, workerFrames } = await bootNode();

    // A two-node session where this node is the host (index 0).
    coordinator({
      type: 'swarm-init',
      taskId: 'swarm-mac',
      sessionId: 'sess-mac',
      model: 'm',
      members: [],
      timeoutMs: 1000,
    });
    coordinator({
      type: 'swarm-slice',
      taskId: 'swarm-mac',
      sessionId: 'sess-mac',
      index: 0,
      chainLength: 2,
      role: 'host',
      slice: { start: 0, end: 4, hasEmbed: true, hasHead: true },
      inboundKey: 'in-key',
      outboundKey: 'out-key',
    });
    await flush();

    // Outbound: what the engine hands over is signed with the outbound hop key.
    const outboundFrame = encodeSwarmFrame({ requestId: 1, pos: 1, tokens: 1 }, new Uint8Array(8));
    workerFrames('sess-mac', outboundFrame);
    await flush();
    await flush();

    const binary = sentRaw().find((m) => typeof m !== 'string') as ArrayBuffer | undefined;
    expect(binary).toBeDefined();
    const envelope = decodeSwarmEnvelope(binary!);
    expect(envelope?.sessionId).toBe('sess-mac');
    expect(envelope?.mac).not.toBeNull();
    expect(await verifySwarmEnvelope('out-key', 'sess-mac', envelope!.frame, envelope!.mac!)).toBe(true);

    // Inbound: a frame signed with our inbound key reaches the engine...
    const inboundFrame = encodeSwarmFrame({ requestId: 2, pos: 2, tokens: 1 }, new Uint8Array(8));
    onmessage({ data: await signSwarmEnvelope('in-key', 'sess-mac', inboundFrame) } as MessageEvent);
    await flush();
    await flush();
    expect(postMessage.mock.calls.some(([m]) => m?.type === 'swarm-frame' && m?.id === 'sess-mac')).toBe(true);

    // ...an unsigned frame is dropped...
    postMessage.mockClear();
    onmessage({ data: encodeSwarmEnvelope('sess-mac', inboundFrame) } as MessageEvent);
    await flush();
    await flush();
    expect(postMessage).not.toHaveBeenCalled();

    // ...and so is a frame signed with the wrong key.
    postMessage.mockClear();
    onmessage({
      data: encodeSwarmEnvelope('sess-mac', inboundFrame, new Uint8Array(16).fill(9)),
    } as MessageEvent);
    await flush();
    await flush();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('queues a fresh session behind an abort and ignores the retired attempt', async () => {
    const { coordinator, postMessage, workerReports, onmessage, sent } = await bootNode();
    const initial = { type: 'swarm-init', taskId: 'swarm-task', sessionId: 'old', model: 'm', members: [] };
    coordinator(initial);
    coordinator({ type: 'abort', taskId: 'swarm-task', sessionId: 'old', error: 'reconnect' });
    coordinator({ ...initial, sessionId: 'new' });
    expect(postMessage.mock.calls.filter(([m]) => m.workload)).toHaveLength(1);
    expect(postMessage).toHaveBeenCalledWith({ id: 'old', type: 'abort', reason: 'reconnect' });

    workerReports('old', 'error', 'reconnect');
    await flush();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'new', workload: 'swarm-inference' }));
    expect(sent().some(m => m.type === 'error')).toBe(false);
    postMessage.mockClear();
    coordinator({ type: 'swarm-start', taskId: 'swarm-task', sessionId: 'old' });
    coordinator({ type: 'abort', taskId: 'swarm-task', sessionId: 'old', error: 'late' });
    coordinator({ ...initial, type: 'swarm-slice' });
    onmessage({ data: encodeSwarmEnvelope('old', new ArrayBuffer(16)) } as MessageEvent);
    expect(postMessage).not.toHaveBeenCalled();

    coordinator({ type: 'swarm-start', taskId: 'swarm-task', sessionId: 'new' });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 'new', type: 'swarm-control', message: expect.objectContaining({ sessionId: 'new', taskId: 'swarm-task' }),
    }), []);
    workerReports('new', 'done', '');
    await flush();
    expect(sent()).toContainEqual(expect.objectContaining({ type: 'result', taskId: 'swarm-task', sessionId: 'new' }));
  });
});
