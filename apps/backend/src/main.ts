import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadBackendArcNetworkConfiguration } from './config/arc-network.config';
import { validateEnvironment } from './config/env.validation';

type CreateApplication = () => ReturnType<typeof NestFactory.create>;

export const WIZPAY_PRODUCTION_APP_ORIGIN = 'https://app.wizpay.xyz';

export function resolveCorsOrigins(
  environment: Record<string, string | undefined>,
): string[] {
  const configured = environment.CORS_ORIGINS;
  const origins = (configured ?? 'http://localhost:3000,http://localhost:3001')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (environment.NODE_ENV === 'production') {
    if (
      configured === undefined ||
      origins.length !== 1 ||
      origins[0] !== WIZPAY_PRODUCTION_APP_ORIGIN
    ) {
      throw new Error(
        `Production CORS_ORIGINS must be exactly ${WIZPAY_PRODUCTION_APP_ORIGIN}.`,
      );
    }
  }

  return origins;
}

export async function bootstrap(
  createApplication: CreateApplication | undefined = undefined,
  environment = process.env,
) {
  const logger = new Logger('Bootstrap');
  loadBackendArcNetworkConfiguration(environment);
  const validated = validateEnvironment(environment);
  logger.log(
    `Runtime isolation: ${JSON.stringify(validated.RUNTIME_ISOLATION_DIAGNOSTIC)}`,
  );
  const app = await (createApplication
    ? createApplication()
    : import('./app.module.js').then(({ AppModule }) =>
        NestFactory.create(AppModule),
      ));
  app.enableShutdownHooks();

  // ── CORS ─────────────────────────────────────────────────────────────
  const corsOrigins = resolveCorsOrigins(environment);

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  const port = environment.PORT ?? 4000;
  await app.listen(port);
  logger.log(`Application running on port ${port}`);
  logger.log(`CORS origins: ${corsOrigins.join(', ')}`);
}

if (require.main === module) {
  void bootstrap();
}
