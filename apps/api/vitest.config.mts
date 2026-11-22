import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC instead of esbuild: Nest DI needs emitDecoratorMetadata.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: { conditions: ['eve-source'] },
  test: {
    name: '@eve/api',
    include: ['src/**/*.test.ts'],
    root: import.meta.dirname,
  },
});
