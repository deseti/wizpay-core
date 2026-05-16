import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { UserSwapService } from '../user-swap/user-swap.service';
import {
  APP_WALLET_SWAP_CHAIN,
  APP_WALLET_SWAP_ERROR_CODES,
  APP_WALLET_SWAP_MODE,
  AppWalletSwapOperationRequest,
  AppWalletSwapOperationResponse,
  AppWalletSwapQuoteRequest,
  AppWalletSwapQuoteResponse,
  AppWalletSwapToken,
} from './app-wallet-swap.types';

const SUPPORTED_TOKENS = new Set<AppWalletSwapToken>(['USDC', 'EURC']);
const DEFAULT_QUOTE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class AppWalletSwapService {
  private readonly operations = new Map<string, AppWalletSwapOperationResponse>();

  constructor(private readonly userSwapService: UserSwapService) {}

  async quote(
    request: AppWalletSwapQuoteRequest,
  ): Promise<AppWalletSwapQuoteResponse> {
    const normalized = this.normalizeRequest(request);
    const treasuryDepositAddress = this.getArcTreasuryDepositAddress();
    const userSwapQuote = await this.userSwapService.quote({
      amountIn: normalized.amountIn,
      chain: APP_WALLET_SWAP_CHAIN,
      fromAddress: treasuryDepositAddress,
      toAddress: normalized.fromAddress,
      tokenIn: normalized.tokenIn,
      tokenOut: normalized.tokenOut,
    });

    return {
      operationMode: APP_WALLET_SWAP_MODE,
      sourceChain: APP_WALLET_SWAP_CHAIN,
      tokenIn: normalized.tokenIn,
      tokenOut: normalized.tokenOut,
      amountIn: normalized.amountIn,
      treasuryDepositAddress,
      expectedOutput: userSwapQuote.expectedOutput ?? null,
      minimumOutput: userSwapQuote.minimumOutput ?? null,
      expiresAt: this.normalizeExpiry(userSwapQuote.expiresAt),
      status: 'quoted',
      quoteId: userSwapQuote.quoteId,
      rawQuote: userSwapQuote.raw,
    };
  }

  async createOperation(
    request: AppWalletSwapOperationRequest,
  ): Promise<AppWalletSwapOperationResponse> {
    const quote = await this.quote(request);
    const now = new Date().toISOString();
    const operation: AppWalletSwapOperationResponse = {
      ...quote,
      operationId: randomUUID(),
      status: 'awaiting_user_deposit',
      userWalletAddress: this.normalizeAddress(request.fromAddress),
      createdAt: now,
      updatedAt: now,
      executionEnabled: this.isExecutionEnabled(),
    };

    this.operations.set(operation.operationId, operation);
    return operation;
  }

  getOperation(operationId: string): AppWalletSwapOperationResponse {
    const operation = this.operations.get(operationId);

    if (!operation) {
      throw new NotFoundException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'App Wallet swap operation was not found.',
      });
    }

    return operation;
  }

  assertExecutionEnabled(): void {
    if (!this.isExecutionEnabled()) {
      throw new ServiceUnavailableException({
        code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_DISABLED,
        message:
          'App Wallet treasury-mediated swap execution is disabled. Set APP_WALLET_TREASURY_SWAP_EXECUTION_ENABLED=true to enable a future execute endpoint.',
      });
    }
  }

  private normalizeRequest(request: AppWalletSwapQuoteRequest) {
    const tokenIn = this.normalizeToken(request.tokenIn);
    const tokenOut = this.normalizeToken(request.tokenOut);
    const amountIn = request.amountIn?.trim();
    const fromAddress = this.normalizeAddress(request.fromAddress);

    if (request.chain !== APP_WALLET_SWAP_CHAIN) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.UNSUPPORTED_CHAIN,
        message:
          'Treasury-mediated App Wallet swap supports ARC-TESTNET only.',
      });
    }

    if (tokenIn === tokenOut) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'tokenIn and tokenOut must be different supported tokens.',
      });
    }

    if (!amountIn || !this.isPositiveDecimal(amountIn)) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'amountIn must be a positive decimal string.',
      });
    }

    return {
      tokenIn,
      tokenOut,
      amountIn,
      fromAddress,
    };
  }

  private normalizeToken(value: string): AppWalletSwapToken {
    const normalized = value?.trim().toUpperCase();

    if (!SUPPORTED_TOKENS.has(normalized as AppWalletSwapToken)) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'Only USDC and EURC are supported for App Wallet swap.',
      });
    }

    return normalized as AppWalletSwapToken;
  }

  private normalizeAddress(value: string): string {
    const normalized = value?.trim().toLowerCase();

    if (!/^0x[a-fA-F0-9]{40}$/.test(normalized ?? '')) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'fromAddress must be an EVM address.',
      });
    }

    return normalized;
  }

  private getArcTreasuryDepositAddress(): string {
    const address = process.env.CIRCLE_WALLET_ADDRESS_ARC?.trim().toLowerCase();

    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      throw new ServiceUnavailableException({
        code: APP_WALLET_SWAP_ERROR_CODES.TREASURY_NOT_CONFIGURED,
        message:
          'Arc treasury deposit address is not configured for App Wallet swap.',
      });
    }

    return address;
  }

  private normalizeExpiry(value: unknown): string {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    return new Date(Date.now() + DEFAULT_QUOTE_TTL_MS).toISOString();
  }

  private isExecutionEnabled(): boolean {
    return process.env.APP_WALLET_TREASURY_SWAP_EXECUTION_ENABLED === 'true';
  }

  private isPositiveDecimal(value: string): boolean {
    if (!/^(?:\d+|\d*\.\d+)$/.test(value)) {
      return false;
    }

    return Number(value) > 0;
  }
}
