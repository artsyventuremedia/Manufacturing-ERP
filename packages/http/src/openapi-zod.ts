import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Zod 4 attaches methods per instance at construction, so the OpenAPI extension must run
// before any API schema is created. Every module that defines OpenAPI-registered schemas
// imports `z` from `@manuling/http`, never from 'zod' directly.
extendZodWithOpenApi(z);

export { z };
export { type OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
