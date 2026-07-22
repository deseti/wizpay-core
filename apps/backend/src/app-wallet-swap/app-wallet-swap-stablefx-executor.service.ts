import { Injectable } from '@nestjs/common';
import {
  StablefxExecutionService,
  StablefxFundRequest,
} from '../user-swap/stablefx-execution.service';
import { normalizeTokenAmountToBaseUnits } from './app-wallet-swap-circle-transaction-matcher';
import { AppWalletSwapCircleExecutorService } from './app-wallet-swap-circle-executor.service';
import {
  getNestedString,
  getNestedValue,
  validTransactionHashOrNull,
} from './app-wallet-swap-provider-reference';
import { AppWalletSwapToken } from './app-wallet-swap.types';

export class AppWalletSwapStablefxResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppWalletSwapStablefxResponseError';
  }
}

export interface AppWalletSwapStablefxTradeExecutionInput {
  amountIn: string;
  approvalIdempotencyKey: string;
  approvalRefId: string;
  chain: string;
  tokenIn: AppWalletSwapToken;
  tokenInAddress: string;
  tokenOut: AppWalletSwapToken;
  tradeIdempotencyKey: string;
  treasuryAddress: string;
  treasuryWalletId: string;
}

export interface AppWalletSwapStablefxApprovalResult {
  allowanceAfter: string;
  allowanceBefore: string;
  approvalTarget: string;
  approvalTxHash?: string | null;
  messageSpender?: string;
  tokenAddress: string;
  tokenIn: AppWalletSwapToken;
  treasuryAddress: string;
}

export interface AppWalletSwapStablefxTradeExecutionResult {
  approval: AppWalletSwapStablefxApprovalResult;
  expectedOutput: string | null;
  quote: Record<string, unknown>;
  quoteId: string;
  trade: Record<string, unknown>;
  tradeId: string;
}

export interface AppWalletSwapStablefxFundingPreparationInput {
  contractTradeId: string;
  memo: string;
  treasuryWalletId: string;
}

export interface AppWalletSwapStablefxFundingPreparationResult {
  request: StablefxFundRequest;
}

export interface AppWalletSwapStablefxTradeState {
  actualOutput: string | null;
  contractTradeId: string | null;
  isFailure: boolean;
  isSettlementComplete: boolean;
  makerDeliver: unknown;
  makerDeliverStatus: string | null;
  raw: Record<string, unknown>;
  settlementHash: string | null;
  status: string;
}

@Injectable()
export class AppWalletSwapStablefxExecutorService {
  constructor(
    private readonly stablefxExecutionService: StablefxExecutionService,
    private readonly circleExecutor: AppWalletSwapCircleExecutorService,
  ) {}

  async createTradeExecution(
    input: Readonly<AppWalletSwapStablefxTradeExecutionInput>,
  ): Promise<AppWalletSwapStablefxTradeExecutionResult> {
    const quote = await this.stablefxExecutionService.createTradableQuote({
      amountIn: input.amountIn,
      chain: input.chain,
      fromAddress: input.treasuryAddress,
      recipientAddress: input.treasuryAddress,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
    });
    const quoteId = this.stringifyUnknown(quote.id ?? quote.quoteId);
    const typedData = this.getTypedDataObject(quote);

    if (!quoteId || !typedData || !this.isRecord(typedData.message)) {
      throw new AppWalletSwapStablefxResponseError(
        'StableFX Treasury quote did not include quoteId and signable typedData.',
      );
    }

    const approvalTarget = this.getPermit2ApprovalTarget(typedData);
    const messageSpender = this.validContractAddressOrNull(
      getNestedString(typedData, ['message', 'spender']),
    );
    const requiredAllowance = BigInt(input.amountIn);
    const { allowanceAfter, allowanceBefore, approvalTxHash } =
      await this.circleExecutor.ensureTokenAllowance({
        approvalTarget,
        contractAddress: input.tokenInAddress,
        idempotencyKey: input.approvalIdempotencyKey,
        network: input.chain,
        refId: input.approvalRefId,
        requiredAllowance,
        treasuryAddress: input.treasuryAddress,
        walletId: input.treasuryWalletId,
      });
    const approval: AppWalletSwapStablefxApprovalResult = {
      allowanceAfter,
      allowanceBefore,
      approvalTarget,
      ...(approvalTxHash !== undefined ? { approvalTxHash } : {}),
      ...(messageSpender ? { messageSpender } : {}),
      tokenAddress: input.tokenInAddress,
      tokenIn: input.tokenIn,
      treasuryAddress: input.treasuryAddress,
    };
    const signedQuote = await this.circleExecutor.signTypedData({
      walletId: input.treasuryWalletId,
      typedData,
      memo: `WizPay App Wallet StableFX ${input.tokenIn}->${input.tokenOut} quote`,
    });
    const trade = await this.stablefxExecutionService.createTrade({
      idempotencyKey: input.tradeIdempotencyKey,
      quoteId,
      address: input.treasuryAddress,
      selectedAddress: input.treasuryAddress,
      message: typedData.message,
      signature: signedQuote.signature,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      walletMode: 'app',
    });

    return {
      approval,
      expectedOutput: this.readToAmountBaseUnits(quote),
      quote,
      quoteId,
      trade,
      tradeId: this.resolveTradeId(trade),
    };
  }

