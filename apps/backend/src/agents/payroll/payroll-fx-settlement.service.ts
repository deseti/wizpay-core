import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { CircleService } from '../../adapters/circle.service';
import { UserSwapService } from '../../user-swap/user-swap.service';
import {
  USER_SWAP_ALLOWED_CHAIN,
  type UserSwapPrepareResponse,
} from '../../user-swap/user-swap.types';
import {
  USER_SWAP_USDC_ADDRESS,
  USER_SWAP_EURC_ADDRESS,
} from '../../user-swap/user-swap.service';

// ─── Types ──────────────────────────────────────────────────────────

export interface FxSettlementRequest {
  sourceToken: string;
  targetToken: string;
  /** Human-readable aggregate amount in source token (e.g. "1500.00") */
  sourceAmount: string;
  /** Wallet address of the sender (informational, not used for execution) */
  walletAddress?: string;
  /** Idempotency reference for this settlement */
  referenceId: string;
}

export interface FxSettlementResult {
  sourceToken: string;
  targetToken: string;
  sourceAmount: string;
  targetAmount: string;
  txHash: string | null;
  status: 'settled' | 'failed';
}

// ─── Constants ──────────────────────────────────────────────────────

const TOKEN_ADDRESS_MAP: Record<string, `0x${string}`> = {
  USDC: USER_SWAP_USDC_ADDRESS as `0x${string}`,
  EURC: USER_SWAP_EURC_ADDRESS as `0x${string}`,
};

// ─── Service ────────────────────────────────────────────────────────

/**
 * PayrollFxSettlementService handles aggregate FX settlement for
 * cross-currency payroll batches.
 *
 * Uses the same App Kit / SwapKit path (Circle Stablecoin Kits API)
 * that powers the working App Wallet Swap and External Wallet Swap features.
 *
 * Two execution modes (same as AppWalletSwapService):
 *   A. Direct contract execution — when prepare() returns transaction.to + transaction.data
 *   B. Adapter execution — when prepare() returns executionParams + signature
 *      (uses @circle-fin/adapter-circle-wallets, same as AppWalletSwapService)
 *
 * Required env:
 *   - WIZPAY_USER_SWAP_ENABLED=true
 *   - WIZPAY_USER_SWAP_ALLOW_TESTNET=true
 *   - WIZPAY_USER_SWAP_KIT_KEY (Circle Kit key)
 *   - CIRCLE_WALLET_ID_ARC (treasury wallet ID for contract execution)
 *   - CIRCLE_WALLET_ADDRESS_ARC (treasury wallet address)
 *   - CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET (for adapter / executeContract)
 *   - APP_WALLET_TREASURY_SWAP_EXECUTION_ENABLED=true
 *
 * Fail-closed: if any required config is missing, returns a clear error.
 * Does NOT use /v1/exchange/stablefx/quotes or StableFX RFQ.
 */
@Injectable()
export class PayrollFxSettlementService {
  private readonly logger = new Logger(PayrollFxSettlementService.name);

