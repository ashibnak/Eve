import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['eve-source'] },
  test: { name: '@eve/web', include: ['src/**/*.test.{ts,tsx}'], environment: 'node' },
});
