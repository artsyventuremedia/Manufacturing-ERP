import { Public } from '@manuling/http';
import { Controller, Get, Header } from '@nestjs/common';
import { type OpenApiDocument, buildOpenApiDocument } from './openapi.js';

@Public()
@Controller()
export class OpenApiController {
  private readonly document: OpenApiDocument = buildOpenApiDocument(
    process.env['npm_package_version'] ?? '0.0.0',
  );

  @Get('openapi.json')
  @Header('cache-control', 'public, max-age=300')
  get(): OpenApiDocument {
    return this.document;
  }
}