  constructor(
    private readonly userSwapService: UserSwapService,
    private readonly circleService: CircleService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Check whether cross-currency payroll settlement is available.
   */
  isSettlementAvailable(): boolean {
    return this.getMissingConfig().length === 0;
  }

  /**
   * Execute an aggregate FX settlement using App Kit / SwapKit:
   *   prepare swap → execute (direct or adapter) → wait for confirmation.
   */
  async settle(request: FxSettlementRequest): Promise<FxSettlementResult> {
    const missingConfig = this.getMissingConfig();

    if (missingConfig.length > 0) {
      throw new ServiceUnavailableException({
        code: 'PAYROLL_FX_SETTLEMENT_UNAVAILABLE',
        message:
          'Cross-currency payroll settlement is not configured. ' +
          `Missing: ${missingConfig.join(', ')}`,
      });
    }

    const treasuryAddress = this.getTreasuryAddress();

    this.logger.log(
      `Payroll FX Settlement — ${request.sourceToken} → ${request.targetToken} ` +
        `amount=${request.sourceAmount} ref=${request.referenceId} ` +
        `treasury=${treasuryAddress}`,
    );

    // ── Step 1: Prepare swap via UserSwapService (App Kit / SwapKit) ──
    this.logger.log(
      `Payroll FX prepare request — ` +
        `tokenIn=${request.sourceToken} tokenOut=${request.targetToken} ` +
        `amountIn=${request.sourceAmount} chain=${USER_SWAP_ALLOWED_CHAIN} ` +
        `fromAddress=${treasuryAddress} toAddress=${treasuryAddress} ` +
        `ref=${request.referenceId}`,
    );

    let prepared: UserSwapPrepareResponse;
    try {
      prepared = await this.userSwapService.prepare({
        amountIn: request.sourceAmount,
        chain: USER_SWAP_ALLOWED_CHAIN,
        fromAddress: treasuryAddress,
        toAddress: treasuryAddress,
        tokenIn: request.sourceToken,
        tokenOut: request.targetToken,
      });
    } catch (error) {
      this.logger.error(
        `Payroll FX prepare FAILED — ` +
          `sourceToken=${request.sourceToken} targetToken=${request.targetToken} ` +
          `sourceAmount=${request.sourceAmount} ref=${request.referenceId} ` +
          `treasury=${treasuryAddress} ` +
          `phase=UserSwapService.prepare ` +
          `errorType=${error?.constructor?.name ?? 'unknown'} ` +
          `status=${this.extractHttpStatus(error)} ` +
          `code=${this.extractErrorCode(error)} ` +
          `message=${this.extractErrorMessage(error)} ` +
          `details=${this.extractErrorDetails(error)}`,
      );
      throw error;
    }

    this.logger.log(
      `Payroll FX prepared — expectedOutput=${String(prepared.expectedOutput ?? 'unknown')} ` +
        `minimumOutput=${String(prepared.minimumOutput ?? 'unknown')}`,
    );

    // ── Step 2: Execute the swap ──────────────────────────────────────
    // Try direct contract execution first (transaction.to + transaction.data).
    // Fall back to adapter execution (executionParams + signature) if direct is unavailable.
    const directExecution = this.tryBuildDirectContractExecution(prepared.transaction);

    let txHash: string | null;

    if (directExecution) {
      this.logger.log(
        `Payroll FX — direct execution path selected ` +
          `contract=${directExecution.contractAddress}`,
      );
      txHash = await this.executeDirectContract(directExecution, request);
    } else {
      // Check for adapter-style payload
      const rawTransaction = this.getRawTransaction(prepared);

      if (!this.hasAdapterPayload(rawTransaction)) {
        this.logger.error(
          `Payroll FX — neither direct nor adapter execution possible — ` +
            `sourceToken=${request.sourceToken} targetToken=${request.targetToken} ` +
            `ref=${request.referenceId} ` +
            `transactionKeys=${this.safeKeys(prepared.transaction)} ` +
            `rawTransactionKeys=${this.safeKeys(rawTransaction)}`,
        );
        throw new BadGatewayException({
          code: 'PAYROLL_FX_SETTLEMENT_EXECUTION_FAILED',
          message:
            'Circle Stablecoin Kits swap response did not include an executable transaction. ' +
            'Neither direct (to+data) nor adapter (executionParams+signature) payload found.',
        });
      }

      this.logger.log(
        `Payroll FX — adapter execution path selected ` +
          `(executionParams present, direct to/data unavailable)`,
      );
      txHash = await this.executeViaAdapter(rawTransaction, prepared, request);
    }

    this.logger.log(
      `Payroll FX settled — txHash=${txHash} ` +
        `sourceToken=${request.sourceToken} targetToken=${request.targetToken} ` +
        `ref=${request.referenceId}`,
    );

    return {
      sourceToken: request.sourceToken,
      targetToken: request.targetToken,
      sourceAmount: request.sourceAmount,
      targetAmount: String(prepared.expectedOutput ?? prepared.minimumOutput ?? request.sourceAmount),
      txHash,
      status: 'settled',
    };
  }

  // ════════════════════════════════════════════════════════════════════
  //  Execution paths
  // ════════════════════════════════════════════════════════════════════

  /**
   * Path A: Direct contract execution (transaction.to + transaction.data).
   * Same as AppWalletSwapService.tryBuildDirectContractExecution path.
   */
  private async executeDirectContract(
    execution: { contractAddress: string; callData: `0x${string}` },
    request: FxSettlementRequest,
  ): Promise<string | null> {
    const walletId = this.configService.get<string>('CIRCLE_WALLET_ID_ARC');
    const idempotencyKey = this.buildIdempotencyKey(request.referenceId);

    this.logger.log(
      `Payroll FX direct — contract=${execution.contractAddress} ` +
        `walletId=${walletId} idempotencyKey=${idempotencyKey}`,
    );

    const result = await this.circleService.executeContract({
      walletId,
      contractAddress: execution.contractAddress,
      callData: execution.callData,
      network: USER_SWAP_ALLOWED_CHAIN,
      idempotencyKey,
      refId: `PAYROLL-FX-${request.referenceId}`,
    });

    this.logger.log(
      `Payroll FX direct submitted — txId=${result.txId} status=${result.status}`,
    );

    const confirmed = await this.circleService.waitForTransactionComplete(
      result.txId,
    );

    this.logger.log(
      `Payroll FX direct confirmed — txHash=${confirmed.txHash} status=${confirmed.status}`,
    );

    return confirmed.txHash;
  }

  /**
   * Path B: Adapter execution (executionParams + signature).
   * Same mechanism as AppWalletSwapService.executeTreasurySwapWithCircleWalletAdapter.
   *
   * Flow:
   *   1. Create Circle Wallets adapter (using CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET)
   *   2. Approve input token to the adapter contract
   *   3. Execute swap.execute with executionParams
   *   4. Wait for transaction confirmation
   */
  private async executeViaAdapter(
    rawTransaction: Record<string, unknown>,
    prepared: UserSwapPrepareResponse,
    request: FxSettlementRequest,
  ): Promise<string | null> {
    const treasuryAddress = this.getTreasuryAddress();
    const tokenInAddress = this.resolveTokenAddress(request.sourceToken);

    // Parse adapter payload
    const signature = this.normalizeHexField(
      rawTransaction.signature,
      'transaction.signature',
    );
    const executionParams = rawTransaction.executionParams;

    if (!this.isRecord(executionParams)) {
      throw new BadGatewayException({
        code: 'PAYROLL_FX_SETTLEMENT_EXECUTION_FAILED',
        message:
          'Circle Stablecoin Kits adapter response missing executionParams object.',
      });
    }

    const executeParams = this.buildSwapExecuteParams(executionParams);
    const inputAmount = this.resolvePreparedInputAmount(
      prepared.raw,
      request.sourceAmount,
    );

    // Create adapter
    const adapter = await this.createCircleWalletsAdapter();
    const { ArcTestnet } = await import('@circle-fin/bridge-kit/chains');
    const adapterContract = this.validContractAddressOrNull(
      ArcTestnet.kitContracts?.adapter,
    );

    if (!adapterContract) {
      throw new BadGatewayException({
        code: 'PAYROLL_FX_SETTLEMENT_EXECUTION_FAILED',
        message:
          'Circle Arc Testnet adapter contract is not configured. ' +
          'Cannot execute adapter-style swap for payroll FX settlement.',
      });
    }

    this.logger.log(
      `Payroll FX adapter — adapterContract=${adapterContract} ` +
        `tokenIn=${tokenInAddress} inputAmount=${inputAmount} ` +
        `treasury=${treasuryAddress}`,
    );

    const context = {
      chain: ArcTestnet,
      address: treasuryAddress,
    };

    // Step 1: Approve input token to adapter contract
    this.logger.log(`Payroll FX adapter — approving token...`);
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

    this.logger.log(
      `Payroll FX adapter — approval submitted txHash=${approvalTxHash}`,
    );

    if (typeof adapter.waitForTransaction === 'function') {
      await adapter.waitForTransaction(approvalTxHash, undefined, ArcTestnet);
      this.logger.log(`Payroll FX adapter — approval confirmed`);
    }

    // Step 2: Execute swap
    this.logger.log(`Payroll FX adapter — executing swap...`);
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
    const swapTxHash: string = await swap.execute();

    this.logger.log(
      `Payroll FX adapter — swap submitted txHash=${swapTxHash}`,
    );

    // Step 3: Wait for confirmation
    if (typeof adapter.waitForTransaction === 'function') {
      await adapter.waitForTransaction(swapTxHash, undefined, ArcTestnet);
      this.logger.log(`Payroll FX adapter — swap confirmed`);
    }

    const validTxHash = this.validTxHashOrNull(swapTxHash);

    if (!validTxHash) {
      throw new BadGatewayException({
        code: 'PAYROLL_FX_SETTLEMENT_EXECUTION_FAILED',
        message:
          'Adapter swap execution did not return a valid transaction hash.',
      });
    }

    return validTxHash;
  }

  // ════════════════════════════════════════════════════════════════════
  //  Private helpers
  // ════════════════════════════════════════════════════════════════════

  private getMissingConfig(): string[] {
    const missing: string[] = [];

    if (this.configService.get<string>('WIZPAY_USER_SWAP_ENABLED') !== 'true') {
      missing.push('WIZPAY_USER_SWAP_ENABLED=true');
    }

    if (this.configService.get<string>('WIZPAY_USER_SWAP_ALLOW_TESTNET') !== 'true') {
      missing.push('WIZPAY_USER_SWAP_ALLOW_TESTNET=true');
    }

    if (!this.configService.get<string>('WIZPAY_USER_SWAP_KIT_KEY')?.trim()) {
      missing.push('WIZPAY_USER_SWAP_KIT_KEY');
    }

    if (
      this.configService.get<string>('APP_WALLET_TREASURY_SWAP_EXECUTION_ENABLED') !== 'true'
    ) {
      missing.push('APP_WALLET_TREASURY_SWAP_EXECUTION_ENABLED=true');
    }

    if (!this.configService.get<string>('CIRCLE_WALLET_ID_ARC')?.trim()) {
      missing.push('CIRCLE_WALLET_ID_ARC');
    }

    if (!this.getTreasuryAddressOrNull()) {
      missing.push('CIRCLE_WALLET_ADDRESS_ARC');
    }

    return missing;
  }

  private getTreasuryAddress(): string {
    const address = this.getTreasuryAddressOrNull();

    if (!address) {
      throw new ServiceUnavailableException({
        code: 'PAYROLL_FX_SETTLEMENT_UNAVAILABLE',
        message:
          'Treasury wallet address (CIRCLE_WALLET_ADDRESS_ARC) is not configured.',
      });
    }

    return address;
  }

  private getTreasuryAddressOrNull(): string | null {
    const address = this.configService
      .get<string>('CIRCLE_WALLET_ADDRESS_ARC')
      ?.trim()
      .toLowerCase();

    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return null;
    }

    return address;
  }

