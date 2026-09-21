import {
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isArcCapabilityEnabled,
  parseArcCapabilityName,
  type ArcCapabilities,
  type ArcCapabilityName,
  type ArcNetworkKey,
} from '@wizpay/arc-network';
import {
  decodeFunctionData,
  isAddressEqual,
  type Address,
  type Hex,
} from 'viem';
import {
  PAYMENT_ROUTE_DECISIONS,
  type PaymentRouteDecision,
  PaymentRoutingService,
} from '../routing/payment-routing.service';
import { WIZPAY_PAYROLL_MAINNET_ABI } from '../contracts/generated/wizpay-payroll-mainnet.abi';
import { WIZPAY_SWAP_EXECUTOR_MAINNET_ABI } from '../contracts/generated/wizpay-swap-executor-mainnet.abi';

const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export const CAPABILITY_ERROR_CODES = Object.freeze({
  DISABLED: 'CAPABILITY_DISABLED',
  UNKNOWN: 'UNKNOWN_CAPABILITY',
  CONTEXT_REQUIRED: 'CAPABILITY_CONTEXT_REQUIRED',
});

export const CAPABILITY_UNAVAILABLE_MESSAGE =
  'This feature is unavailable on the selected Arc network.';

@Injectable()
export class CapabilityService {
  readonly network: ArcNetworkKey;
  readonly capabilities: ArcCapabilities;

  response() {
    return Object.freeze({
      network: this.network,
      capabilities: this.capabilities,
    });
  }

  assert(capability: unknown): asserts capability is ArcCapabilityName {
    let name: ArcCapabilityName;
    try {
      name = parseArcCapabilityName(capability);
    } catch {
      throw new BadRequestException({
        code: CAPABILITY_ERROR_CODES.UNKNOWN,
        message: 'Unknown feature capability.',
      });
    }
    if (!isArcCapabilityEnabled(this.capabilities, name)) {
      throw new ServiceUnavailableException({
        code: CAPABILITY_ERROR_CODES.DISABLED,
        capability: name,
        network: this.network,
        message: CAPABILITY_UNAVAILABLE_MESSAGE,
      });
    }
  }

  assertPayroll(payload: Record<string, unknown>) {
    const source = payload.sourceTokenAddress;
    const recipients = Array.isArray(payload.recipients)
      ? payload.recipients
      : [];
    if (!source || recipients.length === 0)
      return this.contextRequired('payroll');
    for (const value of recipients) {
      if (!value || typeof value !== 'object')
        return this.contextRequired('payroll');
      const target =
        (value as Record<string, unknown>).targetTokenAddress ?? source;
      if (!target) return this.contextRequired('payroll');
      this.assertPaymentDecision(
        this.routing.decide({
          network: this.network,
          operation: 'PAYROLL',
          tokenIn: source,
          tokenOut: target,
        }),
      );
    }
  }

