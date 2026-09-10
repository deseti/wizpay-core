import {
  BadRequestException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  getArcTokenResource,
  getArcNetworkByKey,
  isArcCapabilityEnabled,
  type ArcCapabilities,
  type ArcCapabilityName,
  type ArcNetworkKey,
  type ArcTokenSymbol,
} from '@wizpay/arc-network';
import { getAddress, isAddressEqual, zeroAddress, type Address } from 'viem';

export const PAYMENT_ROUTE_DECISIONS = Object.freeze({
  DIRECT_TRANSFER: 'DIRECT_TRANSFER',
  CROSS_TOKEN_PROVIDER: 'CROSS_TOKEN_PROVIDER',
  CROSS_TOKEN_DISABLED: 'CROSS_TOKEN_DISABLED',
});

export const PAYMENT_ROUTING_ERROR_CODES = Object.freeze({
  CROSS_TOKEN_DISABLED: 'CROSS_TOKEN_DISABLED',
  INVALID_CONTEXT: 'PAYMENT_ROUTING_INVALID_CONTEXT',
  INVALID_TOKEN: 'PAYMENT_ROUTING_INVALID_TOKEN',
  UNSUPPORTED_TOKEN: 'PAYMENT_ROUTING_UNSUPPORTED_TOKEN',
  FOREIGN_NETWORK_TOKEN: 'PAYMENT_ROUTING_FOREIGN_NETWORK_TOKEN',
});

export const CROSS_TOKEN_DISABLED_MESSAGE =
  'Cross-token payments are unavailable on the selected Arc network.';

export type PaymentOperation = 'SEND' | 'PAYROLL' | 'INVOICE' | 'PAYMENT_LINK';

export type PaymentRouteDecision = Readonly<{
  kind: (typeof PAYMENT_ROUTE_DECISIONS)[keyof typeof PAYMENT_ROUTE_DECISIONS];
  network: ArcNetworkKey;
  operation: PaymentOperation;
  tokenIn: Address;
  tokenInSymbol: ArcTokenSymbol;
  tokenOut: Address;
  tokenOutSymbol: ArcTokenSymbol;
  provider: 'XYLONET' | null;
}>;

type RouteInput = Readonly<{
  network: unknown;
  operation: PaymentOperation;
  tokenIn: unknown;
  tokenOut: unknown;
}>;

@Injectable()
export class PaymentRoutingService {
  readonly network: ArcNetworkKey;
  readonly chainId: number;
  private readonly capabilities: ArcCapabilities;
  private readonly tokens: Readonly<Partial<Record<ArcTokenSymbol, Address>>>;

  constructor(config: ConfigService) {
    this.network = config.getOrThrow<ArcNetworkKey>('arcNetwork.key');
    this.chainId =
      config.get<number>('arcNetwork.chainId') ??
      getArcNetworkByKey(this.network).chainId;
    this.capabilities = config.getOrThrow<ArcCapabilities>('arcCapabilities');
    const eurc = this.optionalConfiguredAddress(config, 'EURC');
    this.tokens = Object.freeze({
      USDC: this.configuredAddress(config, 'USDC'),
      ...(eurc ? { EURC: eurc } : {}),
    });
  }

  canonicalToken(symbol: ArcTokenSymbol): Address {
    const address = this.tokens[symbol];
    if (!address)
      throw new BadRequestException({
        code: PAYMENT_ROUTING_ERROR_CODES.UNSUPPORTED_TOKEN,
        message: `Canonical ${symbol} is unavailable on the selected Arc network.`,
      });
    return address;
  }

  decide(input: RouteInput): PaymentRouteDecision {
    if (input.network !== this.network) {
      throw new BadRequestException({
        code: PAYMENT_ROUTING_ERROR_CODES.INVALID_CONTEXT,
        message:
          'Payment routing network does not match the selected Arc network.',
      });
    }
    const tokenIn = this.identifyToken(input.tokenIn);
    const tokenOut = this.identifyToken(input.tokenOut);
    const sameToken = isAddressEqual(tokenIn.address, tokenOut.address);
    const capability = sameToken
      ? this.directCapability(input.operation)
      : this.crossTokenCapability(input.operation);

    if (sameToken) {
      return this.decision(
        input.operation,
        tokenIn,
        tokenOut,
        PAYMENT_ROUTE_DECISIONS.DIRECT_TRANSFER,
        null,
      );
    }

    if (
      this.network === 'arc-testnet' &&
      isArcCapabilityEnabled(this.capabilities, capability)
    ) {
      return this.decision(
        input.operation,
        tokenIn,
        tokenOut,
        PAYMENT_ROUTE_DECISIONS.CROSS_TOKEN_PROVIDER,
        'XYLONET',
      );
    }
    return this.decision(
      input.operation,
      tokenIn,
      tokenOut,
      PAYMENT_ROUTE_DECISIONS.CROSS_TOKEN_DISABLED,
      null,
    );
  }

