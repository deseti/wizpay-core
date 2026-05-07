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

export function normalizeRuntimeEnvironmentValues<
  T extends RuntimeEnvironment,
>(environment: T): T {
  if (isDockerRuntime(environment)) {
    return environment;
  }

  const normalizedDatabaseUrl = normalizeDatabaseUrlForHostRun(
    environment.DATABASE_URL,
    environment,
  );
  const normalizedRedisHost = normalizeRedisHostForHostRun(
    environment.REDIS_HOST,
  );

  return {
    ...environment,
    ...(normalizedDatabaseUrl
      ? { DATABASE_URL: normalizedDatabaseUrl }
      : {}),
    ...(normalizedRedisHost ? { REDIS_HOST: normalizedRedisHost } : {}),
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

function normalizeRedisHostForHostRun(redisHost: string | undefined) {
  const trimmedRedisHost = redisHost?.trim();

  if (!trimmedRedisHost) {
    return undefined;
  }

  return trimmedRedisHost === DOCKER_REDIS_HOST
    ? DEFAULT_HOST_RUN_REDIS_HOST
    : trimmedRedisHost;
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