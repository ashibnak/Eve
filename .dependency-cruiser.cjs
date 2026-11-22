/**
 * Module boundary rules (CLAUDE.md rules 2-3, ADR-001, ADR-004).
 * Paths are relative to the cruise base dir (repo root in CI, a fixture root in tests).
 * `$1`/`$2` in `to` refer to the capture groups of `from.path`.
 */
const PACK_MODULE = '^apps/api/src/packs/([^/]+)/([^/]+)/';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'platform-not-to-packs',
      comment: 'The platform knows no domain: platform/** must never import packs/** (ADR-001).',
      severity: 'error',
      from: { path: '^apps/api/src/platform/' },
      to: { path: '^apps/api/src/packs/' },
    },
    {
      name: 'pack-module-isolation',
      comment:
        'A pack module must not import another module. Cross-module access goes through ' +
        'a port in the consumer, implemented in adapters/ (ADR-004).',
      severity: 'error',
      from: { path: PACK_MODULE, pathNot: '^apps/api/src/packs/[^/]+/[^/]+/adapters/' },
      to: { path: '^apps/api/src/packs/[^/]+/[^/]+/', pathNot: '^apps/api/src/packs/$1/$2/' },
    },
    {
      name: 'adapters-only-public-service',
      comment:
        "An adapter may import another module only through that module's public service " +
        'entry point packs/<pack>/<slug>/service/index.ts.',
      severity: 'error',
      from: { path: '^apps/api/src/packs/([^/]+)/([^/]+)/adapters/' },
      to: {
        path: '^apps/api/src/packs/[^/]+/[^/]+/',
        pathNot: [
          '^apps/api/src/packs/$1/$2/',
          '^apps/api/src/packs/[^/]+/[^/]+/service/index\\.ts$',
        ],
      },
    },
    {
      name: 'packages-not-to-apps',
      comment: 'Shared packages (contracts, jurisdictions) must not depend on an app.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'web-not-to-api',
      comment: 'The web app talks to the API over HTTP only; share types via packages/contracts.',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^apps/api/' },
    },
    {
      name: 'api-not-to-web',
      severity: 'error',
      from: { path: '^apps/api/' },
      to: { path: '^apps/web/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['node_modules', '/dist/', 'src/generated/', '__fixtures__'] },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['eve-source', 'import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
