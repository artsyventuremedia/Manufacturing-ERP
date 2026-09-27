import { RequirePermission } from '@manuling/authz';
import {
  type OpenAPIRegistry,
  ZodPipe,
  decodeCursor,
  encodeCursor,
  formatEtag,
  pageQuerySchema,
  parseIfMatch,
  z,
} from '@manuling/http';
import { RequestContexts } from '@manuling/kernel';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CustomRecordService, type RecordView } from '../application/custom-record.service.js';
import { CustomisationService } from '../application/customisation.service.js';
import { PLATFORM_PERMISSIONS as P } from '../authorisation/permissions.js';
import { FIELD_TYPES, type FieldDef } from '../domain/custom-fields.js';
import { type ObjectDef } from '../infrastructure/customisation.repository.js';
import { idParam } from './dto.js';

const idPipe = new ZodPipe(idParam);
const i18n = z.record(z.string(), z.string().max(200));
const objectName = z.string().regex(/^[a-z][a-z0-9_]{2,39}$/);
const entityName = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);

export const createFieldBody = z
  .object({
    entity: entityName,
    apiName: z.string().max(40),
    dataType: z.enum(FIELD_TYPES),
    label: i18n,
    help: i18n.optional(),
    required: z.boolean().optional(),
    defaultValue: z.unknown().optional(),
    options: z
      .array(z.object({ value: z.string(), label: i18n }))
      .max(200)
      .optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export const updateFieldBody = z
  .object({
    label: i18n.optional(),
    help: i18n.nullable().optional(),
    required: z.boolean().optional(),
    defaultValue: z.unknown().optional(),
    options: z
      .array(z.object({ value: z.string(), label: i18n }))
      .max(200)
      .optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict();

export const createObjectBody = z
  .object({
    apiName: objectName,
    label: i18n,
    pluralLabel: i18n,
    description: z.string().max(1000).optional(),
    companyScoped: z.boolean().optional(),
  })
  .strict();

export const updateObjectBody = z
  .object({
    label: i18n.optional(),
    pluralLabel: i18n.optional(),
    description: z.string().max(1000).nullable().optional(),
    titleField: z.string().max(40).nullable().optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict();

export const createRecordBody = z
  .object({ companyId: z.uuid().nullable().optional(), data: z.record(z.string(), z.unknown()) })
  .strict();
export const updateRecordBody = z.object({ data: z.record(z.string(), z.unknown()) }).strict();
export const layoutBody = z.object({ layout: z.record(z.string(), z.unknown()) }).strict();

const fieldOut = (f: FieldDef) => ({ ...f });
const objectOut = (o: ObjectDef) => ({ ...o });
const recordOut = (r: RecordView) => ({
  id: r.id,
  object: r.objectApiName,
  companyId: r.companyId,
  data: r.data,
  status: r.status,
  version: r.version,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/** Custom fields, custom objects, their records, and UI layouts (step 0.9). */
@Controller('v1/platform')
export class CustomisationController {
  constructor(
    private readonly customisation: CustomisationService,
    private readonly records: CustomRecordService,
  ) {}

  // ----- definitions ---------------------------------------------------------------------

  @Get('custom-fields')
  @RequirePermission(P.roleRead)
  async fields(@Query('entity', new ZodPipe(entityName)) entity: string) {
    return { items: (await this.customisation.listFields(entity)).map(fieldOut) };
  }

  @Post('custom-fields')
  @RequirePermission(P.customizationManage)
  async createField(@Body(new ZodPipe(createFieldBody)) body: z.output<typeof createFieldBody>) {
    return fieldOut(await this.customisation.createField(body));
  }

  @Patch('custom-fields/:id')
  @RequirePermission(P.customizationManage)
  async updateField(
    @Param('id', idPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateFieldBody)) body: z.output<typeof updateFieldBody>,
  ) {
    return fieldOut(await this.customisation.updateField(id, parseIfMatch(ifMatch), body));
  }

  @Get('custom-objects')
  @RequirePermission(P.customRecordRead)
  async objects() {
    return { items: (await this.customisation.listObjects()).map(objectOut) };
  }

  @Post('custom-objects')
  @RequirePermission(P.customizationManage)
  async createObject(@Body(new ZodPipe(createObjectBody)) body: z.output<typeof createObjectBody>) {
    return objectOut(await this.customisation.createObject(body));
  }

  @Patch('custom-objects/:id')
  @RequirePermission(P.customizationManage)
  async updateObject(
    @Param('id', idPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateObjectBody)) body: z.output<typeof updateObjectBody>,
  ) {
    return objectOut(await this.customisation.updateObject(id, parseIfMatch(ifMatch), body));
  }

  // ----- records ---------------------------------------------------------------------------

  @Get('custom-objects/:apiName/records')
  @RequirePermission(P.customRecordRead)
  async list(
    @Param('apiName', new ZodPipe(objectName)) apiName: string,
    @Query(new ZodPipe(pageQuerySchema)) page: z.output<typeof pageQuerySchema>,
    @Query() raw: Record<string, unknown>,
  ) {
    const after = page.cursor ? (decodeCursor(page.cursor, 2) as [string, string]) : undefined;
    const rows = await this.records.list(apiName, raw, page.limit, after);
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    return {
      items: items.map(recordOut),
      ...(rows.length > page.limit && last
        ? { nextCursor: encodeCursor([last.createdAt.toISOString(), last.id]) }
        : {}),
    };
  }

  @Get('custom-objects/:apiName/records/export.csv')
  @RequirePermission(P.customRecordRead)
  async export(
    @Param('apiName', new ZodPipe(objectName)) apiName: string,
    @Query() raw: Record<string, unknown>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const { filename, csv, truncated } = await this.records.export(apiName, raw);
    void reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('x-export-truncated', String(truncated))
      .header('content-language', RequestContexts.requireTenant().locale);
    return csv;
  }

  @Post('custom-objects/:apiName/records')
  @RequirePermission(P.customRecordWrite)
  async create(
    @Param('apiName', new ZodPipe(objectName)) apiName: string,
    @Body(new ZodPipe(createRecordBody)) body: z.output<typeof createRecordBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const record = await this.records.create(apiName, body);
    void reply.header('etag', formatEtag(record.version));
    return recordOut(record);
  }

  @Get('custom-objects/:apiName/records/:id')
  @RequirePermission(P.customRecordRead)
  async get(
    @Param('apiName', new ZodPipe(objectName)) apiName: string,
    @Param('id', idPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const record = await this.records.get(apiName, id);
    void reply.header('etag', formatEtag(record.version));
    return recordOut(record);
  }

  @Patch('custom-objects/:apiName/records/:id')
  @RequirePermission(P.customRecordWrite)
  async update(
    @Param('apiName', new ZodPipe(objectName)) apiName: string,
    @Param('id', idPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateRecordBody)) body: z.output<typeof updateRecordBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const record = await this.records.update(apiName, id, parseIfMatch(ifMatch), body);
    void reply.header('etag', formatEtag(record.version));
    return recordOut(record);
  }

  @Post('custom-objects/:apiName/records/:id/archive')
  @HttpCode(200)
  @RequirePermission(P.customRecordWrite)
  async archive(
    @Param('apiName', new ZodPipe(objectName)) apiName: string,
    @Param('id', idPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    return recordOut(await this.records.archive(apiName, id, parseIfMatch(ifMatch)));
  }

  // ----- layouts -----------------------------------------------------------------------------

  @Get('layouts/:entity/:kind')
  @RequirePermission(P.roleRead)
  async layout(
    @Param('entity', new ZodPipe(entityName)) entity: string,
    @Param('kind', new ZodPipe(z.enum(['form', 'list']))) kind: 'form' | 'list',
  ) {
    return { layout: (await this.customisation.getLayout(entity, kind))?.layout ?? null };
  }

  @Put('layouts/:entity/:kind')
  @RequirePermission(P.customizationManage)
  async saveLayout(
    @Param('entity', new ZodPipe(entityName)) entity: string,
    @Param('kind', new ZodPipe(z.enum(['form', 'list']))) kind: 'form' | 'list',
    @Body(new ZodPipe(layoutBody)) body: z.output<typeof layoutBody>,
  ) {
    const saved = await this.customisation.saveLayout(entity, kind, body.layout);
    return { layout: saved.layout, version: saved.version };
  }
}

export function registerCustomisationOpenApi(registry: OpenAPIRegistry): void {
  const security = [{ bearer: [] }];
  const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
  const tags = ['Customisation'];
  const id = z.object({ id: z.uuid() });
  const obj = z.object({ apiName: objectName });
  const objId = z.object({ apiName: objectName, id: z.uuid() });
  const layoutParams = z.object({ entity: entityName, kind: z.enum(['form', 'list']) });
  const path = (
    method: 'get' | 'post' | 'patch' | 'put',
    p: string,
    summary: string,
    request: Record<string, unknown> = {},
  ) =>
    registry.registerPath({
      method,
      path: p,
      tags,
      security,
      summary,
      request,
      responses: { 200: { description: 'OK' } },
    });
  path('get', '/v1/platform/custom-fields', 'Custom fields of an entity', {
    query: z.object({ entity: entityName }),
  });
  path('post', '/v1/platform/custom-fields', 'Define a custom field', {
    body: { content: json(createFieldBody) },
  });
  path('patch', '/v1/platform/custom-fields/{id}', 'Change or archive a custom field', {
    params: id,
    body: { content: json(updateFieldBody) },
  });
  path('get', '/v1/platform/custom-objects', 'Custom objects');
  path('post', '/v1/platform/custom-objects', 'Define a custom object', {
    body: { content: json(createObjectBody) },
  });
  path('patch', '/v1/platform/custom-objects/{id}', 'Change a custom object', {
    params: id,
    body: { content: json(updateObjectBody) },
  });
  path(
    'get',
    '/v1/platform/custom-objects/{apiName}/records',
    'List records (filters: data.<field>=v, data.<field>[gte]=v)',
    { params: obj },
  );
  path('post', '/v1/platform/custom-objects/{apiName}/records', 'Create a record', {
    params: obj,
    body: { content: json(createRecordBody) },
  });
  path('get', '/v1/platform/custom-objects/{apiName}/records/export.csv', 'Export records as CSV', {
    params: obj,
  });
  path('get', '/v1/platform/custom-objects/{apiName}/records/{id}', 'Get a record', {
    params: objId,
  });
  path(
    'patch',
    '/v1/platform/custom-objects/{apiName}/records/{id}',
    'Update a record (merge; null clears)',
    {
      params: objId,
      body: { content: json(updateRecordBody) },
    },
  );
  path('post', '/v1/platform/custom-objects/{apiName}/records/{id}/archive', 'Archive a record', {
    params: objId,
  });
  path('get', '/v1/platform/layouts/{entity}/{kind}', 'Form or list layout', {
    params: layoutParams,
  });
  path('put', '/v1/platform/layouts/{entity}/{kind}', 'Save a form or list layout', {
    params: layoutParams,
    body: { content: json(layoutBody) },
  });
}
