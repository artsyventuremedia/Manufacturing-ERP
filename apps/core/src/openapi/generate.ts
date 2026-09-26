import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from './openapi.js';

/** Writes the contract to docs/api/openapi.json so API changes are reviewed in PR diffs. */
const target = fileURLToPath(new URL('../../../../docs/api/openapi.json', import.meta.url));
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(buildOpenApiDocument('0.0.0'), null, 2)}\n`);
process.stdout.write(`OpenAPI written to ${target}\n`);
