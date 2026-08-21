import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AppWalletXylonetOperation, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hash,
  type PublicClient,
} from 'viem';
import { resolveArcTestnetRpcUrl } from '../config/arc-rpc';
import { PrismaService } from '../database/prisma.service';
import { W3sAuthService } from '../modules/wallet/w3s-auth.service';
import { WalletService } from '../modules/wallet/wallet.service';
import type { AppWalletXylonetOperationDto } from './dto/app-wallet-xylonet-operation.dto';
import {
  APP_WALLET_XYLONET_ERRORS,
  APP_WALLET_XYLONET_MODE,
  APP_WALLET_XYLONET_PROVIDER,
  type AppWalletXylonetOperationResponse,
  type AppWalletXylonetStage,
  type AppWalletXylonetTerminalStatus,
} from './app-wallet-xylonet.types';

const ARC_CHAIN_ID = 5_042_002;
const FEE_BPS = 25;
const DEFAULT_DEADLINE_SECONDS = 600;
const MAX_DEADLINE_SECONDS = 1_200;
const MAX_POLL_ATTEMPTS = 60;
const MAX_OPERATION_AGE_MS = 20 * 60 * 1_000;

const ERC20_ABI = [
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
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Approval',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'spender', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

const EXECUTOR_ABI = [
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'feeRecipient',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'feeBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowedRouters',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowedTokens',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'executeSwap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'router', type: 'address' },
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' },
      { name: 'recipient', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'WizPaySwapExecuted',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'router', type: 'address', indexed: true },
      { name: 'tokenIn', type: 'address', indexed: true },
      { name: 'tokenOut', type: 'address', indexed: false },
      { name: 'amountIn', type: 'uint256', indexed: false },
      { name: 'feeAmount', type: 'uint256', indexed: false },
      { name: 'netAmountIn', type: 'uint256', indexed: false },
      { name: 'amountOut', type: 'uint256', indexed: false },
      { name: 'recipient', type: 'address', indexed: false },
    ],
  },
] as const;

