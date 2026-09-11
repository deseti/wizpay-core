import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';
import * as path from 'path';
import * as fs from 'fs';

// Try loading .env from two locations (local vs docker)
const envPaths = [
  path.resolve(process.cwd(), '../../.env'), // Local
  path.resolve(process.cwd(), '.env'), // Docker (if mounted, or fallback)
];

for (const p of envPaths) {
  if (fs.existsSync(p)) {
    loadEnv({ path: p });
    break;
  }
}

const command = process.argv.join(' ');
const needsDatabase = /\bmigrate\b|\bdb\s+(push|pull|execute)\b/.test(command);
const selectedNetwork = process.env.WIZPAY_ARC_NETWORK;
const migrationNetwork = process.env.WIZPAY_MIGRATION_NETWORK;
const databaseKey =
  selectedNetwork === 'arc-testnet'
    ? 'ARC_TESTNET_DATABASE_URL'
    : selectedNetwork === 'arc-mainnet'
      ? 'ARC_MAINNET_DATABASE_URL'
      : null;

if (needsDatabase) {
  if (
    !databaseKey ||
    migrationNetwork !== selectedNetwork ||
    process.env.DATABASE_URL !== undefined
  ) {
    throw new Error(
      'Prisma migration requires matching explicit Arc runtime and migration networks and rejects DATABASE_URL.',
    );
  }
  if (!process.env[databaseKey]?.trim()) {
    throw new Error(`Prisma migration requires ${databaseKey}.`);
  }
}

export default defineConfig({
  schema: 'src/database/schema.prisma',
  migrations: {
    path: 'src/database/migrations',
  },
  datasource: {
    url: databaseKey ? (process.env[databaseKey] ?? '') : '',
  },
});
