import { parseArcNetworkKey } from '@wizpay/arc-network';
import { assertDeploymentManifestIsolation } from './deployment-manifest.config';

type Environment = Record<string, string | undefined>;

const MAINNET_NETWORK = 'arc-mainnet' as const;

const MAINNET_VARIABLES = Object.freeze({
  databaseUrl: 'ARC_MAINNET_DATABASE_URL',
  redisUrl: 'ARC_MAINNET_REDIS_URL',
  queuePrefix: 'ARC_MAINNET_QUEUE_PREFIX',
} as const);

const FORBIDDEN_UNSCOPED_RUNTIME_KEYS = Object.freeze([
  'DATABASE_URL',
  'REDIS_URL',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_DB',
  'BULLMQ_PREFIX',
  'QUEUE_PREFIX',
]);

const RUNTIME_IDENTITY_KEYS = Object.freeze([
  'WIZPAY_API_NETWORK',
  'WIZPAY_WORKER_NETWORK',
]);

export type RuntimeIsolationDiagnostic = Readonly<{
  network: typeof MAINNET_NETWORK;
  environment: 'mainnet';
  database: Readonly<{ host: string; port: number; database: string }>;
  redis: Readonly<{ host: string; port: number; databaseIndex: number }>;
  queuePrefix: string;
  manifest: 'arc-mainnet-unavailable';
}>;

export type RuntimeIsolationConfiguration = Readonly<{
  network: typeof MAINNET_NETWORK;
  databaseUrl: string;
  redisUrl: string;
  redis: Readonly<{
    host: string;
    port: number;
    databaseIndex: number;
    username?: string;
    password?: string;
    tls: boolean;
  }>;
  queuePrefix: string;
  diagnostic: RuntimeIsolationDiagnostic;
}>;

export class RuntimeIsolationConfigurationError extends Error {
  readonly code = 'RUNTIME_ISOLATION_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'RuntimeIsolationConfigurationError';
  }
}

export function resolveRuntimeIsolationConfiguration(
  environment: Environment,
): RuntimeIsolationConfiguration {
  const network = parseArcNetworkKey(environment.WIZPAY_ARC_NETWORK);
  if (network !== MAINNET_NETWORK) {
    fail(
      `Unsupported Arc network: ${JSON.stringify(network)}. WizPay backend requires ${MAINNET_NETWORK}.`,
    );
  }
  assertRuntimeIdentityAgreement(environment);
  assertNoUnscopedRuntimeConfiguration(environment);
  assertNoRetiredNetworkConfiguration(environment);
  assertNoCustodiedWalletConfiguration(environment);

  const manifest = assertDeploymentManifestIsolation(network, environment);
  if (manifest.network !== MAINNET_NETWORK) {
    fail(
      `Unsupported deployment manifest network: ${JSON.stringify(manifest.network)}. WizPay backend requires ${MAINNET_NETWORK}.`,
    );
  }

  const databaseUrl = requireExact(environment, MAINNET_VARIABLES.databaseUrl);
  const redisUrl = requireExact(environment, MAINNET_VARIABLES.redisUrl);
  const queuePrefix = requireQueuePrefix(
    environment,
    MAINNET_VARIABLES.queuePrefix,
  );

  const database = parseDatabaseTarget(
    databaseUrl,
    MAINNET_VARIABLES.databaseUrl,
  );
  const redis = parseRedisTarget(redisUrl, MAINNET_VARIABLES.redisUrl);

  const diagnostic: RuntimeIsolationDiagnostic = Object.freeze({
    network,
    environment: 'mainnet',
    database: Object.freeze({
      host: database.host,
      port: database.port,
      database: database.database,
    }),
    redis: Object.freeze({
      host: redis.host,
      port: redis.port,
      databaseIndex: redis.databaseIndex,
    }),
    queuePrefix,
    manifest: 'arc-mainnet-unavailable',
  });

  return Object.freeze({
    network,
    databaseUrl,
    redisUrl,
    redis: Object.freeze({
      host: redis.host,
      port: redis.port,
      databaseIndex: redis.databaseIndex,
      ...(redis.username ? { username: redis.username } : {}),
      ...(redis.password ? { password: redis.password } : {}),
      tls: redis.tls,
    }),
    queuePrefix,
    diagnostic,
  });
}

function assertRuntimeIdentityAgreement(environment: Environment) {
  for (const key of RUNTIME_IDENTITY_KEYS) {
    const value = readExact(environment, key);
    if (value !== null && value !== MAINNET_NETWORK) {
      fail(`${key} conflicts with WIZPAY_ARC_NETWORK.`);
    }
  }
}

function assertNoUnscopedRuntimeConfiguration(environment: Environment) {
  for (const key of FORBIDDEN_UNSCOPED_RUNTIME_KEYS) {
    if (environment[key] !== undefined) {
      fail(`Legacy unscoped runtime configuration ${key} is not accepted.`);
    }
  }
}

function assertNoRetiredNetworkConfiguration(environment: Environment) {
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().includes('TESTNET')) {
      fail(`Legacy network configuration ${key} is not accepted.`);
    }
  }
}

function assertNoCustodiedWalletConfiguration(environment: Environment) {
  for (const key of Object.keys(environment)) {
    if (key.startsWith('CIRCLE')) {
      fail(
        `Arc Mainnet is external-wallet-only: custodied-wallet configuration ${key} is not accepted.`,
      );
    }
  }
}

function requireQueuePrefix(environment: Environment, key: string) {
  const prefix = requireExact(environment, key);
  if (
    !/^[a-z0-9][a-z0-9:_-]{5,63}$/.test(prefix) ||
    !prefix.includes(MAINNET_NETWORK) ||
    ['default', 'bull', 'bullmq', 'queue', 'wizpay'].includes(prefix)
  ) {
    fail(
      `Selected queue prefix ${key} must be non-generic and include ${MAINNET_NETWORK}.`,
    );
  }
  return prefix;
}

function parseDatabaseTarget(value: string, key: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`Selected database configuration ${key} is invalid.`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    fail(`Selected database configuration ${key} must use PostgreSQL.`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !database || !url.username) {
    fail(`Selected database configuration ${key} is incomplete.`);
  }
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail(`Selected database configuration ${key} has an invalid port.`);
  }
  return {
    host: url.hostname.toLowerCase(),
    port,
    database,
  };
}

function parseRedisTarget(value: string, key: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`Selected Redis configuration ${key} is invalid.`);
  }
  if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname) {
    fail(`Selected Redis configuration ${key} must be a Redis URL.`);
  }
  const path = url.pathname.replace(/^\//, '');
  const databaseIndex = path === '' ? 0 : Number(path);
  const port = url.port ? Number(url.port) : 6379;
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !Number.isInteger(databaseIndex) ||
    databaseIndex < 0
  ) {
    fail(`Selected Redis configuration ${key} has an invalid target.`);
  }
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  return {
    host: url.hostname.toLowerCase(),
    port,
    databaseIndex,
    username,
    password,
    tls: url.protocol === 'rediss:',
  };
}

function requireExact(environment: Environment, key: string) {
  const value = readExact(environment, key);
  if (value === null)
    fail(`Selected runtime configuration ${key} is required.`);
  return value;
}

function readExact(environment: Environment, key: string): string | null {
  const value = environment[key];
  if (value === undefined) return null;
  if (!value || value !== value.trim()) {
    fail(`Runtime configuration ${key} must be a non-empty exact value.`);
  }
  return value;
}

function fail(message: string): never {
  throw new RuntimeIsolationConfigurationError(message);
}
