import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';
import * as path from 'path';
import * as fs from 'fs';

// Try loading .env from two locations (local vs docker)
const envPaths = [
  path.resolve(process.cwd(), '../../.env'), // Local
  path.resolve(process.cwd(), '.env'),       // Docker (if mounted, or fallback)
];

for (const p of envPaths) {
  if (fs.existsSync(p)) {
    loadEnv({ path: p });
    break;
  }
}

// When building Docker image, DATABASE_URL might not be present.
// We only enforce it if we are actually running migrations or the server.
const isGenerating = process.argv.join(' ').includes('generate');

if (!process.env.DATABASE_URL && !isGenerating) {
  throw new Error('DATABASE_URL environment variable is not defined.');
}

export default defineConfig({
  schema: 'src/database/schema.prisma',
  migrations: {
    path: 'src/database/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});