  private resolveTokenAddress(token: string): `0x${string}` {
    const address = TOKEN_ADDRESS_MAP[token.toUpperCase()];

    if (!address) {
      throw new BadGatewayException({
        code: 'PAYROLL_FX_SETTLEMENT_EXECUTION_FAILED',
        message: `Unsupported token "${token}" for payroll FX settlement.`,
      });
    }

    return address;
  }

  // ── Transaction inspection ──────────────────────────────────────────

  private tryBuildDirectContractExecution(transaction: {
    to?: unknown;
    data?: unknown;
  }): { contractAddress: string; callData: `0x${string}` } | null {
    const contractAddress = this.validContractAddressOrNull(transaction.to);
    const callData = this.validCallDataOrNull(transaction.data);

    return contractAddress && callData ? { contractAddress, callData } : null;
  }

  private getRawTransaction(prepared: UserSwapPrepareResponse): Record<string, unknown> {
    const raw = prepared.transaction?.raw;
    return this.isRecord(raw) ? raw : {};
  }

  private hasAdapterPayload(rawTransaction: Record<string, unknown>): boolean {
    return (
      this.isRecord(rawTransaction.executionParams) &&
      rawTransaction.signature !== undefined
    );
  }

  // ── Adapter execution helpers (same logic as AppWalletSwapService) ──

