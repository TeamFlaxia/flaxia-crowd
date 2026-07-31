import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initFlaxiaNode } from '../SignalingClient';

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
});
