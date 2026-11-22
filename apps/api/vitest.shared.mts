import swc from 'unplugin-swc';
import type { ViteUserConfig } from 'vitest/config';

/**
 * Shared by the unit and integration configs. SWC instead of esbuild: Nest DI needs
 * emitDecoratorMetadata. Workspace packages are inlined and resolved to their TypeScript
 * sources (`eve-source` condition), so tests never depend on a prior build.
 */
export const shared: ViteUserConfig = {
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: { conditions: ['eve-source'] },
  ssr: { resolve: { conditions: ['eve-source'], externalConditions: ['eve-source'] } },
};

export const inlineWorkspace = { server: { deps: { inline: [/@eve\//] } } };
