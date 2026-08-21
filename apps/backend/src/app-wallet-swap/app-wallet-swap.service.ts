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
import { AppWalletSwapCircleExecutorService } from './app-wallet-swap-circle-executor.service';
import {
  equalsIgnoreCase,
  isFailedCircleTransactionStatus,
  normalizeTokenAmountToBaseUnits,
} from './app-wallet-swap-circle-transaction-matcher';
import { AppWalletSwapDepositService } from './app-wallet-swap-deposit.service';
import { mapAppWalletSwapOperationRecord } from './app-wallet-swap-operation.mapper';
import {
  AppWalletSwapOperationRepository,
  toAppWalletSwapNullableJson,
} from './app-wallet-swap-operation.repository';
import {
  describeAppWalletSwapPayloadShape,
  sanitizeAppWalletSwapPayload,
} from './app-wallet-swap-payload-sanitizer';
import {
  toPublicAppWalletSwapOperation,
  toPublicAppWalletSwapQuote,
} from './app-wallet-swap-public.mapper';
import { AppWalletSwapRefundService } from './app-wallet-swap-refund.service';
import {
  extractCircleTransactionHash as extractCircleTransactionHashFromPayload,
  getNestedString as getNestedStringFromPayload,
  validTransactionHashOrNull,
} from './app-wallet-swap-provider-reference';
import {
  buildSwapkitRouteUnavailableDiagnostics,
  isCircleRouteUnavailableError,
  readSwapkitBaseUnitAmount,
  toSwapkitRouteUnavailableError,
} from './app-wallet-swap-swapkit-quote';
import { AppWalletSwapPayoutExecutorService } from './app-wallet-swap-payout-executor.service';
import { AppWalletSwapTreasuryVerifierService } from './app-wallet-swap-treasury-verifier.service';
import {
  AppWalletSwapStablefxExecutorService,
  AppWalletSwapStablefxResponseError,
} from './app-wallet-swap-stablefx-executor.service';
import {
  APP_WALLET_SWAP_CHAIN,
  APP_WALLET_SWAP_ERROR_CODES,
  APP_WALLET_SWAP_MODE,
  AppWalletSwapDepositRequest,
  AppWalletSwapDepositTxHashRequest,
  AppWalletSwapOperationRequest,
  AppWalletSwapOperationResponse,
  AppWalletSwapProvider,
  AppWalletSwapQuoteRequest,
  AppWalletSwapQuoteResponse,
  AppWalletSwapToken,
  resolveAppWalletSwapProvider,
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
    private readonly depositService: AppWalletSwapDepositService,
    private readonly refundService: AppWalletSwapRefundService,
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
    const routedProvider = resolveAppWalletSwapProvider(normalized.amountIn);

    if (normalized.provider && normalized.provider !== routedProvider) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_PROVIDER_INVALID,
        message:
          `App Wallet automatically routes this amount to ${routedProvider}; ` +
          `the requested provider cannot be used.`,
      });
    }

    if (routedProvider === 'swapkit') {
      this.rejectUnsupportedUserControlledSwapkit('quote');
    }

    const routedRequest = { ...normalized, provider: routedProvider };
    const treasuryDepositAddress = this.getArcTreasuryDepositAddress();
    const userSwapQuote = await this.requestProviderQuote(
      routedRequest,
      treasuryDepositAddress,
    );
    const quoteProvider = this.resolveAppWalletExecutionProvider(
      userSwapQuote.provider,
      userSwapQuote.raw,
    );

    if (quoteProvider !== routedProvider) {
      throw new BadGatewayException({
        code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_PROVIDER_INVALID,
        message:
          'App Wallet quote provider did not match the explicitly requested provider.',
      });
    }

    if (
      quoteProvider === 'stablefx' &&
      BigInt(normalized.amountIn) < STABLEFX_MIN_BASE_UNITS
    ) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.STABLEFX_MIN_AMOUNT,
        message: 'StableFX requires a minimum amount of 10 for this pair.',
      });
    }

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

  // Requests the provider quote and translates Circle's structured
  // route-unavailable answer into a stable WizPay domain error. The provider
  // is never switched here: a route rejection fails closed and the caller keeps
  // whatever provider they selected.
  private async requestProviderQuote(
    normalized: ReturnType<AppWalletSwapService['normalizeRequest']>,
    treasuryDepositAddress: string,
  ) {
    try {
      return await this.userSwapService.quote({
        amountIn: normalized.amountIn,
        chain: APP_WALLET_SWAP_CHAIN,
        fromAddress: treasuryDepositAddress,
        toAddress: normalized.fromAddress,
        tokenIn: normalized.tokenIn,
        tokenOut: normalized.tokenOut,
        ...(normalized.provider
          ? {
              provider: normalized.provider,
              allowProviderFallback: false,
            }
          : {}),
      });
    } catch (error) {
      // Only the Circle Stablecoin Kits (swapkit) path can produce this,
      // so the classification is provider-accurate without inspecting the
      // requested provider.
      if (isCircleRouteUnavailableError(error)) {
        const diagnostics = buildSwapkitRouteUnavailableDiagnostics({
          error,
          tokenIn: normalized.tokenIn,
          tokenOut: normalized.tokenOut,
          amountIn: normalized.amountIn,
        });

        this.logger.warn(
          `[app-wallet-swap-swapkit] Route unavailable: ` +
            `provider=${diagnostics.provider} ` +
            `direction=${diagnostics.direction} ` +
            `amountIn=${diagnostics.amountIn} ` +
            `upstreamStatus=${diagnostics.upstreamStatus ?? 'unknown'} ` +
            `upstreamCode=${diagnostics.upstreamCode ?? 'unknown'} ` +
            `traceId=${diagnostics.traceId ?? 'none'}`,
        );

        throw toSwapkitRouteUnavailableError({
          error,
          tokenIn: normalized.tokenIn,
          tokenOut: normalized.tokenOut,
          amountIn: normalized.amountIn,
        });
      }

      throw error;
    }
  }

  async createOperation(
    request: AppWalletSwapOperationRequest,
  ): Promise<AppWalletSwapOperationResponse> {
    const quote = await this.buildQuote(request);
    const now = new Date().toISOString();
    const operation: AppWalletSwapOperationResponse & {
      provider: AppWalletSwapProvider;
    } = {
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
    const operation = await this.getOperationForExecution(operationId);
    if (operation.provider === 'swapkit') {
      this.rejectUnsupportedUserControlledSwapkit('deposit');
    }
    return this.depositService.submitDeposit(operationId, request);
  }

  async attachDepositTxHash(
    operationId: string,
    request: AppWalletSwapDepositTxHashRequest,
  ): Promise<AppWalletSwapOperationResponse> {
    return this.depositService.attachDepositTxHash(operationId, request);
  }

  async resolveDepositTxHash(
    operationId: string,
  ): Promise<AppWalletSwapOperationResponse> {
    return this.depositService.resolveDepositTxHash(operationId);
  }

  async confirmDeposit(
    operationId: string,
  ): Promise<AppWalletSwapOperationResponse> {
    return this.depositService.confirmDeposit(operationId);
  }

  async execute(operationId: string): Promise<AppWalletSwapOperationResponse> {
    this.assertOperationId(operationId);

    let operation = await this.getOperationForExecution(operationId);

    if (operation.status === 'completed') {
      return this.toPublicOperation(operation);
    }

    if (operation.provider === 'swapkit') {
      this.rejectUnsupportedUserControlledSwapkit('execute');
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
    this.assertPersistedExecutionProvider(operation);

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

    return this.refundService.recover(operationId);
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
    this.assertTreasuryExecutionConfig(operation.provider);
  }

  private assertTreasuryExecutionConfig(
    provider: AppWalletSwapProvider | undefined,
  ): void {
    this.assertPersistedExecutionProviderValue(provider);
    const isStablefx = provider === 'stablefx';
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
      return this.stablefxExecutor.submitTreasurySwapIfNeeded(operation);
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
      provider: pendingOperation.provider,
    });
    // The floor that actually protects this execution is the one returned by
    // the prepare call we are about to submit, not the earlier indicative
    // quote. Persist it so confirmation can verify against it even after a
    // restart, and so operations quoted before this fix can still be resumed.
    const preparedMinimumOutput = readSwapkitBaseUnitAmount(
      prepared.minimumOutput,
    );
    const rawTreasurySwapBase = toAppWalletSwapNullableJson({
      prepare: this.sanitizeForPersistence(prepared.raw),
      transactionShape: describeAppWalletSwapPayloadShape(prepared.transaction),
      ...(preparedMinimumOutput
        ? { minimumOutput: preparedMinimumOutput }
        : {}),
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
            ...(preparedMinimumOutput
              ? { minimumOutput: preparedMinimumOutput }
              : {}),
          }),
          executionError: null,
          updatedAt: new Date(),
        },
      ),
    );
  }

  private async confirmTreasurySwapIfPossible(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperationResponse> {
    if (this.isStablefxOperation(operation)) {
      return this.stablefxExecutor.confirmTreasurySwapIfPossible(operation);
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

    // Fail closed before confirming any financial outcome: without a positive
    // floor the on-chain check would accept any non-zero output.
    const minimumOutput = this.resolveTreasurySwapMinimumOutput(operation);

    if (!minimumOutput) {
      throw new TerminalExecutionError(
        'SwapKit treasury swap has no verifiable minimum output, so the swap result cannot be confirmed safely.',
      );
    }

    const verification = await this.treasuryVerifier
      .verifyTreasurySwap({
        txHash,
        tokenOut: operation.tokenOut,
        treasuryAddress: operation.treasuryDepositAddress,
        minimumOutput,
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

  /**
   * Resolves the slippage floor used to verify a SwapKit treasury swap.
   *
   * Preferred source is the operation's quoted minimum output. Operations
   * created before the quote parser fix persisted `minimumOutput: null`; for
   * those, the floor recorded from the prepare response that was actually
   * submitted is used, so in-flight operations stay resumable. Returns
   * undefined when neither source yields a positive base-unit amount.
   */
  private resolveTreasurySwapMinimumOutput(
    operation: AppWalletSwapOperationResponse,
  ): string | undefined {
    const quoted = readSwapkitBaseUnitAmount(operation.minimumOutput);

    if (quoted) {
      return quoted;
    }

    const rawTreasurySwap = operation.rawTreasurySwap;

    if (!this.isRecord(rawTreasurySwap)) {
      return undefined;
    }

    return (
      readSwapkitBaseUnitAmount(rawTreasurySwap.minimumOutput) ??
      readSwapkitBaseUnitAmount(
        this.findFirst(rawTreasurySwap, [
          'prepare.stopLimit',
          'prepare.minimumOutput',
        ]),
      ) ??
      undefined
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
    return mapAppWalletSwapOperationRecord(record);
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
    this.assertPersistedExecutionProvider(operation);
    return operation.provider === 'stablefx';
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

  private resolveAppWalletExecutionProvider(
    provider: string | undefined,
    rawQuote: unknown,
  ): AppWalletSwapProvider {
    if (provider === 'swapkit' || provider === 'stablefx') {
      if (this.isRecord(rawQuote)) {
        const rawProvider = rawQuote.provider;
        if (rawProvider !== undefined && rawProvider !== provider) {
          throw new BadGatewayException({
            code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_PROVIDER_INVALID,
            message:
              'App Wallet quote returned conflicting execution providers.',
          });
        }
      }

      return provider;
    }

    if (provider === 'xylonet') {
      throw new ServiceUnavailableException({
        code: APP_WALLET_SWAP_ERROR_CODES.TREASURY_NOT_CONFIGURED,
        message:
          'App Wallet swap does not support XyloNet quotes. Use External Wallet swap for XyloNet.',
      });
    }

    throw new ServiceUnavailableException({
      code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_PROVIDER_INVALID,
      message:
        'App Wallet quote did not resolve to a supported execution provider.',
    });
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
    const provider = this.normalizeRequestedProvider(request.provider);

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

    return {
      tokenIn,
      tokenOut,
      amountIn,
      fromAddress,
      provider,
    };
  }

  private normalizeRequestedProvider(
    provider: AppWalletSwapProvider | undefined,
  ): AppWalletSwapProvider | undefined {
    if (provider === undefined) {
      return undefined;
    }

    if (provider === 'swapkit' || provider === 'stablefx') {
      return provider;
    }

    throw new BadRequestException({
      code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_PROVIDER_INVALID,
      message: 'provider must be either swapkit or stablefx.',
    });
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

  private rejectUnsupportedUserControlledSwapkit(stage: string): never {
    const flagEnabled =
      process.env.APP_WALLET_SWAPKIT_USER_CONTROLLED_ENABLED === 'true';
    this.logger.warn(
      `[app-wallet-swap] provider=swapkit mode=user-controlled ` +
        `stage=${stage} enabled=${flagEnabled} outcome=blocked ` +
        `treasuryFallback=false`,
    );

    throw new ServiceUnavailableException({
      code: APP_WALLET_SWAP_ERROR_CODES.SWAPKIT_USER_CONTROLLED_UNAVAILABLE,
      message: flagEnabled
        ? 'User-Controlled App Wallet SwapKit execution is unavailable because Circle does not document a supported SwapKit-to-W3S User-Controlled Wallet execution adapter. No treasury fallback was used.'
        : 'User-Controlled App Wallet SwapKit execution is disabled. No treasury fallback was used.',
      executionMode: 'user-controlled',
      provider: 'swapkit',
      treasuryFallback: false,
    });
  }

  private isPositiveDecimal(value: string): boolean {
    if (!/^(?:\d+|\d*\.\d+)$/.test(value)) {
      return false;
    }

    return Number(value) > 0;
  }

  private assertPersistedExecutionProvider(
    operation: AppWalletSwapOperationResponse,
  ): asserts operation is AppWalletSwapOperationResponse & {
    provider: AppWalletSwapProvider;
  } {
    this.assertPersistedExecutionProviderValue(operation.provider);
  }

  private assertPersistedExecutionProviderValue(
    provider: AppWalletSwapProvider | undefined,
  ): asserts provider is AppWalletSwapProvider {
    if (provider !== 'swapkit' && provider !== 'stablefx') {
      throw new ServiceUnavailableException({
        code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_PROVIDER_INVALID,
        message:
          'App Wallet swap execution provider is missing or invalid. This operation requires manual recovery review.',
      });
    }
  }
}
