import {
  DEFAULT_DATABASE_URL,
  DEFAULT_REDIS_HOST,
  DEFAULT_REDIS_PORT,
} from './configuration';

type EnvironmentValues = Record<string, unknown> & {
  DATABASE_URL?: string;
  REDIS_HOST?: string;
  REDIS_PORT?: string;
};

export function validateEnvironment(config: Record<string, unknown>) {
  const environment = config as EnvironmentValues;
  const redisPort = Number.parseInt(
    environment.REDIS_PORT ?? String(DEFAULT_REDIS_PORT),
    10,
  );

  if (!Number.isInteger(redisPort) || redisPort <= 0) {
    throw new Error('REDIS_PORT must be a positive integer');
  }

  return {
    ...config,
    DATABASE_URL:
      environment.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL,
    REDIS_HOST: environment.REDIS_HOST?.trim() || DEFAULT_REDIS_HOST,
    REDIS_PORT: String(redisPort),
  };
}