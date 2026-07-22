import { AppWalletSwapOperation } from '@prisma/client';
import {
  BadRequestException,
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import {
  USER_SWAP_EURC_ADDRESS,
  USER_SWAP_USDC_ADDRESS,
  UserSwapService,
} from '../user-swap/user-swap.service';
import { AppWalletSwapDepositVerifierService } from './app-wallet-swap-deposit-verifier.service';
import { AppWalletSwapCircleExecutorService } from './app-wallet-swap-circle-executor.service';
import {
  buildDepositResolutionDiagnostic,
  equalsIgnoreCase,
  findMatchingCircleDepositTransaction,
  isFailedCircleTransactionStatus,
  normalizeTokenAmountToBaseUnits,
  type CircleDepositTransactionMatch,
} from './app-wallet-swap-circle-transaction-matcher';
import {
  mapAppWalletSwapOperationRecord,
  toPublicAppWalletSwapOperation,
  toPublicAppWalletSwapQuote,
} from './app-wallet-swap-operation.mapper';
import {
  AppWalletSwapOperationRepository,
  toAppWalletSwapNullableJson,
} from './app-wallet-swap-operation.repository';
import {
  describeAppWalletSwapPayloadShape,
  sanitizeAppWalletSwapPayload,
} from './app-wallet-swap-payload-sanitizer';
import {
  extractCircleTransactionHash as extractCircleTransactionHashFromPayload,
  getNestedString as getNestedStringFromPayload,
  validTransactionHashOrNull,
} from './app-wallet-swap-provider-reference';
import { AppWalletSwapPayoutExecutorService } from './app-wallet-swap-payout-executor.service';
import { AppWalletSwapTreasuryVerifierService } from './app-wallet-swap-treasury-verifier.service';
import {
  AppWalletSwapStablefxExecutorService,
  AppWalletSwapStablefxResponseError,
  type AppWalletSwapStablefxApprovalResult,
  type AppWalletSwapStablefxTradeState,
} from './app-wallet-swap-stablefx-executor.service';
import {
  APP_WALLET_SWAP_CHAIN,
  APP_WALLET_SWAP_ERROR_CODES,
  APP_WALLET_SWAP_MODE,
  AppWalletSwapDepositRequest,
  AppWalletSwapDepositTxHashRequest,
  AppWalletSwapOperationRequest,
  AppWalletSwapOperationResponse,
  AppWalletSwapQuoteRequest,
  AppWalletSwapQuoteResponse,
  AppWalletSwapToken,
} from './app-wallet-swap.types';

const SUPPORTED_TOKENS = new Set<AppWalletSwapToken>(['USDC', 'EURC']);
const TOKEN_ADDRESS_BY_SYMBOL: Record<AppWalletSwapToken, string> = {
  USDC: USER_SWAP_USDC_ADDRESS,
  EURC: USER_SWAP_EURC_ADDRESS,
};
const TOKEN_DECIMALS_BY_SYMBOL: Record<AppWalletSwapToken, number> = {
  USDC: 6,
  EURC: 6,
};
const DEFAULT_QUOTE_TTL_MS = 5 * 60 * 1000;
const STABLEFX_MIN_BASE_UNITS = 10_000_000n;
const STABLEFX_APP_WALLET_PAIRS = new Set(['USDC->EURC', 'EURC->USDC']);
const DEFAULT_EXECUTION_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 20 * 1000;
const EXECUTION_LEASE_MS = 15 * 60 * 1000;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

class TerminalExecutionError extends Error {}

@Injectable()
export class AppWalletSwapService {
  private readonly logger = new Logger(AppWalletSwapService.name);

  constructor(
    private readonly userSwapService: UserSwapService,
    private readonly depositVerifier: AppWalletSwapDepositVerifierService,
    private readonly treasuryVerifier: AppWalletSwapTreasuryVerifierService,
    private readonly circleExecutor: AppWalletSwapCircleExecutorService,
    private readonly stablefxExecutor: AppWalletSwapStablefxExecutorService,
    private readonly payoutExecutor: AppWalletSwapPayoutExecutorService,
    private readonly operationRepository: AppWalletSwapOperationRepository,
  ) {}

  async quote(
    request: AppWalletSwapQuoteRequest,
  ): Promise<AppWalletSwapQuoteResponse> {
    return this.toPublicQuote(await this.buildQuote(request));
  }

  private async buildQuote(
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
    const quoteProvider = this.toAppWalletQuoteProvider(userSwapQuote.provider);

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
      provider: quoteProvider,
      quoteId: userSwapQuote.quoteId,
      rawQuote: this.attachQuoteProvider(userSwapQuote.raw, quoteProvider),
    };
  }

  async createOperation(
    request: AppWalletSwapOperationRequest,
  ): Promise<AppWalletSwapOperationResponse> {
    const quote = await this.buildQuote(request);
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

    return this.toPublicOperation(
      this.mapOperationRecord(await this.operationRepository.create(operation)),
    );
  }

  async getOperation(
    operationId: string,
  ): Promise<AppWalletSwapOperationResponse> {
    this.assertOperationId(operationId);

    return this.toPublicOperation(
      await this.getOperationForExecution(operationId),
    );
  }

  private async getOperationForExecution(
    operationId: string,
  ): Promise<AppWalletSwapOperationResponse> {
    this.assertOperationId(operationId);

    const operation = await this.operationRepository.findById(operationId);

    if (!operation) {
      throw new NotFoundException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'App Wallet swap operation was not found.',
      });
    }

    return this.mapOperationRecord(operation);
  }

  async submitDeposit(
    operationId: string,
    request: AppWalletSwapDepositRequest,
  ): Promise<AppWalletSwapOperationResponse> {
    this.assertOperationId(operationId);

    const operation = await this.getOperationForExecution(operationId);

    if (operation.status !== 'awaiting_user_deposit') {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'App Wallet swap operation is not awaiting a user deposit.',
      });
    }

    const depositTxHash = this.normalizeOptionalString(request.depositTxHash);
    const circleWalletId = this.normalizeOptionalString(request.circleWalletId);
    const circleTransactionId = this.normalizeOptionalString(
      request.circleTransactionId,
    );
    const circleReferenceId = this.normalizeOptionalString(
      request.circleReferenceId,
    );

    if (
      !depositTxHash &&
      !circleTransactionId &&
      !circleReferenceId &&
      !circleWalletId
    ) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message:
          'Provide depositTxHash, circleTransactionId, circleReferenceId, or circleWalletId.',
      });
    }

    if (depositTxHash) {
      this.assertDepositTxHash(depositTxHash);
    }

    const now = new Date().toISOString();
    const updatedOperation = this.mapOperationRecord(
      await this.operationRepository.update(operationId, {
        status: 'deposit_submitted',
        ...(depositTxHash ? { depositTxHash } : {}),
        ...(circleWalletId ? { circleWalletId } : {}),
        ...(circleTransactionId ? { circleTransactionId } : {}),
        ...(circleReferenceId ? { circleReferenceId } : {}),
        depositSubmittedAt: new Date(now),
        updatedAt: new Date(now),
      }),
    );

    if (!updatedOperation.depositTxHash) {
      return this.resolveDepositTxHash(updatedOperation.operationId).catch(() =>
        this.toPublicOperation(updatedOperation),
      );
    }

    return this.toPublicOperation(updatedOperation);
  }

  async attachDepositTxHash(
    operationId: string,
    request: AppWalletSwapDepositTxHashRequest,
  ): Promise<AppWalletSwapOperationResponse> {
    this.assertOperationId(operationId);

    const operation = await this.getOperationForExecution(operationId);

    if (operation.status !== 'deposit_submitted') {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message:
          'App Wallet swap operation must be deposit_submitted before attaching a deposit txHash.',
      });
    }

    const depositTxHash = this.normalizeOptionalString(request.depositTxHash);

    if (!depositTxHash) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'depositTxHash is required.',
      });
    }

    this.assertDepositTxHash(depositTxHash);

    return this.toPublicOperation(
      this.mapOperationRecord(
        await this.operationRepository.update(operationId, {
          depositTxHash,
          depositConfirmationError: null,
          updatedAt: new Date(),
        }),
      ),
    );
  }

  async resolveDepositTxHash(
    operationId: string,
  ): Promise<AppWalletSwapOperationResponse> {
    this.assertOperationId(operationId);

    const operation = await this.getOperationForExecution(operationId);

    if (operation.status !== 'deposit_submitted') {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message:
          'App Wallet swap operation must be deposit_submitted before resolving a deposit txHash.',
      });
    }

    if (operation.depositTxHash) {
      return this.toPublicOperation(operation);
    }

    const lookupIds = [
      operation.circleTransactionId,
      operation.circleReferenceId,
    ].filter((value): value is string => Boolean(value));

    if (lookupIds.length === 0 && !operation.circleWalletId) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message:
          'Circle transaction, reference id, or wallet id is required before resolving a deposit txHash.',
      });
    }

    for (const lookupId of lookupIds) {
      const transactionResponse = await this.circleExecutor
        .getW3sTransaction(lookupId)
        .catch(() => null);
      const directMatch = findMatchingCircleDepositTransaction(
        transactionResponse,
        operation,
        TOKEN_ADDRESS_BY_SYMBOL,
      );
      this.logRelaxedCircleDepositMatch(directMatch, operation);
      const depositTxHash = extractCircleTransactionHashFromPayload(
        directMatch?.transaction,
      );

      if (depositTxHash) {
        return this.attachDepositTxHash(operationId, { depositTxHash });
      }
    }

    const listTransactionsParams = operation.circleWalletId
      ? { walletIds: operation.circleWalletId }
      : {
          blockchain: APP_WALLET_SWAP_CHAIN,
          destinationAddress: operation.treasuryDepositAddress,
        };

    const transactionListResponse = await this.circleExecutor
      .listW3sTransactions(listTransactionsParams)
      .catch(() => null);

    const matchingDeposit = findMatchingCircleDepositTransaction(
      transactionListResponse,
      operation,
      TOKEN_ADDRESS_BY_SYMBOL,
    );
    this.logRelaxedCircleDepositMatch(matchingDeposit, operation);
    const listDepositTxHash = extractCircleTransactionHashFromPayload(
      matchingDeposit?.transaction,
    );

    if (listDepositTxHash) {
      return this.attachDepositTxHash(operationId, {
        depositTxHash: listDepositTxHash,
      });
    }

    const diagnostic = buildDepositResolutionDiagnostic(
      transactionListResponse,
      operation,
      TOKEN_ADDRESS_BY_SYMBOL,
    );

    if (diagnostic) {
      this.logger.warn(
        `App Wallet ${operation.tokenIn} deposit txHash unresolved for operation ${operation.operationId}: ${diagnostic}`,
      );
    }

    return this.toPublicOperation(
      this.mapOperationRecord(
        await this.operationRepository.update(operationId, {
          depositConfirmationError: diagnostic
            ? `Deposit txHash is not available from Circle yet. Retry shortly. Candidate transaction shapes: ${diagnostic}`
            : 'Deposit txHash is not available from Circle yet. Retry shortly.',
          updatedAt: new Date(),
        }),
      ),
    );
  }

  private logRelaxedCircleDepositMatch(
    match: CircleDepositTransactionMatch | null,
    operation: AppWalletSwapOperationResponse,
  ): void {
    if (match?.destinationAddressMissing) {
      this.logger.log(
        `App Wallet ${operation.tokenIn} deposit txHash matched operation ${operation.operationId} by token transfer fields with no Circle destinationAddress.`,
      );
    }
  }

  async confirmDeposit(
    operationId: string,
  ): Promise<AppWalletSwapOperationResponse> {
    this.assertOperationId(operationId);

    const operation = await this.getOperationForExecution(operationId);

    if (operation.status !== 'deposit_submitted') {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message:
          'App Wallet swap operation must be deposit_submitted before deposit confirmation.',
      });
    }

    const now = new Date().toISOString();

    if (!operation.depositTxHash) {
      return this.toPublicOperation(
        this.mapOperationRecord(
          await this.operationRepository.update(operationId, {
            depositConfirmationError:
              'Deposit txHash is not available yet. Circle reference alone is not on-chain confirmation.',
            updatedAt: new Date(now),
          }),
        ),
      );
    }

    const verification = await this.depositVerifier
      .verifyDeposit({
        amountIn: operation.amountIn,
        depositTxHash: operation.depositTxHash,
        tokenIn: operation.tokenIn,
        treasuryDepositAddress: operation.treasuryDepositAddress,
        userWalletAddress: operation.userWalletAddress,
      })
      .catch(() => null);

    if (!verification) {
      return this.toPublicOperation(
        this.mapOperationRecord(
          await this.operationRepository.update(operationId, {
            depositConfirmationError:
              'Deposit could not be verified on-chain yet. Retry after the transaction is indexed.',
            updatedAt: new Date(now),
          }),
        ),
      );
    }

    if (!verification.confirmed) {
      return this.toPublicOperation(
        this.mapOperationRecord(
          await this.operationRepository.update(operationId, {
            depositConfirmationError:
              verification.error ?? 'Deposit could not be confirmed on-chain.',
            updatedAt: new Date(now),
          }),
        ),
      );
    }

    return this.toPublicOperation(
      this.mapOperationRecord(
        await this.operationRepository.update(operationId, {
          status: 'deposit_confirmed',
          depositConfirmedAt: new Date(now),
          depositConfirmedAmount: verification.confirmedAmount,
          depositConfirmationError: null,
          updatedAt: new Date(now),
        }),
      ),
    );
  }

  async execute(operationId: string): Promise<AppWalletSwapOperationResponse> {
    this.assertOperationId(operationId);

    let operation = await this.getOperationForExecution(operationId);

    if (operation.status === 'completed') {
      return this.toPublicOperation(operation);
    }

    this.assertExecutableOperation(operation);

    const leaseId = randomUUID();
    if (!(await this.claimExecution(operationId, leaseId))) {
      return this.getOperation(operationId);
    }

    try {
      operation = await this.getOperationForExecution(operationId);
      operation = await this.submitTreasurySwapIfNeeded(operation);
      operation = await this.confirmTreasurySwapIfPossible(operation);

      if (!operation.treasurySwapConfirmedAt) {
        return this.toPublicOperation(operation);
      }

      operation = await this.submitPayoutIfNeeded(operation);
      operation = await this.confirmPayoutIfPossible(operation);

      return this.toPublicOperation(operation);
    } catch (error) {
      return this.toPublicOperation(
        await this.markExecutionError(operation.operationId, error),
      );
    } finally {
      await this.releaseExecution(operationId, leaseId);
    }
  }

  async refund(operationId: string): Promise<AppWalletSwapOperationResponse> {
    this.assertOperationId(operationId);
    let operation = await this.getOperationForExecution(operationId);

    if (operation.status === 'refunded') {
      return this.toPublicOperation(operation);
    }
    if (
      ![
        'execution_recovery_required',
        'execution_failed',
        'refund_pending',
        'refund_submitted',
      ].includes(operation.status)
    ) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.REFUND_NOT_SAFE,
        message: 'This App Wallet swap operation is not eligible for recovery.',
      });
    }

    const leaseId = randomUUID();
    if (!(await this.claimExecution(operationId, leaseId))) {
      return this.getOperation(operationId);
    }

    try {
      operation = await this.getOperationForExecution(operationId);
      operation = await this.submitRefundIfSafe(operation);
      return this.toPublicOperation(
        await this.confirmRefundIfPossible(operation),
      );
    } catch (error) {
      return this.toPublicOperation(
        await this.markExecutionError(operationId, error),
      );
    } finally {
      await this.releaseExecution(operationId, leaseId);
    }
  }

  private async claimExecution(
    operationId: string,
    leaseId: string,
  ): Promise<boolean> {
    const now = new Date();

    return this.operationRepository.claimExecutionLease(
      operationId,
      leaseId,
      now,
      new Date(now.getTime() + EXECUTION_LEASE_MS),
    );
  }

  private async releaseExecution(
    operationId: string,
    leaseId: string,
  ): Promise<void> {
    await this.operationRepository.releaseExecutionLease(operationId, leaseId);
  }

  assertExecutionEnabled(): void {
    if (!this.isExecutionEnabled()) {
      throw new ServiceUnavailableException({
        code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_DISABLED,
        message:
          'App Wallet treasury-mediated swap execution is disabled. Set APP_WALLET_TREASURY_SWAP_EXECUTION_ENABLED=true to enable treasury swap and payout execution.',
      });
    }
  }

  private assertExecutableOperation(
    operation: AppWalletSwapOperationResponse,
  ): void {
    const allowedStatuses: AppWalletSwapOperationResponse['status'][] = [
      'deposit_confirmed',
      'stablefx_quote_requested',
      'stablefx_trade_created',
      'stablefx_contract_ready',
      'stablefx_funded',
      'stablefx_settled_to_treasury',
      'treasury_swap_pending',
      'treasury_swap_submitted',
      'treasury_swap_confirmed',
      'payout_pending',
      'payout_submitted',
      'payout_confirmed',
      'execution_failed',
    ];

    if (!allowedStatuses.includes(operation.status)) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message:
          'App Wallet swap operation must be deposit_confirmed before execution.',
      });
    }

    if (!operation.depositTxHash) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message:
          'App Wallet swap operation requires a verified deposit txHash before execution.',
      });
    }

    if (!operation.depositConfirmedAt) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message:
          'App Wallet swap operation requires on-chain deposit confirmation before execution.',
      });
    }

    if (!operation.executionEnabled) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message:
          'App Wallet swap operation was created while treasury execution was disabled. Create a new operation after enabling execution.',
      });
    }

    if (
      !SUPPORTED_TOKENS.has(operation.tokenIn) ||
      !SUPPORTED_TOKENS.has(operation.tokenOut)
    ) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'Only App Wallet USDC and EURC treasury swaps are supported.',
      });
    }

    if (operation.tokenIn === operation.tokenOut) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'tokenIn and tokenOut must be different supported tokens.',
      });
    }

    const treasuryAddress = this.getArcTreasuryDepositAddress();

    if (!equalsIgnoreCase(operation.treasuryDepositAddress, treasuryAddress)) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message:
          'App Wallet swap treasury deposit address does not match the configured Arc treasury wallet.',
      });
    }

    this.assertExecutionEnabled();
    this.assertTreasuryExecutionConfig();
  }

  private assertTreasuryExecutionConfig(): void {
    const isStablefx =
      process.env.WIZPAY_SWAP_PROVIDER?.trim().toLowerCase() === 'stablefx';
    const missing = [
      'CIRCLE_WALLET_ID_ARC',
      'CIRCLE_WALLET_ADDRESS_ARC',
      'CIRCLE_API_KEY',
      'CIRCLE_ENTITY_SECRET',
      isStablefx ? 'CIRCLE_STABLEFX_API_KEY' : 'WIZPAY_USER_SWAP_KIT_KEY',
    ].filter((name) => !process.env[name]?.trim());

    if (process.env.WIZPAY_USER_SWAP_ENABLED !== 'true') {
      missing.push('WIZPAY_USER_SWAP_ENABLED=true');
    }

    if (process.env.WIZPAY_USER_SWAP_ALLOW_TESTNET !== 'true') {
      missing.push('WIZPAY_USER_SWAP_ALLOW_TESTNET=true');
    }

    if (missing.length > 0) {
      throw new ServiceUnavailableException({
        code: APP_WALLET_SWAP_ERROR_CODES.TREASURY_NOT_CONFIGURED,
        message:
          'App Wallet treasury swap execution is missing required backend configuration.',
        missing,
      });
    }
  }

  private async submitTreasurySwapIfNeeded(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperationResponse> {
    if (this.isStablefxOperation(operation)) {
      if (
        operation.treasurySwapConfirmedAt &&
        operation.treasurySwapActualOutput
      ) {
        return operation;
      }

      if (operation.treasurySwapId) {
        return operation;
      }

      return this.submitStablefxTreasurySwap(operation);
    }

    if (operation.treasurySwapId || operation.treasurySwapTxHash) {
      return operation;
    }

    const now = new Date();
    const pendingOperation = this.mapOperationRecord(
      await this.operationRepository.update(operation.operationId, {
        status: 'treasury_swap_pending',
        executionError: null,
        updatedAt: now,
      }),
    );

    const treasuryAddress = this.getArcTreasuryDepositAddress();
    const prepared = await this.userSwapService.prepare({
      amountIn: pendingOperation.amountIn,
      chain: APP_WALLET_SWAP_CHAIN,
      fromAddress: treasuryAddress,
      toAddress: treasuryAddress,
      tokenIn: pendingOperation.tokenIn,
      tokenOut: pendingOperation.tokenOut,
    });
    const rawTreasurySwapBase = toAppWalletSwapNullableJson({
      prepare: this.sanitizeForPersistence(prepared.raw),
      transactionShape: describeAppWalletSwapPayloadShape(prepared.transaction),
    });
    const operationWithRawPrepare = this.mapOperationRecord(
      await this.operationRepository.update(pendingOperation.operationId, {
        rawTreasurySwap: rawTreasurySwapBase,
        updatedAt: new Date(),
      }),
    );
    const directExecution =
      this.circleExecutor.buildDirectContractExecution(prepared);
    let execution: {
      txId: string | null;
      txHash: string | null;
      raw: unknown;
    };

    if (directExecution) {
      const directResult = await this.circleExecutor.submitContractExecution({
        walletId: process.env.CIRCLE_WALLET_ID_ARC?.trim(),
        contractAddress: directExecution.contractAddress,
        callData: directExecution.callData,
        network: APP_WALLET_SWAP_CHAIN,
        idempotencyKey: this.deriveIdempotencyKey(
          pendingOperation.operationId,
          'treasury-swap',
        ),
        refId: `APP-WALLET-SWAP-${pendingOperation.operationId}-TREASURY-SWAP`,
      });
      execution = {
        txId: directResult.txId,
        txHash: directResult.txHash,
        raw: directResult.raw,
      };
    } else {
      execution =
        await this.circleExecutor.executeTreasurySwapWithCircleWalletAdapter({
          amountIn: operationWithRawPrepare.amountIn,
          preparedRaw: prepared.raw,
          preparedTransaction: prepared.transaction,
          tokenInAddress: TOKEN_ADDRESS_BY_SYMBOL[
            operationWithRawPrepare.tokenIn
          ] as `0x${string}`,
          treasuryAddress: operationWithRawPrepare.treasuryDepositAddress,
        });
    }

    return this.mapOperationRecord(
      await this.operationRepository.update(
        operationWithRawPrepare.operationId,
        {
          status: 'treasury_swap_submitted',
          treasurySwapId: execution.txId,
          treasurySwapQuoteId:
            this.stringifyUnknown(
              this.findFirst(prepared.raw, ['quoteId', 'id']),
            ) ?? null,
          treasurySwapTxHash: validTransactionHashOrNull(execution.txHash),
          treasurySwapSubmittedAt: new Date(),
          treasurySwapExpectedOutput: toAppWalletSwapNullableJson(
            prepared.expectedOutput ?? null,
          ),
          rawTreasurySwap: toAppWalletSwapNullableJson({
            prepare: this.sanitizeForPersistence(prepared.raw),
            execution: this.sanitizeForPersistence(execution.raw),
          }),
          executionError: null,
          updatedAt: new Date(),
        },
      ),
    );
  }

  private async submitStablefxTreasurySwap(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperationResponse> {
    const now = new Date();
    const treasuryAddress = this.getArcTreasuryDepositAddress();
    const treasuryWalletId = this.getArcTreasuryWalletId();
    const amountIn = operation.depositConfirmedAmount ?? operation.amountIn;

    const pendingOperation = this.mapOperationRecord(
      await this.operationRepository.update(operation.operationId, {
        status: 'stablefx_quote_requested',
        executionError: null,
        updatedAt: now,
      }),
    );
    const execution = await this.stablefxExecutor.createTradeExecution({
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
      await this.operationRepository.update(pendingOperation.operationId, {
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

  private async confirmTreasurySwapIfPossible(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperationResponse> {
    if (this.isStablefxOperation(operation)) {
      return this.confirmStablefxTreasurySwapIfPossible(operation);
    }

    if (
      operation.treasurySwapConfirmedAt &&
      operation.treasurySwapActualOutput
    ) {
      if (operation.status === 'execution_failed') {
        return this.mapOperationRecord(
          await this.operationRepository.update(operation.operationId, {
            status: 'treasury_swap_confirmed',
            executionError: null,
            updatedAt: new Date(),
          }),
        );
      }

      return operation;
    }

    let txHash = operation.treasurySwapTxHash;
    let rawStatus: unknown = null;

    if (!txHash && operation.treasurySwapId) {
      const status = await this.circleExecutor.getTransactionStatus(
        operation.treasurySwapId,
      );
      rawStatus = status;

      if (isFailedCircleTransactionStatus(status.status)) {
        throw new TerminalExecutionError(
          `Treasury swap Circle transaction failed with status ${status.status}${status.errorReason ? `: ${status.errorReason}` : ''}`,
        );
      }

      txHash = validTransactionHashOrNull(status.txHash) ?? undefined;

      if (txHash) {
        operation = this.mapOperationRecord(
          await this.operationRepository.update(operation.operationId, {
            treasurySwapTxHash: txHash,
            rawTreasurySwap: toAppWalletSwapNullableJson({
              provider: 'circle',
              transactionId: operation.treasurySwapId,
              txHash,
              status: this.sanitizeForPersistence(status),
              observedAt: new Date().toISOString(),
            }),
            updatedAt: new Date(),
          }),
        );
      }
    }

    if (!txHash) {
      return operation;
    }

    const verification = await this.treasuryVerifier
      .verifyTreasurySwap({
        txHash,
        tokenOut: operation.tokenOut,
        treasuryAddress: operation.treasuryDepositAddress,
        minimumOutput: this.stringifyAmount(operation.minimumOutput),
      })
      .catch(() => null);

    if (!verification?.confirmed || !verification.actualOutput) {
      return rawStatus
        ? this.mapOperationRecord(
            await this.operationRepository.update(operation.operationId, {
              rawTreasurySwap: toAppWalletSwapNullableJson({
                provider: 'circle',
                transactionId: operation.treasurySwapId,
                txHash: operation.treasurySwapTxHash ?? null,
                status: this.sanitizeForPersistence(rawStatus),
                observedAt: new Date().toISOString(),
              }),
              updatedAt: new Date(),
            }),
          )
        : operation;
    }

    return this.mapOperationRecord(
      await this.operationRepository.update(operation.operationId, {
        status: 'treasury_swap_confirmed',
        treasurySwapConfirmedAt: new Date(),
        treasurySwapActualOutput: verification.actualOutput,
        executionError: null,
        updatedAt: new Date(),
      }),
    );
  }

  private async confirmStablefxTreasurySwapIfPossible(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperationResponse> {
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
      throw new TerminalExecutionError(
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
        await this.operationRepository.update(operation.operationId, {
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

      const funding = await this.stablefxExecutor.prepareFunding({
        contractTradeId,
        memo: `WizPay App Wallet StableFX ${operation.tokenIn}->${operation.tokenOut} funding`,
        treasuryWalletId: this.getArcTreasuryWalletId(),
      });
      operation = this.mapOperationRecord(
        await this.operationRepository.update(operation.operationId, {
          stablefxFundingRequestedAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      const fund = await this.stablefxExecutor.fundTrade(funding.request);
      const fundState = this.stablefxExecutor.interpretTrade(fund);

      operation = this.mapOperationRecord(
        await this.operationRepository.update(operation.operationId, {
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
        await this.operationRepository.update(operation.operationId, {
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
      throw new TerminalExecutionError(
        `StableFX Treasury trade failed with status ${finalStatus}.`,
      );
    }

    if (!tradeState.isSettlementComplete) {
      return this.mapOperationRecord(
        await this.operationRepository.update(operation.operationId, {
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
      await this.operationRepository.update(operation.operationId, {
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

  private async submitPayoutIfNeeded(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperationResponse> {
    if (operation.payoutSubmittedAt || operation.payoutTxHash) {
      return operation;
    }

    if (!operation.treasurySwapActualOutput) {
      return operation;
    }

    const pendingOperation = this.mapOperationRecord(
      await this.operationRepository.update(operation.operationId, {
        status: 'payout_pending',
        executionError: null,
        updatedAt: new Date(),
      }),
    );
    const payoutAmount = pendingOperation.treasurySwapActualOutput;

    if (!payoutAmount) {
      return pendingOperation;
    }

    const payout = await this.payoutExecutor.submitPayout({
      walletId: process.env.CIRCLE_WALLET_ID_ARC?.trim(),
      network: APP_WALLET_SWAP_CHAIN,
      token: pendingOperation.tokenOut,
      recipientAddress: pendingOperation.userWalletAddress,
      payoutAmount,
      tokenDecimals: TOKEN_DECIMALS_BY_SYMBOL[pendingOperation.tokenOut],
      idempotencyKey: this.deriveIdempotencyKey(
        pendingOperation.operationId,
        'payout',
      ),
    });

    return this.mapOperationRecord(
      await this.operationRepository.update(pendingOperation.operationId, {
        status: 'payout_submitted',
        payoutAmount,
        payoutTxHash: payout.txHash,
        payoutSubmittedAt: new Date(),
        rawPayout: toAppWalletSwapNullableJson(payout.snapshot),
        executionError: null,
        updatedAt: new Date(),
      }),
    );
  }

  private async submitRefundIfSafe(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperationResponse> {
    if (operation.refundSubmittedAt || operation.refundTransactionId) {
      return operation;
    }

    const refundAmount = operation.depositConfirmedAmount;
    if (
      !refundAmount ||
      operation.treasurySwapConfirmedAt ||
      operation.payoutSubmittedAt
    ) {
      throw new TerminalExecutionError(
        'Refund is not safe because the verified deposit amount is unavailable or settlement/payout has already advanced.',
      );
    }

    const fundingWasAttempted =
      Boolean(operation.stablefxFundingRequestedAt) ||
      Boolean(operation.stablefxFundedAt) ||
      this.containsObjectKey(operation.rawTreasurySwap, 'fund');
    if (fundingWasAttempted) {
      if (!operation.treasurySwapId) {
        throw new TerminalExecutionError(
          'Refund is blocked because StableFX funding was submitted without a recoverable trade identifier.',
        );
      }
      const trade = await this.pollStablefxTrade(operation.treasurySwapId);
      if (!trade.isFailure) {
        throw new TerminalExecutionError(
          'Refund is blocked while the funded StableFX trade is not in a terminal failure/refund state.',
        );
      }
    }

    const balances = await this.withProviderTimeout(
      this.circleExecutor.getWalletBalance(
        this.getArcTreasuryWalletId(),
        TOKEN_ADDRESS_BY_SYMBOL[operation.tokenIn],
      ),
      'Treasury balance verification timed out.',
    );
    const matchingBalance = balances.find((balance) =>
      equalsIgnoreCase(
        balance.tokenAddress,
        TOKEN_ADDRESS_BY_SYMBOL[operation.tokenIn],
      ),
    );
    const available = matchingBalance
      ? normalizeTokenAmountToBaseUnits(
          matchingBalance.amount,
          TOKEN_DECIMALS_BY_SYMBOL[operation.tokenIn],
        )
      : null;

    if (available === null || available < BigInt(refundAmount)) {
      throw new TerminalExecutionError(
        `Refund is blocked because the treasury does not hold the verified ${operation.tokenIn} deposit amount.`,
      );
    }

    operation = this.mapOperationRecord(
      await this.operationRepository.update(operation.operationId, {
        status: 'refund_pending',
        refundAmount,
        executionError: null,
        updatedAt: new Date(),
      }),
    );
    const transfer = await this.circleExecutor.submitTransfer({
      walletId: this.getArcTreasuryWalletId(),
      network: APP_WALLET_SWAP_CHAIN,
      token: operation.tokenIn,
      toAddress: operation.userWalletAddress,
      amount: this.circleExecutor.formatBaseUnits(refundAmount, 6),
      idempotencyKey: this.deriveIdempotencyKey(
        operation.operationId,
        'deposit-refund',
      ),
    });

    return this.mapOperationRecord(
      await this.operationRepository.update(operation.operationId, {
        status: 'refund_submitted',
        refundTransactionId: transfer.txId,
        refundTxHash: validTransactionHashOrNull(transfer.txHash),
        refundSubmittedAt: new Date(),
        rawRefund: toAppWalletSwapNullableJson({
          provider: 'circle',
          transactionId: transfer.txId,
          txHash: validTransactionHashOrNull(transfer.txHash),
          providerStatus: transfer.status,
          transfer: this.sanitizeForPersistence(transfer),
          observedAt: new Date().toISOString(),
        }),
        executionError: null,
        updatedAt: new Date(),
      }),
    );
  }

  private async confirmRefundIfPossible(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperationResponse> {
    if (operation.status === 'refunded') return operation;
    if (!operation.refundSubmittedAt || !operation.refundAmount)
      return operation;

    const refundAmount = operation.refundAmount;
    let txHash = operation.refundTxHash;
    if (!txHash && operation.refundTransactionId) {
      const status = await this.withProviderTimeout(
        this.circleExecutor.getTransactionStatus(operation.refundTransactionId),
        'Refund transaction polling timed out.',
      );
      if (isFailedCircleTransactionStatus(status.status)) {
        throw new TerminalExecutionError(
          `Refund Circle transaction failed with status ${status.status}${status.errorReason ? `: ${status.errorReason}` : ''}`,
        );
      }
      txHash = validTransactionHashOrNull(status.txHash) ?? undefined;
      operation = this.mapOperationRecord(
        await this.operationRepository.update(operation.operationId, {
          ...(txHash ? { refundTxHash: txHash } : {}),
          rawRefund: toAppWalletSwapNullableJson({
            provider: 'circle',
            transactionId: operation.refundTransactionId,
            txHash: txHash ?? null,
            providerStatus: status.status,
            status: this.sanitizeForPersistence(status),
            observedAt: new Date().toISOString(),
          }),
          updatedAt: new Date(),
        }),
      );
    }

    if (!txHash) return operation;
    const verification = await this.withProviderTimeout(
      this.treasuryVerifier.verifyPayout({
        tokenOut: operation.tokenIn,
        txHash,
        treasuryAddress: operation.treasuryDepositAddress,
        userWalletAddress: operation.userWalletAddress,
        payoutAmount: refundAmount,
      }),
      'Refund on-chain confirmation timed out.',
    );
    if (!verification.confirmed) return operation;

    const confirmedAt = new Date();
    return this.mapOperationRecord(
      await this.operationRepository.update(operation.operationId, {
        status: 'refunded',
        refundTxHash: txHash,
        refundConfirmedAt: confirmedAt,
        executionError: null,
        updatedAt: confirmedAt,
      }),
    );
  }

  private async confirmPayoutIfPossible(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperationResponse> {
    if (operation.status === 'completed') {
      return operation;
    }

    if (!operation.payoutSubmittedAt || !operation.payoutAmount) {
      return operation;
    }

    const payoutAmount = operation.payoutAmount;
    const storedReferences = this.payoutExecutor.getStoredPayoutReferences(
      operation.rawPayout,
    );
    let txHash = operation.payoutTxHash ?? storedReferences.txHash ?? undefined;

    if (operation.rawPayout && !txHash) {
      const payoutTransactionId = storedReferences.transactionId;

      if (payoutTransactionId) {
        const payoutStatus = await this.payoutExecutor
          .getPayoutStatus(payoutTransactionId)
          .catch(() => null);

        if (payoutStatus) {
          if (payoutStatus.failed) {
            throw new TerminalExecutionError(
              `Payout Circle transaction failed with status ${payoutStatus.providerStatus}${payoutStatus.errorReason ? `: ${payoutStatus.errorReason}` : ''}`,
            );
          }

          txHash = payoutStatus.txHash ?? undefined;

          operation = this.mapOperationRecord(
            await this.operationRepository.update(operation.operationId, {
              ...(txHash ? { payoutTxHash: txHash } : {}),
              rawPayout: toAppWalletSwapNullableJson(payoutStatus.snapshot),
              updatedAt: new Date(),
            }),
          );
        }
      }
    }

    if (!txHash) {
      const resolved = await this.resolvePayoutTxHashFromCircleList(operation);

      if (resolved) {
        txHash = resolved.txHash;
        operation = resolved.operation;
      }
    }

    if (!txHash) {
      return operation;
    }

    const verification = await this.withProviderTimeout(
      this.treasuryVerifier.verifyPayout({
        tokenOut: operation.tokenOut,
        txHash,
        treasuryAddress: operation.treasuryDepositAddress,
        userWalletAddress: operation.userWalletAddress,
        payoutAmount,
      }),
      'Payout on-chain confirmation timed out.',
    );

    if (!verification.confirmed) {
      return operation;
    }

    return this.finalizePayout(operation, txHash);
  }

  private async finalizePayout(
    operation: AppWalletSwapOperationResponse,
    txHash: string,
  ): Promise<AppWalletSwapOperationResponse> {
    const payoutConfirmedAt = new Date();
    const completedAt = new Date();

    return this.mapOperationRecord(
      await this.operationRepository.update(operation.operationId, {
        status: 'completed',
        payoutTxHash: txHash,
        payoutConfirmedAt,
        completedAt,
        executionError: null,
        updatedAt: completedAt,
      }),
    );
  }

  private async resolvePayoutTxHashFromCircleList(
    operation: AppWalletSwapOperationResponse,
  ): Promise<{
    operation: AppWalletSwapOperationResponse;
    txHash: string;
  } | null> {
    const treasuryWalletId = process.env.CIRCLE_WALLET_ID_ARC?.trim();

    if (!treasuryWalletId) {
      return null;
    }

    const recovered = await this.payoutExecutor
      .recoverPayoutReference({
        treasuryWalletId,
        tokenAddresses: TOKEN_ADDRESS_BY_SYMBOL,
        payout: {
          tokenOut: operation.tokenOut,
          payoutAmount: operation.payoutAmount!,
          treasuryDepositAddress: operation.treasuryDepositAddress,
          userWalletAddress: operation.userWalletAddress,
          payoutSubmittedAt: operation.payoutSubmittedAt!,
        },
        existingTransactionId: this.payoutExecutor.getStoredPayoutReferences(
          operation.rawPayout,
        ).transactionId,
      })
      .catch(() => null);

    if (!recovered) {
      return null;
    }

    const updatedOperation = this.mapOperationRecord(
      await this.operationRepository.update(operation.operationId, {
        payoutTxHash: recovered.txHash,
        rawPayout: toAppWalletSwapNullableJson(recovered.snapshot),
        updatedAt: new Date(),
      }),
    );

    return { operation: updatedOperation, txHash: recovered.txHash! };
  }

  private async markExecutionError(
    operationId: string,
    error: unknown,
  ): Promise<AppWalletSwapOperationResponse> {
    const operation = await this.getOperationForExecution(operationId);
    const terminal =
      error instanceof TerminalExecutionError ||
      error instanceof BadGatewayException ||
      error instanceof AppWalletSwapStablefxResponseError ||
      (error instanceof BadRequestException &&
        Boolean(operation.treasurySwapId));
    return this.mapOperationRecord(
      await this.operationRepository.update(operationId, {
        ...(terminal
          ? {
              status: operation.depositConfirmedAt
                ? 'execution_recovery_required'
                : 'execution_failed',
            }
          : {}),
        executionError: this.getPublicErrorMessage(error),
        updatedAt: new Date(),
      }),
    );
  }
  private mapOperationRecord(
    record: AppWalletSwapOperation,
  ): AppWalletSwapOperationResponse {
    const fallbackProvider = this.shouldUseStablefxTreasury(
      record.tokenIn,
      record.tokenOut,
    )
      ? 'stablefx'
      : undefined;

    return mapAppWalletSwapOperationRecord(record, fallbackProvider);
  }

  toPublicOperation(
    operation: AppWalletSwapOperationResponse,
  ): AppWalletSwapOperationResponse {
    return toPublicAppWalletSwapOperation(operation);
  }

  private toPublicQuote(
    quote: AppWalletSwapQuoteResponse,
  ): AppWalletSwapQuoteResponse {
    return toPublicAppWalletSwapQuote(quote);
  }

  private sanitizeForPersistence(value: unknown): unknown {
    return sanitizeAppWalletSwapPayload(value);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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

  private stringifyAmount(value: unknown): string | undefined {
    const candidate = this.stringifyUnknown(value);

    return candidate && /^\d+$/.test(candidate) ? candidate : undefined;
  }

  private stringifyUnknown(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }

    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;

      return this.stringifyUnknown(
        record.amount ?? record.value ?? record.toAmount,
      );
    }

    return undefined;
  }

  private findFirst(raw: unknown, paths: string[]): unknown {
    for (const path of paths) {
      const value = path.split('.').reduce<unknown>((current, key) => {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
          return undefined;
        }

        return (current as Record<string, unknown>)[key];
      }, raw);

      if (value !== undefined && value !== null) {
        return value;
      }
    }

    return undefined;
  }

  private isStablefxOperation(
    operation: AppWalletSwapOperationResponse,
  ): boolean {
    return (
      operation.provider === 'stablefx' ||
      this.shouldUseStablefxTreasury(operation.tokenIn, operation.tokenOut)
    );
  }

  private shouldUseStablefxTreasury(
    tokenIn: string,
    tokenOut: string,
  ): boolean {
    return (
      process.env.WIZPAY_SWAP_PROVIDER?.trim().toLowerCase() === 'stablefx' &&
      STABLEFX_APP_WALLET_PAIRS.has(`${tokenIn}->${tokenOut}`)
    );
  }

  private attachQuoteProvider(
    rawQuote: unknown,
    provider: 'swapkit' | 'stablefx' | undefined,
  ): unknown {
    if (!provider || !this.isRecord(rawQuote) || rawQuote.provider) {
      return rawQuote;
    }

    return {
      ...rawQuote,
      provider,
    };
  }

  private toAppWalletQuoteProvider(
    provider: string | undefined,
  ): 'swapkit' | 'stablefx' | undefined {
    if (provider === 'swapkit' || provider === 'stablefx') {
      return provider;
    }

    if (provider === 'xylonet') {
      throw new ServiceUnavailableException({
        code: APP_WALLET_SWAP_ERROR_CODES.TREASURY_NOT_CONFIGURED,
        message:
          'App Wallet swap does not support XyloNet quotes. Use External Wallet swap for XyloNet.',
      });
    }

    return undefined;
  }

  private async pollStablefxTrade(
    tradeId: string,
  ): Promise<AppWalletSwapStablefxTradeState> {
    return this.withProviderTimeout(
      this.stablefxExecutor.getTradeState(tradeId),
      'StableFX trade polling timed out.',
    );
  }

  private containsObjectKey(value: unknown, targetKey: string): boolean {
    if (Array.isArray(value)) {
      return value.some((item) => this.containsObjectKey(item, targetKey));
    }
    if (!this.isRecord(value)) return false;
    if (Object.prototype.hasOwnProperty.call(value, targetKey)) return true;
    return Object.values(value).some((item) =>
      this.containsObjectKey(item, targetKey),
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
      throw new TerminalExecutionError(
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

  private getPublicErrorMessage(error: unknown): string {
    if (error instanceof BadRequestException) {
      const response = error.getResponse();
      if (typeof response === 'string' && response.trim()) return response;
      if (this.isRecord(response)) {
        const message = response.message;
        if (typeof message === 'string' && message.trim()) return message;
        if (this.isRecord(message)) {
          const nestedMessage = getNestedStringFromPayload(message, [
            'message',
          ]);
          if (nestedMessage) return nestedMessage;
        }
      }
      return 'App Wallet swap execution request is invalid.';
    }

    if (error instanceof ServiceUnavailableException) {
      return 'App Wallet swap execution is not available.';
    }

    if (error instanceof Error && error.message) {
      return error.message;
    }

    return 'App Wallet swap execution failed.';
  }

  private assertOperationId(operationId: string): void {
    if (!UUID_PATTERN.test(operationId)) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'App Wallet swap operation id is invalid.',
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
        message: 'Treasury-mediated App Wallet swap supports ARC-TESTNET only.',
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

    if (
      process.env.WIZPAY_SWAP_PROVIDER?.trim().toLowerCase() === 'stablefx' &&
      BigInt(amountIn) < STABLEFX_MIN_BASE_UNITS
    ) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.STABLEFX_MIN_AMOUNT,
        message: 'StableFX requires a minimum amount of 10 for this pair.',
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

  private normalizeOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private assertDepositTxHash(depositTxHash: string): void {
    if (!/^0x[a-fA-F0-9]{64}$/.test(depositTxHash)) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'depositTxHash must be a 32-byte transaction hash.',
      });
    }
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
