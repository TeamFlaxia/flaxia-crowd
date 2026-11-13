import { beforeEach, describe, expect, it, vi } from 'vitest';

const close = vi.hoisted(() => vi.fn());
const instances: object[] = vi.hoisted(() => []);

vi.mock('../VectorStoreEngine', () => {
  class MockVectorStoreEngine {
    initialize = vi.fn().mockResolvedValue(undefined);
    close = close;
    constructor() {
      instances.push(this);
    }
  }
  return { VectorStoreEngine: MockVectorStoreEngine };
});

import { getVectorEngine, releaseVectorEngine } from '../sharedEngine';

beforeEach(() => {
  releaseVectorEngine();
  close.mockClear();
  instances.length = 0;
});

describe('shared vector engine', () => {
  it('shares one engine between vector-store and vector-query', async () => {
    const first = await getVectorEngine();
    const second = await getVectorEngine();

    expect(first).toBe(second);
    expect(instances).toHaveLength(1);
  });

  it('closes the shared engine on release', async () => {
    const engine = await getVectorEngine();

    releaseVectorEngine();

    expect(engine.close).toHaveBeenCalledTimes(1);
  });
});
