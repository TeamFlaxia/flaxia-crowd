import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlaxiaClient } from '../client';
import type { TaskRecord, TaskPayload } from '../types';
import { TaskNotFoundError, FlaxiaError, AuthenticationError } from '../errors';

describe('FlaxiaClient', () => {
  const apiKey = 'fc_test_abc123';
  const baseUrl = 'https://api.flaxia.crowd';
  const client = new FlaxiaClient({ apiKey });

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  describe('constructor', () => {
    it('throws AuthenticationError if API key is empty', () => {
      expect(() => new FlaxiaClient({ apiKey: '' })).toThrow(AuthenticationError);
    });

    it('uses custom baseUrl when provided', () => {
      const c = new FlaxiaClient({ apiKey, baseUrl: 'http://localhost:8787' });
      expect((c as any).baseUrl).toBe('http://localhost:8787');
    });

    it('normalizes a /crowd-suffixed baseUrl', () => {
      const c = new FlaxiaClient({ apiKey, baseUrl: 'https://api.flaxia.crowd/crowd' });
      expect((c as any).baseUrl).toBe('https://api.flaxia.crowd');
    });

    it('normalizes trailing slashes', () => {
      const c = new FlaxiaClient({ apiKey, baseUrl: 'https://api.flaxia.crowd/' });
      expect((c as any).baseUrl).toBe('https://api.flaxia.crowd');
    });

    it('uses default baseUrl when not provided', () => {
      const c = new FlaxiaClient({ apiKey });
      expect((c as any).baseUrl).toBe('https://api.flaxia.crowd');
    });
  });

  describe('submit', () => {
    const mockTask: TaskRecord = {
      id: 'task_1',
      status: 'pending',
      workload: 'ai-inference',
      payload: { task: 'test', model: 'test', input: 'hi' },
      createdAt: Date.now(),
      retryCount: 0,
      timeoutMs: 30000,
    };

    it('submits a task successfully', async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockTask,
      });

      const result = await client.submit({
        workload: 'ai-inference',
        payload: { task: 'test', model: 'test', input: 'hi' },
      });

      expect(result).toEqual(mockTask);
      expect(fetch).toHaveBeenCalledWith(`${baseUrl}/crowd/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          workload: 'ai-inference',
          payload: { task: 'test', model: 'test', input: 'hi' },
        }),
      });
    });

    it('includes callbackUrl when provided', async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockTask,
      });

      await client.submit({
        workload: 'ai-inference',
        payload: { task: 'test', model: 'test', input: 'hi' },
        callbackUrl: 'https://example.com/callback',
      });

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body.callbackUrl).toBe('https://example.com/callback');
    });

    it('throws ValidationError for missing workload', async () => {
      await expect(client.submit({} as any)).rejects.toThrow('workload and payload are required');
    });

    it('throws ValidationError for missing payload', async () => {
      await expect(client.submit({ workload: 'ai-inference' } as any)).rejects.toThrow('workload and payload are required');
    });

    it('throws FlaxiaError on server error', async () => {
      (fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.submit({
        workload: 'ai-inference',
        payload: { task: 'test', model: 'test', input: 'hi' },
      })).rejects.toThrow(FlaxiaError);
    });

    it('throws FlaxiaError with SUBMIT_ERROR code on server error', async () => {
      (fetch as any).mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
      });

      try {
        await client.submit({
          workload: 'ai-inference',
          payload: { task: 'test', model: 'test', input: 'hi' },
        });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(FlaxiaError);
        expect((e as FlaxiaError).code).toBe('SUBMIT_ERROR');
        expect((e as FlaxiaError).status).toBe(400);
      }
    });
  });

  describe('getTask', () => {
    it('gets a task by id', async () => {
      const mockTask: TaskRecord = {
        id: 'task_1',
        status: 'done',
        workload: 'ai-inference',
        payload: {} as TaskPayload,
        createdAt: Date.now(),
        retryCount: 0,
        timeoutMs: 30000,
        result: { output: 'test' },
      };

      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockTask,
      });

      const result = await client.getTask('task_1');
      expect(result).toEqual(mockTask);
      expect(fetch).toHaveBeenCalledWith(`${baseUrl}/crowd/tasks/task_1`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
    });

    it('throws TaskNotFoundError for 404', async () => {
      (fetch as any).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(client.getTask('nonexistent')).rejects.toThrow(TaskNotFoundError);
    });

    it('throws FlaxiaError on other error status', async () => {
      (fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      try {
        await client.getTask('task_1');
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(FlaxiaError);
        expect((e as FlaxiaError).code).toBe('FETCH_ERROR');
        expect((e as FlaxiaError).status).toBe(500);
      }
    });
  });

  describe('subscribe', () => {
    class MockWebSocket {
      static instances: MockWebSocket[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;

      constructor(public url: string, public protocols?: string[]) {
        MockWebSocket.instances.push(this);
        queueMicrotask(() => this.onopen?.());
      }

      close() { this.closed = true; }
    }

    beforeEach(() => {
      MockWebSocket.instances = [];
      (globalThis as any).WebSocket = MockWebSocket;
    });

    it('uses the token from the submit response', async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          message: 'Task submitted', taskId: 'task_1', id: 'task_1', status: 'pending', createdAt: 1,
          subscribeToken: 'sub-token', subscribeTokenExpiresAt: Date.now() + 600000,
        }),
      });

      const submitted = await client.submit({
        workload: 'ai-inference',
        payload: { task: 'test', model: 'test', input: 'hi' },
      });
      expect(submitted.subscribeToken).toBe('sub-token');

      const subscription = await client.subscribe('task_1');
      const socket = MockWebSocket.instances[0];
      expect(socket.url).toBe(`${baseUrl.replace('https', 'wss')}/crowd/subscribe?taskId=task_1`);
      expect(socket.protocols).toEqual(['flaxia-subscribe-v1', 'bearer.sub-token']);
      subscription.close();
      expect(socket.closed).toBe(true);
      // No extra fetch: the token came from the submit response.
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('fetches a token with the API key when none is cached', async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'task_2', status: 'pending', workload: 'ai-inference', payload: {},
          createdAt: 1, retryCount: 0, timeoutMs: 1000, tenantId: 'tenant',
          subscribeToken: 'fresh-token', subscribeTokenExpiresAt: Date.now() + 600000,
        }),
      });

      await client.subscribe('task_2');
      expect(fetch).toHaveBeenCalledWith(`${baseUrl}/crowd/tasks/task_2`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(MockWebSocket.instances[0].protocols).toEqual(['flaxia-subscribe-v1', 'bearer.fresh-token']);
    });

    it('refuses to stream when the server issues no token', async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'task_3', status: 'pending', workload: 'ai-inference', payload: {},
          createdAt: 1, retryCount: 0, timeoutMs: 1000, tenantId: 'tenant',
        }),
      });

      await expect(client.subscribe('task_3')).rejects.toThrow(/subscribe token/i);
      expect(MockWebSocket.instances).toHaveLength(0);
    });

    it('accepts an explicitly supplied token', async () => {
      await client.subscribe('task_4', { subscribeToken: 'explicit' });
      expect(MockWebSocket.instances[0].protocols).toEqual(['flaxia-subscribe-v1', 'bearer.explicit']);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('waitForTask', () => {
    it('returns task when done', async () => {
      const mockTask: TaskRecord = {
        id: 'task_1',
        status: 'done',
        workload: 'ai-inference',
        payload: {} as TaskPayload,
        createdAt: Date.now(),
        retryCount: 0,
        timeoutMs: 30000,
        result: { output: 'result' },
      };

      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockTask,
      });

      const result = await client.waitForTask('task_1', 10, 5000);
      expect(result.status).toBe('done');
      expect(result.result).toEqual({ output: 'result' });
    });

    it('returns task when failed', async () => {
      const mockTask: TaskRecord = {
        id: 'task_1',
        status: 'failed',
        workload: 'ai-inference',
        payload: {} as TaskPayload,
        createdAt: Date.now(),
        retryCount: 3,
        timeoutMs: 30000,
        error: 'Max retries exceeded',
      };

      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockTask,
      });

      const result = await client.waitForTask('task_1', 10, 5000);
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Max retries exceeded');
    });

    it('polls multiple times until done', async () => {
      const pendingTask: TaskRecord = {
        id: 'task_1', status: 'pending', workload: 'ai-inference',
        payload: {} as TaskPayload, createdAt: Date.now(), retryCount: 0, timeoutMs: 30000,
      };
      const doneTask: TaskRecord = {
        id: 'task_1', status: 'done', workload: 'ai-inference',
        payload: {} as TaskPayload, createdAt: Date.now(), retryCount: 0, timeoutMs: 30000,
        result: { output: 'final' },
      };

      let callCount = 0;
      (fetch as any).mockImplementation(async () => ({
        ok: true,
        json: async () => {
          callCount++;
          return callCount === 1 ? pendingTask : doneTask;
        },
      }));

      const result = await client.waitForTask('task_1', 5, 5000);
      expect(result.status).toBe('done');
      expect(callCount).toBe(2);
    });

    it('throws FlaxiaError on polling timeout', async () => {
      const pendingTask: TaskRecord = {
        id: 'task_1', status: 'pending', workload: 'ai-inference',
        payload: {} as TaskPayload, createdAt: Date.now(), retryCount: 0, timeoutMs: 30000,
      };

      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => pendingTask,
      });

      await expect(client.waitForTask('task_1', 5, 50)).rejects.toThrow(FlaxiaError);
      await expect(client.waitForTask('task_1', 5, 50)).rejects.toThrow(/polling timed out/);
    });

    it('throws FlaxiaError with POLLING_TIMEOUT code on timeout', async () => {
      const pendingTask: TaskRecord = {
        id: 'task_1', status: 'pending', workload: 'ai-inference',
        payload: {} as TaskPayload, createdAt: Date.now(), retryCount: 0, timeoutMs: 30000,
      };

      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => pendingTask,
      });

      try {
        await client.waitForTask('task_1', 5, 50);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(FlaxiaError);
        expect((e as FlaxiaError).code).toBe('POLLING_TIMEOUT');
        expect((e as FlaxiaError).status).toBe(408);
      }
    });
  });
});
