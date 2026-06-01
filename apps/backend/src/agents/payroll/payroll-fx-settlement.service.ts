import {
  BadGatewayException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { BlockchainService } from '../../adapters/blockchain.service';
import { CircleService } from '../../adapters/circle.service';
import { StablefxExecutionService } from '../../user-swap/stablefx-execution.service';
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
const STABLEFX_PAYROLL_PAIRS = new Set(['USDC->EURC', 'EURC->USDC']);

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
    @Optional()
    private readonly stablefxExecutionService: StablefxExecutionService = new StablefxExecutionService(),
    @Optional()
    private readonly blockchainService?: BlockchainService,
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

    if (this.shouldUseStablefxSettlement(request)) {
      return this.settleWithStablefxTreasury(request, treasuryAddress);
    }

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

  private async settleWithStablefxTreasury(
    request: FxSettlementRequest,
    treasuryAddress: string,
  ): Promise<FxSettlementResult> {
    this.logStablefxPayrollPhase(request, 'tradable_quote');

    const quote = await this.stablefxExecutionService.createTradableQuote({
      amountIn: request.sourceAmount,
      chain: USER_SWAP_ALLOWED_CHAIN,
      fromAddress: treasuryAddress,
      recipientAddress: treasuryAddress,
      tokenIn: request.sourceToken,
      tokenOut: request.targetToken,
    });
    const quoteId = this.stringifyUnknown(quote.id ?? quote.quoteId);
    const typedData = this.getTypedDataObject(quote);

    if (!quoteId || !typedData || !this.isRecord(typedData.message)) {
      throw new BadGatewayException({
        code: 'PAYROLL_FX_SETTLEMENT_STABLEFX_FAILED',
        message:
          'StableFX payroll settlement quote did not include quoteId and signable typedData.',
      });
    }

    await this.ensureStablefxTreasuryTokenAllowance({
      amountIn: request.sourceAmount,
      referenceId: request.referenceId,
      tokenIn: request.sourceToken,
      treasuryAddress,
      typedData,
    });

    this.logStablefxPayrollPhase(request, 'sign_quote');
    const signedQuote = await this.circleService.signTypedData({
      walletId: this.getTreasuryWalletId(),
      typedData,
      memo: `WizPay Payroll StableFX ${request.sourceToken}->${request.targetToken} quote`,
    });

    this.logStablefxPayrollPhase(request, 'create_trade');
    const trade = await this.stablefxExecutionService.createTrade({
      idempotencyKey: this.buildIdempotencyKey(
        `${request.referenceId}:stablefx-create-trade`,
      ),
      quoteId,
      address: treasuryAddress,
      selectedAddress: treasuryAddress,
      message: typedData.message,
      signature: signedQuote.signature,
      tokenIn: request.sourceToken,
      tokenOut: request.targetToken,
      walletMode: 'app',
    });
    const tradeId = this.resolveStablefxTradeId(trade);
    const { contractTradeId } =
      await this.waitForStablefxContractTradeId(request, tradeId, trade);

    this.logStablefxPayrollPhase(request, 'funding_presign');
    const fundingPresign =
      await this.stablefxExecutionService.createFundingPresign({
        contractTradeId,
      });
    const fundingTypedData = this.getTypedDataObject(fundingPresign);

    if (
      !fundingTypedData ||
      !this.isRecord(fundingTypedData.message)
    ) {
      throw new BadGatewayException({
        code: 'PAYROLL_FX_SETTLEMENT_STABLEFX_FAILED',
        message:
          'StableFX payroll settlement funding presign did not include signable typedData.',
      });
    }

    this.logStablefxPayrollPhase(request, 'sign_funding');
    const signedFunding = await this.circleService.signTypedData({
      walletId: this.getTreasuryWalletId(),
      typedData: fundingTypedData,
      memo: `WizPay Payroll StableFX ${request.sourceToken}->${request.targetToken} funding`,
    });

    this.logStablefxPayrollPhase(request, 'fund');
    const fund = await this.stablefxExecutionService.fund({
      permit2: fundingTypedData.message,
      signature: signedFunding.signature,
    });
    const settledTrade = await this.waitForStablefxSettlement(
      request,
      tradeId,
    );
    const txHash =
      this.extractStablefxSettlementHash(settledTrade) ??
      this.extractStablefxSettlementHash(fund);
    if (!txHash) {
      throw new BadGatewayException({
        code: 'PAYROLL_FX_SETTLEMENT_STABLEFX_FAILED',
        message:
          'StableFX payroll settlement completed without a settlement transaction hash.',
      });
    }

    const targetAmount =
      this.readStablefxToAmountBaseUnits(settledTrade) ??
      this.readStablefxToAmountBaseUnits(quote) ??
      request.sourceAmount;

    this.logStablefxPayrollPhase(request, 'settled');

    return {
      sourceToken: request.sourceToken,
      targetToken: request.targetToken,
      sourceAmount: request.sourceAmount,
      targetAmount,
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

  private async waitForStablefxContractTradeId(
    request: FxSettlementRequest,
    tradeId: string,
    initialTrade: Record<string, unknown>,
  ): Promise<{ contractTradeId: string; trade: Record<string, unknown> }> {
    let trade = initialTrade;
    let contractTradeId = this.resolveStablefxContractTradeId(trade);

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const status = this.resolveStablefxStatus(trade);

      if (contractTradeId) {
        this.logStablefxPayrollPhase(request, 'contract_ready');
        return { contractTradeId, trade };
      }

      if (this.isStablefxFailureStatus(status)) {
        throw new BadGatewayException({
          code: 'PAYROLL_FX_SETTLEMENT_STABLEFX_FAILED',
          message: `StableFX payroll trade failed before funding with status ${status}.`,
        });
      }

      this.logStablefxPayrollPhase(request, 'get_trade');
      await this.delay(2_000);
      trade = await this.stablefxExecutionService.getTrade(tradeId);
      contractTradeId = this.resolveStablefxContractTradeId(trade);
    }

    throw new BadGatewayException({
      code: 'PAYROLL_FX_SETTLEMENT_STABLEFX_FAILED',
      message:
        'StableFX payroll trade was created but contractTradeId was not ready before timeout.',
    });
  }

  private async waitForStablefxSettlement(
    request: FxSettlementRequest,
    tradeId: string,
  ): Promise<Record<string, unknown>> {
    let latest: Record<string, unknown> | null = null;

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      this.logStablefxPayrollPhase(request, 'get_trade');
      latest = await this.stablefxExecutionService.getTrade(tradeId);
      const status = this.resolveStablefxStatus(latest);
      const settlementHash = this.extractStablefxSettlementHash(latest);

      if (
        settlementHash ||
        ['complete', 'completed', 'settled'].includes(status.toLowerCase())
      ) {
        return latest;
      }

      if (this.isStablefxFailureStatus(status)) {
        throw new BadGatewayException({
          code: 'PAYROLL_FX_SETTLEMENT_STABLEFX_FAILED',
          message: `StableFX payroll trade failed during settlement with status ${status}.`,
        });
      }

      await this.delay(3_000);
    }

    if (latest) {
      return latest;
    }

    throw new BadGatewayException({
      code: 'PAYROLL_FX_SETTLEMENT_STABLEFX_FAILED',
      message: 'StableFX payroll trade status was not available after funding.',
    });
  }

  private async ensureStablefxTreasuryTokenAllowance(input: {
    amountIn: string;
    referenceId: string;
    tokenIn: string;
    treasuryAddress: string;
    typedData: Record<string, unknown>;
  }): Promise<void> {
    if (!this.blockchainService) {
      throw new ServiceUnavailableException({
        code: 'PAYROLL_FX_SETTLEMENT_UNAVAILABLE',
        message:
          'StableFX payroll settlement requires BlockchainService for treasury token approval.',
      });
    }

    const approvalTarget = this.getStablefxPermit2ApprovalTarget(
      input.typedData,
    );
    const tokenAddress = this.resolveTokenAddress(input.tokenIn);
    const requiredAllowance = BigInt(input.amountIn);
    const allowanceBefore = (
      await this.blockchainService.getAllowance(
        input.treasuryAddress,
        approvalTarget,
        tokenAddress,
      )
    ).allowance;
    let approvalTxHash: string | null = null;
    let allowanceAfter = allowanceBefore;

    if (BigInt(allowanceBefore) < requiredAllowance) {
      const approval = await this.circleService.executeContract({
        walletId: this.getTreasuryWalletId(),
        contractAddress: tokenAddress,
        callData: this.blockchainService.buildERC20ApproveData(
          approvalTarget,
          requiredAllowance,
        ) as `0x${string}`,
        network: USER_SWAP_ALLOWED_CHAIN,
        idempotencyKey: this.buildIdempotencyKey(
          `${input.referenceId}:stablefx-${input.tokenIn.toLowerCase()}-approval`,
        ),
        refId: `PAYROLL-FX-${input.referenceId}-STABLEFX-${input.tokenIn}-APPROVAL`,
      });
      const completed = await this.circleService.waitForTransactionComplete(
        approval.txId,
      );

      approvalTxHash = completed.txHash ?? approval.txHash ?? null;
      allowanceAfter = (
        await this.blockchainService.getAllowance(
          input.treasuryAddress,
          approvalTarget,
          tokenAddress,
        )
      ).allowance;

      if (BigInt(allowanceAfter) < requiredAllowance) {
        throw new BadGatewayException({
          code: 'PAYROLL_FX_SETTLEMENT_STABLEFX_FAILED',
          message:
            'StableFX payroll treasury token approval completed but allowance is still insufficient.',
        });
      }
    }

    this.logger.log(
      `[payroll-fx-settlement] provider=stablefx payroll-fx settlement ` +
        `phase=allowance_check sourceToken=${input.tokenIn} ` +
        `sourceAmount=${input.amountIn} referenceId=${input.referenceId} ` +
        `treasuryAddress=${input.treasuryAddress} tokenAddress=${tokenAddress} ` +
        `approvalTarget=${approvalTarget} allowanceBefore=${allowanceBefore} ` +
        `approvalTxHash=${approvalTxHash ?? 'not_required'} allowanceAfter=${allowanceAfter}`,
    );
  }

  // ════════════════════════════════════════════════════════════════════
  //  Private helpers
  // ════════════════════════════════════════════════════════════════════

  private getMissingConfig(): string[] {
    const missing: string[] = [];
    const stablefxSelected = this.isStablefxProviderSelected();

    if (this.configService.get<string>('WIZPAY_USER_SWAP_ENABLED') !== 'true') {
      missing.push('WIZPAY_USER_SWAP_ENABLED=true');
    }

    if (this.configService.get<string>('WIZPAY_USER_SWAP_ALLOW_TESTNET') !== 'true') {
      missing.push('WIZPAY_USER_SWAP_ALLOW_TESTNET=true');
    }

    if (
      !stablefxSelected &&
      !this.configService.get<string>('WIZPAY_USER_SWAP_KIT_KEY')?.trim()
    ) {
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

  private shouldUseStablefxSettlement(request: FxSettlementRequest): boolean {
    return (
      this.isStablefxProviderSelected() &&
      STABLEFX_PAYROLL_PAIRS.has(
        `${request.sourceToken.toUpperCase()}->${request.targetToken.toUpperCase()}`,
      )
    );
  }

  private isStablefxProviderSelected(): boolean {
    return (
      this.configService
        .get<string>('WIZPAY_SWAP_PROVIDER')
        ?.trim()
        .toLowerCase() === 'stablefx' ||
      this.configService
        .get<string>('USE_REAL_STABLEFX')
        ?.trim()
        .toLowerCase() === 'true' ||
      this.configService
        .get<string>('NEXT_PUBLIC_USE_REAL_STABLEFX')
        ?.trim()
        .toLowerCase() === 'true'
    );
  }

  private getTreasuryWalletId(): string {
    const walletId = this.configService
      .get<string>('CIRCLE_WALLET_ID_ARC')
      ?.trim();

    if (!walletId) {
      throw new ServiceUnavailableException({
        code: 'PAYROLL_FX_SETTLEMENT_UNAVAILABLE',
        message: 'Treasury wallet ID (CIRCLE_WALLET_ID_ARC) is not configured.',
      });
    }

    return walletId;
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

  private logStablefxPayrollPhase(
    request: FxSettlementRequest,
    phase: string,
  ): void {
    this.logger.log(
      `[payroll-fx-settlement] provider=stablefx payroll-fx settlement ` +
        `sourceToken=${request.sourceToken} targetToken=${request.targetToken} ` +
        `sourceAmount=${request.sourceAmount} referenceId=${request.referenceId} ` +
        `phase=${phase}`,
    );
  }

  private getTypedDataObject(raw: unknown): Record<string, unknown> | null {
    const typedData = this.getNestedValue(raw, ['typedData']);
    return this.isRecord(typedData) ? typedData : null;
  }

  private getStablefxPermit2ApprovalTarget(
    typedData: Record<string, unknown>,
  ): string {
    const approvalTarget = this.validContractAddressOrNull(
      this.getNestedString(typedData, ['domain', 'verifyingContract']),
    );

    if (!approvalTarget) {
      throw new BadGatewayException({
        code: 'PAYROLL_FX_SETTLEMENT_STABLEFX_FAILED',
        message:
          'StableFX payroll quote typedData did not include a valid Permit2 verifyingContract approval target.',
      });
    }

    return approvalTarget;
  }

  private resolveStablefxTradeId(raw: unknown): string {
    const tradeId =
      this.getNestedString(raw, ['id']) ??
      this.getNestedString(raw, ['tradeId']) ??
      this.getNestedString(raw, ['data', 'id']) ??
      this.getNestedString(raw, ['data', 'tradeId']);

    if (!tradeId) {
      throw new BadGatewayException({
        code: 'PAYROLL_FX_SETTLEMENT_STABLEFX_FAILED',
        message: 'StableFX create_trade did not return a trade identifier.',
      });
    }

    return tradeId;
  }

  private resolveStablefxContractTradeId(raw: unknown): string | null {
    return (
      this.getNestedString(raw, ['contractTradeId']) ??
      this.getNestedString(raw, ['data', 'contractTradeId']) ??
      this.getNestedString(raw, ['trade', 'contractTradeId']) ??
      this.getNestedString(raw, ['data', 'trade', 'contractTradeId'])
    );
  }

  private resolveStablefxStatus(raw: unknown): string {
    return (
      this.getNestedString(raw, ['status']) ??
      this.getNestedString(raw, ['data', 'status']) ??
      'unknown'
    );
  }

  private isStablefxFailureStatus(status: string): boolean {
    return ['failed', 'rejected', 'expired', 'breached', 'refunded'].includes(
      status.toLowerCase(),
    );
  }

  private extractStablefxSettlementHash(raw: unknown): string | null {
    return this.validTxHashOrNull(
      this.getNestedString(raw, ['settlementTransactionHash']) ??
        this.getNestedString(raw, ['data', 'settlementTransactionHash']) ??
        this.getNestedString(raw, [
          'contractTransactions',
          'makerDeliver',
          'txHash',
        ]) ??
        this.getNestedString(raw, [
          'data',
          'contractTransactions',
          'makerDeliver',
          'txHash',
        ]) ??
        this.getNestedString(raw, [
          'contractTransactions',
          'takerDeliver',
          'txHash',
        ]) ??
        this.getNestedString(raw, [
          'data',
          'contractTransactions',
          'takerDeliver',
          'txHash',
        ]),
    );
  }

  private readStablefxToAmountBaseUnits(raw: unknown): string | null {
    const amount =
      this.getNestedString(raw, ['to', 'amount']) ??
      this.getNestedString(raw, ['data', 'to', 'amount']);

    return amount ? this.decimalToBaseUnits(amount, 6) : null;
  }

  private decimalToBaseUnits(value: string, decimals: number): string {
    const [wholeRaw, fractionRaw = ''] = value.trim().split('.');
    const whole = wholeRaw || '0';
    const fraction = fractionRaw.padEnd(decimals, '0').slice(0, decimals);

    if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) {
      return value;
    }

    return (
      BigInt(whole) * 10n ** BigInt(decimals) +
      BigInt(fraction || '0')
    ).toString();
  }

  private stringifyUnknown(value: unknown): string | null {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
      return String(value);
    }

    return null;
  }

  private getNestedString(raw: unknown, path: string[]): string | null {
    const value = this.getNestedValue(raw, path);

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
      return String(value);
    }

    return null;
  }

  private getNestedValue(raw: unknown, path: string[]): unknown {
    let current = raw;

    for (const key of path) {
      if (!this.isRecord(current)) {
        return undefined;
      }

      current = current[key];
    }

    return current;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
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
