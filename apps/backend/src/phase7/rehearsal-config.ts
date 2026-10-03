import { isAbsolute, join, resolve } from 'node:path';
import type { ClientConfig } from 'pg';
import {
  postgresUrl,
  runtimeDatabasePool,
} from '../database/database-connection.config';

type Environment = Record<string, string | undefined>;
export const REHEARSAL_ACK = 'ISOLATED_TARGET_ONLY';
export const REHEARSAL_MARKER = 'wizpay-migration-rehearsal:v1';
export const backendRoot = resolve(__dirname, '../..');
export const repositoryRoot = resolve(backendRoot, '../..');
export const migrationRoot = join(backendRoot, 'src/database/migrations');
export const localHost = (host: string) =>
  ['127.0.0.1', 'localhost', '[::1]'].includes(host);

function endpoint(value: string | undefined, name: string) {
  const url = postgresUrl(value, name);
  if (
    !/^[a-zA-Z0-9_-]+$/.test(decodeURIComponent(url.pathname.slice(1))) ||
    (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1))
  )
    throw new Error('Rehearsal endpoint identity is ambiguous.');
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!['sslmode', 'sslrootcert'].includes(key) || seen.has(key))
      throw new Error('Unsupported or duplicate rehearsal URL option.');
    seen.add(key);
  }
  if (url.hostname.endsWith('.pooler.supabase.com') && url.port === '6543')
    throw new Error('Rehearsal requires direct or Session connections.');
  if (
    !localHost(url.hostname) &&
    url.searchParams.get('sslmode') !== 'verify-full'
  )
    throw new Error('External rehearsal endpoints require verified TLS.');
  return url;
}

export function rehearsalConfiguration(environment: Environment) {
  if (
    environment.DATABASE_URL !== undefined ||
    environment.DIRECT_URL !== undefined
  )
    throw new Error('Unscoped database variables are not accepted.');
  if (environment.WIZPAY_MIGRATION_REHEARSAL_ACK !== REHEARSAL_ACK)
    throw new Error('Explicit isolated-target acknowledgement is required.');
  const source = endpoint(
    environment.WIZPAY_MIGRATION_SOURCE_URL,
    'WIZPAY_MIGRATION_SOURCE_URL',
  );
  const target = endpoint(
    environment.WIZPAY_MIGRATION_TARGET_URL,
    'WIZPAY_MIGRATION_TARGET_URL',
  );
  const database = decodeURIComponent(target.pathname.slice(1));
  if (
    target.hostname !== environment.WIZPAY_MIGRATION_TARGET_HOST ||
    database !== environment.WIZPAY_MIGRATION_TARGET_DATABASE
  )
    throw new Error(
      'Target must match the independently acknowledged identity.',
    );
  if (
    (source.hostname === target.hostname ||
      (localHost(source.hostname) && localHost(target.hostname))) &&
    (source.port || '5432') === (target.port || '5432') &&
    source.pathname === target.pathname
  )
    throw new Error('Source and target must be different databases.');
  if (localHost(target.hostname)) {
    if (!/^wizpay_rehearsal_[0-9a-f]{32}$/.test(database))
      throw new Error('Local target must be a dedicated rehearsal database.');
  } else {
    const project = environment.WIZPAY_MIGRATION_TARGET_PROJECT_REF ?? '';
    if (
      !/^[a-z]{20}$/.test(project) ||
      database !== 'postgres' ||
      !(
        (target.hostname === `db.${project}.supabase.co` &&
          (target.port || '5432') === '5432') ||
        (target.hostname.endsWith('.pooler.supabase.com') &&
          target.port === '5432' &&
          decodeURIComponent(target.username).endsWith(`.${project}`))
      )
    )
      throw new Error(
        'Remote target must be the designated Supabase validation project.',
      );
  }
  const binaryDirectory = environment.WIZPAY_REHEARSAL_PG_BIN;
  if (binaryDirectory && !isAbsolute(binaryDirectory))
    throw new Error('PostgreSQL binary directory must be absolute.');
  return {
    source,
    target,
    localTarget: localHost(target.hostname),
    binary: (name: 'pg_dump' | 'pg_restore') =>
      binaryDirectory ? join(binaryDirectory, name) : name,
    backupDirectory: environment.WIZPAY_MIGRATION_BACKUP_DIRECTORY,
  };
}

export type RehearsalConfiguration = ReturnType<typeof rehearsalConfiguration>;

export function connection(url: URL, readOnly = false): ClientConfig {
  const config = localHost(url.hostname)
    ? { connectionString: url.toString() }
    : runtimeDatabasePool(url.toString(), {
        WIZPAY_DATABASE_PROFILE: 'supavisor-transaction',
      });
  return {
    ...config,
    application_name: 'wizpay-migration-rehearsal',
    options: `${readOnly ? '-c default_transaction_read_only=on ' : ''}-c lock_timeout=5000`,
    connectionTimeoutMillis: 10_000,
  };
}

/** Credentials are child-process environment only, never command arguments. */
export function nativeEnvironment(
  url: URL,
  readOnly: boolean,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PG')) delete env[key];
  return {
    ...env,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: url.searchParams.get('sslmode') ?? 'disable',
    PGSSLROOTCERT: url.searchParams.get('sslrootcert') ?? undefined,
    PGCONNECT_TIMEOUT: '10',
    PGAPPNAME: 'wizpay-migration-rehearsal',
    PGOPTIONS: `${readOnly ? '-c default_transaction_read_only=on ' : ''}-c lock_timeout=5000`,
  };
}
