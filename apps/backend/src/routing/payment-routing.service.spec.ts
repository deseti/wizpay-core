import { ConfigService } from '@nestjs/config';
import { resolveArcCapabilities } from '@wizpay/arc-network';
import {
  PAYMENT_ROUTE_DECISIONS,
  PAYMENT_ROUTING_ERROR_CODES,
  PaymentRoutingService,
} from './payment-routing.service';

const TESTNET_USDC = '0x3600000000000000000000000000000000000000';
const TESTNET_EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const MAINNET_USDC_FIXTURE = '0x1111111111111111111111111111111111111111';
const MAINNET_EURC_FIXTURE = '0x2222222222222222222222222222222222222222';

function service(
  network: 'arc-testnet' | 'arc-mainnet',
  capabilities = resolveArcCapabilities(network, {}),
) {
  const mainnet = network === 'arc-mainnet';
  return new PaymentRoutingService(
    new ConfigService({
      arcNetwork: {
        key: network,
        tokens: {
          USDC: { address: mainnet ? MAINNET_USDC_FIXTURE : TESTNET_USDC },
          EURC: { address: mainnet ? MAINNET_EURC_FIXTURE : TESTNET_EURC },
        },
      },
      arcCapabilities: capabilities,
    }),
  );
}

describe('PaymentRoutingService', () => {
  it.each(['SEND', 'PAYROLL', 'INVOICE', 'PAYMENT_LINK'] as const)(
    'routes canonical same-token %s directly without a provider',
    (operation) => {
      const routing = service('arc-testnet');
      expect(
        routing.decide({
          network: 'arc-testnet',
          operation,
          tokenIn: TESTNET_USDC,
          tokenOut: TESTNET_USDC.toUpperCase().replace('0X', '0x'),
        }),
      ).toMatchObject({
        kind: PAYMENT_ROUTE_DECISIONS.DIRECT_TRANSFER,
        provider: null,
        tokenInSymbol: 'USDC',
        tokenOutSymbol: 'USDC',
      });
    },
  );

  it('rejects Mainnet cross-token routing with the stable error before execution', () => {
    const routing = service('arc-mainnet');
    const decision = routing.decide({
      network: 'arc-mainnet',
      operation: 'PAYROLL',
      tokenIn: MAINNET_USDC_FIXTURE,
      tokenOut: MAINNET_EURC_FIXTURE,
    });
    expect(decision.kind).toBe(PAYMENT_ROUTE_DECISIONS.CROSS_TOKEN_DISABLED);
    expect(() => routing.assertExecutable(decision)).toThrow(
      expect.objectContaining({ status: 422 }),
    );
    try {
      routing.assertExecutable(decision);
    } catch (error: any) {
      expect(error.response.code).toBe(
        PAYMENT_ROUTING_ERROR_CODES.CROSS_TOKEN_DISABLED,
      );
      expect(JSON.stringify(error.response)).not.toMatch(
        /key|secret|provider|xylonet|stablefx/i,
      );
    }
  });

  it('preserves Testnet cross-token routing only while its capability is enabled', () => {
    const enabled = service('arc-testnet');
    expect(
      enabled.decide({
        network: 'arc-testnet',
        operation: 'PAYROLL',
        tokenIn: TESTNET_USDC,
        tokenOut: TESTNET_EURC,
      }),
    ).toMatchObject({
      kind: PAYMENT_ROUTE_DECISIONS.CROSS_TOKEN_PROVIDER,
      provider: 'XYLONET',
    });

    const disabled = service('arc-testnet', {
      ...resolveArcCapabilities('arc-testnet', {}),
      crossTokenPayroll: false,
    });
    expect(
      disabled.decide({
        network: 'arc-testnet',
        operation: 'PAYROLL',
        tokenIn: TESTNET_USDC,
        tokenOut: TESTNET_EURC,
      }).kind,
    ).toBe(PAYMENT_ROUTE_DECISIONS.CROSS_TOKEN_DISABLED);
  });

  it.each([undefined, '', 'USDC', '0x1234', `0x${'0'.repeat(40)}`])(
    'fails closed for invalid token input %p',
    (tokenIn) => {
      expect(() =>
        service('arc-testnet').decide({
          network: 'arc-testnet',
          operation: 'SEND',
          tokenIn,
          tokenOut: TESTNET_USDC,
        }),
      ).toThrow();
    },
  );

  it('rejects unsupported, foreign-network, and wrong-network context', () => {
    const routing = service('arc-mainnet');
    for (const [token, code] of [
      [TESTNET_USDC, PAYMENT_ROUTING_ERROR_CODES.FOREIGN_NETWORK_TOKEN],
      [
        '0x3333333333333333333333333333333333333333',
        PAYMENT_ROUTING_ERROR_CODES.UNSUPPORTED_TOKEN,
      ],
    ] as const) {
      try {
        routing.decide({
          network: 'arc-mainnet',
          operation: 'SEND',
          tokenIn: token,
          tokenOut: MAINNET_USDC_FIXTURE,
        });
        throw new Error('Expected routing rejection.');
      } catch (error: any) {
        expect(error.response.code).toBe(code);
      }
    }
    expect(() =>
      routing.decide({
        network: 'arc-testnet',
        operation: 'SEND',
        tokenIn: MAINNET_USDC_FIXTURE,
        tokenOut: MAINNET_USDC_FIXTURE,
      }),
    ).toThrow('Payment routing network does not match');
  });

  it('ignores caller route labels because they are not part of the policy input', () => {
    const routing = service('arc-mainnet');
    const decision = routing.decide({
      network: 'arc-mainnet',
      operation: 'PAYMENT_LINK',
      tokenIn: MAINNET_USDC_FIXTURE,
      tokenOut: MAINNET_EURC_FIXTURE,
      route: 'same-token',
      provider: 'xylonet',
    } as never);
    expect(decision.kind).toBe(PAYMENT_ROUTE_DECISIONS.CROSS_TOKEN_DISABLED);
    expect(decision.provider).toBeNull();
  });
});
