import { ConfigService } from '@nestjs/config';
import {
  assertSelectedJobNetwork,
  selectedQueuePrefix,
  selectedRedisConnection,
} from './queue-runtime';

describe('BullMQ runtime isolation', () => {
  const secondary = config({
    'arcNetwork.key': 'arc-legacy',
    BULLMQ_PREFIX: 'wizpay:arc-legacy',
    REDIS_HOST: 'redis-secondary.internal',
    REDIS_PORT: '6379',
    REDIS_DB: '2',
    REDIS_TLS: 'false',
  });
  const mainnet = config({
    'arcNetwork.key': 'arc-mainnet',
    BULLMQ_PREFIX: 'wizpay:arc-mainnet',
    REDIS_HOST: 'redis-mainnet.internal',
    REDIS_PORT: '6380',
    REDIS_DB: '3',
    REDIS_TLS: 'true',
  });

  it('gives equal business identifiers independent Redis and key spaces', () => {
    expect(selectedQueuePrefix(secondary)).not.toBe(selectedQueuePrefix(mainnet));
    expect(selectedRedisConnection(secondary)).toMatchObject({
      host: 'redis-secondary.internal',
      port: 6379,
      db: 2,
    });
    expect(selectedRedisConnection(mainnet)).toMatchObject({
      host: 'redis-mainnet.internal',
      port: 6380,
      db: 3,
      tls: {},
    });
  });

  it('rejects jobs from the other network and legacy jobs without identity', () => {
    expect(() =>
      assertSelectedJobNetwork(secondary, { network: 'arc-mainnet' }),
    ).toThrow('does not match');
    expect(() => assertSelectedJobNetwork(secondary, {} as never)).toThrow(
      'does not match',
    );
    expect(() =>
      assertSelectedJobNetwork(mainnet, { network: 'arc-legacy' as never }),
    ).toThrow('does not match');
  });
});

function config(values: Record<string, string>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`Missing ${key}`);
      return value;
    },
  } as unknown as ConfigService;
}
