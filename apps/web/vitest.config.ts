import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their TypeScript sources (`eve-source`), also for node-environment
// (SSR) resolution, so unit tests never depend on a prior build (as in CI).
export default defineConfig({
  resolve: { conditions: ['eve-source'] },
  ssr: { resolve: { conditions: ['eve-source'], externalConditions: ['eve-source'] } },
  test: {
    name: '@eve/web',
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    server: { deps: { inline: [/@eve\//] } },
  },
});
