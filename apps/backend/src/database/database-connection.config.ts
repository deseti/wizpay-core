import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';

type Environment = Record<string, string | undefined>;
export type DatabaseProfile = 'vps' | 'supavisor-transaction';

function invalid(message: string): never {
  // Never include supplied URL values or underlying parser/driver errors.
  throw new Error(`Database configuration: ${message}`);
}

export function databaseProfile(environment: Environment): DatabaseProfile {
  const value = environment.WIZPAY_DATABASE_PROFILE ?? 'vps';
  if (value !== 'vps' && value !== 'supavisor-transaction')
    invalid('WIZPAY_DATABASE_PROFILE must be vps or supavisor-transaction.');
  return value;
}

export function postgresUrl(value: string | undefined, name: string): URL {
  if (!value || value !== value.trim())
    invalid(`${name} is required and must be exact.`);
  try {
    const url = new URL(value);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.pathname.slice(1) ||
      url.hash
    )
      invalid(`${name} must be a complete PostgreSQL URL.`);
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    decodeURIComponent(url.pathname);
    return url;
  } catch {
    invalid(`${name} must be a complete PostgreSQL URL.`);
  }
}

function verifiedTls(url: URL): PoolConfig['ssl'] {
  if (url.searchParams.get('sslmode') !== 'verify-full')
    invalid('external connections require sslmode=verify-full.');
  for (const key of url.searchParams.keys()) {
    if (!['sslmode', 'sslrootcert'].includes(key))
      invalid('external URL options are limited to sslmode and sslrootcert.');
  }
  const caFile = url.searchParams.get('sslrootcert');
  let ca: string | undefined;
  if (caFile) {
    try {
      ca = readFileSync(caFile, 'utf8');
    } catch {
      invalid('sslrootcert must reference a readable trusted CA file.');
    }
  }
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}

/** One adapter-owned pool per PrismaService, never a pool per query. */
export function runtimeDatabasePool(
  connectionString: string,
  environment: Environment,
): PoolConfig {
  const profile = databaseProfile(environment);
  const url = postgresUrl(connectionString, 'ARC_MAINNET_DATABASE_URL');
  if (profile === 'vps') {
    if (url.hostname.endsWith('.pooler.supabase.com'))
      invalid(
        'Supavisor endpoints require an explicit supavisor-transaction profile.',
      );
    if (environment.WIZPAY_DATABASE_POOL_MAX !== undefined)
      invalid(
        'WIZPAY_DATABASE_POOL_MAX requires supavisor-transaction profile.',
      );
    return { connectionString }; // Preserve the existing VPS driver defaults.
  }
  const rawMax = environment.WIZPAY_DATABASE_POOL_MAX ?? '1';
  if (!/^[1-3]$/.test(rawMax))
    invalid('WIZPAY_DATABASE_POOL_MAX must be an integer from 1 to 3.');
  if (url.hostname === 'postgres')
    invalid(
      'supavisor-transaction requires an explicitly supplied external endpoint.',
    );
  // Explicit fields prevent URL parameters from overriding TLS or pool limits.
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl: verifiedTls(url),
    max: Number(rawMax),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  };
}

/** CLI never borrows the pooled runtime URL in the transaction profile. */
export function migrationDatabaseUrl(environment: Environment): string {
  if (
    environment.WIZPAY_ARC_NETWORK !== 'arc-mainnet' ||
    environment.WIZPAY_MIGRATION_NETWORK !== environment.WIZPAY_ARC_NETWORK ||
    environment.DATABASE_URL !== undefined ||
    environment.DIRECT_URL !== undefined
  )
    invalid(
      'migration requires matching Mainnet selectors and rejects DATABASE_URL/DIRECT_URL.',
    );
  const profile = databaseProfile(environment);
  const dedicated = environment.ARC_MAINNET_MIGRATION_DATABASE_URL;
  // Legacy VPS explicitly uses one direct database for both purposes. No
  // transaction-profile fallback, and an empty dedicated binding is an error.
  const name =
    dedicated !== undefined || profile === 'supavisor-transaction'
      ? 'ARC_MAINNET_MIGRATION_DATABASE_URL'
      : 'ARC_MAINNET_DATABASE_URL';
  const value = environment[name];
  const url = postgresUrl(value, name);
  if (profile === 'supavisor-transaction') {
    const mode = environment.WIZPAY_MIGRATION_DATABASE_MODE;
    if (mode !== 'direct' && mode !== 'session')
      invalid(
        'WIZPAY_MIGRATION_DATABASE_MODE must explicitly be direct or session.',
      );
    verifiedTls(url);
    if (url.hostname.endsWith('.pooler.supabase.com') && url.port === '6543')
      invalid(
        'the known Supavisor transaction endpoint cannot run migrations.',
      );
    if (environment.ARC_MAINNET_DATABASE_URL) {
      const runtime = postgresUrl(
        environment.ARC_MAINNET_DATABASE_URL,
        'ARC_MAINNET_DATABASE_URL',
      );
      if (
        runtime.hostname === url.hostname &&
        (runtime.port || '5432') === (url.port || '5432') &&
        runtime.pathname === url.pathname &&
        runtime.username === url.username
      )
        invalid(
          'migration and transaction runtime endpoints must be distinct.',
        );
    }
    // Native Prisma migration engines use different TLS parameter names than
    // node-postgres. Passing verify-full/sslrootcert through is insufficient:
    // explicitly require strict certificate validation in the native engine.
    const caFile = url.searchParams.get('sslrootcert');
    url.search = '';
    url.searchParams.set('sslmode', 'require');
    url.searchParams.set('sslaccept', 'strict');
    if (caFile) url.searchParams.set('sslcert', caFile);
    return url.toString();
  }
  return value!;
}