  private async createCircleWalletsAdapter(): Promise<any> {
    const { createCircleWalletsAdapter } = await import(
      '@circle-fin/adapter-circle-wallets'
    );

    return createCircleWalletsAdapter({
      apiKey: this.configService.get<string>('CIRCLE_API_KEY') ?? '',
      entitySecret: this.configService.get<string>('CIRCLE_ENTITY_SECRET') ?? '',
    });
  }

  private buildSwapExecuteParams(executionParams: Record<string, unknown>) {
    if (!Array.isArray(executionParams.instructions)) {
      throw new BadGatewayException({
        code: 'PAYROLL_FX_SETTLEMENT_EXECUTION_FAILED',
        message:
          'Circle Stablecoin Kits adapter response missing execution instructions.',
      });
    }

    const instructions = executionParams.instructions.map(
      (instruction: unknown, index: number) => {
        if (!this.isRecord(instruction)) {
          throw new BadGatewayException({
            code: 'PAYROLL_FX_SETTLEMENT_EXECUTION_FAILED',
            message: `Adapter swap instruction ${index + 1} is invalid.`,
          });
        }

        return {
          target: this.normalizeAddressField(instruction.target, `instruction[${index}].target`),
          data: this.normalizeHexField(instruction.data, `instruction[${index}].data`),
          value: this.normalizeBigIntField(instruction.value, `instruction[${index}].value`),
          tokenIn: this.normalizeAddressField(instruction.tokenIn, `instruction[${index}].tokenIn`),
          amountToApprove: this.normalizeBigIntField(instruction.amountToApprove, `instruction[${index}].amountToApprove`),
          tokenOut: this.normalizeAddressField(instruction.tokenOut, `instruction[${index}].tokenOut`),
          minTokenOut: this.normalizeBigIntField(instruction.minTokenOut, `instruction[${index}].minTokenOut`),
        };
      },
    );

    const tokens = Array.isArray(executionParams.tokens)
      ? executionParams.tokens.map((token: unknown, index: number) => {
          if (!this.isRecord(token)) {
            throw new BadGatewayException({
              code: 'PAYROLL_FX_SETTLEMENT_EXECUTION_FAILED',
              message: `Adapter swap output token ${index + 1} is invalid.`,
            });
          }

          return {
            token: this.normalizeAddressField(token.token, `token[${index}].token`),
            beneficiary: this.normalizeAddressField(token.beneficiary, `token[${index}].beneficiary`),
          };
        })
      : [];

    return {
      instructions,
      tokens,
      execId: this.normalizeBigIntField(executionParams.execId, 'execId'),
      deadline: this.normalizeBigIntField(executionParams.deadline, 'deadline'),
      metadata: this.normalizeHexField(executionParams.metadata, 'metadata'),
    };
  }

