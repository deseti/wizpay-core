import {
  AUTH_CONNECT_TIMEOUT_MS,
  AUTH_RETRY_DELAYS_MS,
  AUTH_RETRY_WINDOW_MS,
  connectWithAuthRetry,
  retryableAuthentication,
} from '../../test/supavisor-auth-retry';

function fixture(errors: unknown[], connectDuration = 0) {
  let elapsed = 0;
  const delays: number[] = [];
  const clients: { connect: jest.Mock; end: jest.Mock }[] = [];
  const timeouts: number[] = [];
  const report = jest.fn();
  const timing = {
    now: () => elapsed,
    wait: (delay: number) => {
      delays.push(delay);
      elapsed += delay;
      return Promise.resolve();
    },
  };
  const create = (timeout: number) => {
    timeouts.push(timeout);
    const index = clients.length;
    const client = {
      connect: jest.fn(() => {
        elapsed += connectDuration;
        return index < errors.length
          ? Promise.reject(
              Object.assign(new Error('Fixture failure'), errors[index]),
            )
          : Promise.resolve();
      }),
      end: jest.fn(() => Promise.resolve()),
    };
    clients.push(client);
    return client;
  };
  return {
    create,
    report,
    timing,
    delays,
    clients,
    timeouts,
    elapsed: () => elapsed,
  };
}
const authenticationFailure = {
  code: '28P01',
  message: 'postgresql://synthetic:synthetic-password@invalid/postgres',
};

describe('Phase 2 Supavisor preflight authentication retries', () => {
  it.each([
    'EAI_AGAIN',
    'ENOTFOUND',
    'ECONNREFUSED',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    '42501',
    '28000',
    '53300',
    undefined,
  ])(
    'does not retry DNS/TLS/permission/configuration errors (%s)',
    async (code) => {
      const test = fixture([{ code, message: authenticationFailure.message }]);
      await expect(
        connectWithAuthRetry(test.create, test.report, test.timing),
      ).rejects.toThrow('Supavisor preflight failed.');
      expect(test.clients).toHaveLength(1);
      expect(test.clients[0].end).toHaveBeenCalledTimes(1);
      expect(test.delays).toEqual([]);
      expect(test.report).toHaveBeenCalledWith({
        retryCount: 0,
        result: 'FAIL',
      });
      expect(retryableAuthentication({ code })).toBe(false);
    },
  );
  it('accepts only exact SQLSTATE 28P01', () => {
    expect(retryableAuthentication(authenticationFailure)).toBe(true);
    for (const error of [
      null,
      undefined,
      '28P01',
      { code: '28P01 ' },
      { sqlState: '28P01' },
    ])
      expect(retryableAuthentication(error)).toBe(false);
  });
  it('uses six attempts at most and an 80-second delay budget, without credential logs', async () => {
    const test = fixture(Array(6).fill(authenticationFailure));
    await expect(
      connectWithAuthRetry(test.create, test.report, test.timing),
    ).rejects.toThrow('Supavisor preflight failed.');
    expect(test.clients).toHaveLength(6);
    expect(test.delays).toEqual(AUTH_RETRY_DELAYS_MS);
    expect(test.delays.reduce((total, delay) => total + delay, 0)).toBe(80_000);
    expect(test.elapsed()).toBeLessThan(AUTH_RETRY_WINDOW_MS);
    expect(AUTH_RETRY_WINDOW_MS).toBeLessThan(120_000);
    expect(
      test.timeouts.every((timeout) => timeout <= AUTH_CONNECT_TIMEOUT_MS),
    ).toBe(true);
    expect(
      test.clients.every((client) => client.end.mock.calls.length === 1),
    ).toBe(true);
    expect(test.report.mock.calls).toEqual([
      [{ retryCount: 5, result: 'FAIL' }],
    ]);
    expect(JSON.stringify(test.report.mock.calls)).not.toMatch(
      /postgresql|synthetic|password/,
    );
  });
  it('returns the successfully connected client and closes only failed attempts', async () => {
    const test = fixture([authenticationFailure, authenticationFailure]);
    expect(
      await connectWithAuthRetry(test.create, test.report, test.timing),
    ).toBe(test.clients[2]);
    expect(test.delays).toEqual([5_000, 10_000]);
    expect(test.clients[0].end).toHaveBeenCalledTimes(1);
    expect(test.clients[1].end).toHaveBeenCalledTimes(1);
    expect(test.clients[2].end).not.toHaveBeenCalled();
    expect(test.report.mock.calls).toEqual([
      [{ retryCount: 2, result: 'PASS' }],
    ]);
  });
  it('reuses fixed endpoint, role, password and verified TLS across authentication attempts', async () => {
    const test = fixture([authenticationFailure]);
    const configuration = Object.freeze({
      host: 'aws-0-ap-southeast-1.pooler.supabase.com',
      port: 5432,
      user: 'wizpay_p2_12345_1.tsvzblikmgocgksgxguc',
      password: 'synthetic-password',
      database: 'postgres',
      ssl: Object.freeze({ rejectUnauthorized: true, ca: 'synthetic-ca' }),
    });
    const bindings: (typeof configuration)[] = [];
    await connectWithAuthRetry(
      (timeout) => {
        bindings.push({ ...configuration });
        return test.create(timeout);
      },
      test.report,
      test.timing,
    );
    expect(bindings).toEqual([configuration, configuration]);
    expect(JSON.stringify(test.report.mock.calls)).not.toContain(
      configuration.password,
    );
  });
  it('stops at the absolute deadline even if attempts consume the connection budget', async () => {
    const test = fixture(
      Array(6).fill(authenticationFailure),
      AUTH_CONNECT_TIMEOUT_MS,
    );
    await expect(
      connectWithAuthRetry(test.create, test.report, test.timing),
    ).rejects.toThrow();
    expect(test.elapsed()).toBeLessThanOrEqual(AUTH_RETRY_WINDOW_MS);
    expect(test.clients.length).toBeLessThanOrEqual(6);
  });
  it('times out a hanging connection without retrying and still closes it', async () => {
    jest.useFakeTimers();
    try {
      const client = {
        connect: () => new Promise<void>(() => undefined),
        end: jest.fn(() => Promise.resolve()),
      };
      const report = jest.fn();
      const result = connectWithAuthRetry(() => client, report);
      const rejection = expect(result).rejects.toThrow(
        'Supavisor preflight failed.',
      );
      await jest.advanceTimersByTimeAsync(AUTH_CONNECT_TIMEOUT_MS);
      await rejection;
      expect(client.end).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith({ retryCount: 0, result: 'FAIL' });
    } finally {
      jest.useRealTimers();
    }
  });
});
