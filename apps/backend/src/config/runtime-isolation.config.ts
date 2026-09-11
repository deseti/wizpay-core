import {
  getArcCircleExecutionDefinition,
  parseArcNetworkKey,
  type ArcNetworkKey,
} from '@wizpay/arc-network';
import { assertDeploymentManifestIsolation } from './deployment-manifest.config';

type Environment = Record<string, string | undefined>;

const NETWORK_VARIABLES = Object.freeze({
  'arc-testnet': {
    databaseUrl: 'ARC_TESTNET_DATABASE_URL',
    redisUrl: 'ARC_TESTNET_REDIS_URL',
    queuePrefix: 'ARC_TESTNET_QUEUE_PREFIX',
  },
  'arc-mainnet': {
    databaseUrl: 'ARC_MAINNET_DATABASE_URL',
    redisUrl: 'ARC_MAINNET_REDIS_URL',
    queuePrefix: 'ARC_MAINNET_QUEUE_PREFIX',
  },
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

export type RuntimeIsolationDiagnostic = Readonly<{
  network: ArcNetworkKey;
  environment: 'testnet' | 'mainnet';
  database: Readonly<{ host: string; port: number; database: string }>;
  redis: Readonly<{ host: string; port: number; databaseIndex: number }>;
  queuePrefix: string;
  manifest: 'arc-testnet-authoritative' | 'arc-mainnet-unavailable';
  circle: Readonly<{
    apiCredentialConfigured: boolean;
    entitySecretConfigured: boolean;
    walletSetConfigured: boolean;
    blockchainAvailable: boolean;
  }>;
  transactionalCapabilityAvailable: boolean;
}>;

export type RuntimeIsolationConfiguration = Readonly<{
  network: ArcNetworkKey;
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
  assertRuntimeIdentityAgreement(network, environment);
  assertNoUnscopedRuntimeConfiguration(environment);

  const selected = NETWORK_VARIABLES[network];
  const manifest = assertDeploymentManifestIsolation(network, environment);
  const oppositeNetwork =
    network === 'arc-testnet' ? 'arc-mainnet' : 'arc-testnet';
  const opposite = NETWORK_VARIABLES[oppositeNetwork];
  const databaseUrl = requireExact(environment, selected.databaseUrl);
  const redisUrl = requireExact(environment, selected.redisUrl);
  const queuePrefix = requireQueuePrefix(
    environment,
    selected.queuePrefix,
    network,
  );

  const database = parseDatabaseTarget(databaseUrl, selected.databaseUrl);
  const oppositeDatabaseUrl = readExact(environment, opposite.databaseUrl);
  if (
    oppositeDatabaseUrl &&
    database.identity ===
      parseDatabaseTarget(oppositeDatabaseUrl, opposite.databaseUrl).identity
  ) {
    fail('Arc Testnet and Arc Mainnet database targets must be distinct.');
  }

  const redis = parseRedisTarget(redisUrl, selected.redisUrl);
  const oppositeRedisUrl = readExact(environment, opposite.redisUrl);
  if (
    oppositeRedisUrl &&
    redis.identity ===
      parseRedisTarget(oppositeRedisUrl, opposite.redisUrl).identity
  ) {
    fail('Arc Testnet and Arc Mainnet Redis targets must be distinct.');
  }

  const oppositePrefix = readExact(environment, opposite.queuePrefix);
  if (oppositePrefix && oppositePrefix === queuePrefix) {
    fail('Arc Testnet and Arc Mainnet queue prefixes must be distinct.');
  }

  const circleDefinition = getArcCircleExecutionDefinition(network);
  const apiCredentialConfigured = hasExact(
    environment,
    circleDefinition.apiCredentialEnvironmentKey,
  );
  const entitySecretConfigured = hasExact(
    environment,
    circleDefinition.entitySecretEnvironmentKey,
  );
  const walletSetConfigured = hasExact(
    environment,
    circleDefinition.walletSetIdEnvironmentKey,
  );
  const completeDeveloperConfiguration = [
    circleDefinition.apiBaseUrlEnvironmentKey,
    circleDefinition.apiCredentialEnvironmentKey,
    circleDefinition.entitySecretEnvironmentKey,
    circleDefinition.walletSetIdEnvironmentKey,
    circleDefinition.walletIdEnvironmentKey,
    circleDefinition.walletAddressEnvironmentKey,
    circleDefinition.receiptConfirmationsEnvironmentKey,
  ].every((key) => hasExact(environment, key));
  const blockchainAvailable = circleDefinition.blockchain !== null;
  const transactionalCapabilityAvailable =
    blockchainAvailable &&
    completeDeveloperConfiguration &&
    network === 'arc-testnet';

  const diagnostic: RuntimeIsolationDiagnostic = Object.freeze({
    network,
    environment: network === 'arc-testnet' ? 'testnet' : 'mainnet',
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
    manifest:
      manifest.network === 'arc-testnet'
        ? 'arc-testnet-authoritative'
        : 'arc-mainnet-unavailable',
    circle: Object.freeze({
      apiCredentialConfigured,
      entitySecretConfigured,
      walletSetConfigured,
      blockchainAvailable,
    }),
    transactionalCapabilityAvailable,
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

function assertRuntimeIdentityAgreement(
  network: ArcNetworkKey,
  environment: Environment,
) {
  for (const key of ['WIZPAY_API_NETWORK', 'WIZPAY_WORKER_NETWORK']) {
    const value = readExact(environment, key);
    if (value !== null && value !== network) {
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

function requireQueuePrefix(
  environment: Environment,
  key: string,
  network: ArcNetworkKey,
) {
  const prefix = requireExact(environment, key);
  if (
    !/^[a-z0-9][a-z0-9:_-]{5,63}$/.test(prefix) ||
    !prefix.includes(network) ||
    ['default', 'bull', 'bullmq', 'queue', 'wizpay'].includes(prefix)
  ) {
    fail(
      `Selected queue prefix ${key} must be non-generic and include ${network}.`,
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
    identity: `${url.username.toLowerCase()}@${url.hostname.toLowerCase()}:${port}/${database}`,
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
    identity: `${username.toLowerCase()}@${url.hostname.toLowerCase()}:${port}/${databaseIndex}`,
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

function hasExact(environment: Environment, key: string) {
  return readExact(environment, key) !== null;
}

function fail(message: string): never {
  throw new RuntimeIsolationConfigurationError(message);
}
