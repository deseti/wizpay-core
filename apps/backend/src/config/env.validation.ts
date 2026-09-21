import {
  parseArcNetworkKey,
  resolveArcCapabilities,
} from '@wizpay/arc-network';
import { normalizeMainnetRuntimeEnvironmentValues } from './runtime-env';
import { resolveRuntimeIsolationConfiguration } from './runtime-isolation.config';

type EnvironmentValues = Record<string, unknown> & {
  WIZPAY_ARC_NETWORK?: string;
};

export function validateEnvironment(config: Record<string, unknown>) {
  const environment = normalizeMainnetRuntimeEnvironmentValues(
    config as EnvironmentValues & Record<string, string | undefined>,
  );
  const arcNetworkKey = parseArcNetworkKey(environment.WIZPAY_ARC_NETWORK);
  resolveArcCapabilities(arcNetworkKey, environment);
  const isolation = resolveRuntimeIsolationConfiguration(environment);

  return {
    ...environment,
    DATABASE_URL: isolation.databaseUrl,
    REDIS_URL: isolation.redisUrl,
    REDIS_HOST: isolation.redis.host,
    REDIS_PORT: String(isolation.redis.port),
    REDIS_DB: String(isolation.redis.databaseIndex),
    REDIS_USERNAME: isolation.redis.username ?? '',
    REDIS_PASSWORD: isolation.redis.password ?? '',
    REDIS_TLS: isolation.redis.tls ? 'true' : 'false',
    BULLMQ_PREFIX: isolation.queuePrefix,
    RUNTIME_ISOLATION_DIAGNOSTIC: isolation.diagnostic,
    WIZPAY_ARC_NETWORK: arcNetworkKey,
  };
}
