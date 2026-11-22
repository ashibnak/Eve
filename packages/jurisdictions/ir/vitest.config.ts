import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: '@eve/jurisdiction-ir', include: ['src/**/*.test.ts'], passWithNoTests: true },
});
