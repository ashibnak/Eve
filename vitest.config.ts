import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'apps/api/vitest.config.mts',
      'apps/api/vitest.int.config.mts',
      'apps/web',
      'packages/contracts',
      'packages/jurisdictions/*',
      'tools',
    ],
  },
});
