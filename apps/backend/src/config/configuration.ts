export const DEFAULT_DATABASE_URL =
  'postgresql://postgres:postgres@localhost:5432/wizpay?schema=public';
export const DEFAULT_REDIS_HOST = '127.0.0.1';
export const DEFAULT_REDIS_PORT = 6379;

export interface ApplicationConfig {
  databaseUrl: string;
  redis: {
    host: string;
    port: number;
  };
}

export default (): ApplicationConfig => ({
  databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  redis: {
    host: process.env.REDIS_HOST ?? DEFAULT_REDIS_HOST,
    port: Number.parseInt(
      process.env.REDIS_PORT ?? String(DEFAULT_REDIS_PORT),
      10,
    ),
  },
});