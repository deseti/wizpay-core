import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import configuration from './configuration';
import { validateEnvironment } from './env.validation';

function resolveEnvFilePath(): string | undefined {
  // In Docker, env vars are injected directly — no .env file needed.
  // Locally, the .env lives at monorepo root (two levels up from apps/backend).
  const candidates = [
    path.resolve(process.cwd(), '.env'),         // Docker: /app/.env or local root
    path.resolve(process.cwd(), '../../.env'),    // Local: apps/backend -> monorepo root
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // No file found — rely on process.env (Docker injects env vars directly)
  return undefined;
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: true,
      envFilePath: resolveEnvFilePath(),
      ignoreEnvFile: resolveEnvFilePath() === undefined,
      load: [configuration],
      validate: validateEnvironment,
    }),
  ],
  exports: [ConfigModule],
})
export class AppConfigModule {}