  async prepareFunding(
    input: Readonly<AppWalletSwapStablefxFundingPreparationInput>,
  ): Promise<AppWalletSwapStablefxFundingPreparationResult> {
    const fundingPresign =
      await this.stablefxExecutionService.createFundingPresign({
        contractTradeId: input.contractTradeId,
      });
    const typedData = this.getTypedDataObject(fundingPresign);

    if (!typedData || !this.isRecord(typedData.message)) {
      throw new AppWalletSwapStablefxResponseError(
        'StableFX Treasury funding presign did not include signable typedData.',
      );
    }

    const signedFunding = await this.circleExecutor.signTypedData({
      walletId: input.treasuryWalletId,
      typedData,
      memo: input.memo,
    });

    return {
      request: {
        permit2: typedData.message,
        signature: signedFunding.signature,
      },
    };
  }

  fundTrade(
    request: Readonly<StablefxFundRequest>,
  ): Promise<Record<string, unknown>> {
    return this.stablefxExecutionService.fund(request);
  }

  async getTradeState(
    tradeId: string,
  ): Promise<AppWalletSwapStablefxTradeState> {
    const raw = await this.stablefxExecutionService.getTrade(tradeId);

    return this.interpretTrade(raw);
  }

  interpretTrade(
    raw: Record<string, unknown>,
  ): AppWalletSwapStablefxTradeState {
    const status = this.resolveStatus(raw);
    const makerDeliver = this.getMakerDeliver(raw);
    const makerDeliverStatus =
      getNestedString(makerDeliver, ['status']) ?? null;
    const normalizedStatus = status.toLowerCase();

    return {
      actualOutput: this.readToAmountBaseUnits(raw),
      contractTradeId: this.resolveContractTradeId(raw),
      isFailure: this.isFailureStatus(status),
      isSettlementComplete:
        ['complete', 'completed', 'settled'].includes(normalizedStatus) &&
        (makerDeliver === null ||
          makerDeliver === undefined ||
          makerDeliverStatus?.toLowerCase() === 'success'),
      makerDeliver,
      makerDeliverStatus,
      raw,
      settlementHash: this.extractSettlementHash(raw),
      status,
    };
  }

  private getTypedDataObject(raw: unknown): Record<string, unknown> | null {
    const typedData = getNestedValue(raw, ['typedData']);

    return this.isRecord(typedData) ? typedData : null;
  }

  private getPermit2ApprovalTarget(typedData: Record<string, unknown>): string {
    const approvalTarget = this.validContractAddressOrNull(
      getNestedString(typedData, ['domain', 'verifyingContract']),
    );

    if (!approvalTarget) {
      throw new AppWalletSwapStablefxResponseError(
        'StableFX Treasury quote typedData did not include a valid Permit2 verifyingContract approval target.',
      );
    }

    return approvalTarget;
  }

  private resolveTradeId(raw: unknown): string {
    const tradeId =
      getNestedString(raw, ['id']) ??
      getNestedString(raw, ['tradeId']) ??
      getNestedString(raw, ['data', 'id']) ??
      getNestedString(raw, ['data', 'tradeId']);

    if (!tradeId) {
      throw new AppWalletSwapStablefxResponseError(
        'StableFX create_trade did not return a trade identifier.',
      );
    }

    return tradeId;
  }

  private resolveContractTradeId(raw: unknown): string | null {
    return (
      getNestedString(raw, ['contractTradeId']) ??
      getNestedString(raw, ['data', 'contractTradeId']) ??
      getNestedString(raw, ['trade', 'contractTradeId']) ??
      getNestedString(raw, ['data', 'trade', 'contractTradeId'])
    );
  }

  private resolveStatus(raw: unknown): string {
    return (
      getNestedString(raw, ['status']) ??
      getNestedString(raw, ['data', 'status']) ??
      'unknown'
    );
  }

  private isFailureStatus(status: string): boolean {
    return ['failed', 'rejected', 'expired', 'breached', 'refunded'].includes(
      status.toLowerCase(),
    );
  }

  private getMakerDeliver(raw: unknown): unknown {
    return (
      getNestedValue(raw, ['contractTransactions', 'makerDeliver']) ??
      getNestedValue(raw, ['data', 'contractTransactions', 'makerDeliver'])
    );
  }

  extractSettlementHash(raw: unknown): string | null {
    return validTransactionHashOrNull(
      getNestedString(raw, ['settlementTransactionHash']) ??
        getNestedString(raw, ['data', 'settlementTransactionHash']) ??
        getNestedString(raw, [
          'contractTransactions',
          'makerDeliver',
          'txHash',
        ]) ??
        getNestedString(raw, [
          'data',
          'contractTransactions',
          'makerDeliver',
          'txHash',
        ]),
    );
  }

  private readToAmountBaseUnits(raw: unknown): string | null {
    const amount =
      getNestedString(raw, ['to', 'amount']) ??
      getNestedString(raw, ['data', 'to', 'amount']);

    return amount
      ? (normalizeTokenAmountToBaseUnits(amount, 6)?.toString() ?? null)
      : null;
  }

  private stringifyUnknown(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return this.stringifyUnknown(
        record.amount ?? record.value ?? record.toAmount,
      );
    }

    return undefined;
  }

  private validContractAddressOrNull(value: unknown): string | null {
    return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)
      ? value
      : null;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
