import { externalTestConnection } from '../../test/postgres-harness';

const valid = {
  WIZPAY_EXTERNAL_TEST_DATABASE_URL:
    'postgresql://test_user:test_password@migration.example.invalid/postgres?sslmode=verify-full',
  WIZPAY_EXTERNAL_TEST_TARGET_HOST: 'migration.example.invalid',
  WIZPAY_EXTERNAL_TEST_TARGET_DATABASE: 'postgres',
  WIZPAY_EXTERNAL_TEST_ACK: 'ISOLATED_NONPRODUCTION_SCHEMA',
};

describe('external PostgreSQL test guards', () => {
  it('requires explicit target acknowledgement and verified TLS before any connection', () => {
    expect(externalTestConnection(valid)).toMatchObject({
      max: 1,
      ssl: { rejectUnauthorized: true },
    });
    for (const extra of [
      { WIZPAY_EXTERNAL_TEST_ACK: undefined },
      { WIZPAY_EXTERNAL_TEST_ACK: 'yes' },
      { NODE_ENV: 'production' },
      { WIZPAY_EXTERNAL_TEST_TARGET_HOST: 'other.example.invalid' },
      { WIZPAY_EXTERNAL_TEST_TARGET_DATABASE: 'other' },
      {
        WIZPAY_EXTERNAL_TEST_DATABASE_URL:
          valid.WIZPAY_EXTERNAL_TEST_DATABASE_URL.replace(
            'verify-full',
            'disable',
          ),
      },
    ])
      expect(() => externalTestConnection({ ...valid, ...extra })).toThrow();
  });
});
