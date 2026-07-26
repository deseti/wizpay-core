import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AppWalletSwapOperation } from '@prisma/client';
import { createHash } from 'crypto';
import {
  StablefxExecutionService,
  StablefxFundRequest,
} from '../user-swap/stablefx-execution.service';
import {
  USER_SWAP_EURC_ADDRESS,
  USER_SWAP_USDC_ADDRESS,
} from '../user-swap/user-swap.service';
import { normalizeTokenAmountToBaseUnits } from './app-wallet-swap-circle-transaction-matcher';
import { AppWalletSwapCircleExecutorService } from './app-wallet-swap-circle-executor.service';
import { mapAppWalletSwapOperationRecord } from './app-wallet-swap-operation.mapper';
import {
  AppWalletSwapOperationRepository,
  toAppWalletSwapNullableJson,
} from './app-wallet-swap-operation.repository';
import { sanitizeAppWalletSwapPayload } from './app-wallet-swap-payload-sanitizer';
import {
  getNestedString,
  getNestedValue,
  validTransactionHashOrNull,
} from './app-wallet-swap-provider-reference';
import {
  APP_WALLET_SWAP_CHAIN,
  APP_WALLET_SWAP_ERROR_CODES,
  AppWalletSwapOperationResponse,
  AppWalletSwapToken,
} from './app-wallet-swap.types';

const TOKEN_ADDRESS_BY_SYMBOL: Record<AppWalletSwapToken, string> = {
  USDC: USER_SWAP_USDC_ADDRESS,
  EURC: USER_SWAP_EURC_ADDRESS,
};
const DEFAULT_EXECUTION_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 20 * 1000;

export class AppWalletSwapStablefxResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppWalletSwapStablefxResponseError';
  }
}

