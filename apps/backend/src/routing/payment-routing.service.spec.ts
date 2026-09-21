import { ConfigService } from '@nestjs/config';
import { resolveArcCapabilities } from '@wizpay/arc-network';
import {
  PAYMENT_ROUTE_DECISIONS,
  PAYMENT_ROUTING_ERROR_CODES,
  PaymentRoutingService,
} from './payment-routing.service';

const MAINNET_USDC = '0x3600000000000000000000000000000000000000';
const MAINNET_EURC = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1';
const FOREIGN_TOKEN = '0x3333333333333333333333333333333333333333';

function service(capabilities = resolveArcCapabilities('arc-mainnet', {})) {
  return new PaymentRoutingService(
    new ConfigService({
      arcNetwork: {
        key: 'arc-mainnet',
        tokens: {
          USDC: { address: MAINNET_USDC },
          EURC: { address: MAINNET_EURC },
        },
      },
      arcCapabilities: capabilities,
    }),
  );
}

function withCapabilities(overrides: Record<string, boolean>) {
  return {
    ...resolveArcCapabilities('arc-mainnet', {}),
    ...overrides,
  };
}

describe('PaymentRoutingService (Arc Mainnet only)', () => {
  it.each(['SEND', 'PAYROLL', 'INVOICE', 'PAYMENT_LINK'] as const)(
    'routes canonical same-token %s directly without a provider',
    (operation) => {
      const routing = service();
      expect(
        routing.decide({
          network: 'arc-mainnet',
          operation,
          tokenIn: MAINNET_USDC,
          tokenOut: MAINNET_USDC.toUpperCase().replace('0X', '0x'),
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
    const routing = service();
    const decision = routing.decide({
      network: 'arc-mainnet',
      operation: 'PAYROLL',
      tokenIn: MAINNET_USDC,
      tokenOut: MAINNET_EURC,
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
      expect(JSON.stringify(error.response)).not.toMatch(/key|secret|provider/i);
    }
  });

  it('routes Mainnet cross-token atomically only while its capability is enabled', () => {
    const enabled = service(
      withCapabilities({ swap: true, crossTokenPayroll: true }),
    );
    expect(
      enabled.decide({
        network: 'arc-mainnet',
        operation: 'PAYROLL',
        tokenIn: MAINNET_USDC,
        tokenOut: MAINNET_EURC,
      }),
    ).toMatchObject({
      kind: PAYMENT_ROUTE_DECISIONS.CROSS_TOKEN_ATOMIC,
      provider: 'UNISWAP_V4',
    });

    const disabled = service(withCapabilities({ crossTokenPayroll: false }));
    expect(
      disabled.decide({
        network: 'arc-mainnet',
        operation: 'PAYROLL',
        tokenIn: MAINNET_USDC,
        tokenOut: MAINNET_EURC,
      }).kind,
    ).toBe(PAYMENT_ROUTE_DECISIONS.CROSS_TOKEN_DISABLED);
  });

  it.each([undefined, '', 'USDC', '0x1234', `0x${'0'.repeat(40)}`])(
    'fails closed for invalid token input %p',
    (tokenIn) => {
      expect(() =>
        service().decide({
          network: 'arc-mainnet',
          operation: 'SEND',
          tokenIn,
          tokenOut: MAINNET_USDC,
        }),
      ).toThrow();
    },
  );

  it('rejects unsupported and wrong-network context', () => {
    const routing = service();
    try {
      routing.decide({
        network: 'arc-mainnet',
        operation: 'SEND',
        tokenIn: FOREIGN_TOKEN,
        tokenOut: MAINNET_USDC,
      });
      throw new Error('Expected routing rejection.');
    } catch (error: any) {
      expect(error.response.code).toBe(
        PAYMENT_ROUTING_ERROR_CODES.UNSUPPORTED_TOKEN,
      );
    }
    expect(() =>
      routing.decide({
        network: 'arc-legacy',
        operation: 'SEND',
        tokenIn: MAINNET_USDC,
        tokenOut: MAINNET_USDC,
      }),
    ).toThrow('Payment routing network does not match');
  });

  it('ignores caller route labels because they are not part of the policy input', () => {
    const routing = service();
    const decision = routing.decide({
      network: 'arc-mainnet',
      operation: 'PAYMENT_LINK',
      tokenIn: MAINNET_USDC,
      tokenOut: MAINNET_EURC,
      route: 'same-token',
      provider: 'external',
    } as never);
    expect(decision.kind).toBe(PAYMENT_ROUTE_DECISIONS.CROSS_TOKEN_DISABLED);
    expect(decision.provider).toBeNull();
  });
});
