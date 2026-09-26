/**
 * Module boundary rules (ADR-0002, docs/architecture/04-monorepo-and-scaffolding.md).
 * CI fails on any violation.
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-module-internals',
      comment:
        'A module may use another module only through its public contracts (modules/<m>/src/contracts).',
      severity: 'error',
      from: { path: '^modules/([^/]+)/' },
      to: {
        path: '^modules/([^/]+)/',
        pathNot: ['^modules/$1/', '^modules/[^/]+/src/contracts/'],
      },
    },
    {
      name: 'domain-is-pure',
      comment:
        'domain/ may import only @manuling/kernel, the framework-free @manuling/authz/core and its own domain code.',
      severity: 'error',
      from: { path: '^modules/([^/]+)/src/domain/' },
      to: {
        pathNot: [
          '^modules/$1/src/domain/',
          '^packages/kernel/',
          '^packages/authz/src/core/',
          'node_modules/decimal\\.js',
        ],
      },
    },
    {
      name: 'packages-never-import-modules',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^(modules|apps|localisation)/' },
    },
    {
      name: 'authz-core-is-framework-free',
      severity: 'error',
      from: { path: '^packages/authz/src/core/' },
      to: { path: '(^packages/authz/src/nest/|node_modules/@nestjs/)' },
    },
    {
      name: 'kernel-has-no-internal-deps',
      severity: 'error',
      from: { path: '^packages/kernel/' },
      to: { path: '^(packages/(?!kernel/)|modules/|apps/|localisation/)' },
    },
    {
      name: 'core-modules-do-not-import-country-packs',
      comment: 'Core stays tax-agnostic; packs are reached via the localisation SPI (ADR-0011).',
      severity: 'error',
      from: { path: '^modules/' },
      to: { path: '^localisation/(?!core/)' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage|node_modules)/' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['@manuling/source', 'import', 'require', 'node', 'default'],
    },
  },
};
