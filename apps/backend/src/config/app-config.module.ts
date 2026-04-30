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
    if (!fs.existsSync(candidate)) {
      continue;
    }

    // Skip empty files — an empty .env shadows the real one
    const stat = fs.statSync(candidate);
    if (stat.size === 0) {
      continue;
    }

    // Also skip files that are only whitespace/comments (no actual key=value)
    const content = fs.readFileSync(candidate, 'utf-8');
    const hasValues = content
      .split('\n')
      .some((line) => /^\s*[A-Z_][A-Z0-9_]*\s*=/.test(line));

    if (hasValues) {
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