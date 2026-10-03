import { Logger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadBackendArcNetworkConfiguration } from './config/arc-network.config';
import { validateEnvironment } from './config/env.validation';
import {
  resolveRuntimeMode,
  type WizPayRuntimeMode,
} from './runtime/runtime.module';

export type CreateApplication = (
  mode: WizPayRuntimeMode,
) => Promise<INestApplication>;
export interface ApplicationOptions {
  environment?: Record<string, string | undefined>;
  runtimeMode?: WizPayRuntimeMode;
  createApplication?: CreateApplication;
}

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

/** Shared HTTP composition; the caller owns initialization and process lifetime. */
export async function createWizPayApplication(
  options: ApplicationOptions = {},
): Promise<INestApplication> {
  const environment = options.environment ?? process.env;
  const runtimeMode = resolveRuntimeMode(
    environment.WIZPAY_RUNTIME_MODE,
    options.runtimeMode,
  );
  if (
    options.runtimeMode !== undefined &&
    runtimeMode !== options.runtimeMode
  ) {
    throw new Error(
      'WIZPAY_RUNTIME_MODE does not match the selected entrypoint.',
    );
  }
  loadBackendArcNetworkConfiguration(environment);
  const validated = validateEnvironment({
    ...environment,
    WIZPAY_RUNTIME_MODE: runtimeMode,
  });
  const corsOrigins = resolveCorsOrigins(environment);
  new Logger('Bootstrap').log(
    `Runtime isolation: ${JSON.stringify(validated.RUNTIME_ISOLATION_DIAGNOSTIC)}`,
  );
  const app = await (options.createApplication
    ? options.createApplication(runtimeMode)
    : import('./app.module.js').then(async ({ AppModule }) =>
        NestFactory.create(await AppModule.forRuntime(runtimeMode), {
          // A failed serverless cold start must reject, rather than exit the host.
          abortOnError: runtimeMode === 'server',
        }),
      ));
  app.enableCors({ origin: corsOrigins, credentials: true });
  return app;
}