  private assertPayrollApproval(params: Record<string, unknown>) {
    const contractAddress = params.contractAddress;
    const callData = params.callData;
    const wizpayAddress = this.config.get<string>(
      'arcNetwork.contracts.wizpay.address',
    );
    if (
      !this.tokenIdentity(contractAddress) ||
      typeof callData !== 'string' ||
      !wizpayAddress
    )
      return this.contextRequired('payroll approval');
    try {
      const decoded = decodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        data: callData as Hex,
      });
      if (
        decoded.functionName !== 'approve' ||
        !decoded.args ||
        !isAddressEqual(decoded.args[0], wizpayAddress as Address)
      )
        return this.contextRequired('payroll approval');
      if (isArcCapabilityEnabled(this.capabilities, 'sameTokenPayroll')) return;
      this.assert('crossTokenPayroll');
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return this.contextRequired('payroll approval');
    }
  }

  private assertPayrollCall(params: Record<string, unknown>) {
    const contractAddress = params.contractAddress;
    const callData = params.callData;
    const wizpayAddress = this.config.get<string>(
      'arcNetwork.contracts.wizpay.address',
    );
    if (
      typeof contractAddress !== 'string' ||
      typeof callData !== 'string' ||
      !wizpayAddress ||
      !/^0x[0-9a-fA-F]{40}$/.test(contractAddress) ||
      !isAddressEqual(contractAddress as Address, wizpayAddress as Address)
    )
      return this.contextRequired('payroll contract execution');
    try {
      this.assertMainnetPayrollCall(callData as Hex);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return this.contextRequired('payroll contract execution');
    }
  }

  private assertMainnetPayrollCall(callData: Hex) {
    const decoded = decodeFunctionData({
      abi: WIZPAY_PAYROLL_MAINNET_ABI,
      data: callData,
    });
    if (decoded.functionName === 'executeSameTokenPayroll' && decoded.args) {
      const [token] = decoded.args;
      this.assertPaymentDecision(
        this.routing.decide({
          network: this.network,
          operation: 'PAYROLL',
          tokenIn: token,
          tokenOut: token,
        }),
      );
      return;
    }
    if (decoded.functionName === 'executeCrossTokenPayroll' && decoded.args) {
      const [tokenIn, tokenOut] = decoded.args;
      this.assertPaymentDecision(
        this.routing.decide({
          network: this.network,
          operation: 'PAYROLL',
          tokenIn,
          tokenOut,
        }),
      );
      return;
    }
    return this.contextRequired('payroll contract execution');
  }

  private assertSwapCall(params: Record<string, unknown>) {
    this.assert('swap');
    if (this.network !== 'arc-mainnet')
      return this.contextRequired('swap contract execution');
    const contractAddress = params.contractAddress;
    const callData = params.callData;
    const executor = this.config.get<string>(
      'arcNetwork.contracts.wizpaySwapExecutorMainnet.address',
    );
    if (
      typeof contractAddress !== 'string' ||
      typeof callData !== 'string' ||
      !executor ||
      !isAddressEqual(contractAddress as Address, executor as Address)
    )
      return this.contextRequired('swap contract execution');
    try {
      const decoded = decodeFunctionData({
        abi: WIZPAY_SWAP_EXECUTOR_MAINNET_ABI,
        data: callData as Hex,
      });
      if (decoded.functionName !== 'executeSwap' || !decoded.args)
        return this.contextRequired('swap contract execution');
      const [tokenIn, tokenOut] = decoded.args;
      this.assertPaymentDecision(
        this.routing.decide({
          network: this.network,
          operation: 'SEND',
          tokenIn,
          tokenOut,
        }),
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return this.contextRequired('swap contract execution');
    }
  }

  private tokenIdentity(value: unknown): string | null {
    if (typeof value !== 'string' || value !== value.trim()) return null;
    if (value === 'USDC' || value === 'EURC') return value;
    const tokens = this.configuredTokenAddresses();
    const normalized = value.toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(normalized)) {
      if (tokens.USDC === normalized) return 'USDC';
      if (tokens.EURC === normalized) return 'EURC';
    }
    return null;
  }

  private assertPaymentDecision(
    decision: PaymentRouteDecision,
  ): PaymentRouteDecision {
    this.routing.assertExecutable(decision);
    if (decision.kind === PAYMENT_ROUTE_DECISIONS.DIRECT_TRANSFER) {
      this.assert(
        decision.operation === 'SEND'
          ? 'send'
          : decision.operation === 'PAYROLL'
            ? 'sameTokenPayroll'
            : decision.operation === 'INVOICE'
              ? 'invoice'
              : 'paymentLink',
      );
    }
    return decision;
  }

  private configuredTokenAddresses() {
    return {
      USDC: this.getTokenAddress('USDC'),
      EURC: this.getTokenAddress('EURC'),
    };
  }

  private getTokenAddress(symbol: 'USDC' | 'EURC') {
    const value =
      this.config.get<string>(`arcNetwork.tokens.${symbol}.address`) ?? '';
    return value.toLowerCase();
  }

  private contextRequired(operation: string): never {
    throw new BadRequestException({
      code: CAPABILITY_ERROR_CODES.CONTEXT_REQUIRED,
      message: `Explicit token context is required for ${operation}.`,
    });
  }

  constructor(
    private readonly config: ConfigService,
    private readonly routing: PaymentRoutingService,
  ) {
    this.network = config.getOrThrow<ArcNetworkKey>('arcNetwork.key');
    this.capabilities = config.getOrThrow<ArcCapabilities>('arcCapabilities');
  }
}