  private resolvePreparedInputAmount(raw: unknown, fallbackAmount: string): bigint {
    if (this.isRecord(raw)) {
      const rawAmount = raw.amount;
      if (
        typeof rawAmount === 'string' ||
        typeof rawAmount === 'number' ||
        typeof rawAmount === 'bigint'
      ) {
        return this.normalizeBigIntField(rawAmount, 'amount');
      }
    }

    return this.normalizeBigIntField(fallbackAmount, 'amountIn');
  }

  // ── Field normalization (same patterns as AppWalletSwapService) ─────

  private normalizeHexField(value: unknown, field: string): `0x${string}` {
    if (typeof value !== 'string' || !/^0x(?:[a-fA-F0-9]{2})*$/.test(value)) {
      throw new BadGatewayException({
        code: 'PAYROLL_FX_SETTLEMENT_EXECUTION_FAILED',
        message: `Adapter response missing valid hex field: ${field}.`,
      });
    }

    return value as `0x${string}`;
  }

  private normalizeAddressField(value: unknown, field: string): `0x${string}` {
    const address = this.validContractAddressOrNull(value);

    if (!address) {
      throw new BadGatewayException({
        code: 'PAYROLL_FX_SETTLEMENT_EXECUTION_FAILED',
        message: `Adapter response missing valid address field: ${field}.`,
      });
    }

    return address as `0x${string}`;
  }

