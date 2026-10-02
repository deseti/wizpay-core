// Phase 2 preflight only. Never wrap migrations, queries or application pools.
export const AUTH_RETRY_DELAYS_MS = Object.freeze([
  5_000, 10_000, 15_000, 20_000, 30_000,
]);
export const AUTH_RETRY_WINDOW_MS = 110_000;
export const AUTH_CONNECT_TIMEOUT_MS = 5_000;

interface AuthClient {
  connect(): Promise<unknown>;
  end(): Promise<void>;
}
interface Timing {
  now(): number;
  wait(delay: number): Promise<void>;
}
type Outcome = { retryCount: number; result: 'PASS' | 'FAIL' };

export function retryableAuthentication(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '28P01'
  );
}

export async function connectWithAuthRetry<T extends AuthClient>(
  create: (timeoutMillis: number) => T,
  report: (outcome: Outcome) => void,
  timing: Timing = {
    now: () => performance.now(),
    wait: (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  },
): Promise<T> {
  const deadline = timing.now() + AUTH_RETRY_WINDOW_MS;
  let retryCount = 0;
  async function bounded<R>(
    operation: () => Promise<R>,
    limit: number,
  ): Promise<R> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Preflight time limit.')),
            limit,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  try {
    for (;;) {
      const remaining = deadline - timing.now();
      if (remaining <= 0) throw new Error('Preflight time limit.');
      const timeout = Math.min(AUTH_CONNECT_TIMEOUT_MS, remaining);
      const client = create(timeout);
      try {
        await bounded(() => client.connect(), timeout);
        if (timing.now() >= deadline) throw new Error('Preflight time limit.');
        report({ retryCount, result: 'PASS' });
        return client;
      } catch (error: unknown) {
        // Close every failed attempt; no credential rotation or endpoint change.
        await bounded(
          () => client.end(),
          Math.max(1, Math.min(1_000, deadline - timing.now())),
        ).catch(() => undefined);
        const delay = AUTH_RETRY_DELAYS_MS[retryCount];
        if (
          !retryableAuthentication(error) ||
          delay === undefined ||
          timing.now() + delay >= deadline
        )
          throw new Error('Preflight failed.');
        await bounded(
          () => timing.wait(delay),
          Math.max(1, deadline - timing.now()),
        );
        retryCount++;
      }
    }
  } catch {
    report({ retryCount, result: 'FAIL' });
    // Discard driver messages, names and response fields containing credentials.
    throw new Error('Supavisor preflight failed.');
  }
}
