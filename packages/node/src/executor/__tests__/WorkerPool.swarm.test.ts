/**
 * Regression test for swarm control-message routing, written from the
 * feature/swarm-inference quality review and kept after the fix landed.
 *
 * Do not weaken it to make the suite green — if it starts failing, the defect
 * it documents has come back.
 *
 *   M3  `sendControl` must post to the task the message names, never to
 *       whichever task happens to be running; a queued swarm session has to
 *       receive its control message when it starts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorkerPool } from '../WorkerPool';
import type { SwarmSliceMessage } from '@flaxia/sdk';

const sliceFor = (taskId: string): SwarmSliceMessage => ({
  type: 'swarm-slice',
  sessionId: `session-${taskId}`,
  taskId,
  model: 'qwen3.5-2b',
  timeoutMs: 60000,
  index: 1,
  chainLength: 2,
  role: 'worker',
  slice: { start: 6, end: 8, hasEmbed: false, hasHead: false },
});

describe('WorkerPool swarm control routing', () => {
  let pool: WorkerPool | undefined;

  afterEach(() => {
    pool?.terminate();
    pool = undefined;
    delete (globalThis as any).Worker;
  });

  it('M3: delivers a control message to the task it belongs to, not to the one running', async () => {
    let handler: Function;
    const posted: any[] = [];

    class MockWorker {
      postMessage = vi.fn((msg: any) => {
        posted.push(msg);
      });
      terminate = vi.fn();
      addEventListener = vi.fn((_event: string, h: Function) => {
        handler = h;
      });
      removeEventListener = vi.fn();
    }
    (globalThis as any).Worker = MockWorker as any;

    pool = new WorkerPool(undefined, 5000);

    // Task A occupies the single worker; task B (a swarm session) is queued.
    const runA = pool.run('A', 'ai-inference', {}, 5000).catch(() => undefined);
    const runB = pool.run('B', 'swarm-inference', sliceFor('B'), 5000).catch(() => undefined);

    // The signalling client learns about B's slice while A is still running.
    pool.sendControl(sliceFor('B'));

    // (1) It must not be handed to the worker under task A's id — today
    // `postToActive` stamps `this.active.id` on whatever it is given.
    expect(posted.filter((m) => m.type === 'swarm-control' && m.id === 'A')).toHaveLength(0);

    // (2) Once task B actually starts, the message must reach it.
    handler!({ data: { id: 'A', type: 'done', result: { output: 'ok' } } });
    await runA;
    await new Promise((r) => setTimeout(r, 20));

    expect(posted.some((m) => m.type === 'swarm-control' && m.id === 'B')).toBe(true);

    void runB;
  });
});
