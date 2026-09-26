import { fileURLToPath } from 'node:url';
import { type MigrationSet } from '@manuling/db';

export const platformMigrations: MigrationSet = {
  name: 'platform',
  directory: fileURLToPath(new URL('../migrations', import.meta.url)),
};
