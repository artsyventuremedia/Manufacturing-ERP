import { RequirePermission } from '@manuling/authz';
import { type OpenAPIRegistry, ZodPipe, formatEtag, parseIfMatch, z } from '@manuling/http';
import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { NumberingService } from '../application/numbering.service.js';
import { PLATFORM_PERMISSIONS as P } from '../authorisation/permissions.js';
import { type NumberingSeries } from '../domain/numbering.js';
import { idParam } from './dto.js';

const idPipe = new ZodPipe(idParam);

export const createSeriesBody = z
  .object({
    code: z.string().max(20),
    docType: z.string().max(80),
    pattern: z.string().max(100),
    gapless: z.boolean(),
    scope: z.enum(['company', 'plant']),
    resetPolicy: z.enum(['fiscal_year', 'never']),
    startValue: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(3).max(100).optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const updateSeriesBody = z
  .object({
    pattern: z.string().max(100).optional(),
    maxLength: z.number().int().min(3).max(100).nullable().optional(),
    isDefault: z.boolean().optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict();

export const previewBody = z
  .object({ documentDate: z.iso.date(), plantId: z.uuid().optional() })
  .strict();

export const seriesResponse = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  code: z.string(),
  docType: z.string(),
  pattern: z.string(),
  gapless: z.boolean(),
  scope: z.enum(['company', 'plant']),
  resetPolicy: z.enum(['fiscal_year', 'never']),
  startValue: z.number().int(),
  maxLength: z.number().int().nullable(),
  isDefault: z.boolean(),
  status: z.enum(['active', 'inactive']),
  version: z.number().int(),
});

type SeriesResponse = z.infer<typeof seriesResponse>;
const toResponse = (s: NumberingSeries): SeriesResponse => ({ ...s });

/** Document numbering series administration (step 0.7). */
@Controller('v1/platform')
export class NumberingController {
  constructor(private readonly numbering: NumberingService) {}

  @Get('companies/:companyId/numbering-series')
  @RequirePermission(P.numberingRead)
  async list(@Param('companyId', idPipe) companyId: string): Promise<{ items: SeriesResponse[] }> {
    return { items: (await this.numbering.listSeries(companyId)).map(toResponse) };
  }

  @Post('companies/:companyId/numbering-series')
  @RequirePermission(P.numberingManage)
  async create(
    @Param('companyId', idPipe) companyId: string,
    @Body(new ZodPipe(createSeriesBody)) body: z.output<typeof createSeriesBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SeriesResponse> {
    const series = await this.numbering.createSeries(companyId, body);
    void reply.header('etag', formatEtag(series.version));
    return toResponse(series);
  }

  @Patch('numbering-series/:id')
  @RequirePermission(P.numberingManage)
  async update(
    @Param('id', idPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateSeriesBody)) body: z.output<typeof updateSeriesBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SeriesResponse> {
    const series = await this.numbering.updateSeries(id, parseIfMatch(ifMatch), body);
    void reply.header('etag', formatEtag(series.version));
    return toResponse(series);
  }

  @Post('numbering-series/:id/preview')
  @HttpCode(200)
  @RequirePermission(P.numberingRead)
  preview(
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(previewBody)) body: z.output<typeof previewBody>,
  ): Promise<{ number: string; sequence: string }> {
    return this.numbering.preview(id, body.documentDate, body.plantId);
  }
}

export function registerNumberingOpenApi(registry: OpenAPIRegistry): void {
  const Series = registry.register('NumberingSeries', seriesResponse);
  const problem = {
    'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
  };
  const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
  const security = [{ bearer: [] }];
  const tags = ['Numbering'];
  const companyId = z.object({ companyId: z.uuid() });
  const id = z.object({ id: z.uuid() });
  registry.registerPath({
    method: 'get',
    path: '/v1/platform/companies/{companyId}/numbering-series',
    tags,
    security,
    summary: 'List numbering series of a company',
    request: { params: companyId },
    responses: { 200: { description: 'OK', content: json(z.object({ items: z.array(Series) })) } },
  });
  registry.registerPath({
    method: 'post',
    path: '/v1/platform/companies/{companyId}/numbering-series',
    tags,
    security,
    summary: 'Create a numbering series',
    request: { params: companyId, body: { content: json(createSeriesBody) } },
    responses: {
      201: { description: 'Created', content: json(Series) },
      422: { description: 'Invalid pattern or coherence rule', content: problem },
    },
  });
  registry.registerPath({
    method: 'patch',
    path: '/v1/platform/numbering-series/{id}',
    tags,
    security,
    summary: 'Change a series (format locked once numbers were issued)',
    request: {
      params: id,
      headers: z.object({ 'If-Match': z.string() }),
      body: { content: json(updateSeriesBody) },
    },
    responses: { 200: { description: 'OK', content: json(Series) } },
  });
  registry.registerPath({
    method: 'post',
    path: '/v1/platform/numbering-series/{id}/preview',
    tags,
    security,
    summary: 'Preview the next number without allocating it',
    request: { params: id, body: { content: json(previewBody) } },
    responses: {
      200: {
        description: 'OK',
        content: json(z.object({ number: z.string(), sequence: z.string() })),
      },
    },
  });
}
