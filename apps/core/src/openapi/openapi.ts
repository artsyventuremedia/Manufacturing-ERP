import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { registerHealthPaths } from '../health/health.openapi.js';
import { z } from '@manuling/http';
import { registerPlatformOpenApi } from '@manuling/platform/module';

/** RFC 9457 problem details as returned by every endpoint on error. */
const problemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  errors: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })).optional(),
  correlationId: z.string().optional(),
});

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

/**
 * Each module contributes its paths through a register function; the generated document is
 * the API contract (OpenAPI 3.1) served at /openapi.json and exported by `pnpm openapi`.
 */
const contributors: ReadonlyArray<(registry: OpenAPIRegistry) => void> = [
  registerHealthPaths,
  registerPlatformOpenApi,
];

export function buildOpenApiDocument(version: string): OpenApiDocument {
  const registry = new OpenAPIRegistry();
  registry.register('ProblemDetails', problemDetails);
  for (const contribute of contributors) contribute(registry);
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Manuling Core API',
      version,
      description:
        'Manuling AI-native manufacturing ERP. Errors use RFC 9457 application/problem+json.',
    },
    servers: [{ url: '/' }],
  });
}
