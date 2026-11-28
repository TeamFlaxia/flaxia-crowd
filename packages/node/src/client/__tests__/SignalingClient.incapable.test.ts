import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initFlaxiaNode } from '../SignalingClient';
import { __consentTestHooks } from '../../consent/storage';

// Simulates an INCAPABLE device: the memory probe reports it cannot commit the
// memory a multi-GB model needs, so the node must advertise empty capabilities.
vi.mock('../../executor/memoryProbe', () => ({
  HEAVY_WORKLOAD_WASM_MEMORY_BYTES: 2 * 1024 ** 3,
  probeMaxWasmMemoryBytes: () => 0,
  hasEnoughWasmMemoryForHeavy: () => false,
  getAdvertisedWasmMemoryBytes: () => 0,
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

/** Seed a valid, HMAC-sealed consent record (the legacy flag no longer counts). */
function seedGrantedConsent() {
  __consentTestHooks.seedGrantedConsent();
}

describe('SignalingClient (incapable device)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
    __consentTestHooks.reset();
    delete (window as any).__flaxia_node_init_started;
    delete (window as any).__flaxia_node_signal_client;
    delete (window as any).__flaxia_node_controller;
    delete (globalThis as any).Worker;
  });

  it('should send empty capabilities when the memory probe fails', async () => {
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

    const [, opts] = (global.fetch as any).mock.calls[0];
    expect(JSON.parse(opts.body).capabilities).toEqual([]);
    expect(JSON.parse(opts.body).expertCapabilities).toEqual([]);
    expect(JSON.parse(opts.body).wasmMemoryBytes).toBe(0);
  });

  it('does not advertise pinned experts on an incapable node', async () => {
    const original = process.env.THEIA_LORA_ADAPTERS;
    process.env.THEIA_LORA_ADAPTERS = JSON.stringify({
      code: { url: 'https://models.example/lora-code.bin', sha256: 'a'.repeat(64), maxBytes: 1024 },
    });
    try {
      globalThis.WebSocket = vi.fn() as any;
      mockFetchToken();
      seedGrantedConsent();

      initFlaxiaNode({
        orchestratorUrl: 'https://flaxia.app',
        siteId: 'test-site',
        consent: { brandName: 'Test', position: 'bottom-right' },
        capabilities: ['theia-inference'],
      });
      await flush();
      await flush();

      const [, opts] = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(opts.body);
      // The heavy workload is filtered out before expert capabilities are derived.
      expect(body.capabilities).toEqual([]);
      expect(body.expertCapabilities).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.THEIA_LORA_ADAPTERS;
      else process.env.THEIA_LORA_ADAPTERS = original;
    }
  });

  it('advertises light workloads even when the memory probe fails', async () => {
    globalThis.WebSocket = vi.fn() as any;
    mockFetchToken();
    seedGrantedConsent();

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
      capabilities: ['ai-inference', 'cc-extract'],
      ccRangeOrigins: ['https://flaxia.app'],
    });
    await flush();
    await flush();

    const [, opts] = (global.fetch as any).mock.calls[0];
    expect(JSON.parse(opts.body).capabilities).toEqual(['cc-extract']);
    expect(JSON.parse(opts.body).wasmMemoryBytes).toBe(0);
  });

  it('does not advertise cc-extract without an allowlisted range proxy', async () => {
    globalThis.WebSocket = vi.fn() as any;
    mockFetchToken();
    seedGrantedConsent();

    initFlaxiaNode({
      orchestratorUrl: 'https://flaxia.app',
      siteId: 'test-site',
      consent: { brandName: 'Test', position: 'bottom-right' },
      capabilities: ['cc-extract'],
    });
    await flush();
    await flush();

    const [, opts] = (global.fetch as any).mock.calls[0];
    expect(JSON.parse(opts.body).capabilities).toEqual([]);
  });
});
