import {
  AppWalletSwapOperation,
  Prisma,
} from '@prisma/client';
import {
  BadRequestException,
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { CircleService } from '../adapters/circle.service';
import { PrismaService } from '../database/prisma.service';
import { W3sAuthService } from '../modules/wallet/w3s-auth.service';
import {
  USER_SWAP_EURC_ADDRESS,
  USER_SWAP_USDC_ADDRESS,
  UserSwapService,
} from '../user-swap/user-swap.service';
import { AppWalletSwapDepositVerifierService } from './app-wallet-swap-deposit-verifier.service';
import { AppWalletSwapTreasuryVerifierService } from './app-wallet-swap-treasury-verifier.service';
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
const ARC_TESTNET_CIRCLE_USDC_TOKEN_ID =
  '15dc2b5d-0994-58b0-bf8c-3a0501148ee8';
const ARC_TESTNET_CIRCLE_EURC_TOKEN_ID =
  '4ea52a96-e6ae-56dc-8336-385bb238755f';
const TOKEN_ADDRESS_BY_SYMBOL: Record<AppWalletSwapToken, string> = {
  USDC: USER_SWAP_USDC_ADDRESS,
  EURC: USER_SWAP_EURC_ADDRESS,
};
const CIRCLE_TOKEN_ID_BY_SYMBOL: Record<AppWalletSwapToken, string> = {
  USDC: ARC_TESTNET_CIRCLE_USDC_TOKEN_ID,
  EURC: ARC_TESTNET_CIRCLE_EURC_TOKEN_ID,
};
const TOKEN_DECIMALS_BY_SYMBOL: Record<AppWalletSwapToken, number> = {
  USDC: 6,
  EURC: 6,
};
const CIRCLE_TRANSACTION_TIME_TOLERANCE_MS = 10_000;
const DEFAULT_QUOTE_TTL_MS = 5 * 60 * 1000;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

@Injectable()
export class AppWalletSwapService {
  private readonly logger = new Logger(AppWalletSwapService.name);

  constructor(
    private readonly userSwapService: UserSwapService,
    private readonly depositVerifier: AppWalletSwapDepositVerifierService,
    private readonly treasuryVerifier: AppWalletSwapTreasuryVerifierService,
    private readonly circleService: CircleService,
    private readonly w3sAuthService: W3sAuthService,
    private readonly prisma: PrismaService,
  ) {}

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

    return this.mapOperationRecord(
      await this.prisma.appWalletSwapOperation.create({
        data: this.toCreateInput(operation),
      }),
    );
  }

  async getOperation(operationId: string): Promise<AppWalletSwapOperationResponse> {
    this.assertOperationId(operationId);

    const operation = await this.prisma.appWalletSwapOperation.findUnique({
      where: { operationId },
    });

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

    const operation = await this.getOperation(operationId);

    if (operation.status !== 'awaiting_user_deposit') {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message:
          'App Wallet swap operation is not awaiting a user deposit.',
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
      await this.prisma.appWalletSwapOperation.update({
        where: { operationId },
        data: {
          status: 'deposit_submitted',
          ...(depositTxHash ? { depositTxHash } : {}),
          ...(circleWalletId ? { circleWalletId } : {}),
          ...(circleTransactionId ? { circleTransactionId } : {}),
          ...(circleReferenceId ? { circleReferenceId } : {}),
          depositSubmittedAt: new Date(now),
          updatedAt: new Date(now),
        },
      }),
    );

    if (!updatedOperation.depositTxHash) {
      return this.resolveDepositTxHash(updatedOperation.operationId).catch(
        () => updatedOperation,
      );
    }

    return updatedOperation;
  }

  async attachDepositTxHash(
    operationId: string,
    request: AppWalletSwapDepositTxHashRequest,
  ): Promise<AppWalletSwapOperationResponse> {
    this.assertOperationId(operationId);

    const operation = await this.getOperation(operationId);

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

    return this.mapOperationRecord(
      await this.prisma.appWalletSwapOperation.update({
        where: { operationId },
        data: {
          depositTxHash,
          depositConfirmationError: null,
          updatedAt: new Date(),
        },
      }),
    );
  }

  async resolveDepositTxHash(
    operationId: string,
  ): Promise<AppWalletSwapOperationResponse> {
    this.assertOperationId(operationId);

    const operation = await this.getOperation(operationId);

    if (operation.status !== 'deposit_submitted') {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message:
          'App Wallet swap operation must be deposit_submitted before resolving a deposit txHash.',
      });
    }

    if (operation.depositTxHash) {
      return operation;
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
      const transactionResponse = await this.w3sAuthService
        .getTransaction(lookupId)
        .catch(() => null);
      const directTransaction = this.findMatchingCircleDepositTransaction(
        transactionResponse,
        operation,
      );
      const depositTxHash = this.extractCircleTransactionHash(directTransaction);

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

    const transactionListResponse = await this.w3sAuthService
      .listTransactions(listTransactionsParams)
      .catch(() => null);

    const matchingTransaction = this.findMatchingCircleDepositTransaction(
      transactionListResponse,
      operation,
    );
    const listDepositTxHash =
      this.extractCircleTransactionHash(matchingTransaction);

    if (listDepositTxHash) {
      return this.attachDepositTxHash(operationId, {
        depositTxHash: listDepositTxHash,
      });
    }

    const diagnostic = this.buildDepositResolutionDiagnostic(
      transactionListResponse,
      operation,
    );

    if (diagnostic) {
      this.logger.warn(
        `App Wallet ${operation.tokenIn} deposit txHash unresolved for operation ${operation.operationId}: ${diagnostic}`,
      );
    }

    return this.mapOperationRecord(
      await this.prisma.appWalletSwapOperation.update({
        where: { operationId },
        data: {
          depositConfirmationError:
            diagnostic
              ? `Deposit txHash is not available from Circle yet. Retry shortly. Candidate transaction shapes: ${diagnostic}`
              : 'Deposit txHash is not available from Circle yet. Retry shortly.',
          updatedAt: new Date(),
        },
      }),
    );
  }

  async confirmDeposit(
    operationId: string,
  ): Promise<AppWalletSwapOperationResponse> {
    this.assertOperationId(operationId);

    const operation = await this.getOperation(operationId);

    if (operation.status !== 'deposit_submitted') {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message:
          'App Wallet swap operation must be deposit_submitted before deposit confirmation.',
      });
    }

    const now = new Date().toISOString();

    if (!operation.depositTxHash) {
      return this.mapOperationRecord(
        await this.prisma.appWalletSwapOperation.update({
          where: { operationId },
          data: {
            depositConfirmationError:
              'Deposit txHash is not available yet. Circle reference alone is not on-chain confirmation.',
            updatedAt: new Date(now),
          },
        }),
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
      return this.mapOperationRecord(
        await this.prisma.appWalletSwapOperation.update({
          where: { operationId },
          data: {
            depositConfirmationError:
              'Deposit could not be verified on-chain yet. Retry after the transaction is indexed.',
            updatedAt: new Date(now),
          },
        }),
      );
    }

    if (!verification.confirmed) {
      return this.mapOperationRecord(
        await this.prisma.appWalletSwapOperation.update({
          where: { operationId },
          data: {
            depositConfirmationError:
              verification.error ?? 'Deposit could not be confirmed on-chain.',
            updatedAt: new Date(now),
          },
        }),
      );
    }

    return this.mapOperationRecord(
      await this.prisma.appWalletSwapOperation.update({
        where: { operationId },
        data: {
          status: 'deposit_confirmed',
          depositConfirmedAt: new Date(now),
          depositConfirmedAmount: verification.confirmedAmount,
          depositConfirmationError: null,
          updatedAt: new Date(now),
        },
      }),
    );
  }

  async execute(operationId: string): Promise<AppWalletSwapOperationResponse> {
    this.assertOperationId(operationId);

    let operation = await this.getOperation(operationId);

    if (operation.status === 'completed') {
      return operation;
    }

    this.assertExecutableOperation(operation);

    try {
      operation = await this.submitTreasurySwapIfNeeded(operation);
      operation = await this.confirmTreasurySwapIfPossible(operation);

      if (!operation.treasurySwapConfirmedAt) {
        return operation;
      }

      operation = await this.submitPayoutIfNeeded(operation);
      operation = await this.confirmPayoutIfPossible(operation);

      return operation;
    } catch (error) {
      return this.markExecutionFailed(operation.operationId, error);
    }
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

    if (!this.equalsIgnoreCase(operation.treasuryDepositAddress, treasuryAddress)) {
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
    const missing = [
      'CIRCLE_WALLET_ID_ARC',
      'CIRCLE_WALLET_ADDRESS_ARC',
      'CIRCLE_API_KEY',
      'CIRCLE_ENTITY_SECRET',
      'WIZPAY_USER_SWAP_KIT_KEY',
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
    if (operation.treasurySwapId || operation.treasurySwapTxHash) {
      return operation;
    }

    const now = new Date();
    const pendingOperation = this.mapOperationRecord(
      await this.prisma.appWalletSwapOperation.update({
        where: { operationId: operation.operationId },
        data: {
          status: 'treasury_swap_pending',
          executionError: null,
          updatedAt: now,
        },
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
    const rawTreasurySwapBase = this.toNullableJson({
      prepare: this.sanitizeForPersistence(prepared.raw),
      transactionShape: this.describeResponseShape(prepared.transaction),
    });
    const operationWithRawPrepare = this.mapOperationRecord(
      await this.prisma.appWalletSwapOperation.update({
        where: { operationId: pendingOperation.operationId },
        data: {
          rawTreasurySwap: rawTreasurySwapBase,
          updatedAt: new Date(),
        },
      }),
    );
    const directExecution = this.tryBuildDirectContractExecution(prepared);
    let execution: {
      txId: string | null;
      txHash: string | null;
      raw: unknown;
    };

    if (directExecution) {
      const directResult = await this.circleService.executeContract({
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
      execution = await this.executeTreasurySwapWithCircleWalletAdapter(
        operationWithRawPrepare,
        prepared,
      );
    }

    return this.mapOperationRecord(
      await this.prisma.appWalletSwapOperation.update({
        where: { operationId: operationWithRawPrepare.operationId },
        data: {
          status: 'treasury_swap_submitted',
          treasurySwapId: execution.txId,
          treasurySwapQuoteId:
            this.stringifyUnknown(this.findFirst(prepared.raw, ['quoteId', 'id'])) ??
            null,
          treasurySwapTxHash: this.validTxHashOrNull(execution.txHash),
          treasurySwapSubmittedAt: new Date(),
          treasurySwapExpectedOutput: this.toNullableJson(
            prepared.expectedOutput ?? null,
          ),
          rawTreasurySwap: this.toNullableJson({
            prepare: this.sanitizeForPersistence(prepared.raw),
            execution: execution.raw,
          }),
          executionError: null,
          updatedAt: new Date(),
        },
      }),
    );
  }

  private async confirmTreasurySwapIfPossible(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperationResponse> {
    if (operation.treasurySwapConfirmedAt && operation.treasurySwapActualOutput) {
      if (operation.status === 'execution_failed') {
        return this.mapOperationRecord(
          await this.prisma.appWalletSwapOperation.update({
            where: { operationId: operation.operationId },
            data: {
              status: 'treasury_swap_confirmed',
              executionError: null,
              updatedAt: new Date(),
            },
          }),
        );
      }

      return operation;
    }

    let txHash = operation.treasurySwapTxHash;
    let rawStatus: unknown = null;

    if (!txHash && operation.treasurySwapId) {
      const status = await this.circleService.getTransactionStatus(
        operation.treasurySwapId,
      );
      rawStatus = status;

      if (this.isFailedCircleStatus(status.status)) {
        throw new Error(
          `Treasury swap Circle transaction failed with status ${status.status}${status.errorReason ? `: ${status.errorReason}` : ''}`,
        );
      }

      txHash = this.validTxHashOrNull(status.txHash) ?? undefined;

      if (txHash) {
        operation = this.mapOperationRecord(
          await this.prisma.appWalletSwapOperation.update({
            where: { operationId: operation.operationId },
            data: {
              treasurySwapTxHash: txHash,
              rawTreasurySwap: this.toNullableJson({
                previous: operation.rawTreasurySwap ?? null,
                status,
              }),
              updatedAt: new Date(),
            },
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
            await this.prisma.appWalletSwapOperation.update({
              where: { operationId: operation.operationId },
              data: {
                rawTreasurySwap: this.toNullableJson({
                  previous: operation.rawTreasurySwap ?? null,
                  status: rawStatus,
                }),
                updatedAt: new Date(),
              },
            }),
          )
        : operation;
    }

    return this.mapOperationRecord(
      await this.prisma.appWalletSwapOperation.update({
        where: { operationId: operation.operationId },
        data: {
          status: 'treasury_swap_confirmed',
          treasurySwapConfirmedAt: new Date(),
          treasurySwapActualOutput: verification.actualOutput,
          executionError: null,
          updatedAt: new Date(),
        },
      }),
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
      await this.prisma.appWalletSwapOperation.update({
        where: { operationId: operation.operationId },
        data: {
          status: 'payout_pending',
          executionError: null,
          updatedAt: new Date(),
        },
      }),
    );
    const payoutAmount = pendingOperation.treasurySwapActualOutput;

    if (!payoutAmount) {
      return pendingOperation;
    }

    const transfer = await this.circleService.transfer({
      walletId: process.env.CIRCLE_WALLET_ID_ARC?.trim(),
      network: APP_WALLET_SWAP_CHAIN,
      token: pendingOperation.tokenOut,
      toAddress: pendingOperation.userWalletAddress,
      amount: this.formatBaseUnits(payoutAmount, 6),
      idempotencyKey: this.deriveIdempotencyKey(
        pendingOperation.operationId,
        'payout',
      ),
    });

    return this.mapOperationRecord(
      await this.prisma.appWalletSwapOperation.update({
        where: { operationId: pendingOperation.operationId },
        data: {
          status: 'payout_submitted',
          payoutAmount,
          payoutTxHash: this.validTxHashOrNull(transfer.txHash),
          payoutSubmittedAt: new Date(),
          rawPayout: this.toNullableJson({ transfer }),
          executionError: null,
          updatedAt: new Date(),
        },
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
    let txHash = operation.payoutTxHash;

    if (operation.rawPayout && !txHash) {
      const payoutTransactionId = this.getPayoutTransactionId(operation.rawPayout);

      if (payoutTransactionId) {
        const status = await this.circleService
          .getTransactionStatus(payoutTransactionId)
          .catch(() => null);

        if (status) {
          if (this.isFailedCircleStatus(status.status)) {
            throw new Error(
              `Payout Circle transaction failed with status ${status.status}${status.errorReason ? `: ${status.errorReason}` : ''}`,
            );
          }

          txHash = this.validTxHashOrNull(status.txHash) ?? undefined;

          operation = this.mapOperationRecord(
            await this.prisma.appWalletSwapOperation.update({
              where: { operationId: operation.operationId },
              data: {
                ...(txHash ? { payoutTxHash: txHash } : {}),
                rawPayout: this.toNullableJson({
                  previous: operation.rawPayout,
                  status,
                }),
                updatedAt: new Date(),
              },
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

    return this.finalizePayout(operation, txHash);
  }

  private async finalizePayout(
    operation: AppWalletSwapOperationResponse,
    txHash: string,
  ): Promise<AppWalletSwapOperationResponse> {
    const payoutConfirmedAt = new Date();
    const completedAt = new Date();

    return this.mapOperationRecord(
      await this.prisma.appWalletSwapOperation.update({
        where: { operationId: operation.operationId },
        data: {
          status: 'completed',
          payoutTxHash: txHash,
          payoutConfirmedAt,
          completedAt,
          executionError: null,
          updatedAt: completedAt,
        },
      }),
    );
  }

  private async resolvePayoutTxHashFromCircleList(
    operation: AppWalletSwapOperationResponse,
  ): Promise<{ operation: AppWalletSwapOperationResponse; txHash: string } | null> {
    const treasuryWalletId = process.env.CIRCLE_WALLET_ID_ARC?.trim();

    if (!treasuryWalletId) {
      return null;
    }

    const transactionListResponse = await this.w3sAuthService
      .listTransactions({ walletIds: treasuryWalletId })
      .catch(() => null);
    const matchingTransaction = this.findMatchingCirclePayoutTransaction(
      transactionListResponse,
      operation,
      treasuryWalletId,
    );
    const txHash = this.extractCircleTransactionHash(matchingTransaction);

    if (!txHash) {
      return null;
    }

    const updatedOperation = this.mapOperationRecord(
      await this.prisma.appWalletSwapOperation.update({
        where: { operationId: operation.operationId },
        data: {
          payoutTxHash: txHash,
          rawPayout: this.toNullableJson({
            previous: operation.rawPayout ?? null,
            resolvedTransaction: matchingTransaction,
          }),
          updatedAt: new Date(),
        },
      }),
    );

    return { operation: updatedOperation, txHash };
  }

  private async markExecutionFailed(
    operationId: string,
    error: unknown,
  ): Promise<AppWalletSwapOperationResponse> {
    return this.mapOperationRecord(
      await this.prisma.appWalletSwapOperation.update({
        where: { operationId },
        data: {
          status: 'execution_failed',
          executionError: this.getPublicErrorMessage(error),
          updatedAt: new Date(),
        },
      }),
    );
  }

  private toCreateInput(
    operation: AppWalletSwapOperationResponse,
  ): Prisma.AppWalletSwapOperationCreateInput {
    return {
      operationId: operation.operationId,
      operationMode: operation.operationMode,
      sourceChain: operation.sourceChain,
      tokenIn: operation.tokenIn,
      tokenOut: operation.tokenOut,
      amountIn: operation.amountIn,
      userWalletAddress: operation.userWalletAddress,
      treasuryDepositAddress: operation.treasuryDepositAddress,
      expectedOutput: this.toNullableJson(operation.expectedOutput),
      minimumOutput: this.toNullableJson(operation.minimumOutput),
      expiresAt: operation.expiresAt,
      status: operation.status,
      quoteId: this.toNullableJson(operation.quoteId),
      rawQuote: this.toNullableJson(operation.rawQuote),
      depositTxHash: operation.depositTxHash,
      circleTransactionId: operation.circleTransactionId,
      circleReferenceId: operation.circleReferenceId,
      circleWalletId: operation.circleWalletId,
      depositSubmittedAt: this.optionalDate(operation.depositSubmittedAt),
      depositConfirmedAt: this.optionalDate(operation.depositConfirmedAt),
      depositConfirmedAmount: operation.depositConfirmedAmount,
      depositConfirmationError: operation.depositConfirmationError,
      executionEnabled: operation.executionEnabled,
      treasurySwapId: operation.treasurySwapId,
      treasurySwapQuoteId: operation.treasurySwapQuoteId,
      treasurySwapTxHash: operation.treasurySwapTxHash,
      treasurySwapSubmittedAt: this.optionalDate(
        operation.treasurySwapSubmittedAt,
      ),
      treasurySwapConfirmedAt: this.optionalDate(
        operation.treasurySwapConfirmedAt,
      ),
      treasurySwapExpectedOutput: this.toNullableJson(
        operation.treasurySwapExpectedOutput,
      ),
      treasurySwapActualOutput: operation.treasurySwapActualOutput,
      rawTreasurySwap: this.toNullableJson(operation.rawTreasurySwap),
      payoutTxHash: operation.payoutTxHash,
      payoutAmount: operation.payoutAmount,
      payoutSubmittedAt: this.optionalDate(operation.payoutSubmittedAt),
      payoutConfirmedAt: this.optionalDate(operation.payoutConfirmedAt),
      rawPayout: this.toNullableJson(operation.rawPayout),
      completedAt: this.optionalDate(operation.completedAt),
      executionError: operation.executionError,
      createdAt: new Date(operation.createdAt),
      updatedAt: new Date(operation.updatedAt),
    };
  }

  private mapOperationRecord(
    record: AppWalletSwapOperation,
  ): AppWalletSwapOperationResponse {
    return {
      operationId: record.operationId,
      operationMode: record.operationMode as AppWalletSwapOperationResponse['operationMode'],
      sourceChain: record.sourceChain as AppWalletSwapOperationResponse['sourceChain'],
      tokenIn: record.tokenIn as AppWalletSwapToken,
      tokenOut: record.tokenOut as AppWalletSwapToken,
      amountIn: record.amountIn,
      userWalletAddress: record.userWalletAddress,
      treasuryDepositAddress: record.treasuryDepositAddress,
      expectedOutput: this.fromNullableJson(record.expectedOutput),
      minimumOutput: this.fromNullableJson(record.minimumOutput),
      expiresAt: record.expiresAt,
      status: record.status as AppWalletSwapOperationResponse['status'],
      ...(record.quoteId !== null
        ? { quoteId: this.fromNullableJson(record.quoteId) }
        : {}),
      ...(record.rawQuote !== null
        ? { rawQuote: this.fromNullableJson(record.rawQuote) }
        : {}),
      ...(record.depositTxHash ? { depositTxHash: record.depositTxHash } : {}),
      ...(record.circleTransactionId
        ? { circleTransactionId: record.circleTransactionId }
        : {}),
      ...(record.circleReferenceId
        ? { circleReferenceId: record.circleReferenceId }
        : {}),
      ...(record.circleWalletId ? { circleWalletId: record.circleWalletId } : {}),
      ...(record.depositSubmittedAt
        ? { depositSubmittedAt: record.depositSubmittedAt.toISOString() }
        : {}),
      ...(record.depositConfirmedAt
        ? { depositConfirmedAt: record.depositConfirmedAt.toISOString() }
        : {}),
      ...(record.depositConfirmedAmount
        ? { depositConfirmedAmount: record.depositConfirmedAmount }
        : {}),
      ...(record.depositConfirmationError
        ? { depositConfirmationError: record.depositConfirmationError }
        : {}),
      ...(record.treasurySwapId
        ? { treasurySwapId: record.treasurySwapId }
        : {}),
      ...(record.treasurySwapQuoteId
        ? { treasurySwapQuoteId: record.treasurySwapQuoteId }
        : {}),
      ...(record.treasurySwapTxHash
        ? { treasurySwapTxHash: record.treasurySwapTxHash }
        : {}),
      ...(record.treasurySwapSubmittedAt
        ? { treasurySwapSubmittedAt: record.treasurySwapSubmittedAt.toISOString() }
        : {}),
      ...(record.treasurySwapConfirmedAt
        ? { treasurySwapConfirmedAt: record.treasurySwapConfirmedAt.toISOString() }
        : {}),
      ...(record.treasurySwapExpectedOutput !== null
        ? {
            treasurySwapExpectedOutput: this.fromNullableJson(
              record.treasurySwapExpectedOutput,
            ),
          }
        : {}),
      ...(record.treasurySwapActualOutput
        ? { treasurySwapActualOutput: record.treasurySwapActualOutput }
        : {}),
      ...(record.rawTreasurySwap !== null
        ? { rawTreasurySwap: this.fromNullableJson(record.rawTreasurySwap) }
        : {}),
      ...(record.payoutTxHash ? { payoutTxHash: record.payoutTxHash } : {}),
      ...(record.payoutAmount ? { payoutAmount: record.payoutAmount } : {}),
      ...(record.payoutSubmittedAt
        ? { payoutSubmittedAt: record.payoutSubmittedAt.toISOString() }
        : {}),
      ...(record.payoutConfirmedAt
        ? { payoutConfirmedAt: record.payoutConfirmedAt.toISOString() }
        : {}),
      ...(record.rawPayout !== null
        ? { rawPayout: this.fromNullableJson(record.rawPayout) }
        : {}),
      ...(record.completedAt
        ? { completedAt: record.completedAt.toISOString() }
        : {}),
      ...(record.executionError
        ? { executionError: record.executionError }
        : {}),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      executionEnabled: record.executionEnabled,
    };
  }

  private toNullableJson(
    value: unknown,
  ): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    if (value === undefined || value === null) {
      return Prisma.JsonNull;
    }

    return value as Prisma.InputJsonValue;
  }

  private tryBuildDirectContractExecution(prepared: {
    transaction: { to?: unknown; data?: unknown };
  }): { contractAddress: string; callData: `0x${string}` } | null {
    const contractAddress = this.validContractAddressOrNull(
      prepared.transaction.to,
    );
    const callData = this.validCallDataOrNull(prepared.transaction.data);

    return contractAddress && callData ? { contractAddress, callData } : null;
  }

  private async executeTreasurySwapWithCircleWalletAdapter(
    operation: AppWalletSwapOperationResponse,
    prepared: {
      amountIn: string;
      raw: unknown;
      transaction: unknown;
    },
  ): Promise<{ txId: null; txHash: string | null; raw: unknown }> {
    const rawTransaction = this.isRecord(prepared.transaction)
      ? prepared.transaction.raw ?? prepared.transaction
      : prepared.transaction;
    const responseShape = {
      prepare: this.describeResponseShape(prepared.raw),
      transaction: this.describeResponseShape(rawTransaction),
    };

    if (!this.isRecord(rawTransaction)) {
      this.logger.warn(
        `Circle Stablecoin Kits swap response transaction shape was not executable: ${JSON.stringify(responseShape)}`,
      );
      throw this.createNonExecutableSwapResponseError(
        prepared.raw,
        rawTransaction,
      );
    }

    const transaction = rawTransaction;

    if (!this.isRecord(transaction.executionParams)) {
      this.logger.warn(
        `Circle Stablecoin Kits swap response missing executionParams: ${JSON.stringify(responseShape)}`,
      );
      throw this.createNonExecutableSwapResponseError(prepared.raw, transaction);
    }

    const signature = this.normalizeHexField(
      transaction.signature,
      'transaction.signature',
    );
    const executeParams = this.buildSwapExecuteParams(
      transaction.executionParams,
    );
    const tokenInAddress = TOKEN_ADDRESS_BY_SYMBOL[
      operation.tokenIn
    ] as `0x${string}`;
    const inputAmount = this.resolvePreparedInputAmount(
      prepared.raw,
      operation.amountIn,
    );
    const adapter = await this.createCircleWalletsAdapter();
    const { ArcTestnet } = await import('@circle-fin/bridge-kit/chains');
    const adapterContract = this.validContractAddressOrNull(
      ArcTestnet.kitContracts?.adapter,
    );

    if (!adapterContract) {
      throw new BadGatewayException({
        code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_FAILED,
        message:
          'Circle Arc Testnet adapter contract is not configured for treasury swap execution.',
      });
    }

    const context = {
      chain: ArcTestnet,
      address: operation.treasuryDepositAddress,
    };
    const approval = await adapter.prepareAction(
      'token.approve',
      {
        tokenAddress: tokenInAddress,
        delegate: adapterContract,
        amount: inputAmount,
      },
      context,
    );
    const approvalTxHash = await approval.execute();

    if (typeof adapter.waitForTransaction === 'function') {
      await adapter.waitForTransaction(approvalTxHash, undefined, ArcTestnet);
    }

    const swap = await adapter.prepareAction(
      'swap.execute',
      {
        executeParams,
        tokenInputs: [
          {
            permitType: 0,
            token: tokenInAddress,
            amount: inputAmount,
            permitCalldata: '0x',
          },
        ],
        signature,
        inputAmount,
        tokenInAddress,
      },
      context,
    );
    const swapTxHash = await swap.execute();

    return {
      txId: null,
      txHash: this.validTxHashOrNull(swapTxHash),
      raw: this.sanitizeForPersistence({
        adapter: 'circle-wallets',
        adapterContract,
        approvalTxHash,
        swapTxHash,
      }),
    };
  }

  private async createCircleWalletsAdapter(): Promise<any> {
    const { createCircleWalletsAdapter } = await import(
      '@circle-fin/adapter-circle-wallets'
    );

    return createCircleWalletsAdapter({
      apiKey: process.env.CIRCLE_API_KEY ?? '',
      entitySecret: process.env.CIRCLE_ENTITY_SECRET ?? '',
    });
  }

  private buildSwapExecuteParams(executionParams: Record<string, unknown>) {
    if (!Array.isArray(executionParams.instructions)) {
      throw new BadGatewayException({
        code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_FAILED,
        message:
          'Circle Stablecoin Kits swap response did not include execution instructions.',
      });
    }

    const instructions = executionParams.instructions.map(
      (instruction, index) => {
        if (!this.isRecord(instruction)) {
          throw new BadGatewayException({
            code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_FAILED,
            message: `Circle Stablecoin Kits swap instruction ${index + 1} is invalid.`,
          });
        }

        return {
          target: this.normalizeAddressField(
            instruction.target,
            'instruction.target',
          ),
          data: this.normalizeHexField(instruction.data, 'instruction.data'),
          value: this.normalizeBigIntField(
            instruction.value,
            'instruction.value',
          ),
          tokenIn: this.normalizeAddressField(
            instruction.tokenIn,
            'instruction.tokenIn',
          ),
          amountToApprove: this.normalizeBigIntField(
            instruction.amountToApprove,
            'instruction.amountToApprove',
          ),
          tokenOut: this.normalizeAddressField(
            instruction.tokenOut,
            'instruction.tokenOut',
          ),
          minTokenOut: this.normalizeBigIntField(
            instruction.minTokenOut,
            'instruction.minTokenOut',
          ),
        };
      },
    );
    const tokens = Array.isArray(executionParams.tokens)
      ? executionParams.tokens.map((token, index) => {
          if (!this.isRecord(token)) {
            throw new BadGatewayException({
              code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_FAILED,
              message: `Circle Stablecoin Kits swap output token ${index + 1} is invalid.`,
            });
          }

          return {
            token: this.normalizeAddressField(token.token, 'token.token'),
            beneficiary: this.normalizeAddressField(
              token.beneficiary,
              'token.beneficiary',
            ),
          };
        })
      : [];

    return {
      instructions,
      tokens,
      execId: this.normalizeBigIntField(executionParams.execId, 'execId'),
      deadline: this.normalizeBigIntField(
        executionParams.deadline,
        'deadline',
      ),
      metadata: this.normalizeHexField(executionParams.metadata, 'metadata'),
    };
  }

  private createNonExecutableSwapResponseError(
    raw: unknown,
    transaction: unknown,
  ): BadGatewayException {
    const topLevelKeys = this.describeResponseShape(raw).keys;
    const transactionKeys = this.describeResponseShape(transaction).keys;

    return new BadGatewayException({
      code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_FAILED,
      message:
        `Circle Stablecoin Kits swap response did not include an executable transaction target. ` +
        `Top-level keys: ${topLevelKeys.join(', ') || 'none'}. ` +
        `Transaction keys: ${transactionKeys.join(', ') || 'none'}.`,
    });
  }

  private describeResponseShape(value: unknown): {
    type: string;
    keys: string[];
  } {
    if (Array.isArray(value)) {
      return { type: 'array', keys: [] };
    }

    if (this.isRecord(value)) {
      return { type: 'object', keys: Object.keys(value).sort() };
    }

    return { type: typeof value, keys: [] };
  }

  private sanitizeForPersistence(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeForPersistence(item));
    }

    if (!this.isRecord(value)) {
      return typeof value === 'bigint' ? value.toString() : value;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        this.shouldRedactKey(key)
          ? '[REDACTED]'
          : this.sanitizeForPersistence(entry),
      ]),
    );
  }

  private shouldRedactKey(key: string): boolean {
    return /(api[-_]?key|authorization|bearer|entity[-_]?secret|private[-_]?key|access[-_]?token|refresh[-_]?token|user[-_]?token|encryption[-_]?key)$/i.test(
      key,
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private fromNullableJson(value: Prisma.JsonValue): unknown {
    return value;
  }

  private optionalDate(value: string | undefined): Date | undefined {
    return value ? new Date(value) : undefined;
  }

  private normalizeContractAddress(value: unknown): string {
    const address = this.validContractAddressOrNull(value);

    if (!address) {
      throw new BadGatewayException({
        code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_FAILED,
        message:
          'Circle Stablecoin Kits swap response did not include a valid contract address.',
      });
    }

    return address;
  }

  private normalizeCallData(value: unknown): `0x${string}` {
    const callData = this.validCallDataOrNull(value);

    if (!callData) {
      throw new BadGatewayException({
        code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_FAILED,
        message:
          'Circle Stablecoin Kits swap response did not include valid call data.',
      });
    }

    return callData;
  }

  private validContractAddressOrNull(value: unknown): string | null {
    return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)
      ? value
      : null;
  }

  private validCallDataOrNull(value: unknown): `0x${string}` | null {
    return typeof value === 'string' && /^0x(?:[a-fA-F0-9]{2})*$/.test(value)
      ? (value as `0x${string}`)
      : null;
  }

  private normalizeAddressField(value: unknown, field: string): `0x${string}` {
    const address = this.validContractAddressOrNull(value);

    if (!address) {
      throw new BadGatewayException({
        code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_FAILED,
        message: `Circle Stablecoin Kits swap response did not include a valid ${field}.`,
      });
    }

    return address as `0x${string}`;
  }

  private normalizeHexField(value: unknown, field: string): `0x${string}` {
    if (
      typeof value !== 'string' ||
      !/^0x(?:[a-fA-F0-9]{2})*$/.test(value)
    ) {
      throw new BadGatewayException({
        code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_FAILED,
        message: `Circle Stablecoin Kits swap response did not include valid ${field}.`,
      });
    }

    return value as `0x${string}`;
  }

  private normalizeBigIntField(value: unknown, field: string): bigint {
    if (typeof value === 'bigint') {
      return value;
    }

    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return BigInt(value);
    }

    if (typeof value === 'string' && /^\d+$/.test(value)) {
      return BigInt(value);
    }

    if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) {
      return BigInt(value);
    }

    throw new BadGatewayException({
      code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_FAILED,
      message: `Circle Stablecoin Kits swap response did not include valid ${field}.`,
    });
  }

  private resolvePreparedInputAmount(raw: unknown, fallbackAmount: string): bigint {
    const rawAmount = this.findFirst(raw, ['amount']);

    if (
      typeof rawAmount === 'string' ||
      typeof rawAmount === 'number' ||
      typeof rawAmount === 'bigint'
    ) {
      return this.normalizeBigIntField(rawAmount, 'amount');
    }

    return this.normalizeBigIntField(fallbackAmount, 'amountIn');
  }

  private validTxHashOrNull(value: string | null | undefined): string | null {
    return value && /^0x[a-fA-F0-9]{64}$/.test(value) ? value : null;
  }

  private isFailedCircleStatus(status: string): boolean {
    return ['FAILED', 'CANCELLED', 'DENIED'].includes(status);
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

  private formatBaseUnits(value: string, decimals: number): string {
    const amount = BigInt(value);
    const scale = 10n ** BigInt(decimals);
    const whole = amount / scale;
    const fraction = amount % scale;

    if (fraction === 0n) {
      return whole.toString();
    }

    return `${whole}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
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

  private getPublicErrorMessage(error: unknown): string {
    if (error instanceof BadRequestException) {
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

  private normalizeOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim()
      ? value.trim()
      : undefined;
  }

  private assertDepositTxHash(depositTxHash: string): void {
    if (!/^0x[a-fA-F0-9]{64}$/.test(depositTxHash)) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'depositTxHash must be a 32-byte transaction hash.',
      });
    }
  }

  private extractCircleTransactionHash(value: unknown): string | null {
    const candidate =
      this.getNestedString(value, ['data', 'transaction', 'txHash']) ??
      this.getNestedString(value, ['data', 'transaction', 'transactionHash']) ??
      this.getNestedString(value, ['data', 'transaction', 'hash']) ??
      this.getNestedString(value, ['transaction', 'txHash']) ??
      this.getNestedString(value, ['transaction', 'transactionHash']) ??
      this.getNestedString(value, ['transaction', 'hash']) ??
      this.getNestedString(value, ['txHash']) ??
      this.getNestedString(value, ['transactionHash']) ??
      this.getNestedString(value, ['hash']);

    return candidate && /^0x[a-fA-F0-9]{64}$/.test(candidate)
      ? candidate
      : null;
  }

  private getPayoutTransactionId(rawPayout: unknown): string | null {
    return (
      this.getNestedString(rawPayout, ['transfer', 'txId']) ??
      this.getNestedString(rawPayout, ['status', 'txId']) ??
      this.getNestedString(rawPayout, ['previous', 'transfer', 'txId']) ??
      this.getNestedString(rawPayout, ['previous', 'status', 'txId'])
    );
  }

  private findMatchingCircleDepositTransaction(
    value: unknown,
    operation: AppWalletSwapOperationResponse,
  ): unknown {
    const transactions = this.extractCircleTransactions(value);

    return transactions.find((transaction) =>
      this.matchesCircleDepositTransaction(transaction, operation),
    );
  }

  private findMatchingCirclePayoutTransaction(
    value: unknown,
    operation: AppWalletSwapOperationResponse,
    treasuryWalletId: string,
  ): unknown {
    const transactions = this.extractCircleTransactions(value);

    return transactions.find((transaction) =>
      this.matchesCirclePayoutTransaction(
        transaction,
        operation,
        treasuryWalletId,
      ),
    );
  }

  private buildDepositResolutionDiagnostic(
    value: unknown,
    operation: AppWalletSwapOperationResponse,
  ): string | null {
    if (operation.tokenIn !== 'EURC') {
      return null;
    }

    const transactions = this.extractCircleTransactions(value);

    if (transactions.length === 0) {
      return null;
    }

    const candidates = transactions.slice(0, 5).map((transaction) =>
      this.sanitizeForPersistence({
        shape: this.describeResponseShape(transaction),
        id: this.getNestedString(transaction, ['id']),
        blockchain: this.getNestedString(transaction, ['blockchain']),
        walletId: this.getNestedString(transaction, ['walletId']),
        sourceAddress:
          this.getNestedString(transaction, ['sourceAddress']) ??
          this.getNestedString(transaction, ['source', 'address']) ??
          this.getNestedString(transaction, ['fromAddress']) ??
          this.getNestedString(transaction, ['from']),
        destinationAddress:
          this.getNestedString(transaction, ['destinationAddress']) ??
          this.getNestedString(transaction, ['destination', 'address']) ??
          this.getNestedString(transaction, ['toAddress']) ??
          this.getNestedString(transaction, ['to']),
        state: this.getNestedString(transaction, ['state']),
        operation: this.getNestedString(transaction, ['operation']),
        transactionType: this.getNestedString(transaction, ['transactionType']),
        token: this.getNestedString(transaction, ['token']),
        tokenSymbol: this.getNestedString(transaction, ['tokenSymbol']),
        assetSymbol: this.getNestedString(transaction, ['assetSymbol']),
        tokenId: this.getNestedString(transaction, ['tokenId']),
        contractAddress: this.getNestedString(transaction, ['contractAddress']),
        tokenAddress: this.getNestedString(transaction, ['tokenAddress']),
        amount:
          this.getNestedString(transaction, ['amount']) ??
          this.getNestedString(transaction, ['value']) ??
          this.firstStringFromArray(
            this.getNestedValue(transaction, ['amounts']),
          ),
        createDate:
          this.getNestedString(transaction, ['createDate']) ??
          this.getNestedString(transaction, ['createdAt']) ??
          this.getNestedString(transaction, ['submittedAt']),
        hasTxHash: Boolean(this.extractCircleTransactionHash(transaction)),
        rejectionReasons: this.getDepositTransactionRejectionReasons(
          transaction,
          operation,
        ),
      }),
    );

    return JSON.stringify({
      expectedToken: operation.tokenIn,
      expectedAmount: operation.amountIn,
      expectedDestination: operation.treasuryDepositAddress,
      expectedWalletId: operation.circleWalletId ?? null,
      candidateCount: transactions.length,
      candidates,
    });
  }

  private extractCircleTransactions(value: unknown): unknown[] {
    const candidates = [
      this.getNestedValue(value, ['data', 'transactions']),
      this.getNestedValue(value, ['transactions']),
      this.getNestedValue(value, ['data', 'transaction']),
      this.getNestedValue(value, ['transaction']),
    ];

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate;
      }

      if (candidate && typeof candidate === 'object') {
        return [candidate];
      }
    }

    return [];
  }

  private matchesCircleDepositTransaction(
    transaction: unknown,
    operation: AppWalletSwapOperationResponse,
  ): boolean {
    if (!transaction || typeof transaction !== 'object') {
      return false;
    }

    const txHash = this.extractCircleTransactionHash(transaction);

    if (!txHash) {
      return false;
    }

    if (
      !this.equalsIgnoreCase(
        this.getNestedString(transaction, ['blockchain']),
        APP_WALLET_SWAP_CHAIN,
      )
    ) {
      return false;
    }

    if (
      !this.transactionDestinationMatchesDepositTarget(transaction, operation)
    ) {
      return false;
    }

    if (!this.transactionMatchesDepositToken(transaction, operation.tokenIn)) {
      return false;
    }

    if (
      !this.transactionAmountEquals(
        operation.amountIn,
        transaction,
        operation.tokenIn,
      )
    ) {
      return false;
    }

    if (!this.transactionOccurredAfter(transaction, operation.depositSubmittedAt)) {
      return false;
    }

    if (!this.transactionHasAcceptableDepositTransferShape(transaction)) {
      return false;
    }

    if (!this.transactionMatchesDepositSource(transaction, operation)) {
      return false;
    }

    if (!this.transactionMatchesReference(transaction, operation)) {
      if (!this.transactionHasStrictFallbackMatch(transaction, operation)) {
        return false;
      }
    }

    const sourceAddress =
      this.getNestedString(transaction, ['sourceAddress']) ??
      this.getNestedString(transaction, ['source', 'address']) ??
      this.getNestedString(transaction, ['fromAddress']) ??
      this.getNestedString(transaction, ['from']);

    if (
      sourceAddress &&
      !this.equalsIgnoreCase(sourceAddress, operation.userWalletAddress)
    ) {
      return false;
    }

    if (
      operation.circleWalletId &&
      !this.equalsIgnoreCase(
        this.getNestedString(transaction, ['walletId']),
        operation.circleWalletId,
      )
    ) {
      return false;
    }

    if (!this.getTransactionDestinationAddress(transaction)) {
      this.logger.log(
        `App Wallet ${operation.tokenIn} deposit txHash matched operation ${operation.operationId} by token transfer fields with no Circle destinationAddress.`,
      );
    }

    return true;
  }

  private transactionMatchesDepositSource(
    transaction: unknown,
    operation: AppWalletSwapOperationResponse,
  ): boolean {
    const walletId = this.getNestedString(transaction, ['walletId']);
    const sourceAddress = this.getTransactionSourceAddress(transaction);

    if (operation.circleWalletId && walletId) {
      return (
        this.equalsIgnoreCase(walletId, operation.circleWalletId) &&
        (!sourceAddress ||
          this.equalsIgnoreCase(sourceAddress, operation.userWalletAddress))
      );
    }

    return Boolean(
      sourceAddress &&
        this.equalsIgnoreCase(sourceAddress, operation.userWalletAddress),
    );
  }

  private transactionDestinationMatchesDepositTarget(
    transaction: unknown,
    operation: AppWalletSwapOperationResponse,
  ): boolean {
    const destinationAddress = this.getTransactionDestinationAddress(transaction);

    return (
      !destinationAddress ||
      this.equalsIgnoreCase(destinationAddress, operation.treasuryDepositAddress)
    );
  }

  private matchesCirclePayoutTransaction(
    transaction: unknown,
    operation: AppWalletSwapOperationResponse,
    treasuryWalletId: string,
  ): boolean {
    if (!transaction || typeof transaction !== 'object') {
      return false;
    }

    if (!this.extractCircleTransactionHash(transaction)) {
      return false;
    }

    if (
      !this.equalsIgnoreCase(
        this.getNestedString(transaction, ['blockchain']),
        APP_WALLET_SWAP_CHAIN,
      )
    ) {
      return false;
    }

    if (
      !this.equalsIgnoreCase(
        this.getNestedString(transaction, ['walletId']),
        treasuryWalletId,
      )
    ) {
      return false;
    }

    const sourceAddress = this.getTransactionSourceAddress(transaction);

    if (
      sourceAddress &&
      !this.equalsIgnoreCase(sourceAddress, operation.treasuryDepositAddress)
    ) {
      return false;
    }

    if (
      !this.addressMatchesAny(transaction, operation.userWalletAddress, [
        ['destinationAddress'],
        ['destination', 'address'],
        ['toAddress'],
        ['to'],
      ])
    ) {
      return false;
    }

    if (!this.transactionMatchesDepositToken(transaction, operation.tokenOut)) {
      return false;
    }

    if (
      !this.transactionAmountEquals(
        operation.payoutAmount,
        transaction,
        operation.tokenOut,
      )
    ) {
      return false;
    }

    if (!this.transactionHasCompleteOutboundTransferShape(transaction)) {
      return false;
    }

    return this.transactionOccurredAfter(
      transaction,
      operation.payoutSubmittedAt,
    );
  }

  private transactionHasStrictFallbackMatch(
    transaction: unknown,
    operation: AppWalletSwapOperationResponse,
  ): boolean {
    const sourceAddress = this.getTransactionSourceAddress(transaction);
    const walletId = this.getNestedString(transaction, ['walletId']);

    return (
      this.transactionHasAcceptableDepositTransferShape(transaction) &&
      (!operation.circleWalletId ||
        this.equalsIgnoreCase(walletId, operation.circleWalletId)) &&
      (!sourceAddress ||
        this.equalsIgnoreCase(sourceAddress, operation.userWalletAddress))
    );
  }

  private getDepositTransactionRejectionReasons(
    transaction: unknown,
    operation: AppWalletSwapOperationResponse,
  ): string[] {
    const reasons: string[] = [];
    const walletId = this.getNestedString(transaction, ['walletId']);
    const sourceAddress = this.getTransactionSourceAddress(transaction);
    const destinationAddress = this.getTransactionDestinationAddress(transaction);

    if (!this.extractCircleTransactionHash(transaction)) {
      reasons.push('missing txHash');
    }

    if (
      !this.equalsIgnoreCase(
        this.getNestedString(transaction, ['blockchain']),
        APP_WALLET_SWAP_CHAIN,
      )
    ) {
      reasons.push('chain mismatch');
    }

    if (
      operation.circleWalletId &&
      walletId &&
      !this.equalsIgnoreCase(walletId, operation.circleWalletId)
    ) {
      reasons.push('address mismatch: walletId');
    }

    if (
      sourceAddress &&
      !this.equalsIgnoreCase(sourceAddress, operation.userWalletAddress)
    ) {
      reasons.push('address mismatch: sourceAddress');
    }

    if (
      destinationAddress &&
      !this.equalsIgnoreCase(destinationAddress, operation.treasuryDepositAddress)
    ) {
      reasons.push('address mismatch: destinationAddress');
    }

    if (!this.transactionMatchesDepositToken(transaction, operation.tokenIn)) {
      reasons.push('token mismatch');
    }

    if (
      !this.transactionAmountEquals(
        operation.amountIn,
        transaction,
        operation.tokenIn,
      )
    ) {
      reasons.push('amount mismatch');
    }

    if (!this.transactionOccurredAfter(transaction, operation.depositSubmittedAt)) {
      reasons.push('timestamp mismatch');
    }

    if (!this.transactionHasAcceptableDepositTransferShape(transaction)) {
      const state = this.getNestedString(transaction, ['state']);
      const operationType = this.getNestedString(transaction, ['operation']);
      const transactionType = this.getNestedString(transaction, ['transactionType']);

      if (state && !this.isResolvableDepositTransactionState(state)) {
        reasons.push('state mismatch');
      }

      if (operationType && !this.equalsIgnoreCase(operationType, 'TRANSFER')) {
        reasons.push('operation mismatch');
      }

      if (
        transactionType &&
        !this.equalsIgnoreCase(transactionType, 'OUTBOUND')
      ) {
        reasons.push('transactionType mismatch');
      }
    }

    return reasons;
  }

  private transactionMatchesReference(
    transaction: unknown,
    operation: AppWalletSwapOperationResponse,
  ): boolean {
    const txId = this.getNestedString(transaction, ['id']);
    const refId = this.getNestedString(transaction, ['refId']);

    if (
      operation.circleTransactionId &&
      this.equalsIgnoreCase(txId, operation.circleTransactionId)
    ) {
      return true;
    }

    if (
      operation.circleReferenceId &&
      (this.equalsIgnoreCase(refId, operation.circleReferenceId) ||
        this.equalsIgnoreCase(txId, operation.circleReferenceId))
    ) {
      return true;
    }

    return false;
  }

  private transactionMatchesDepositToken(
    transaction: unknown,
    token: AppWalletSwapToken,
  ): boolean {
    const tokenAddress = TOKEN_ADDRESS_BY_SYMBOL[token];
    const circleTokenId = CIRCLE_TOKEN_ID_BY_SYMBOL[token];
    const transactionTokenId = this.getNestedString(transaction, ['tokenId']);

    if (transactionTokenId) {
      return this.equalsIgnoreCase(transactionTokenId, circleTokenId);
    }

    return (
      this.equalsIgnoreCase(
        this.getNestedString(transaction, ['token']),
        token,
      ) ||
      this.equalsIgnoreCase(
        this.getNestedString(transaction, ['token', 'symbol']),
        token,
      ) ||
      this.equalsIgnoreCase(
        this.getNestedString(transaction, ['tokenSymbol']),
        token,
      ) ||
      this.equalsIgnoreCase(
        this.getNestedString(transaction, ['assetSymbol']),
        token,
      ) ||
      this.equalsIgnoreCase(
        this.getNestedString(transaction, ['asset', 'symbol']),
        token,
      ) ||
      this.equalsIgnoreCase(
        this.getNestedString(transaction, ['currency']),
        token,
      ) ||
      this.equalsIgnoreCase(
        this.getNestedString(transaction, ['contractAddress']),
        tokenAddress,
      ) ||
      this.equalsIgnoreCase(
        this.getNestedString(transaction, ['token', 'contractAddress']),
        tokenAddress,
      ) ||
      this.equalsIgnoreCase(
        this.getNestedString(transaction, ['tokenAddress']),
        tokenAddress,
      ) ||
      this.equalsIgnoreCase(
        this.getNestedString(transaction, ['asset', 'address']),
        tokenAddress,
      )
    );
  }

  private transactionAmountEquals(
    expectedAmount: string | undefined,
    transaction: unknown,
    token: AppWalletSwapToken = 'USDC',
  ): boolean {
    if (!expectedAmount) {
      return false;
    }

    const rawAmount =
      this.getNestedString(transaction, ['amount']) ??
      this.getNestedString(transaction, ['value']) ??
      this.firstStringFromArray(this.getNestedValue(transaction, ['amounts']));

    if (!rawAmount) {
      return false;
    }

    const normalizedAmount = this.normalizeCircleAmountToBaseUnits(
      rawAmount,
      expectedAmount,
      token,
    );

    return normalizedAmount !== null && normalizedAmount === BigInt(expectedAmount);
  }

  private transactionOccurredAfter(
    transaction: unknown,
    submittedAt: string | undefined,
  ): boolean {
    if (!submittedAt) {
      return false;
    }

    const submittedTime = Date.parse(submittedAt);

    if (!Number.isFinite(submittedTime)) {
      return false;
    }

    const timestamp =
      this.getNestedString(transaction, ['createDate']) ??
      this.getNestedString(transaction, ['createdAt']) ??
      this.getNestedString(transaction, ['submittedAt']) ??
      this.getNestedString(transaction, ['updateDate']) ??
      this.getNestedString(transaction, ['updatedAt']);

    if (!timestamp) {
      return false;
    }

    const transactionTime = Date.parse(timestamp);

    return (
      Number.isFinite(transactionTime) &&
      transactionTime + CIRCLE_TRANSACTION_TIME_TOLERANCE_MS >= submittedTime
    );
  }

  private transactionHasCompleteOutboundTransferShape(
    transaction: unknown,
  ): boolean {
    return (
      this.equalsIgnoreCase(this.getNestedString(transaction, ['state']), 'COMPLETE') &&
      this.equalsIgnoreCase(
        this.getNestedString(transaction, ['operation']),
        'TRANSFER',
      ) &&
      this.equalsIgnoreCase(
        this.getNestedString(transaction, ['transactionType']),
        'OUTBOUND',
      )
    );
  }

  private transactionHasAcceptableDepositTransferShape(
    transaction: unknown,
  ): boolean {
    const state = this.getNestedString(transaction, ['state']);
    const operationType = this.getNestedString(transaction, ['operation']);
    const transactionType = this.getNestedString(transaction, ['transactionType']);

    return (
      (!state || this.isResolvableDepositTransactionState(state)) &&
      (!operationType || this.equalsIgnoreCase(operationType, 'TRANSFER')) &&
      (!transactionType || this.equalsIgnoreCase(transactionType, 'OUTBOUND'))
    );
  }

  private isResolvableDepositTransactionState(state: string): boolean {
    return (
      this.equalsIgnoreCase(state, 'COMPLETE') ||
      this.equalsIgnoreCase(state, 'SENT')
    );
  }

  private getTransactionSourceAddress(transaction: unknown): string | null {
    return (
      this.getNestedString(transaction, ['sourceAddress']) ??
      this.getNestedString(transaction, ['source', 'address']) ??
      this.getNestedString(transaction, ['fromAddress']) ??
      this.getNestedString(transaction, ['from'])
    );
  }

  private getTransactionDestinationAddress(transaction: unknown): string | null {
    return (
      this.getNestedString(transaction, ['destinationAddress']) ??
      this.getNestedString(transaction, ['destination', 'address']) ??
      this.getNestedString(transaction, ['toAddress']) ??
      this.getNestedString(transaction, ['to'])
    );
  }

  private normalizeCircleAmountToBaseUnits(
    rawAmount: string,
    expectedBaseAmount: string,
    token: AppWalletSwapToken,
  ): bigint | null {
    const amount = rawAmount.trim();

    if (!amount) {
      return null;
    }

    if (/^\d+$/.test(amount) && amount === expectedBaseAmount) {
      return BigInt(amount);
    }

    return this.normalizeTokenAmountToBaseUnits(
      amount,
      TOKEN_DECIMALS_BY_SYMBOL[token],
    );
  }

  private normalizeTokenAmountToBaseUnits(
    rawAmount: string,
    decimals: number,
  ): bigint | null {
    const amount = rawAmount.trim();

    if (!amount) {
      return null;
    }

    if (/^\d+$/.test(amount)) {
      return BigInt(amount) * 10n ** BigInt(decimals);
    }

    const match = amount.match(/^(\d*)\.(\d+)$/);

    if (!match) {
      return null;
    }

    const whole = match[1] || '0';
    const fraction = match[2].slice(0, decimals).padEnd(decimals, '0');

    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction);
  }

  private addressMatchesAny(
    value: unknown,
    expectedAddress: string,
    paths: string[][],
  ): boolean {
    return paths.some((path) =>
      this.equalsIgnoreCase(this.getNestedString(value, path), expectedAddress),
    );
  }

  private getNestedString(value: unknown, path: string[]): string | null {
    const current = this.getNestedValue(value, path);

    return typeof current === 'string' && current.trim()
      ? current.trim()
      : null;
  }

  private getNestedValue(value: unknown, path: string[]): unknown {
    let current = value;

    for (const key of path) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        return null;
      }

      current = (current as Record<string, unknown>)[key];
    }

    return current;
  }

  private firstStringFromArray(value: unknown): string | null {
    if (!Array.isArray(value)) {
      return null;
    }

    const firstString = value.find(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );

    return firstString?.trim() ?? null;
  }

  private equalsIgnoreCase(left: string | null, right: string): boolean {
    return left?.toLowerCase() === right.toLowerCase();
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
