import { type OpenAPIRegistry, z } from '@manuling/http';

const healthResponse = z.object({
  status: z.literal('ok'),
  checks: z.record(z.string(), z.literal('ok')).optional(),
});

export function registerHealthPaths(registry: OpenAPIRegistry): void {
  const schema = registry.register('HealthResponse', healthResponse);
  registry.registerPath({
    method: 'get',
    path: '/health/live',
    tags: ['Operations'],
    summary: 'Liveness probe',
    responses: {
      200: { description: 'Process is alive', content: { 'application/json': { schema } } },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/health/ready',
    tags: ['Operations'],
    summary: 'Readiness probe (checks the database)',
    responses: {
      200: { description: 'Ready to serve traffic', content: { 'application/json': { schema } } },
      503: {
        description: 'A dependency is unavailable',
        content: {
          'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
        },
      },
    },
  });
}