  assertExecutable(decision: PaymentRouteDecision): PaymentRouteDecision {
    if (decision.kind === PAYMENT_ROUTE_DECISIONS.CROSS_TOKEN_DISABLED) {
      throw new UnprocessableEntityException({
        code: PAYMENT_ROUTING_ERROR_CODES.CROSS_TOKEN_DISABLED,
        message: CROSS_TOKEN_DISABLED_MESSAGE,
        network: decision.network,
        operation: decision.operation,
      });
    }
    return decision;
  }

  private configuredAddress(
    config: ConfigService,
    symbol: ArcTokenSymbol,
  ): Address {
    const raw = config.get<unknown>(`arcNetwork.tokens.${symbol}.address`);
    try {
      return this.parseAddress(raw);
    } catch {
      throw new BadRequestException({
        code: PAYMENT_ROUTING_ERROR_CODES.INVALID_CONTEXT,
        message: `Canonical ${symbol} is unavailable for the selected Arc network.`,
      });
    }
  }

  private identifyToken(value: unknown): {
    address: Address;
    symbol: ArcTokenSymbol;
  } {
    let address: Address;
    try {
      address = this.parseAddress(value);
    } catch {
      throw new BadRequestException({
        code: PAYMENT_ROUTING_ERROR_CODES.INVALID_TOKEN,
        message: 'Payment token address is missing or malformed.',
      });
    }
    for (const symbol of ['USDC', 'EURC'] as const) {
      const configured = this.tokens[symbol];
      if (configured && isAddressEqual(address, configured)) {
        return { address: configured, symbol };
      }
    }
    const otherNetwork =
      this.network === 'arc-testnet' ? 'arc-mainnet' : 'arc-testnet';
    for (const symbol of ['USDC', 'EURC'] as const) {
      const resource = getArcTokenResource(otherNetwork, symbol);
      if (
        resource.status === 'available' &&
        isAddressEqual(address, resource.value.address)
      ) {
        throw new BadRequestException({
          code: PAYMENT_ROUTING_ERROR_CODES.FOREIGN_NETWORK_TOKEN,
          message: 'Payment token belongs to a different Arc network.',
        });
      }
    }
    throw new BadRequestException({
      code: PAYMENT_ROUTING_ERROR_CODES.UNSUPPORTED_TOKEN,
      message: 'Payment token is not supported on the selected Arc network.',
    });
  }

  private optionalConfiguredAddress(
    config: ConfigService,
    symbol: ArcTokenSymbol,
  ): Address | null {
    const raw = config.get<unknown>(`arcNetwork.tokens.${symbol}.address`);
    if (raw === undefined || raw === null) return null;
    try {
      return this.parseAddress(raw);
    } catch {
      throw new BadRequestException({
        code: PAYMENT_ROUTING_ERROR_CODES.INVALID_CONTEXT,
        message: `Canonical ${symbol} configuration is malformed.`,
      });
    }
  }

  private parseAddress(value: unknown): Address {
    if (typeof value !== 'string' || value !== value.trim()) throw new Error();
    const address = getAddress(value);
    if (isAddressEqual(address, zeroAddress)) throw new Error();
    return address;
  }

  private directCapability(operation: PaymentOperation): ArcCapabilityName {
    if (operation === 'SEND') return 'send';
    if (operation === 'PAYROLL') return 'sameTokenPayroll';
    if (operation === 'INVOICE') return 'invoice';
    return 'paymentLink';
  }

  private crossTokenCapability(operation: PaymentOperation): ArcCapabilityName {
    return operation === 'PAYROLL'
      ? 'crossTokenPayroll'
      : operation === 'SEND'
        ? 'swap'
        : 'crossTokenInvoice';
  }

  private decision(
    operation: PaymentOperation,
    tokenIn: { address: Address; symbol: ArcTokenSymbol },
    tokenOut: { address: Address; symbol: ArcTokenSymbol },
    kind: PaymentRouteDecision['kind'],
    provider: PaymentRouteDecision['provider'],
  ): PaymentRouteDecision {
    return Object.freeze({
      kind,
      network: this.network,
      operation,
      tokenIn: tokenIn.address,
      tokenInSymbol: tokenIn.symbol,
      tokenOut: tokenOut.address,
      tokenOutSymbol: tokenOut.symbol,
      provider,
    });
  }
}
