import { describe, expect, it } from 'vitest';
import { orderPendingTasks, parseTenantSchedulingWeights } from '../queue-scheduler';

describe('pending task fairness', () => {
  it('ages a low-priority task ahead of fresh high-priority arrivals', () => {
    const now = 300_000;
    const result = orderPendingTasks([
      { id: 'old', tenantId: 'a', createdAt: 0, priority: 0 },
      { id: 'new', tenantId: 'b', createdAt: now, priority: 3 },
    ], now);
    expect(result.ordered.map((task) => task.id)).toEqual(['old', 'new']);
  });

  it('applies bounded tenant weights within a priority band and rotates the cursor', () => {
    const tasks = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, tenantId: 'a', createdAt: i, priority: 1 })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, tenantId: 'b', createdAt: i, priority: 1 })),
    ];
    const first = orderPendingTasks(tasks, 0, { a: 2 }, 'a');
    expect(first.ordered.slice(0, 3).map((task) => task.tenantId)).toEqual(['a', 'a', 'b']);
    expect(first.nextTenantCursor).toBe('b');
    const next = orderPendingTasks(tasks, 0, { a: 2 }, first.nextTenantCursor);
    expect(next.ordered[0].tenantId).toBe('b');
  });

  it('preserves tenant weights when only one node is free per scheduling pass', () => {
    let tasks = ['a', 'b'].flatMap((tenantId) => Array.from({ length: 6 }, (_, i) => ({
      id: `${tenantId}${i}`, tenantId, createdAt: 0, priority: 1,
    })));
    let cursor = 'a';
    let served = 0;
    const assigned: string[] = [];
    for (let pass = 0; pass < 6; pass++) {
      const order = orderPendingTasks(tasks, 0, { a: 2 }, cursor, served);
      const task = order.ordered[0];
      assigned.push(task.tenantId);
      ({ tenantId: cursor, served } = order.cursorAfter[task.id]);
      tasks = tasks.filter((pending) => pending.id !== task.id);
    }
    expect(assigned).toEqual(['a', 'a', 'b', 'a', 'a', 'b']);
  });

  it('ignores invalid weights and caps configuration to the bounded range', () => {
    expect(parseTenantSchedulingWeights('{"valid":2,"tooHigh":5,"bad":"2"}')).toEqual({ valid: 2 });
    expect(parseTenantSchedulingWeights('not-json')).toEqual({});
    expect(parseTenantSchedulingWeights('x'.repeat(16_385))).toEqual({});
  });
});