class AppWalletSwapStablefxTerminalError extends AppWalletSwapStablefxResponseError {}

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
  private readonly logger = new Logger('AppWalletSwapService');

  constructor(
    private readonly stablefxExecutionService: StablefxExecutionService,
    private readonly circleExecutor: AppWalletSwapCircleExecutorService,
    @Optional()
    private readonly operationRepository?: AppWalletSwapOperationRepository,
  ) {}

  async submitTreasurySwapIfNeeded(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperationResponse> {
    if (!operation.provider) {
      throw new ServiceUnavailableException({
        code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_PROVIDER_INVALID,
        message:
          'App Wallet swap execution provider is missing or invalid. This operation requires manual recovery review.',
      });
    }
    if (operation.provider !== 'stablefx') return operation;

    if (
      operation.treasurySwapConfirmedAt &&
      operation.treasurySwapActualOutput
    ) {
      return operation;
    }

    if (operation.treasurySwapId) {
      return operation;
    }

    const now = new Date();
    const treasuryAddress = this.getArcTreasuryDepositAddress();
    const treasuryWalletId = this.getArcTreasuryWalletId();
    const amountIn = operation.depositConfirmedAmount ?? operation.amountIn;
    const pendingOperation = this.mapOperationRecord(
      await this.repository().update(operation.operationId, {
        status: 'stablefx_quote_requested',
        executionError: null,
        updatedAt: now,
      }),
    );
    const execution = await this.createTradeExecution({
      amountIn,
      approvalIdempotencyKey: this.deriveIdempotencyKey(
        pendingOperation.operationId,
        `stablefx-${pendingOperation.tokenIn.toLowerCase()}-permit2-approval`,
      ),
      approvalRefId: `APP-WALLET-SWAP-${pendingOperation.operationId}-STABLEFX-${pendingOperation.tokenIn}-APPROVAL`,
      chain: APP_WALLET_SWAP_CHAIN,
      tokenIn: pendingOperation.tokenIn,
      tokenInAddress: TOKEN_ADDRESS_BY_SYMBOL[pendingOperation.tokenIn],
      tokenOut: pendingOperation.tokenOut,
      tradeIdempotencyKey: this.deriveIdempotencyKey(
        pendingOperation.operationId,
        'stablefx-create-trade',
      ),
      treasuryAddress,
      treasuryWalletId,
    });
    this.logStablefxTreasuryApproval(execution.approval);

    return this.mapOperationRecord(
      await this.repository().update(pendingOperation.operationId, {
        status: 'stablefx_trade_created',
        treasurySwapId: execution.tradeId,
        treasurySwapQuoteId: execution.quoteId,
        treasurySwapSubmittedAt: new Date(),
        treasurySwapExpectedOutput: toAppWalletSwapNullableJson(
          execution.expectedOutput,
        ),
        rawTreasurySwap: toAppWalletSwapNullableJson({
          provider: 'stablefx',
          approval: execution.approval,
          quote: this.sanitizeForPersistence(execution.quote),
          trade: this.sanitizeForPersistence(execution.trade),
        }),
        executionError: null,
        updatedAt: new Date(),
      }),
    );
  }

  async confirmTreasurySwapIfPossible(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperationResponse> {
    if (!operation.provider) {
      throw new ServiceUnavailableException({
        code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_PROVIDER_INVALID,
        message:
          'App Wallet swap execution provider is missing or invalid. This operation requires manual recovery review.',
      });
    }
    if (operation.provider !== 'stablefx') return operation;
    if (
      operation.treasurySwapConfirmedAt &&
      operation.treasurySwapActualOutput
    ) {
      return operation;
    }

    if (!operation.treasurySwapId) {
      return operation;
    }

    const tradeId = operation.treasurySwapId;
    this.assertExecutionPollingWithinDeadline(operation);
    let tradeState = await this.pollStablefxTrade(tradeId);
    let trade = tradeState.raw;
    const contractTradeId = tradeState.contractTradeId;
    const status = tradeState.status;

    if (tradeState.isFailure) {
      throw new AppWalletSwapStablefxTerminalError(
        `StableFX Treasury trade failed with status ${status}.`,
      );
    }

    if (
      contractTradeId &&
      !operation.stablefxFundingRequestedAt &&
      operation.status !== 'stablefx_funded' &&
      operation.status !== 'stablefx_settled_to_treasury'
    ) {
      operation = this.mapOperationRecord(
        await this.repository().update(operation.operationId, {
          status: 'stablefx_contract_ready',
          rawTreasurySwap: toAppWalletSwapNullableJson({
            provider: 'stablefx',
            tradeId,
            contractTradeId,
            providerStatus: status,
            trade: this.sanitizeForPersistence(trade),
            observedAt: new Date().toISOString(),
          }),
          updatedAt: new Date(),
        }),
      );

      const funding = await this.prepareFunding({
        contractTradeId,
        memo: `WizPay App Wallet StableFX ${operation.tokenIn}->${operation.tokenOut} funding`,
        treasuryWalletId: this.getArcTreasuryWalletId(),
      });
      operation = this.mapOperationRecord(
        await this.repository().update(operation.operationId, {
          stablefxFundingRequestedAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      const fund = await this.fundTrade(funding.request);
      const fundState = this.interpretTrade(fund);

      operation = this.mapOperationRecord(
        await this.repository().update(operation.operationId, {
          status: 'stablefx_funded',
          rawTreasurySwap: toAppWalletSwapNullableJson({
            provider: 'stablefx',
            tradeId,
            contractTradeId,
            providerStatus: fundState.status,
            fund: this.sanitizeForPersistence(fund),
            observedAt: new Date().toISOString(),
          }),
          updatedAt: new Date(),
        }),
      );

      operation = this.mapOperationRecord(
        await this.repository().update(operation.operationId, {
          stablefxFundedAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      tradeState = await this.pollStablefxTrade(tradeId);
      trade = tradeState.raw;
    }

    const settlementHash = tradeState.settlementHash;
    const finalStatus = tradeState.status;

    if (tradeState.isFailure) {
      throw new AppWalletSwapStablefxTerminalError(
        `StableFX Treasury trade failed with status ${finalStatus}.`,
      );
    }

    if (!tradeState.isSettlementComplete) {
      return this.mapOperationRecord(
        await this.repository().update(operation.operationId, {
          rawTreasurySwap: toAppWalletSwapNullableJson({
            provider: 'stablefx',
            tradeId,
            contractTradeId,
            providerStatus: finalStatus,
            trade: this.sanitizeForPersistence(trade),
            observedAt: new Date().toISOString(),
          }),
          updatedAt: new Date(),
        }),
      );
    }

    const actualOutput =
      tradeState.actualOutput ??
      this.stringifyAmount(operation.treasurySwapExpectedOutput);

    if (!actualOutput) {
      return operation;
    }

    return this.mapOperationRecord(
      await this.repository().update(operation.operationId, {
        status: 'treasury_swap_confirmed',
        treasurySwapTxHash: settlementHash,
        treasurySwapConfirmedAt: new Date(),
        treasurySwapActualOutput: actualOutput,
        rawTreasurySwap: toAppWalletSwapNullableJson({
          provider: 'stablefx',
          tradeId,
          contractTradeId,
          providerStatus: finalStatus,
          settlementTxHash: settlementHash,
          trade: this.sanitizeForPersistence(trade),
          observedAt: new Date().toISOString(),
        }),
        executionError: null,
        updatedAt: new Date(),
      }),
    );
  }

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

  private repository(): AppWalletSwapOperationRepository {
    if (!this.operationRepository) {
      throw new Error(
        'App Wallet StableFX repository orchestration is not configured.',
      );
    }

    return this.operationRepository;
  }

  private mapOperationRecord(
    record: AppWalletSwapOperation,
  ): AppWalletSwapOperationResponse {
    return mapAppWalletSwapOperationRecord(record);
  }

  private sanitizeForPersistence(value: unknown): unknown {
    return sanitizeAppWalletSwapPayload(value);
  }

  private deriveIdempotencyKey(operationId: string, purpose: string): string {
    const hex = createHash('sha256')
      .update(`${operationId}:${purpose}`)
      .digest('hex');
    const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);

    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      `4${hex.slice(13, 16)}`,
      `${variant}${hex.slice(17, 20)}`,
      hex.slice(20, 32),
    ].join('-');
  }

  private logStablefxTreasuryApproval(
    approval: AppWalletSwapStablefxApprovalResult,
  ): void {
    this.logger.log(
      `[stablefx-app-wallet-treasury-approval] provider=stablefx ` +
        `tokenIn=${approval.tokenIn} tokenAddress=${approval.tokenAddress} ` +
        `treasuryAddress=${approval.treasuryAddress} ` +
        `approvalTarget=${approval.approvalTarget} ` +
        `messageSpender=${approval.messageSpender ?? 'unavailable'} ` +
        `allowanceBefore=${approval.allowanceBefore} ` +
        `approvalTxHash=${approval.approvalTxHash ?? 'not_required'} ` +
        `allowanceAfter=${approval.allowanceAfter}`,
    );
  }

  private async pollStablefxTrade(
    tradeId: string,
  ): Promise<AppWalletSwapStablefxTradeState> {
    return this.withProviderTimeout(
      this.getTradeState(tradeId),
      'StableFX trade polling timed out.',
    );
  }

  private assertExecutionPollingWithinDeadline(
    operation: AppWalletSwapOperationResponse,
  ): void {
    if (!operation.treasurySwapSubmittedAt) return;
    const configured = Number(process.env.APP_WALLET_SWAP_POLL_TIMEOUT_MS);
    const timeoutMs =
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_EXECUTION_POLL_TIMEOUT_MS;
    if (
      Date.now() - new Date(operation.treasurySwapSubmittedAt).getTime() >=
      timeoutMs
    ) {
      throw new AppWalletSwapStablefxTerminalError(
        'StableFX execution polling timed out. The operation requires recovery or a verified refund.',
      );
    }
  }

  private async withProviderTimeout<T>(
    promise: Promise<T>,
    message: string,
  ): Promise<T> {
    const configured = Number(process.env.APP_WALLET_PROVIDER_TIMEOUT_MS);
    const timeoutMs =
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private getArcTreasuryDepositAddress(): string {
    const address = process.env.CIRCLE_WALLET_ADDRESS_ARC?.trim().toLowerCase();

    if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
      throw new ServiceUnavailableException({
        code: APP_WALLET_SWAP_ERROR_CODES.TREASURY_NOT_CONFIGURED,
        message:
          'Arc treasury deposit address is not configured for App Wallet swap.',
      });
    }

    return address;
  }

  private getArcTreasuryWalletId(): string {
    const walletId = process.env.CIRCLE_WALLET_ID_ARC?.trim();

    if (!walletId) {
      throw new ServiceUnavailableException({
        code: APP_WALLET_SWAP_ERROR_CODES.TREASURY_NOT_CONFIGURED,
        message:
          'Arc treasury wallet id is not configured for App Wallet swap.',
      });
    }

    return walletId;
  }

  private stringifyAmount(value: unknown): string | undefined {
    const candidate = this.stringifyUnknown(value);

    return candidate && /^\d+$/.test(candidate) ? candidate : undefined;
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