const ROUTER_QUOTE_ABI = [
  {
    type: 'function',
    name: 'getAmountOut',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

export const APP_WALLET_XYLONET_PUBLIC_CLIENT = Symbol(
  'APP_WALLET_XYLONET_PUBLIC_CLIENT',
);

type CircleTransaction = Record<string, unknown>;
type ChallengeStage = 'approval' | 'swap';
type CircleChallengeState =
  | 'pending'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'expired'
  | 'timed_out'
  | 'unknown';

@Injectable()
export class AppWalletXylonetUserControlledExecutorService {
  private readonly logger = new Logger(
    AppWalletXylonetUserControlledExecutorService.name,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly w3sAuthService: W3sAuthService,
    @Optional()
    @Inject(APP_WALLET_XYLONET_PUBLIC_CLIENT)
    private readonly injectedPublicClient?: PublicClient,
  ) {}

  async quote(request: AppWalletXylonetOperationDto, userToken: string) {
    const config = this.getConfig();
    await this.assertOnchainCapability(config);
    const identity = await this.authenticateWallet(
      userToken,
      request.walletId,
      request.walletAddress,
    );
    const tokenIn = this.normalizeToken(request.tokenIn);
    const tokenOut = this.normalizeToken(request.tokenOut);
    if (tokenIn === tokenOut)
      this.invalid('tokenIn and tokenOut must be different.');
    if (request.chain !== 'ARC-TESTNET')
      this.invalid('Only ARC-TESTNET is supported.');
    const amountIn = this.parsePositiveAmount(request.amountIn, 'amountIn');
    const feeAmount = (amountIn * BigInt(FEE_BPS)) / 10_000n;
    const netAmountIn = amountIn - feeAmount;
    const expectedOutput = (await this.getPublicClient().readContract({
      address: config.router,
      abi: ROUTER_QUOTE_ABI,
      functionName: 'getAmountOut',
      args: [config.tokens[tokenIn], config.tokens[tokenOut], netAmountIn],
    })) as bigint;
    const minimumOutput =
      (expectedOutput * BigInt(10_000 - request.slippageBps)) / 10_000n;
    if (expectedOutput <= 0n || minimumOutput <= 0n) {
      throw new BadGatewayException({
        code: APP_WALLET_XYLONET_ERRORS.VERIFICATION_FAILED,
        message: 'XyloNet returned no slippage-protected executable output.',
      });
    }
    return {
      operationMode: APP_WALLET_XYLONET_MODE,
      executionMode: APP_WALLET_XYLONET_MODE,
      provider: APP_WALLET_XYLONET_PROVIDER,
      sourceChain: 'ARC-TESTNET' as const,
      chainId: ARC_CHAIN_ID,
      circleWalletId: identity.walletId,
      walletAddress: identity.address,
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      expectedOutput: expectedOutput.toString(),
      minimumOutput: minimumOutput.toString(),
      feeBps: FEE_BPS,
      routerAddress: config.router,
      executorAddress: config.executor,
      recipientAddress: identity.address,
      expiresAt: new Date(
        Date.now() + config.deadlineSeconds * 1_000,
      ).toISOString(),
      status: 'quoted' as const,
    };
  }

  async createOperation(
    request: AppWalletXylonetOperationDto,
    userToken: string,
  ): Promise<AppWalletXylonetOperationResponse> {
    const config = this.getConfig();
    await this.assertOnchainCapability(config);
    const identity = await this.authenticateWallet(
      userToken,
      request.walletId,
      request.walletAddress,
    );
    const tokenIn = this.normalizeToken(request.tokenIn);
    const tokenOut = this.normalizeToken(request.tokenOut);
    if (tokenIn === tokenOut) {
      this.invalid('tokenIn and tokenOut must be different.');
    }
    if (request.chain !== 'ARC-TESTNET') {
      this.invalid('Only ARC-TESTNET is supported.');
    }

    const amountIn = this.parsePositiveAmount(request.amountIn, 'amountIn');
    const tokenInAddress = config.tokens[tokenIn];
    const tokenOutAddress = config.tokens[tokenOut];
    const feeAmount = (amountIn * BigInt(FEE_BPS)) / 10_000n;
    const netAmountIn = amountIn - feeAmount;
    const expectedOutput = (await this.getPublicClient().readContract({
      address: config.router,
      abi: ROUTER_QUOTE_ABI,
      functionName: 'getAmountOut',
      args: [tokenInAddress, tokenOutAddress, netAmountIn],
    })) as bigint;
    if (expectedOutput <= 0n) {
      throw new BadGatewayException({
        code: APP_WALLET_XYLONET_ERRORS.VERIFICATION_FAILED,
        message: 'XyloNet returned no executable output.',
      });
    }
    const minimumOutput =
      (expectedOutput * BigInt(10_000 - request.slippageBps)) / 10_000n;
    if (minimumOutput <= 0n) this.invalid('minimumOutput must be positive.');

    const operationId = randomUUID();
    const now = new Date();
    const deadline = BigInt(
      Math.floor(now.getTime() / 1_000) + config.deadlineSeconds,
    );
    const operation = await this.prisma.appWalletXylonetOperation.create({
      data: {
        operationId,
        applicationUserId: identity.userId,
        executionMode: APP_WALLET_XYLONET_MODE,
        circleWalletId: identity.walletId,
        walletAddress: identity.address,
        chain: 'ARC-TESTNET',
        chainId: ARC_CHAIN_ID,
        tokenIn,
        tokenOut,
        tokenInAddress,
        tokenOutAddress,
        amountIn: amountIn.toString(),
        expectedOutput: expectedOutput.toString(),
        minimumOutput: minimumOutput.toString(),
        slippageBps: request.slippageBps,
        feeBps: FEE_BPS,
        routerAddress: config.router,
        executorAddress: config.executor,
        recipientAddress: identity.address,
        deadline: deadline.toString(),
        approvalIdempotencyKey: this.deterministicUuidV4(
          operationId,
          'approval',
        ),
        swapIdempotencyKey: this.deterministicUuidV4(operationId, 'swap'),
        lifecycleStage: 'created',
      },
    });

    this.logger.log(
      `[app-wallet-xylonet] mode=${APP_WALLET_XYLONET_MODE} ` +
        `operationId=${operationId} stage=created treasuryFallback=false`,
    );
    return this.toPublic(operation);
  }

  async getOperation(
    operationId: string,
    userToken: string,
  ): Promise<AppWalletXylonetOperationResponse> {
    const operation = await this.getOwnedOperation(operationId, userToken);
    return this.toPublic(
      await this.reconcileCompletedSwapTransactionHash(operation, userToken),
    );
  }

  async createApprovalChallenge(
    operationId: string,
    userToken: string,
  ): Promise<AppWalletXylonetOperationResponse> {
    const operation = await this.getOwnedOperation(operationId, userToken);
    this.assertNotTerminal(operation);
    if (
      operation.approvalChallengeId ||
      ['awaiting_approval_confirmation', 'approval_submitted'].includes(
        operation.lifecycleStage,
      )
    ) {
      return this.toPublic(operation);
    }
    if (operation.lifecycleStage === 'approval_confirmed') {
      return this.toPublic(operation);
    }
    if (
      !['created', 'approval_challenge_creating'].includes(
        operation.lifecycleStage,
      )
    ) {
      this.invalidStage(operation, 'approval challenge');
    }

    const allowance = (await this.getPublicClient().readContract({
      address: this.address(operation.tokenInAddress),
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [
        this.address(operation.walletAddress),
        this.address(operation.executorAddress),
      ],
    })) as bigint;
    if (allowance >= BigInt(operation.amountIn)) {
      return this.toPublic(
        await this.prisma.appWalletXylonetOperation.update({
          where: { operationId },
          data: {
            lifecycleStage: 'approval_confirmed',
            approvalConfirmedAt: new Date(),
          },
        }),
      );
    }

    await this.prisma.appWalletXylonetOperation.update({
      where: { operationId },
      data: { lifecycleStage: 'approval_challenge_creating' },
    });
    const callData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [
        this.address(operation.executorAddress),
        BigInt(operation.amountIn),
      ],
    });
    this.validateApprovalCallData(operation, callData);
    const response =
      await this.w3sAuthService.createUserContractExecutionChallenge({
        callData,
        contractAddress: operation.tokenInAddress,
        idempotencyKey: operation.approvalIdempotencyKey,
        refId: this.refId(operationId, 'approval'),
        userToken: this.requireUserToken(userToken),
        walletId: operation.circleWalletId,
      });
    const challengeId = this.readRequiredString(response, 'challengeId');
    const updated = await this.prisma.appWalletXylonetOperation.update({
      where: { operationId },
      data: {
        approvalChallengeId: challengeId,
        approvalChallengeCreatedAt: new Date(),
        lifecycleStage: 'awaiting_approval_confirmation',
      },
    });
    return this.toPublic(updated);
  }

  async createSwapChallenge(
    operationId: string,
    userToken: string,
  ): Promise<AppWalletXylonetOperationResponse> {
    const operation = await this.getOwnedOperation(operationId, userToken);
    this.assertNotTerminal(operation);
    if (
      operation.swapChallengeId ||
      ['awaiting_swap_confirmation', 'swap_submitted'].includes(
        operation.lifecycleStage,
      )
    ) {
      return this.toPublic(operation);
    }
    if (
      !['approval_confirmed', 'swap_challenge_creating'].includes(
        operation.lifecycleStage,
      )
    ) {
      this.invalidStage(operation, 'swap challenge');
    }
    this.assertDeadlineStillUsable(operation);

    await this.prisma.appWalletXylonetOperation.update({
      where: { operationId },
      data: { lifecycleStage: 'swap_challenge_creating' },
    });
    const callData = this.buildSwapCallData(operation);
    this.validateSwapCallData(operation, callData);
    const response =
      await this.w3sAuthService.createUserContractExecutionChallenge({
        callData,
        contractAddress: operation.executorAddress,
        idempotencyKey: operation.swapIdempotencyKey,
        refId: this.refId(operationId, 'swap'),
        userToken: this.requireUserToken(userToken),
        walletId: operation.circleWalletId,
      });
    const challengeId = this.readRequiredString(response, 'challengeId');
    const updated = await this.prisma.appWalletXylonetOperation.update({
      where: { operationId },
      data: {
        swapChallengeId: challengeId,
        swapChallengeCreatedAt: new Date(),
        lifecycleStage: 'awaiting_swap_confirmation',
      },
    });
    return this.toPublic(updated);
  }

  async recordChallengeResult(
    operationId: string,
    stage: ChallengeStage,
    result: { status: string; reason?: string },
    userToken: string,
  ): Promise<AppWalletXylonetOperationResponse> {
    const operation = await this.getOwnedOperation(operationId, userToken);
    this.assertNotTerminal(operation);
    const expectedStage =
      stage === 'approval'
        ? 'awaiting_approval_confirmation'
        : 'awaiting_swap_confirmation';
    if (operation.lifecycleStage !== expectedStage) {
      if (
        result.status === 'COMPLETE' &&
        ((stage === 'approval' &&
          operation.lifecycleStage === 'approval_submitted') ||
          (stage === 'swap' && operation.lifecycleStage === 'swap_submitted'))
      ) {
        return this.toPublic(operation);
      }
      this.invalidStage(operation, `${stage} challenge result`);
    }

    const callbackState = this.circleChallengeState(result.status);
    if (callbackState === 'pending' || callbackState === 'complete') {
      const synced = await this.syncChallengeStatus(
        operation,
        stage,
        userToken,
      );
      if (synced.operation.terminalStatus) {
        return this.toPublic(synced.operation);
      }
      const now = new Date();
      const updated = await this.prisma.appWalletXylonetOperation.update({
        where: { operationId },
        data:
          stage === 'approval'
            ? { lifecycleStage: 'approval_submitted', approvalSubmittedAt: now }
            : { lifecycleStage: 'swap_submitted', swapSubmittedAt: now },
      });
      return this.toPublic(updated);
    }

    if (callbackState === 'unknown') {
      this.invalid(`Unsupported Circle challenge status: ${result.status}.`);
    }
    const terminal = this.challengeTerminalStatus(callbackState);
    const updated = await this.failOperation(
      operation,
      terminal,
      result.reason || `${stage} challenge ${terminal}`,
    );
    return this.toPublic(updated);
  }

  async poll(
    operationId: string,
    userToken: string,
  ): Promise<AppWalletXylonetOperationResponse> {
    let operation = await this.getOwnedOperation(operationId, userToken);
    if (operation.terminalStatus) {
      return this.toPublic(
        await this.reconcileCompletedSwapTransactionHash(operation, userToken),
      );
    }
    if (
      operation.pollAttempts >= MAX_POLL_ATTEMPTS ||
      Date.now() - operation.createdAt.getTime() > MAX_OPERATION_AGE_MS
    ) {
      operation = await this.failOperation(
        operation,
        'timed_out',
        'Circle transaction confirmation timed out.',
      );
      return this.toPublic(operation);
    }
    operation = await this.prisma.appWalletXylonetOperation.update({
      where: { operationId },
      data: { pollAttempts: { increment: 1 } },
    });

    if (operation.lifecycleStage === 'approval_submitted') {
      operation = await this.pollStage(operation, 'approval', userToken);
    } else if (operation.lifecycleStage === 'swap_submitted') {
      operation = await this.pollStage(operation, 'swap', userToken);
    }
    return this.toPublic(operation);
  }

  private async pollStage(
    operation: AppWalletXylonetOperation,
    stage: ChallengeStage,
    userToken: string,
  ): Promise<AppWalletXylonetOperation> {
    const challenge = await this.syncChallengeStatus(
      operation,
      stage,
      userToken,
    );
    operation = challenge.operation;
    if (operation.terminalStatus || challenge.state === 'pending') {
      return operation;
    }

    const transactionId =
      stage === 'approval'
        ? operation.approvalTransactionId
        : operation.swapTransactionId;
    let transaction: CircleTransaction | null = null;
    if (transactionId) {
      let response: CircleTransaction;
      try {
        response = await this.w3sAuthService.getUserTransaction(
          transactionId,
          this.requireUserToken(userToken),
        );
      } catch (error) {
        if (this.circleHttpStatus(error) === 404) return operation;
        throw this.circleLookupError(error, `${stage} transaction`);
      }
      transaction = this.readCircleTransaction(response);
    } else {
      let listed: CircleTransaction;
      try {
        listed = await this.w3sAuthService.listUserTransactions(
          { walletId: operation.circleWalletId },
          this.requireUserToken(userToken),
        );
      } catch (error) {
        throw this.circleLookupError(error, `${stage} transaction list`);
      }
      transaction = this.findStageTransaction(listed, operation, stage);
    }
    if (!transaction) return operation;

    const id = this.readOptionalString(transaction, 'id');
    if (transactionId && id && id !== transactionId) {
      throw new BadGatewayException({
        code: APP_WALLET_XYLONET_ERRORS.CIRCLE_FAILED,
        message: `Circle returned a different ${stage} transaction identifier.`,
      });
    }
    const txHash =
      this.readOptionalString(transaction, 'txHash') ||
      this.readOptionalString(transaction, 'transactionHash');
    this.validateCircleTransaction(operation, transaction, stage);
    const state = (
      this.readOptionalString(transaction, 'state') || ''
    ).toUpperCase();
    if (['CANCELLED', 'CANCELED'].includes(state)) {
      return this.failOperation(
        operation,
        'cancelled',
        `${stage} transaction cancelled.`,
      );
    }
    if (['DENIED', 'REJECTED'].includes(state)) {
      return this.failOperation(
        operation,
        'rejected',
        `${stage} transaction denied.`,
      );
    }
    if (['FAILED', 'EXPIRED'].includes(state)) {
      return this.failOperation(
        operation,
        'failed',
        `${stage} transaction failed (${state}).`,
      );
    }

    const identifiers: Prisma.AppWalletXylonetOperationUpdateInput =
      stage === 'approval'
        ? { approvalTransactionId: id, approvalTransactionHash: txHash }
        : { swapTransactionId: id, swapTransactionHash: txHash };
    operation = await this.prisma.appWalletXylonetOperation.update({
      where: { operationId: operation.operationId },
      data: identifiers,
    });
    if (
      ['INITIATED', 'SUBMITTED', 'QUEUED', 'CLEARED', 'SENT', 'STUCK'].includes(
        state,
      ) ||
      (state === 'CONFIRMED' && !txHash)
    ) {
      return operation;
    }
    if (
      !['CONFIRMED', 'COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCEEDED'].includes(
        state,
      )
    ) {
      throw new BadGatewayException({
        code: APP_WALLET_XYLONET_ERRORS.CIRCLE_FAILED,
        message: `Circle returned unknown ${stage} transaction state ${state || '(missing)'}.`,
      });
    }
    if (!txHash) return operation;

    try {
      if (stage === 'approval') {
        await this.verifyApprovalReceipt(operation, txHash as Hash);
        return this.prisma.appWalletXylonetOperation.update({
          where: { operationId: operation.operationId },
          data: {
            lifecycleStage: 'approval_confirmed',
            approvalConfirmedAt: new Date(),
          },
        });
      }
      const amountOut = await this.verifySwapReceipt(operation, txHash as Hash);
      this.logger.log(
        `[app-wallet-xylonet] operationId=${operation.operationId} ` +
          `stage=output_verified amountOut=${amountOut} treasuryFallback=false`,
      );
      return this.prisma.appWalletXylonetOperation.update({
        where: { operationId: operation.operationId },
        data: {
          lifecycleStage: 'completed',
          terminalStatus: 'confirmed',
          swapConfirmedAt: new Date(),
          completedAt: new Date(),
        },
      });
    } catch (error) {
      const message = this.errorMessage(error);
      if (
        message.includes('not found') ||
        message.includes('could not be found')
      ) {
        return operation;
      }
      return this.failOperation(operation, 'failed', message);
    }
  }

  private async reconcileCompletedSwapTransactionHash(
    operation: AppWalletXylonetOperation,
    userToken: string,
  ): Promise<AppWalletXylonetOperation> {
    if (
      operation.lifecycleStage !== 'completed' ||
      operation.terminalStatus !== 'confirmed' ||
      operation.swapTransactionHash ||
      !operation.swapTransactionId
    ) {
      return operation;
    }

    let response: CircleTransaction;
    try {
      response = await this.w3sAuthService.getUserTransaction(
        operation.swapTransactionId,
        this.requireUserToken(userToken),
      );
    } catch (error) {
      if (this.circleHttpStatus(error) === 404) return operation;
      throw this.circleLookupError(error, 'swap transaction');
    }

    const transaction = this.readCircleTransaction(response);
    const transactionId = this.readOptionalString(transaction, 'id');
    if (transactionId && transactionId !== operation.swapTransactionId) {
      throw new BadGatewayException({
        code: APP_WALLET_XYLONET_ERRORS.CIRCLE_FAILED,
        message: 'Circle returned a different swap transaction identifier.',
      });
    }
    this.validateCircleTransaction(operation, transaction, 'swap');

    const txHash = this.readOptionalString(transaction, 'txHash');
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return operation;

    return this.prisma.appWalletXylonetOperation.update({
      where: { operationId: operation.operationId },
      data: { swapTransactionHash: txHash },
    });
  }

  private readCircleTransaction(
    response: CircleTransaction,
  ): CircleTransaction {
    if (response.transaction && typeof response.transaction === 'object') {
      return response.transaction as CircleTransaction;
    }
    const data =
      response.data && typeof response.data === 'object'
        ? (response.data as CircleTransaction)
        : null;
    return data?.transaction && typeof data.transaction === 'object'
      ? (data.transaction as CircleTransaction)
      : response;
  }

  private async verifyApprovalReceipt(
    operation: AppWalletXylonetOperation,
    txHash: Hash,
  ): Promise<void> {
    const receipt = await this.getPublicClient().getTransactionReceipt({
      hash: txHash,
    });
    if (receipt.status !== 'success')
      throw new Error('Approval receipt reverted.');
    const expectedToken = this.address(operation.tokenInAddress);
    const approval = receipt.logs.find((log) => {
      if (getAddress(log.address) !== expectedToken) return false;
      try {
        const decoded = decodeEventLog({ abi: ERC20_ABI, ...log });
        return (
          decoded.eventName === 'Approval' &&
          this.sameAddress(decoded.args.owner, operation.walletAddress) &&
          this.sameAddress(decoded.args.spender, operation.executorAddress) &&
          decoded.args.value === BigInt(operation.amountIn)
        );
      } catch {
        return false;
      }
    });
    if (!approval)
      throw new Error(
        'Approval receipt did not authorize the exact executor amount.',
      );
  }

  private async verifySwapReceipt(
    operation: AppWalletXylonetOperation,
    txHash: Hash,
  ): Promise<string> {
    const client = this.getPublicClient();
    const [receipt, transaction] = await Promise.all([
      client.getTransactionReceipt({ hash: txHash }),
      client.getTransaction({ hash: txHash }),
    ]);
    if (receipt.status !== 'success') throw new Error('Swap receipt reverted.');
    if (
      transaction.to &&
      this.sameAddress(transaction.to, operation.executorAddress)
    ) {
      this.validateSwapCallData(operation, transaction.input);
    }

    const executor = this.address(operation.executorAddress);
    let amountOut: bigint | null = null;
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== executor) continue;
      try {
        const decoded = decodeEventLog({ abi: EXECUTOR_ABI, ...log });
        if (decoded.eventName !== 'WizPaySwapExecuted') continue;
        const args = decoded.args;
        if (
          !this.sameAddress(args.user, operation.walletAddress) ||
          !this.sameAddress(args.router, operation.routerAddress) ||
          !this.sameAddress(args.tokenIn, operation.tokenInAddress) ||
          !this.sameAddress(args.tokenOut, operation.tokenOutAddress) ||
          args.amountIn !== BigInt(operation.amountIn) ||
          !this.sameAddress(args.recipient, operation.recipientAddress)
        ) {
          throw new Error(
            'WizPaySwapExecuted event fields do not match the operation.',
          );
        }
        amountOut = args.amountOut;
      } catch (error) {
        if (this.errorMessage(error).includes('do not match')) throw error;
      }
    }
    if (amountOut === null)
      throw new Error('WizPaySwapExecuted event was not found.');
    if (amountOut < BigInt(operation.minimumOutput)) {
      throw new Error('Actual swap output is below minimumOutput.');
    }

    let delivered = 0n;
    for (const log of receipt.logs) {
      if (!this.sameAddress(log.address, operation.tokenOutAddress)) continue;
      try {
        const decoded = decodeEventLog({ abi: ERC20_ABI, ...log });
        if (
          decoded.eventName === 'Transfer' &&
          this.sameAddress(decoded.args.to, operation.recipientAddress)
        ) {
          delivered += decoded.args.value;
        }
      } catch {
        // Ignore non-ERC20 logs emitted by the token contract.
      }
    }
    if (delivered < amountOut) {
      throw new Error(
        'Output token transfer to the user does not match the executor event.',
      );
    }
    return amountOut.toString();
  }

  private validateCircleTransaction(
    operation: AppWalletXylonetOperation,
    transaction: CircleTransaction,
    stage: ChallengeStage,
  ): void {
    const source =
      this.readOptionalString(transaction, 'sourceAddress') ||
      this.readOptionalString(transaction, 'from');
    if (source && !this.sameAddress(source, operation.walletAddress)) {
      throw new ForbiddenException({
        code: APP_WALLET_XYLONET_ERRORS.WALLET_MISMATCH,
        message:
          'Circle transaction source does not match the User-Controlled wallet.',
      });
    }
    const walletId = this.readOptionalString(transaction, 'walletId');
    if (walletId && walletId !== operation.circleWalletId) {
      throw new ForbiddenException({
        code: APP_WALLET_XYLONET_ERRORS.WALLET_MISMATCH,
        message: 'Circle transaction walletId does not match the operation.',
      });
    }
    const expectedContract =
      stage === 'approval'
        ? operation.tokenInAddress
        : operation.executorAddress;
    const target =
      this.readOptionalString(transaction, 'contractAddress') ||
      this.readOptionalString(transaction, 'destinationAddress');
    if (target && !this.sameAddress(target, expectedContract)) {
      throw new BadGatewayException({
        code: APP_WALLET_XYLONET_ERRORS.VERIFICATION_FAILED,
        message:
          'Circle transaction target does not match the persisted operation.',
      });
    }
  }

  private validateApprovalCallData(
    operation: AppWalletXylonetOperation,
    callData: Hash,
  ): void {
    const decoded = decodeFunctionData({ abi: ERC20_ABI, data: callData });
    if (
      decoded.functionName !== 'approve' ||
      !decoded.args ||
      !this.sameAddress(decoded.args[0], operation.executorAddress) ||
      decoded.args[1] !== BigInt(operation.amountIn)
    ) {
      this.invalid('Approval calldata does not match the persisted operation.');
    }
  }

  private validateSwapCallData(
    operation: AppWalletXylonetOperation,
    callData: Hash,
  ): void {
    const decoded = decodeFunctionData({ abi: EXECUTOR_ABI, data: callData });
    if (decoded.functionName !== 'executeSwap' || !decoded.args) {
      this.invalid('Swap calldata does not call executeSwap.');
    }
    const [router, tokenIn, tokenOut, amountIn, minOut, recipient, deadline] =
      decoded.args;
    if (
      !this.sameAddress(router, operation.routerAddress) ||
      !this.sameAddress(tokenIn, operation.tokenInAddress) ||
      !this.sameAddress(tokenOut, operation.tokenOutAddress) ||
      amountIn !== BigInt(operation.amountIn) ||
      minOut !== BigInt(operation.minimumOutput) ||
      !this.sameAddress(recipient, operation.walletAddress) ||
      deadline !== BigInt(operation.deadline)
    ) {
      this.invalid('Swap calldata does not match the persisted operation.');
    }
  }

  private buildSwapCallData(operation: AppWalletXylonetOperation): Hash {
    return encodeFunctionData({
      abi: EXECUTOR_ABI,
      functionName: 'executeSwap',
      args: [
        this.address(operation.routerAddress),
        this.address(operation.tokenInAddress),
        this.address(operation.tokenOutAddress),
        BigInt(operation.amountIn),
        BigInt(operation.minimumOutput),
        this.address(operation.walletAddress),
        BigInt(operation.deadline),
      ],
    });
  }

  private async getOwnedOperation(
    operationId: string,
    userToken: string,
  ): Promise<AppWalletXylonetOperation> {
    this.getConfig();
    const operation = await this.prisma.appWalletXylonetOperation.findUnique({
      where: { operationId },
    });
    if (!operation)
      throw new NotFoundException('App Wallet XyloNet operation not found.');
    const identity = await this.authenticateWallet(
      userToken,
      operation.circleWalletId,
      operation.walletAddress,
    );
    if (identity.userId !== operation.applicationUserId) {
      throw new ForbiddenException({
        code: APP_WALLET_XYLONET_ERRORS.OPERATION_FORBIDDEN,
        message: 'The authenticated user does not own this operation.',
      });
    }
    return operation;
  }

  private async authenticateWallet(
    userToken: string,
    walletId: string,
    walletAddress: string,
  ) {
    const token = this.requireUserToken(userToken);
    const synced = await this.walletService.syncWallets({ userToken: token });
    const wallet = synced.wallets.find(
      (candidate) =>
        candidate.walletId === walletId &&
        candidate.blockchain === 'ARC-TESTNET',
    );
    if (!wallet || !this.sameAddress(wallet.address, walletAddress)) {
      throw new ForbiddenException({
        code: APP_WALLET_XYLONET_ERRORS.WALLET_MISMATCH,
        message:
          'The Circle wallet ID, address, chain, and authenticated user do not match.',
      });
    }
    return {
      address: getAddress(wallet.address),
      userId: synced.userId,
      walletId: wallet.walletId,
    };
  }

  private getConfig() {
    if (process.env.APP_WALLET_XYLONET_USER_CONTROLLED_ENABLED !== 'true') {
      throw new ServiceUnavailableException({
        code: APP_WALLET_XYLONET_ERRORS.DISABLED,
        message:
          'Direct User-Controlled XyloNet App Wallet execution is disabled. No treasury fallback was used.',
        treasuryFallback: false,
      });
    }
    const chainId = Number(process.env.APP_XYLONET_CHAIN_ID);
    if (chainId !== ARC_CHAIN_ID)
      this.configError('APP_XYLONET_CHAIN_ID must equal 5042002.');
    const executor = this.configAddress('APP_XYLONET_EXECUTOR_ADDRESS');
    const routers = this.configAddressList('APP_XYLONET_ROUTER_ADDRESSES');
    const tokens = this.configTokens();
    const deadlineSeconds = Number(
      process.env.APP_XYLONET_DEADLINE_MAX_SECONDS || DEFAULT_DEADLINE_SECONDS,
    );
    if (
      !Number.isInteger(deadlineSeconds) ||
      deadlineSeconds <= 0 ||
      deadlineSeconds > MAX_DEADLINE_SECONDS
    ) {
      this.configError(
        'APP_XYLONET_DEADLINE_MAX_SECONDS must be between 1 and 1200.',
      );
    }
    const safe = this.configAddress('WIZPAY_FEE_SAFE');
    return {
      executor,
      router: routers[0],
      routers,
      tokens,
      deadlineSeconds,
      safe,
    };
  }

  private async assertOnchainCapability(
    config: ReturnType<typeof this.getConfig>,
  ) {
    const client = this.getPublicClient();
    const bytecode = await client.getBytecode({ address: config.executor });
    if (!bytecode || bytecode === '0x') {
      this.configError(
        'APP_XYLONET_EXECUTOR_ADDRESS has no deployed contract code.',
      );
    }
    const [
      owner,
      feeRecipient,
      feeBps,
      routerAllowed,
      usdcAllowed,
      eurcAllowed,
    ] = await Promise.all([
      client.readContract({
        address: config.executor,
        abi: EXECUTOR_ABI,
        functionName: 'owner',
      }),
      client.readContract({
        address: config.executor,
        abi: EXECUTOR_ABI,
        functionName: 'feeRecipient',
      }),
      client.readContract({
        address: config.executor,
        abi: EXECUTOR_ABI,
        functionName: 'feeBps',
      }),
      client.readContract({
        address: config.executor,
        abi: EXECUTOR_ABI,
        functionName: 'allowedRouters',
        args: [config.router],
      }),
      client.readContract({
        address: config.executor,
        abi: EXECUTOR_ABI,
        functionName: 'allowedTokens',
        args: [config.tokens.USDC],
      }),
      client.readContract({
        address: config.executor,
        abi: EXECUTOR_ABI,
        functionName: 'allowedTokens',
        args: [config.tokens.EURC],
      }),
    ]);
    if (
      typeof owner !== 'string' ||
      typeof feeRecipient !== 'string' ||
      !this.sameAddress(owner, config.safe) ||
      !this.sameAddress(feeRecipient, config.safe) ||
      feeBps !== BigInt(FEE_BPS) ||
      routerAllowed !== true ||
      usdcAllowed !== true ||
      eurcAllowed !== true
    ) {
      this.configError(
        'WizPaySwapExecutorV2 owner, fee recipient, fee, router, or token allowlist is not safely configured.',
      );
    }
  }

  private configTokens(): Record<'USDC' | 'EURC', Address> {
    const entries = (process.env.APP_XYLONET_TOKEN_ADDRESSES || '').split(',');
    const parsed = new Map<string, Address>();
    for (const entry of entries) {
      const [symbol, value] = entry.split('=').map((part) => part?.trim());
      if (symbol && value && isAddress(value))
        parsed.set(symbol.toUpperCase(), getAddress(value));
    }
    const usdc = parsed.get('USDC');
    const eurc = parsed.get('EURC');
    if (!usdc || !eurc || usdc === eurc) {
      this.configError(
        'APP_XYLONET_TOKEN_ADDRESSES must contain distinct valid USDC and EURC addresses.',
      );
    }
    return { USDC: usdc, EURC: eurc };
  }

  private configAddress(name: string): Address {
    const value = process.env[name]?.trim();
    if (!value || !isAddress(value))
      this.configError(`${name} must be a valid EVM address.`);
    return getAddress(value);
  }

  private configAddressList(name: string): Address[] {
    const values = (process.env[name] || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (values.length === 0 || values.some((value) => !isAddress(value))) {
      this.configError(`${name} must contain at least one valid EVM address.`);
    }
    return [...new Set(values.map((value) => getAddress(value)))];
  }

  private getPublicClient(): PublicClient {
    if (this.injectedPublicClient) return this.injectedPublicClient;
    const rpcUrl = resolveArcTestnetRpcUrl([
      { name: 'RPC_URL', value: process.env.RPC_URL },
      { name: 'ARC_RPC_URL', value: process.env.ARC_RPC_URL },
    ]);
    return createPublicClient({
      chain: defineChain({
        id: ARC_CHAIN_ID,
        name: 'Arc Testnet',
        nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
        testnet: true,
      }),
      transport: http(rpcUrl),
    });
  }

  private findStageTransaction(
    response: CircleTransaction,
    operation: AppWalletXylonetOperation,
    stage: ChallengeStage,
  ): CircleTransaction | null {
    const transactions = Array.isArray(response.transactions)
      ? response.transactions
      : Array.isArray(
            (response.data as CircleTransaction | undefined)?.transactions,
          )
        ? ((response.data as CircleTransaction).transactions as unknown[])
        : [];
    const expectedRefId = this.refId(operation.operationId, stage);
    return (
      transactions.find((item): item is CircleTransaction =>
        Boolean(
          item &&
          typeof item === 'object' &&
          this.readOptionalString(item as CircleTransaction, 'refId') ===
            expectedRefId,
        ),
      ) || null
    );
  }

  private assertNotTerminal(operation: AppWalletXylonetOperation): void {
    if (operation.terminalStatus) {
      throw new ConflictException({
        code: APP_WALLET_XYLONET_ERRORS.INVALID_STAGE,
        message: `Operation is already terminal (${operation.terminalStatus}).`,
      });
    }
  }

  private assertDeadlineStillUsable(
    operation: AppWalletXylonetOperation,
  ): void {
    if (BigInt(operation.deadline) <= BigInt(Math.floor(Date.now() / 1_000))) {
      throw new ConflictException({
        code: APP_WALLET_XYLONET_ERRORS.INVALID_STAGE,
        message:
          'The persisted swap deadline has expired. Create a new operation.',
      });
    }
  }

  private async failOperation(
    operation: AppWalletXylonetOperation,
    terminalStatus: Exclude<AppWalletXylonetTerminalStatus, 'confirmed'>,
    reason: string,
  ): Promise<AppWalletXylonetOperation> {
    return this.prisma.appWalletXylonetOperation.update({
      where: { operationId: operation.operationId },
      data: {
        lifecycleStage: terminalStatus,
        terminalStatus,
        failureReason: reason.slice(0, 500),
      },
    });
  }

  private challengeTerminalStatus(
    status: CircleChallengeState,
  ): Exclude<AppWalletXylonetTerminalStatus, 'confirmed'> {
    switch (status) {
      case 'cancelled':
        return 'cancelled';
      case 'rejected':
        return 'rejected';
      case 'expired':
        return 'expired';
      case 'timed_out':
        return 'timed_out';
      default:
        return 'failed';
    }
  }

  private circleChallengeState(status: string): CircleChallengeState {
    switch (status.trim().toUpperCase()) {
      case 'PENDING':
      case 'IN_PROGRESS':
      case 'INITIATED':
      case 'SUBMITTED':
        return 'pending';
      case 'COMPLETE':
      case 'COMPLETED':
      case 'SUCCESS':
      case 'SUCCEEDED':
        return 'complete';
      case 'FAILED':
        return 'failed';
      case 'CANCELLED':
      case 'CANCELED':
        return 'cancelled';
      case 'REJECTED':
      case 'DENIED':
        return 'rejected';
      case 'EXPIRED':
        return 'expired';
      case 'TIMED_OUT':
        return 'timed_out';
      default:
        return 'unknown';
    }
  }

  private async syncChallengeStatus(
    operation: AppWalletXylonetOperation,
    stage: ChallengeStage,
    userToken: string,
  ): Promise<{
    operation: AppWalletXylonetOperation;
    state: CircleChallengeState;
  }> {
    const challengeId =
      stage === 'approval'
        ? operation.approvalChallengeId
        : operation.swapChallengeId;
    if (!challengeId) {
      this.invalidStage(operation, `${stage} challenge status`);
    }

    let challengeResponse: CircleTransaction;
    try {
      challengeResponse = await this.w3sAuthService.getUserChallenge(
        challengeId,
        this.requireUserToken(userToken),
      );
    } catch (error) {
      throw this.circleLookupError(error, `${stage} challenge`);
    }
    const challenge =
      challengeResponse.challenge &&
      typeof challengeResponse.challenge === 'object'
        ? (challengeResponse.challenge as CircleTransaction)
        : challengeResponse;
    const verifiedChallengeId = this.readOptionalString(challenge, 'id');
    if (!verifiedChallengeId || verifiedChallengeId !== challengeId) {
      throw new BadGatewayException({
        code: APP_WALLET_XYLONET_ERRORS.CIRCLE_FAILED,
        message: !verifiedChallengeId
          ? 'Circle challenge response is missing its identifier.'
          : 'Circle returned a different challenge identifier.',
      });
    }

    const rawStatus = this.readOptionalString(challenge, 'status') || '';
    const state = this.circleChallengeState(rawStatus);
    if (state === 'unknown') {
      throw new BadGatewayException({
        code: APP_WALLET_XYLONET_ERRORS.CIRCLE_FAILED,
        message: `Circle returned unknown ${stage} challenge status ${rawStatus || '(missing)'}.`,
      });
    }

    const correlations = Array.isArray(challenge.correlationIds)
      ? challenge.correlationIds.filter(
          (value): value is string =>
            typeof value === 'string' && value.trim().length > 0,
        )
      : [];
    if (correlations.length > 1) {
      throw new BadGatewayException({
        code: APP_WALLET_XYLONET_ERRORS.CIRCLE_FAILED,
        message: `Circle returned multiple transaction identifiers for one ${stage} challenge.`,
      });
    }
    const transactionId = correlations[0]?.trim();
    if (transactionId) {
      const persistedTransactionId =
        stage === 'approval'
          ? operation.approvalTransactionId
          : operation.swapTransactionId;
      if (persistedTransactionId && persistedTransactionId !== transactionId) {
        throw new BadGatewayException({
          code: APP_WALLET_XYLONET_ERRORS.CIRCLE_FAILED,
          message: `Circle returned a different ${stage} transaction identifier.`,
        });
      }
      if (!persistedTransactionId) {
        operation = await this.prisma.appWalletXylonetOperation.update({
          where: { operationId: operation.operationId },
          data:
            stage === 'approval'
              ? { approvalTransactionId: transactionId }
              : { swapTransactionId: transactionId },
        });
      }
    }

    if (
      ['failed', 'cancelled', 'rejected', 'expired', 'timed_out'].includes(
        state,
      )
    ) {
      const reason =
        this.readOptionalString(challenge, 'errorMessage') ||
        `${stage} challenge ${state}.`;
      operation = await this.failOperation(
        operation,
        this.challengeTerminalStatus(state),
        reason,
      );
    }
    return { operation, state };
  }

  private circleHttpStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }

  private circleLookupError(error: unknown, resource: string) {
    const status = this.circleHttpStatus(error);
    const message = this.errorMessage(error);
    return new BadGatewayException({
      code: APP_WALLET_XYLONET_ERRORS.CIRCLE_FAILED,
      message: `Circle ${resource} lookup failed${status ? ` (${status})` : ''}: ${message}`,
    });
  }

  private toPublic(
    operation: AppWalletXylonetOperation,
  ): AppWalletXylonetOperationResponse {
    return {
      operationId: operation.operationId,
      executionMode: APP_WALLET_XYLONET_MODE,
      provider: APP_WALLET_XYLONET_PROVIDER,
      applicationUserId: operation.applicationUserId,
      circleWalletId: operation.circleWalletId,
      walletAddress: operation.walletAddress,
      chain: 'ARC-TESTNET',
      chainId: ARC_CHAIN_ID,
      tokenIn: operation.tokenIn as 'USDC' | 'EURC',
      tokenOut: operation.tokenOut as 'USDC' | 'EURC',
      tokenInAddress: operation.tokenInAddress,
      tokenOutAddress: operation.tokenOutAddress,
      amountIn: operation.amountIn,
      expectedOutput: operation.expectedOutput,
      minimumOutput: operation.minimumOutput,
      slippageBps: operation.slippageBps,
      feeBps: operation.feeBps,
      routerAddress: operation.routerAddress,
      executorAddress: operation.executorAddress,
      recipientAddress: operation.recipientAddress,
      deadline: operation.deadline,
      lifecycleStage: operation.lifecycleStage as AppWalletXylonetStage,
      ...(operation.terminalStatus
        ? {
            terminalStatus:
              operation.terminalStatus as AppWalletXylonetTerminalStatus,
          }
        : {}),
      ...(operation.failureReason
        ? { failureReason: operation.failureReason }
        : {}),
      ...(operation.approvalChallengeId
        ? { approvalChallengeId: operation.approvalChallengeId }
        : {}),
      ...(operation.swapChallengeId
        ? { swapChallengeId: operation.swapChallengeId }
        : {}),
      ...(operation.approvalTransactionId
        ? { approvalTransactionId: operation.approvalTransactionId }
        : {}),
      ...(operation.swapTransactionId
        ? { swapTransactionId: operation.swapTransactionId }
        : {}),
      ...(operation.approvalTransactionHash
        ? { approvalTransactionHash: operation.approvalTransactionHash }
        : {}),
      ...(operation.swapTransactionHash
        ? { swapTransactionHash: operation.swapTransactionHash }
        : {}),
      createdAt: operation.createdAt.toISOString(),
      updatedAt: operation.updatedAt.toISOString(),
      ...(operation.completedAt
        ? { completedAt: operation.completedAt.toISOString() }
        : {}),
    };
  }

  private deterministicUuidV4(
    operationId: string,
    stage: ChallengeStage,
  ): string {
    const bytes = Buffer.from(
      createHash('sha256')
        .update(`${operationId}:${stage}`)
        .digest()
        .subarray(0, 16),
    );
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private refId(operationId: string, stage: ChallengeStage): string {
    return `app-wallet-xylonet:${operationId}:${stage}`;
  }

  private normalizeToken(value: string): 'USDC' | 'EURC' {
    const token = value.trim().toUpperCase();
    if (token !== 'USDC' && token !== 'EURC')
      this.invalid('Only USDC and EURC are supported.');
    return token as 'USDC' | 'EURC';
  }

  private parsePositiveAmount(value: string, field: string): bigint {
    if (!/^\d+$/.test(value) || BigInt(value) <= 0n)
      this.invalid(`${field} must be a positive base-unit integer.`);
    return BigInt(value);
  }

  private requireUserToken(value: string): string {
    const token = value?.trim();
    if (!token) {
      throw new ForbiddenException({
        code: APP_WALLET_XYLONET_ERRORS.AUTH_REQUIRED,
        message: 'X-User-Token is required.',
      });
    }
    return token;
  }

  private readRequiredString(source: CircleTransaction, key: string): string {
    const value = this.readOptionalString(source, key);
    if (!value)
      throw new BadGatewayException({
        code: APP_WALLET_XYLONET_ERRORS.CIRCLE_FAILED,
        message: `Circle did not return ${key}.`,
      });
    return value;
  }

  private readOptionalString(
    source: CircleTransaction,
    key: string,
  ): string | null {
    const value = source[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private sameAddress(left: unknown, right: unknown): boolean {
    return (
      typeof left === 'string' &&
      typeof right === 'string' &&
      isAddress(left) &&
      isAddress(right) &&
      getAddress(left) === getAddress(right)
    );
  }

  private address(value: string): Address {
    if (!isAddress(value))
      this.configError(`Invalid persisted address: ${value}`);
    return getAddress(value);
  }

  private invalid(message: string): never {
    throw new BadRequestException({
      code: APP_WALLET_XYLONET_ERRORS.INVALID_REQUEST,
      message,
    });
  }

  private invalidStage(
    operation: AppWalletXylonetOperation,
    action: string,
  ): never {
    throw new ConflictException({
      code: APP_WALLET_XYLONET_ERRORS.INVALID_STAGE,
      message: `Cannot create ${action} from stage ${operation.lifecycleStage}.`,
    });
  }

  private configError(message: string): never {
    throw new ServiceUnavailableException({
      code: APP_WALLET_XYLONET_ERRORS.CONFIG_INVALID,
      message,
      treasuryFallback: false,
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message
      : 'Unknown verification error.';
  }
}
