import { type PluginOption } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Shared Vitest settings. `@manuling/source` makes workspace packages resolve to their
 * TypeScript sources, so tests never depend on a prior build.
 */
const conditions = ['@manuling/source', 'node', 'default'];

export function vitestConfig(
  options: { integration?: boolean; coverage?: boolean; plugins?: PluginOption[] } = {},
) {
  return defineConfig({
    plugins: options.plugins ?? [],
    resolve: { conditions },
    ssr: { resolve: { conditions } },
    test: options.integration
      ? // hookTimeout covers embedded Postgres start-up retries (3 × 20 s + cleanup).
        {
          include: ['test/**/*.int.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
          // Each file boots its own PostgreSQL; cap concurrent clusters on small machines/CI.
          maxWorkers: 2,
        }
      : {
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['test/**/*.int.test.ts', '**/node_modules/**'],
          ...(options.coverage
            ? {
                coverage: {
                  provider: 'v8' as const,
                  include: ['src/**'],
                  exclude: ['src/**/*.test.ts', 'src/index.ts'],
                  thresholds: { lines: 80, functions: 80 },
                },
              }
            : {}),
        },
  });
}
