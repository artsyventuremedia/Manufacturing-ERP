import { type OpenAPIRegistry, z } from '@manuling/http';
import {
  type CompanyRecord,
  type FiscalYearRecord,
  type PlantRecord,
} from '../infrastructure/organisation.repository.js';

// ----- requests ------------------------------------------------------------------

export const idParam = z.uuid();

export const createCompanyBody = z
  .object({
    code: z.string().max(20),
    legalName: z.string().max(200),
    baseCurrency: z.string().length(3),
    countryCode: z.string().length(2),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
    ext: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const updateCompanyBody = z
  .object({
    legalName: z.string().max(200).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
    ext: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const createPlantBody = z
  .object({
    code: z.string().max(20),
    name: z.string().max(200),
    regionCode: z.string().max(6).optional(),
    timezone: z.string().max(64),
    ext: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const updatePlantBody = z
  .object({
    name: z.string().max(200).optional(),
    regionCode: z.string().max(6).nullable().optional(),
    timezone: z.string().max(64).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    ext: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const createFiscalYearBody = z.object({ startYear: z.number().int() }).strict();

// ----- responses -------------------------------------------------------------------

const timestamps = { createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() };

export const companyResponse = z.object({
  id: z.uuid(),
  code: z.string(),
  legalName: z.string(),
  baseCurrency: z.string(),
  countryCode: z.string(),
  fiscalYearStartMonth: z.number().int(),
  status: z.enum(['active', 'inactive']),
  version: z.number().int(),
  ext: z.record(z.string(), z.unknown()),
  ...timestamps,
});

export const plantResponse = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  code: z.string(),
  name: z.string(),
  regionCode: z.string().nullable(),
  timezone: z.string(),
  status: z.enum(['active', 'inactive']),
  version: z.number().int(),
  ext: z.record(z.string(), z.unknown()),
  ...timestamps,
});

export const fiscalYearResponse = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  code: z.string(),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  status: z.enum(['open', 'closed']),
  version: z.number().int(),
  ...timestamps,
});

export const meResponse = z.object({
  user: z.object({
    id: z.uuid(),
    email: z.string(),
    displayName: z.string(),
    locale: z.string(),
    timezone: z.string(),
  }),
  tenant: z.object({ id: z.uuid(), slug: z.string(), name: z.string(), edition: z.string() }),
  companyIds: z.array(z.uuid()),
  permissions: z.array(z.string()),
});

export type CompanyResponse = z.infer<typeof companyResponse>;
export type PlantResponse = z.infer<typeof plantResponse>;
export type FiscalYearResponse = z.infer<typeof fiscalYearResponse>;
export type MeResponse = z.infer<typeof meResponse>;

export function toCompanyResponse(c: CompanyRecord): CompanyResponse {
  return {
    id: c.id,
    code: c.code,
    legalName: c.legalName,
    baseCurrency: c.baseCurrency,
    countryCode: c.countryCode,
    fiscalYearStartMonth: c.fiscalYearStartMonth,
    status: c.status,
    version: c.version,
    ext: { ...c.ext },
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function toPlantResponse(p: PlantRecord): PlantResponse {
  return {
    id: p.id,
    companyId: p.companyId,
    code: p.code,
    name: p.name,
    regionCode: p.regionCode,
    timezone: p.timezone,
    status: p.status,
    version: p.version,
    ext: { ...p.ext },
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function toFiscalYearResponse(f: FiscalYearRecord): FiscalYearResponse {
  return {
    id: f.id,
    companyId: f.companyId,
    code: f.code,
    startDate: f.startDate.toString(),
    endDate: f.endDate.toString(),
    status: f.status,
    version: f.version,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

// ----- OpenAPI ---------------------------------------------------------------------

const problem = {
  'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
};
const errors = {
  400: { description: 'Workspace not specified', content: problem },
  401: { description: 'Missing or invalid access token', content: problem },
  403: { description: 'Not a member of the workspace, or not permitted', content: problem },
};

/** OpenAPI paths for identity and organisation structure (aggregated in ./openapi.ts). */
export function registerOrganisationOpenApi(registry: OpenAPIRegistry): void {
  registry.registerComponent('securitySchemes', 'bearer', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });
  const tenantHeader = registry.registerParameter(
    'TenantHeader',
    z.string().openapi({
      param: {
        name: 'X-Tenant',
        in: 'header',
        required: false,
        description: 'Workspace slug (or use its subdomain)',
      },
    }),
  );
  const ifMatch = z
    .string()
    .openapi({ param: { name: 'If-Match', in: 'header', required: true }, example: '"v3"' });
  const idempotencyKey = z
    .string()
    .optional()
    .openapi({ param: { name: 'Idempotency-Key', in: 'header', required: false } });
  const Company = registry.register('Company', companyResponse);
  const Plant = registry.register('Plant', plantResponse);
  const FiscalYear = registry.register('FiscalYear', fiscalYearResponse);
  const Me = registry.register('Me', meResponse);
  const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
  const security = [{ bearer: [] }];
  const id = z.object({ id: idParam });
  const companyId = z.object({ companyId: idParam });
  const tags = ['Platform'];

  registry.registerPath({
    method: 'get',
    path: '/v1/platform/me',
    tags,
    security,
    summary: 'Current user and workspace',
    request: { headers: [tenantHeader] },
    responses: { 200: { description: 'OK', content: json(Me) }, ...errors },
  });
  registry.registerPath({
    method: 'get',
    path: '/v1/platform/companies',
    tags,
    security,
    summary: 'List companies',
    request: {
      headers: [tenantHeader],
      query: z.object({ limit: z.number().int().optional(), cursor: z.string().optional() }),
    },
    responses: {
      200: {
        description: 'OK',
        content: json(z.object({ items: z.array(Company), nextCursor: z.string().optional() })),
      },
      ...errors,
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/v1/platform/companies',
    tags,
    security,
    summary: 'Create a company (admin)',
    request: {
      headers: z.object({ 'Idempotency-Key': idempotencyKey }),
      body: { content: json(createCompanyBody) },
    },
    responses: {
      201: { description: 'Created', content: json(Company) },
      409: { description: 'Duplicate code', content: problem },
      422: { description: 'Invalid', content: problem },
      ...errors,
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/v1/platform/companies/{id}',
    tags,
    security,
    summary: 'Get a company',
    request: { params: id },
    responses: {
      200: { description: 'OK (ETag header carries the version)', content: json(Company) },
      404: { description: 'Not found', content: problem },
      ...errors,
    },
  });
  registry.registerPath({
    method: 'patch',
    path: '/v1/platform/companies/{id}',
    tags,
    security,
    summary: 'Update a company (admin)',
    request: {
      params: id,
      headers: z.object({ 'If-Match': ifMatch }),
      body: { content: json(updateCompanyBody) },
    },
    responses: {
      200: { description: 'OK', content: json(Company) },
      412: { description: 'Stale If-Match', content: problem },
      428: { description: 'If-Match required', content: problem },
      ...errors,
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/v1/platform/companies/{companyId}/plants',
    tags,
    security,
    summary: 'List plants of a company',
    request: { params: companyId },
    responses: {
      200: { description: 'OK', content: json(z.object({ items: z.array(Plant) })) },
      ...errors,
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/v1/platform/companies/{companyId}/plants',
    tags,
    security,
    summary: 'Create a plant (admin)',
    request: { params: companyId, body: { content: json(createPlantBody) } },
    responses: { 201: { description: 'Created', content: json(Plant) }, ...errors },
  });
  registry.registerPath({
    method: 'get',
    path: '/v1/platform/plants/{id}',
    tags,
    security,
    summary: 'Get a plant',
    request: { params: id },
    responses: { 200: { description: 'OK', content: json(Plant) }, ...errors },
  });
  registry.registerPath({
    method: 'patch',
    path: '/v1/platform/plants/{id}',
    tags,
    security,
    summary: 'Update a plant (admin)',
    request: {
      params: id,
      headers: z.object({ 'If-Match': ifMatch }),
      body: { content: json(updatePlantBody) },
    },
    responses: { 200: { description: 'OK', content: json(Plant) }, ...errors },
  });
  registry.registerPath({
    method: 'get',
    path: '/v1/platform/companies/{companyId}/fiscal-years',
    tags,
    security,
    summary: 'List fiscal years',
    request: { params: companyId },
    responses: {
      200: { description: 'OK', content: json(z.object({ items: z.array(FiscalYear) })) },
      ...errors,
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/v1/platform/companies/{companyId}/fiscal-years',
    tags,
    security,
    summary: 'Open a fiscal year (admin)',
    request: { params: companyId, body: { content: json(createFiscalYearBody) } },
    responses: {
      201: { description: 'Created', content: json(FiscalYear) },
      422: { description: 'Overlaps an existing year', content: problem },
      ...errors,
    },
  });
}
