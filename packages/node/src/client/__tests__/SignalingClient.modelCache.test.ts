import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initFlaxiaNode } from '../SignalingClient';
import { __consentTestHooks } from '../../consent/storage';

const { collectNodeResourceReportMock } = vi.hoisted(() => ({
  collectNodeResourceReportMock: vi.fn(),
}));
vi.mock('../../executor/resourceReporter', () => ({
  collectNodeResourceReport: collectNodeResourceReportMock,
}));

vi.mock('../../executor/memoryProbe', () => ({
  HEAVY_WORKLOAD_WASM_MEMORY_BYTES: 2 * 1024 ** 3,
  probeMaxWasmMemoryBytes: () => 4 * 1024 ** 3,
  hasEnoughWasmMemoryForHeavy: () => true,
  getAdvertisedWasmMemoryBytes: () => 4 * 1024 ** 3,
}));

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('SignalingClient heartbeat model cache', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
    collectNodeResourceReportMock.mockReset().mockResolvedValue({
      version: 1,
      sampledAt: Date.now(),
      expiresAt: Date.now() + 90_000,
      gpu: { status: 'unknown' },
    });
    __consentTestHooks.reset();
    delete (window as any).__flaxia_node_init_started;
    delete (window as any).__flaxia_node_signal_client;
    delete (window as any).__flaxia_node_controller;
    delete (globalThis as any).Worker;
  });

  it('relays LoRA adapter entries from the worker snapshot in its pong', async () => {
    const send = vi.fn();
    let wsInstance: any;
    class MockWebSocket {
      readyState = 1;
      binaryType = 'arraybuffer';
      onopen?: () => void;
      onmessage?: (event: MessageEvent) => void;
      close = vi.fn();
      send = send;
      constructor() { wsInstance = this; }
    }
    globalThis.WebSocket = MockWebSocket as any;
    (globalThis.WebSocket as any).OPEN = 1;

    let workerHandler: ((event: { data: unknown }) => void) | undefined;
    class MockWorker {
      postMessage = vi.fn();
      terminate = vi.fn();
      addEventListener = vi.fn((_type: string, handler: (event: { data: unknown }) => void) => {
        workerHandler = handler;
      });
      removeEventListener = vi.fn();
      onerror = null;
      onmessageerror = null;
    }
    (globalThis as any).Worker = MockWorker as any;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        token: 'test-token',
        nodeId: 'node-1',
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      }),
    });
    __consentTestHooks.seedGrantedConsent();
    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
    });
    await flush();
    await flush();

    // Start a task so the pool installs its worker message listener; the
    // snapshot then arrives on that listener like a real worker heartbeat.
    wsInstance.onmessage({
      data: JSON.stringify({
        type: 'task',
        taskId: 'cache-task',
        workload: 'cc-extract',
        payload: {},
      }),
    });
    await flush();

    const sampledAt = Date.now();
    const snapshot = {
      version: 1 as const,
      sampledAt,
      expiresAt: sampledAt + 60_000,
      entries: [
        {
          modelId: 'test-dllm',
          revision: 'base',
          dtype: 'q4_0',
          backend: 'wasm' as const,
          state: 'ready' as const,
          referenceCount: 1,
        },
        {
          modelId: 'test-dllm',
          revision: 'adapter',
          dtype: 'q4_0',
          backend: 'wasm' as const,
          state: 'ready' as const,
          referenceCount: 1,
          adapterId: 'code',
        },
      ],
    };
    workerHandler!({ data: { id: 'cache-task', type: 'heartbeat', modelCache: snapshot } });

    wsInstance.onopen();
    await flush();
    // The connect heartbeat already sent one pong; inspect the one triggered
    // by the coordinator ping after the snapshot arrived.
    send.mockClear();
    wsInstance.onmessage({ data: JSON.stringify({ type: 'ping' }) });
    await flush();

    const pongs = send.mock.calls
      .map(([message]) => JSON.parse(message as string))
      .filter((message) => message.type === 'pong');
    expect(pongs).toHaveLength(1);
    expect(pongs[0].modelCache.entries).toEqual(snapshot.entries);
    expect(pongs[0].modelCache.entries[1].adapterId).toBe('code');
  });
});
