import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';
import * as path from 'path';
import * as fs from 'fs';
import { migrationDatabaseUrl } from './src/database/database-connection.config';

// Try loading .env from two locations (local vs docker)
const envPaths = [
  path.resolve(process.cwd(), '../../.env'), // Local
  path.resolve(process.cwd(), '.env'), // Docker (if mounted, or fallback)
];

for (const p of envPaths) {
  if (fs.existsSync(p)) {
    // Keep Prisma CLI output machine-safe. In particular, `migrate diff
    // --script` must emit SQL only when redirected into a migration file.
    loadEnv({ path: p, quiet: true });
    break;
  }
}

const command = process.argv.join(' ');
const needsDatabase = /\bmigrate\b|\bdb\s+(push|pull|execute)\b/.test(command);
// Generate/validate need no URL or live database. Database commands choose an
// explicit migration purpose, with no pooled-runtime fallback in that profile.
const migrationUrl = needsDatabase ? migrationDatabaseUrl(process.env) : '';

export default defineConfig({
  schema: 'src/database/schema.prisma',
  migrations: {
    path: 'src/database/migrations',
  },
  datasource: {
    url: migrationUrl,
  },
});
