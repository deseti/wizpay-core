const DEFAULT_HOST_RUN_POSTGRES_HOST = '127.0.0.1';
const DEFAULT_HOST_RUN_POSTGRES_PORT = '15432';
const DEFAULT_HOST_RUN_REDIS_HOST = '127.0.0.1';
const DOCKER_POSTGRES_HOST = 'postgres';
const DOCKER_REDIS_HOST = 'redis';

type RuntimeEnvironment = Record<string, string | undefined>;

export function isDockerRuntime(
  environment: RuntimeEnvironment = process.env,
) {
  return environment.DOCKER === 'true';
}

/**
 * Normalize Arc Mainnet runtime endpoints for host runs.
 *
 * Docker Compose uses the `postgres` / `redis` service hostnames, which are
 * only resolvable inside the Compose network. Local backend runs outside
 * Docker must target the published host ports instead. Docker runs keep
 * the injected values untouched.
 */
export function normalizeMainnetRuntimeEnvironmentValues<
  T extends RuntimeEnvironment,
>(environment: T): T {
  if (isDockerRuntime(environment)) {
    return environment;
  }

  const normalizedDatabaseUrl = normalizeDatabaseUrlForHostRun(
    environment.ARC_MAINNET_DATABASE_URL,
    environment,
  );
  const normalizedRedisUrl = normalizeRedisUrlForHostRun(
    environment.ARC_MAINNET_REDIS_URL,
  );

  return {
    ...environment,
    ...(normalizedDatabaseUrl
      ? { ARC_MAINNET_DATABASE_URL: normalizedDatabaseUrl }
      : {}),
    ...(normalizedRedisUrl
      ? { ARC_MAINNET_REDIS_URL: normalizedRedisUrl }
      : {}),
  };
}

function normalizeDatabaseUrlForHostRun(
  databaseUrl: string | undefined,
  environment: RuntimeEnvironment,
) {
  const trimmedDatabaseUrl = databaseUrl?.trim();

  if (!trimmedDatabaseUrl) {
    return undefined;
  }

  try {
    const parsedDatabaseUrl = new URL(trimmedDatabaseUrl);

    if (parsedDatabaseUrl.hostname !== DOCKER_POSTGRES_HOST) {
      return trimmedDatabaseUrl;
    }

    parsedDatabaseUrl.hostname = DEFAULT_HOST_RUN_POSTGRES_HOST;
    parsedDatabaseUrl.port = resolveHostRunPostgresPort(
      environment,
      parsedDatabaseUrl.port,
    );

    return parsedDatabaseUrl.toString();
  } catch {
    return trimmedDatabaseUrl;
  }
}

function normalizeRedisUrlForHostRun(redisUrl: string | undefined) {
  const trimmedRedisUrl = redisUrl?.trim();

  if (!trimmedRedisUrl) {
    return undefined;
  }

  try {
    const parsedRedisUrl = new URL(trimmedRedisUrl);

    if (parsedRedisUrl.hostname !== DOCKER_REDIS_HOST) {
      return trimmedRedisUrl;
    }

    parsedRedisUrl.hostname = DEFAULT_HOST_RUN_REDIS_HOST;
    return parsedRedisUrl.toString();
  } catch {
    return trimmedRedisUrl;
  }
}

function resolveHostRunPostgresPort(
  environment: RuntimeEnvironment,
  currentPort: string,
) {
  const configuredHostPort = environment.POSTGRES_HOST_PORT?.trim();

  if (configuredHostPort) {
    return configuredHostPort;
  }

  if (currentPort && currentPort !== '5432') {
    return currentPort;
  }

  return DEFAULT_HOST_RUN_POSTGRES_PORT;
}
