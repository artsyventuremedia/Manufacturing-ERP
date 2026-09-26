import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PLATFORM_EVENTS } from '@manuling/platform/contracts';
import { z } from 'zod';

/**
 * Writes the JSON Schema of every published event's `data` to docs/events/<type>.json, so
 * contract changes show up in review and CI can fail when the files are stale (ADR-0007 §5).
 */
const catalogues = [PLATFORM_EVENTS];
const dir = fileURLToPath(new URL('../../../../docs/events/', import.meta.url));
await mkdir(dir, { recursive: true });

const index: { type: string; file: string }[] = [];
for (const catalogue of catalogues) {
  for (const [type, schema] of Object.entries(catalogue)) {
    const file = `${type}.json`;
    const json = { $id: `urn:manuling:event:${type}`, title: type, ...z.toJSONSchema(schema) };
    await writeFile(`${dir}${file}`, `${JSON.stringify(json, null, 2)}\n`);
    index.push({ type, file });
  }
}
index.sort((a, b) => a.type.localeCompare(b.type));
await writeFile(`${dir}index.json`, `${JSON.stringify(index, null, 2)}\n`);
process.stdout.write(`Wrote ${index.length} event schemas to ${dir}\n`);
