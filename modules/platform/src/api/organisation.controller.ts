import { AccessControl, RequirePermission } from '@manuling/authz';
import {
  type Page,
  ZodPipe,
  decodeCursor,
  formatEtag,
  pageQuerySchema,
  parseIfMatch,
  toPage,
} from '@manuling/http';
import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type z } from 'zod';
import { OrganisationService } from '../application/organisation.service.js';
import { PLATFORM_PERMISSIONS as P } from '../authorisation/permissions.js';
import {
  type CompanyResponse,
  type FiscalYearResponse,
  type PlantResponse,
  createCompanyBody,
  createFiscalYearBody,
  createPlantBody,
  idParam,
  toCompanyResponse,
  toFiscalYearResponse,
  toPlantResponse,
  updateCompanyBody,
  updatePlantBody,
} from './dto.js';

const idPipe = new ZodPipe(idParam);

/** Field-policy entity names (platform.field_policy.entity). */
const COMPANY = 'platform.company';
const PLANT = 'platform.plant';

/** Response mappers that drop fields hidden by the caller's field policies. */
const companyOut = (r: Parameters<typeof toCompanyResponse>[0]): Partial<CompanyResponse> =>
  AccessControl.redact(COMPANY, toCompanyResponse(r));
const plantOut = (r: Parameters<typeof toPlantResponse>[0]): Partial<PlantResponse> =>
  AccessControl.redact(PLANT, toPlantResponse(r));

/** Organisation structure: companies, plants, fiscal years (docs/api/openapi.json). */
@Controller('v1/platform')
export class OrganisationController {
  constructor(private readonly service: OrganisationService) {}

  // ----- companies ---------------------------------------------------------------

  @Get('companies')
  @RequirePermission(P.companyRead)
  async listCompanies(
    @Query(new ZodPipe(pageQuerySchema)) query: z.output<typeof pageQuerySchema>,
  ): Promise<Page<Partial<CompanyResponse>>> {
    const after = query.cursor ? (decodeCursor(query.cursor, 2) as [string, string]) : undefined;
    const rows = await this.service.listCompanies(query.limit, after);
    const page = toPage(rows, query.limit, (c) => [c.code, c.id]);
    return { ...page, items: page.items.map(companyOut) };
  }

  @Post('companies')
  @RequirePermission(P.companyCreate)
  async createCompany(
    @Body(new ZodPipe(createCompanyBody)) body: z.output<typeof createCompanyBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Partial<CompanyResponse>> {
    const record = await this.service.createCompany(body);
    void reply
      .header('etag', formatEtag(record.version))
      .header('location', `/v1/platform/companies/${record.id}`);
    return companyOut(record);
  }

  @Get('companies/:id')
  @RequirePermission(P.companyRead)
  async getCompany(
    @Param('id', idPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Partial<CompanyResponse>> {
    const record = await this.service.getCompany(id);
    void reply.header('etag', formatEtag(record.version));
    return companyOut(record);
  }

  @Patch('companies/:id')
  @RequirePermission(P.companyUpdate)
  async updateCompany(
    @Param('id', idPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateCompanyBody)) body: z.output<typeof updateCompanyBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Partial<CompanyResponse>> {
    AccessControl.assertWritable(COMPANY, body);
    const record = await this.service.updateCompany(id, parseIfMatch(ifMatch), body);
    void reply.header('etag', formatEtag(record.version));
    return companyOut(record);
  }

  // ----- plants ----------------------------------------------------------------------

  @Get('companies/:companyId/plants')
  @RequirePermission(P.plantRead)
  async listPlants(
    @Param('companyId', idPipe) companyId: string,
  ): Promise<{ items: Partial<PlantResponse>[] }> {
    return { items: (await this.service.listPlants(companyId)).map(plantOut) };
  }

  @Post('companies/:companyId/plants')
  @RequirePermission(P.plantCreate)
  async createPlant(
    @Param('companyId', idPipe) companyId: string,
    @Body(new ZodPipe(createPlantBody)) body: z.output<typeof createPlantBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Partial<PlantResponse>> {
    const record = await this.service.createPlant(companyId, body);
    void reply
      .header('etag', formatEtag(record.version))
      .header('location', `/v1/platform/plants/${record.id}`);
    return plantOut(record);
  }

  @Get('plants/:id')
  @RequirePermission(P.plantRead)
  async getPlant(
    @Param('id', idPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Partial<PlantResponse>> {
    const record = await this.service.getPlant(id);
    void reply.header('etag', formatEtag(record.version));
    return plantOut(record);
  }

  @Patch('plants/:id')
  @RequirePermission(P.plantUpdate)
  async updatePlant(
    @Param('id', idPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updatePlantBody)) body: z.output<typeof updatePlantBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Partial<PlantResponse>> {
    AccessControl.assertWritable(PLANT, body);
    const record = await this.service.updatePlant(id, parseIfMatch(ifMatch), body);
    void reply.header('etag', formatEtag(record.version));
    return plantOut(record);
  }

  // ----- fiscal years ------------------------------------------------------------------

  @Get('companies/:companyId/fiscal-years')
  @RequirePermission(P.fiscalYearRead)
  async listFiscalYears(
    @Param('companyId', idPipe) companyId: string,
  ): Promise<{ items: FiscalYearResponse[] }> {
    return { items: (await this.service.listFiscalYears(companyId)).map(toFiscalYearResponse) };
  }

  @Post('companies/:companyId/fiscal-years')
  @RequirePermission(P.fiscalYearCreate)
  async createFiscalYear(
    @Param('companyId', idPipe) companyId: string,
    @Body(new ZodPipe(createFiscalYearBody)) body: z.output<typeof createFiscalYearBody>,
  ): Promise<FiscalYearResponse> {
    return toFiscalYearResponse(await this.service.createFiscalYear(companyId, body.startYear));
  }
}
