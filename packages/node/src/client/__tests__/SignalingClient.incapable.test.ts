import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initFlaxiaNode } from '../SignalingClient';

// Simulates an INCAPABLE device: the memory probe reports it cannot commit the
// memory a multi-GB model needs, so the node must advertise empty capabilities.
vi.mock('../../executor/memoryProbe', () => ({
  HEAVY_WORKLOAD_WASM_MEMORY_BYTES: 2 * 1024 ** 3,
  probeMaxWasmMemoryBytes: () => 0,
  hasEnoughWasmMemoryForHeavy: () => false,
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

describe('SignalingClient (incapable device)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (window as any).__flaxia_node_init_started;
    delete (window as any).__flaxia_node_signal_client;
    delete (window as any).__flaxia_node_controller;
    delete (globalThis as any).Worker;
  });

  it('should send empty capabilities when the memory probe fails', async () => {
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

    const [, opts] = (global.fetch as any).mock.calls[0];
    expect(JSON.parse(opts.body).capabilities).toEqual([]);
    expect(JSON.parse(opts.body).wasmMemoryBytes).toBe(0);
  });
});
