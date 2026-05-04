import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import configuration from './configuration';
import { validateEnvironment } from './env.validation';

function resolveEnvFilePath(): string | undefined {
  // Local backend runs should read only the monorepo root .env.
  // Docker injects env vars directly, so no file is needed in containers.
  const candidates = [path.resolve(process.cwd(), '../../.env')];

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

const envFilePath = resolveEnvFilePath();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: true,
      envFilePath,
      ignoreEnvFile: envFilePath === undefined,
      load: [configuration],
      validate: validateEnvironment,
    }),
  ],
  exports: [ConfigModule],
})
export class AppConfigModule {}