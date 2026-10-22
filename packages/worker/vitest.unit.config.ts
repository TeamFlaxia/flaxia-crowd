import { defineConfig } from 'vitest/config';

/** Fast Node-only tests for pure worker helpers that do not need the Workers runtime. */
export default defineConfig({
  test: {
    include: ['src/worker/__tests__/peer-quality.test.ts', 'src/worker/__tests__/relay-budget.test.ts', 'src/worker/__tests__/mesh-planner.test.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
  },
});
