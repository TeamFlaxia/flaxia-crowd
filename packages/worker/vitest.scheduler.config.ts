import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/worker/__tests__/scheduler.test.ts'],
  },
});