  private normalizeBigIntField(value: unknown, field: string): bigint {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
    if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);

    throw new BadGatewayException({
      code: 'PAYROLL_FX_SETTLEMENT_EXECUTION_FAILED',
      message: `Adapter response missing valid numeric field: ${field}.`,
    });
  }

  // ── General helpers ─────────────────────────────────────────────────

  private validContractAddressOrNull(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed : null;
  }

  private validCallDataOrNull(value: unknown): `0x${string}` | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return /^0x[a-fA-F0-9]+$/.test(trimmed) ? (trimmed as `0x${string}`) : null;
  }

  private validTxHashOrNull(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    return /^0x[a-fA-F0-9]{64}$/.test(value) ? value : null;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private buildIdempotencyKey(referenceId: string): string {
    const digest = createHash('sha256')
      .update(`payroll-fx-settlement:${referenceId}`)
      .digest('hex');
    const variant = ((parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);

    return [
      digest.slice(0, 8),
      digest.slice(8, 12),
      `4${digest.slice(13, 16)}`,
      `${variant}${digest.slice(17, 20)}`,
      digest.slice(20, 32),
    ].join('-');
  }

  // ── Diagnostic helpers ──────────────────────────────────────────────

  private extractHttpStatus(error: unknown): string {
    if (error && typeof error === 'object') {
      const e = error as Record<string, unknown>;
      if (typeof e.status === 'number') return String(e.status);
      if (typeof e.statusCode === 'number') return String(e.statusCode);
      if (e.response && typeof e.response === 'object') {
        const r = e.response as Record<string, unknown>;
        if (typeof r.statusCode === 'number') return String(r.statusCode);
      }
    }
    return 'unknown';
  }

  private extractErrorCode(error: unknown): string {
    if (error && typeof error === 'object') {
      const e = error as Record<string, unknown>;
      if (e.response && typeof e.response === 'object') {
        const r = e.response as Record<string, unknown>;
        if (typeof r.code === 'string') return r.code;
      }
      if (typeof e.code === 'string') return e.code;
    }
    return 'none';
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message.slice(0, 300);
    if (error && typeof error === 'object') {
      const e = error as Record<string, unknown>;
      if (e.response && typeof e.response === 'object') {
        const r = e.response as Record<string, unknown>;
        if (typeof r.message === 'string') return r.message.slice(0, 300);
      }
      if (typeof e.message === 'string') return e.message.slice(0, 300);
    }
    return 'unknown';
  }

  private extractErrorDetails(error: unknown): string {
    if (error && typeof error === 'object') {
      const e = error as Record<string, unknown>;
      if (e.response && typeof e.response === 'object') {
        const r = e.response as Record<string, unknown>;
        if (r.details !== undefined) return JSON.stringify(r.details).slice(0, 500);
      }
    }
    return 'none';
  }

  private safeKeys(value: unknown): string {
    if (!value || typeof value !== 'object') return `(${typeof value})`;
    return Object.keys(value as object).join(',') || '(empty)';
  }
}
