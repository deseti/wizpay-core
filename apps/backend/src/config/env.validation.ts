import {
  parseArcNetworkKey,
  resolveArcCapabilities,
} from '@wizpay/arc-network';
import { validateCircleEnvironmentIsolation } from './circle-execution.config';
import { resolveRuntimeIsolationConfiguration } from './runtime-isolation.config';

type EnvironmentValues = Record<string, unknown> & {
  WIZPAY_ARC_NETWORK?: string;
};

export function validateEnvironment(config: Record<string, unknown>) {
  const environment = config as EnvironmentValues &
    Record<string, string | undefined>;
  const arcNetworkKey = parseArcNetworkKey(environment.WIZPAY_ARC_NETWORK);
  resolveArcCapabilities(arcNetworkKey, environment);
  validateCircleEnvironmentIsolation(environment);
  const isolation = resolveRuntimeIsolationConfiguration(environment);

  return {
    ...config,
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
