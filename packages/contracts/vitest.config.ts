import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: '@eve/contracts', include: ['src/**/*.test.ts'], passWithNoTests: true },
});
