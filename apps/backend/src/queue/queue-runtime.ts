import { ConfigService } from '@nestjs/config';
import type { RedisOptions } from 'ioredis';
import type { ArcNetworkKey } from '@wizpay/arc-network';

export type NetworkJob = { network: ArcNetworkKey };

export function selectedQueueNetwork(config: ConfigService): ArcNetworkKey {
  return config.getOrThrow<ArcNetworkKey>('arcNetwork.key');
}

export function selectedQueuePrefix(config: ConfigService): string {
  return config.getOrThrow<string>('BULLMQ_PREFIX');
}

export function selectedRedisConnection(config: ConfigService): RedisOptions {
  const tls = config.get<string>('REDIS_TLS') === 'true';
  const username = config.get<string>('REDIS_USERNAME') || undefined;
  const password = config.get<string>('REDIS_PASSWORD') || undefined;
  return {
    host: config.getOrThrow<string>('REDIS_HOST'),
    port: Number(config.getOrThrow<string>('REDIS_PORT')),
    db: Number(config.getOrThrow<string>('REDIS_DB')),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(tls ? { tls: {} } : {}),
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

export function assertSelectedJobNetwork<T extends NetworkJob>(
  config: ConfigService,
  job: T,
): T {
  if (job.network !== selectedQueueNetwork(config)) {
    throw new Error(
      'Queue job network does not match the selected runtime network.',
    );
  }
  return job;
}
