import {
  CIRCLE_CONFIGURATION_ERROR_CODES,
  resolveCircleExecutionConfiguration,
  validateCircleEnvironmentIsolation,
} from './circle-execution.config';

const testnet = {
  CIRCLE_TESTNET_API_BASE_URL: 'https://api.circle.test',
  CIRCLE_TESTNET_API_KEY: 'testnet-secret-value',
  CIRCLE_TESTNET_APP_ID: 'testnet-app-id',
  CIRCLE_TESTNET_RECEIPT_CONFIRMATIONS: '2',
};

describe('Circle execution configuration', () => {
  it('resolves only the selected Testnet credential keys and exact chain', () => {
    expect(
      resolveCircleExecutionConfiguration(
        'arc-testnet',
        testnet,
        'user-controlled',
      ),
    ).toMatchObject({
      environment: 'testnet',
      blockchain: 'ARC-TESTNET',
      apiBaseUrl: 'https://api.circle.test',
    });
  });

  it('fails Mainnet construction before consuming credentials', () => {
    expect(() =>
      resolveCircleExecutionConfiguration(
        'arc-mainnet',
        {
          CIRCLE_MAINNET_API_BASE_URL: 'https://api.circle.com',
          CIRCLE_MAINNET_API_KEY: 'mainnet-secret-value',
        },
        'user-controlled',
      ),
    ).toThrow('unverified');
  });

  it('rejects opposite-environment credentials and generic fallbacks', () => {
    for (const environment of [
      {
        CIRCLE_MAINNET_API_BASE_URL: 'https://api.circle.com',
        CIRCLE_MAINNET_API_KEY: 'mainnet-secret-value',
      },
      { ...testnet, CIRCLE_API_KEY: 'generic-secret-value' },
    ]) {
      expect(() =>
        resolveCircleExecutionConfiguration(
          'arc-testnet',
          environment,
          'user-controlled',
        ),
      ).toThrow();
    }
  });

  it.each([undefined, '', '   ', ' value', 'value '])(
    'rejects missing or inexact selected credentials: %p',
    (value) => {
      expect(() =>
        resolveCircleExecutionConfiguration(
          'arc-testnet',
          { ...testnet, CIRCLE_TESTNET_API_KEY: value },
          'user-controlled',
        ),
      ).toThrow();
    },
  );

  it('rejects identical Testnet and Mainnet wallet sets', () => {
    expect(() =>
      validateCircleEnvironmentIsolation({
        CIRCLE_TESTNET_WALLET_SET_ID: 'same-wallet-set',
        CIRCLE_MAINNET_WALLET_SET_ID: 'same-wallet-set',
      }),
    ).toThrow('must be distinct');
  });

  it.each([
    ['CIRCLE_TESTNET_API_KEY', 'CIRCLE_MAINNET_API_KEY'],
    ['CIRCLE_TESTNET_APP_ID', 'CIRCLE_MAINNET_APP_ID'],
    ['CIRCLE_TESTNET_ENTITY_SECRET', 'CIRCLE_MAINNET_ENTITY_SECRET'],
    ['CIRCLE_TESTNET_WALLET_ID', 'CIRCLE_MAINNET_WALLET_ID'],
  ])('rejects a shared environment identity: %s / %s', (testKey, mainKey) => {
    expect(() =>
      validateCircleEnvironmentIsolation({
        [testKey]: 'shared-value',
        [mainKey]: 'shared-value',
      }),
    ).toThrow('must be distinct');
  });

  it('requires all developer-controlled custody references without leaking values', () => {
    const secret = 'do-not-leak-this-secret';
    try {
      resolveCircleExecutionConfiguration(
        'arc-testnet',
        { ...testnet, CIRCLE_TESTNET_ENTITY_SECRET: secret },
        'developer-controlled',
      );
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toMatchObject({
        code: CIRCLE_CONFIGURATION_ERROR_CODES.MISSING,
      });
      expect(String(error)).not.toContain(secret);
    }
  });
});
