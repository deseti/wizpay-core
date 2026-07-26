import { AppWalletSwapOperation } from '@prisma/client';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  USER_SWAP_EURC_ADDRESS,
  USER_SWAP_USDC_ADDRESS,
} from '../user-swap/user-swap.service';
import { AppWalletSwapCircleExecutorService } from './app-wallet-swap-circle-executor.service';
import {
  buildDepositResolutionDiagnostic,
  findMatchingCircleDepositTransaction,
  type CircleDepositTransactionMatch,
} from './app-wallet-swap-circle-transaction-matcher';
import { AppWalletSwapDepositVerifierService } from './app-wallet-swap-deposit-verifier.service';
import { mapAppWalletSwapOperationRecord } from './app-wallet-swap-operation.mapper';
import { AppWalletSwapOperationRepository } from './app-wallet-swap-operation.repository';
import { toPublicAppWalletSwapOperation } from './app-wallet-swap-public.mapper';
import { extractCircleTransactionHash } from './app-wallet-swap-provider-reference';
import {
  APP_WALLET_SWAP_CHAIN,
  APP_WALLET_SWAP_ERROR_CODES,
  AppWalletSwapDepositRequest,
  AppWalletSwapDepositTxHashRequest,
  AppWalletSwapOperationResponse,
  AppWalletSwapToken,
} from './app-wallet-swap.types';

const TOKEN_ADDRESS_BY_SYMBOL: Record<AppWalletSwapToken, string> = {
  USDC: USER_SWAP_USDC_ADDRESS,
  EURC: USER_SWAP_EURC_ADDRESS,
};
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

@Injectable()
export class AppWalletSwapDepositService {
  private readonly logger = new Logger('AppWalletSwapService');

  constructor(
    private readonly depositVerifier: AppWalletSwapDepositVerifierService,
    private readonly circleExecutor: AppWalletSwapCircleExecutorService,
    private readonly operationRepository: AppWalletSwapOperationRepository,
  ) {}

  async submitDeposit(
    operationId: string,
    request: AppWalletSwapDepositRequest,
  ): Promise<AppWalletSwapOperationResponse> {
    this.assertOperationId(operationId);

    const operation = await this.getOperation(operationId);

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

    const operation = await this.getOperation(operationId);

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
      const depositTxHash = extractCircleTransactionHash(
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
    const listDepositTxHash = extractCircleTransactionHash(
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

  private async getOperation(
    operationId: string,
  ): Promise<AppWalletSwapOperationResponse> {
    const operation = await this.operationRepository.findById(operationId);

    if (!operation) {
      throw new NotFoundException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'App Wallet swap operation was not found.',
      });
    }

    return this.mapOperationRecord(operation);
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

  private mapOperationRecord(
    record: AppWalletSwapOperation,
  ): AppWalletSwapOperationResponse {
    return mapAppWalletSwapOperationRecord(record);
  }

  private toPublicOperation(
    operation: AppWalletSwapOperationResponse,
  ): AppWalletSwapOperationResponse {
    return toPublicAppWalletSwapOperation(operation);
  }

  private assertOperationId(operationId: string): void {
    if (!UUID_PATTERN.test(operationId)) {
      throw new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'App Wallet swap operation id is invalid.',
      });
    }
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
}
