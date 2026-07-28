import {
  BadGatewayException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { BlockchainService } from '../adapters/blockchain.service';
import { CircleService } from '../adapters/circle.service';
import { StablefxExecutionService } from '../user-swap/stablefx-execution.service';
import {
  USER_SWAP_EURC_ADDRESS,
  USER_SWAP_USDC_ADDRESS,
} from '../user-swap/user-swap.service';
import { USER_SWAP_ALLOWED_CHAIN } from '../user-swap/user-swap.types';
import { PayrollFxStablefxEvidenceReader } from './payroll-fx-stablefx-evidence';
import { PayrollFxStablefxOperationService } from './payroll-fx-stablefx-operation.service';
import type {
  PayrollFxLeaseFence,
  PayrollFxOperation,
  PayrollFxOperationStatus,
} from './payroll-fx-operation.types';
import type {
  PayrollFxStablefxLifecycleRequest,
  PayrollFxStablefxLifecycleResult,
  PayrollFxStablefxPayoutCompletion,
  PayrollFxStablefxPayoutSubmission,
} from './payroll-fx-stablefx-lifecycle.types';

const TOKEN_ADDRESS_MAP: Record<string, string> = {
  USDC: USER_SWAP_USDC_ADDRESS,
  EURC: USER_SWAP_EURC_ADDRESS,
};

@Injectable()
export class PayrollFxStablefxLifecycleService {
  private readonly logger = new Logger(PayrollFxStablefxLifecycleService.name);
  private readonly evidence = new PayrollFxStablefxEvidenceReader();
  private readonly operationService: PayrollFxStablefxOperationService;

  constructor(
    private readonly stablefxExecutionService: StablefxExecutionService,
    private readonly circleService: CircleService,
    private readonly configService: ConfigService,
    @Optional() private readonly blockchainService?: BlockchainService,
    @Optional()
    operationService?: PayrollFxStablefxOperationService,
  ) {
    this.operationService =
      operationService ?? new PayrollFxStablefxOperationService();
  }

  async settle(
    request: PayrollFxStablefxLifecycleRequest,
    treasuryAddress: string,
  ): Promise<PayrollFxStablefxLifecycleResult> {
    const operation = await this.operationService.begin(
      request,
      treasuryAddress,
      this.resolveTokenAddress(request.sourceToken),
      this.resolveTokenAddress(request.targetToken),
    );
    return this.executeForward(
      request,
      treasuryAddress,
      operation,
      operation?.status ?? 'quote_pending',
    );
  }

  async settlePersisted(
    request: PayrollFxStablefxLifecycleRequest,
    treasuryAddress: string,
    operation: PayrollFxOperation,
    fence: PayrollFxLeaseFence,
  ): Promise<PayrollFxStablefxLifecycleResult> {
    let status = operation.status;
    if (status === 'created') {
      await this.operationService.markQuotePending(
        operation.operationId,
        fence,
      );
      status = 'quote_pending';
    }
    if (!['quote_pending', 'quote_ready'].includes(status)) {
      throw this.stablefxFailure(
        `StableFX Payroll forward execution cannot start from ${status}.`,
      );
    }
    return this.executeForward(
      request,
      treasuryAddress,
      operation,
      status,
      fence,
    );
  }

  private async executeForward(
    request: PayrollFxStablefxLifecycleRequest,
    treasuryAddress: string,
    operation: PayrollFxOperation | null,
    startingStatus: PayrollFxOperationStatus,
    fence?: PayrollFxLeaseFence,
  ): Promise<PayrollFxStablefxLifecycleResult> {
    const context = {
      externalSideEffectPossible: false,
      stage: 'tradable_quote',
    };

    try {
      this.logPhase(request, operation?.operationId, context.stage);
      const quote = await this.stablefxExecutionService.createTradableQuote({
        amountIn: request.sourceAmount,
        chain: USER_SWAP_ALLOWED_CHAIN,
        fromAddress: treasuryAddress,
        recipientAddress: treasuryAddress,
        tokenIn: request.sourceToken,
        tokenOut: request.targetToken,
      });
      const quoteId =
        this.evidence.getString(quote, ['id']) ??
        this.evidence.getString(quote, ['quoteId']);
      const typedData = this.evidence.getTypedData(quote);

      if (
        !quoteId ||
        !typedData ||
        !this.evidence.isRecord(typedData.message)
      ) {
        throw this.stablefxFailure(
          'StableFX payroll settlement quote did not include quoteId and signable typedData.',
        );
      }

      if (operation) {
        const quoteEvidence = {
          quoteId,
          approvalTargetAddress: this.getPermit2ApprovalTarget(typedData),
          quoteExpiresAt: this.evidence.readQuoteExpiry(quote),
          expectedOutputBaseUnits: this.evidence.readOutputBaseUnits(quote),
          lastProviderStatus: this.evidence.readOptionalStatus(quote),
          diagnosticSnapshot: { stage: 'quote_recorded' },
        };
        if (fence) {
          await this.operationService.recordQuote(
            operation.operationId,
            quoteEvidence,
            startingStatus === 'quote_ready' ? 'quote_ready' : 'quote_pending',
            fence,
          );
        } else {
          await this.operationService.recordQuote(
            operation.operationId,
            quoteEvidence,
          );
        }
      }

      context.stage = 'allowance_check';
      if (operation && fence) {
        await this.operationService.markApprovalPending(
          operation.operationId,
          fence,
        );
      }
      const approval = await this.ensureTreasuryTokenAllowance(
        request,
        treasuryAddress,
        typedData,
        context,
      );
      if (operation && approval) {
        const approvalEvidence = {
          approvalTransactionId: approval.transactionId,
          approvalTransactionHash: approval.transactionHash,
          diagnosticSnapshot: { stage: 'approval_confirmed' },
        };
        if (fence) {
          await this.operationService.recordApproval(
            operation.operationId,
            approvalEvidence,
            fence,
          );
        } else {
          await this.operationService.recordApproval(
            operation.operationId,
            approvalEvidence,
          );
        }
      }

      context.stage = 'sign_quote';
      this.logPhase(request, operation?.operationId, context.stage);
      const signedQuote = await this.circleService.signTypedData({
        walletId: this.getTreasuryWalletId(),
        typedData,
        memo: `WizPay Payroll StableFX ${request.sourceToken}->${request.targetToken} quote`,
      });

      context.stage = 'create_trade';
      this.logPhase(request, operation?.operationId, context.stage);
      if (operation && fence) {
        await this.operationService.markSubmitted(
          operation.operationId,
          'approval_pending',
          fence,
        );
      }
      context.externalSideEffectPossible = true;
      const trade = await this.stablefxExecutionService.createTrade({
        idempotencyKey: this.buildProviderIdempotencyKey(
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

      if (operation) {
        const submissionEvidence = {
          providerOperationId: tradeId,
          submittedAt: new Date(),
          lastProviderStatus: this.evidence.resolveStatus(trade),
          diagnosticSnapshot: { stage: 'trade_submitted' },
        };
        if (fence) {
          await this.operationService.recordSubmission(
            operation.operationId,
            'submitted',
            submissionEvidence,
            fence,
          );
        } else {
          await this.operationService.recordSubmission(
            operation.operationId,
            approval ? 'approval_pending' : 'quote_ready',
            submissionEvidence,
          );
        }
      }

      return await this.finishSubmittedTrade(
        request,
        operation,
        fence,
        tradeId,
        trade,
        this.evidence.readOutputBaseUnits(quote),
        context,
      );
    } catch (error) {
      if (operation) {
        if (fence) {
          await this.operationService.recordFailureSafely(
            operation.operationId,
            error,
            context.stage,
            context.externalSideEffectPossible,
            fence,
          );
        } else {
          await this.operationService.recordFailureSafely(
            operation.operationId,
            error,
            context.stage,
            context.externalSideEffectPossible,
          );
        }
      }
      throw error;
    }
  }

  async resumeSubmitted(
    request: PayrollFxStablefxLifecycleRequest,
    operation: PayrollFxOperation,
    fence: PayrollFxLeaseFence,
    trade: Record<string, unknown>,
  ): Promise<PayrollFxStablefxLifecycleResult> {
    const context = {
      externalSideEffectPossible: false,
      stage: 'trade_reconciliation',
    };
    try {
      return await this.finishSubmittedTrade(
        request,
        operation,
        fence,
        operation.providerOperationId!,
        trade,
        operation.expectedOutputBaseUnits,
        context,
      );
    } catch (error) {
      await this.operationService.recordFailureSafely(
        operation.operationId,
        error,
        context.stage,
        context.externalSideEffectPossible,
        fence,
      );
      throw error;
    }
  }

  async resumeSettlement(
    request: PayrollFxStablefxLifecycleRequest,
    operation: PayrollFxOperation,
    fence: PayrollFxLeaseFence,
  ): Promise<PayrollFxStablefxLifecycleResult> {
    const settledTrade = await this.waitForSettlement(
      request,
      operation.operationId,
      operation.providerOperationId!,
    );
    return this.persistSettledTrade(
      request,
      operation,
      fence,
      settledTrade,
      operation.expectedOutputBaseUnits,
    );
  }

  async recordReconciledFunding(
    operation: PayrollFxOperation,
    fence: PayrollFxLeaseFence,
    trade: Record<string, unknown>,
  ): Promise<void> {
    await this.operationService.recordFunding(
      operation.operationId,
      {
        fundingTransactionId: this.evidence.readTransactionId(trade),
        fundingTransactionHash: this.evidence.readTransactionHash(trade),
        fundingConfirmedAt: new Date(),
        lastProviderStatus: this.evidence.resolveStatus(trade),
        diagnosticSnapshot: { stage: 'funding_reconciled_from_trade' },
      },
      'funding_pending',
      fence,
    );
  }

  private async finishSubmittedTrade(
    request: PayrollFxStablefxLifecycleRequest,
    operation: PayrollFxOperation | null,
    fence: PayrollFxLeaseFence | undefined,
    tradeId: string,
    trade: Record<string, unknown>,
    fallbackOutput: string | null,
    context: { stage: string; externalSideEffectPossible: boolean },
  ): Promise<PayrollFxStablefxLifecycleResult> {
    const { contractTradeId } = await this.waitForContractTradeId(
      request,
      operation?.operationId,
      tradeId,
      trade,
    );
    context.stage = 'funding_presign';
    const fundingPresign =
      await this.stablefxExecutionService.createFundingPresign({
        contractTradeId,
      });
    const fundingTypedData = this.evidence.getTypedData(fundingPresign);
    if (
      !fundingTypedData ||
      !this.evidence.isRecord(fundingTypedData.message)
    ) {
      throw this.stablefxFailure(
        'StableFX payroll settlement funding presign did not include signable typedData.',
      );
    }

    context.stage = 'sign_funding';
    const signedFunding = await this.circleService.signTypedData({
      walletId: this.getTreasuryWalletId(),
      typedData: fundingTypedData,
      memo: `WizPay Payroll StableFX ${request.sourceToken}->${request.targetToken} funding`,
    });

    context.stage = 'fund';
    if (operation && fence) {
      await this.operationService.markFundingPending(
        operation.operationId,
        fence,
      );
    }
    context.externalSideEffectPossible = true;
    const fund = await this.stablefxExecutionService.fund({
      permit2: fundingTypedData.message,
      signature: signedFunding.signature,
    });
    if (operation) {
      const fundingEvidence = {
        fundingTransactionId: this.evidence.readTransactionId(fund),
        fundingTransactionHash: this.evidence.readTransactionHash(fund),
        fundingConfirmedAt: new Date(),
        lastProviderStatus: this.evidence.readOptionalStatus(fund),
        diagnosticSnapshot: { stage: 'funding_submitted' },
      };
      if (fence) {
        await this.operationService.recordFunding(
          operation.operationId,
          fundingEvidence,
          'funding_pending',
          fence,
        );
      } else {
        await this.operationService.recordFunding(
          operation.operationId,
          fundingEvidence,
        );
      }
    }

    context.stage = 'settlement';
    const settledTrade = await this.waitForSettlement(
      request,
      operation?.operationId,
      tradeId,
    );
    return this.persistSettledTrade(
      request,
      operation,
      fence,
      settledTrade,
      fallbackOutput,
      fund,
    );
  }

  private async persistSettledTrade(
    request: PayrollFxStablefxLifecycleRequest,
    operation: PayrollFxOperation | null,
    fence: PayrollFxLeaseFence | undefined,
    settledTrade: Record<string, unknown>,
    fallbackOutput: string | null,
    fallbackEvidence?: Record<string, unknown>,
  ): Promise<PayrollFxStablefxLifecycleResult> {
    const txHash =
      this.evidence.extractSettlementHash(settledTrade) ??
      this.evidence.extractSettlementHash(fallbackEvidence);
    if (!txHash) {
      throw this.stablefxFailure(
        'StableFX payroll settlement completed without a settlement transaction hash.',
      );
    }
    const targetAmount =
      this.evidence.readOutputBaseUnits(settledTrade) ??
      fallbackOutput ??
      request.sourceAmount;
    if (operation) {
      const settlementEvidence = {
        actualOutputBaseUnits: targetAmount,
        settlementTransactionId: this.evidence.readTransactionId(settledTrade),
        settlementTransactionHash: txHash,
        settledAt: new Date(),
        lastProviderStatus: this.evidence.resolveStatus(settledTrade),
        diagnosticSnapshot: {
          stage: 'settled',
          settlementEvidence: this.evidence.classifySettlement(settledTrade),
        },
      };
      if (fence) {
        await this.operationService.recordSettlement(
          operation.operationId,
          settlementEvidence,
          fence,
        );
      } else {
        await this.operationService.recordSettlement(
          operation.operationId,
          settlementEvidence,
        );
      }
    }
    return {
      sourceToken: request.sourceToken,
      targetToken: request.targetToken,
      sourceAmount: request.sourceAmount,
      targetAmount,
      txHash,
      status: 'settled',
      ...(operation ? { operationId: operation.operationId } : {}),
    };
  }

  async recordPayoutSubmission(
    operationId: string,
    evidence: PayrollFxStablefxPayoutSubmission,
  ): Promise<void> {
    await this.operationService.recordPayoutSubmission(operationId, evidence);
  }

  async recordPayoutCompletion(
    operationId: string,
    evidence: PayrollFxStablefxPayoutCompletion,
  ): Promise<void> {
    await this.operationService.recordPayoutCompletion(operationId, evidence);
  }

  async recordPayoutFailure(
    operationId: string,
    error: unknown,
  ): Promise<void> {
    await this.operationService.recordFailureSafely(
      operationId,
      error,
      'payout',
      true,
    );
  }

  private async ensureTreasuryTokenAllowance(
    request: PayrollFxStablefxLifecycleRequest,
    treasuryAddress: string,
    typedData: Record<string, unknown>,
    context: { externalSideEffectPossible: boolean },
  ): Promise<{
    transactionId: string | null;
    transactionHash: string | null;
  } | null> {
    if (!this.blockchainService) {
      throw new ServiceUnavailableException({
        code: 'PAYROLL_FX_SETTLEMENT_UNAVAILABLE',
        message:
          'StableFX payroll settlement requires BlockchainService for treasury token approval.',
      });
    }

    const approvalTarget = this.getPermit2ApprovalTarget(typedData);
    const tokenAddress = this.resolveTokenAddress(request.sourceToken);
    const requiredAllowance = BigInt(request.sourceAmount);
    const allowanceBefore = (
      await this.blockchainService.getAllowance(
        treasuryAddress,
        approvalTarget,
        tokenAddress,
      )
    ).allowance;
    let approvalEvidence: {
      transactionId: string | null;
      transactionHash: string | null;
    } | null = null;
    let allowanceAfter = allowanceBefore;

    if (BigInt(allowanceBefore) < requiredAllowance) {
      context.externalSideEffectPossible = true;
      const approval = await this.circleService.executeContract({
        walletId: this.getTreasuryWalletId(),
        contractAddress: tokenAddress,
        callData: this.blockchainService.buildERC20ApproveData(
          approvalTarget,
          requiredAllowance,
        ) as `0x${string}`,
        network: USER_SWAP_ALLOWED_CHAIN,
        idempotencyKey: this.buildProviderIdempotencyKey(
          `${request.referenceId}:stablefx-${request.sourceToken.toLowerCase()}-approval`,
        ),
        refId: `PAYROLL-FX-${request.referenceId}-STABLEFX-${request.sourceToken}-APPROVAL`,
      });
      const completed = await this.circleService.waitForTransactionComplete(
        approval.txId,
      );
      approvalEvidence = {
        transactionId: approval.txId ?? null,
        transactionHash: completed.txHash ?? approval.txHash ?? null,
      };
      allowanceAfter = (
        await this.blockchainService.getAllowance(
          treasuryAddress,
          approvalTarget,
          tokenAddress,
        )
      ).allowance;

      if (BigInt(allowanceAfter) < requiredAllowance) {
        throw this.stablefxFailure(
          'StableFX payroll treasury token approval completed but allowance is still insufficient.',
        );
      }
    }

    this.logger.log(
      `[payroll-fx-settlement] provider=stablefx phase=allowance_check ` +
        `referenceId=${request.referenceId} sourceToken=${request.sourceToken} ` +
        `sourceAmount=${request.sourceAmount} treasuryAddress=${treasuryAddress} ` +
        `tokenAddress=${tokenAddress} approvalTarget=${approvalTarget} ` +
        `allowanceBefore=${allowanceBefore} ` +
        `approvalTxHash=${approvalEvidence?.transactionHash ?? 'not_required'} ` +
        `allowanceAfter=${allowanceAfter}`,
    );
    return approvalEvidence;
  }

  private async waitForContractTradeId(
    request: PayrollFxStablefxLifecycleRequest,
    operationId: string | undefined,
    tradeId: string,
    initialTrade: Record<string, unknown>,
  ): Promise<{ contractTradeId: string; trade: Record<string, unknown> }> {
    let trade = initialTrade;
    let contractTradeId = this.resolveStablefxContractTradeId(trade);

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const status = this.evidence.resolveStatus(trade);
      if (contractTradeId) {
        this.logPhase(request, operationId, 'contract_ready');
        return { contractTradeId, trade };
      }
      if (this.evidence.isFailureStatus(status)) {
        throw this.stablefxFailure(
          `StableFX payroll trade failed before funding with status ${status}.`,
        );
      }
      this.logPhase(request, operationId, 'get_trade');
      await this.delay(2_000);
      trade = await this.stablefxExecutionService.getTrade(tradeId);
      contractTradeId = this.resolveStablefxContractTradeId(trade);
    }

    throw this.stablefxFailure(
      'StableFX payroll trade was created but contractTradeId was not ready before timeout.',
    );
  }

  private async waitForSettlement(
    request: PayrollFxStablefxLifecycleRequest,
    operationId: string | undefined,
    tradeId: string,
  ): Promise<Record<string, unknown>> {
    let latest: Record<string, unknown> | null = null;

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      this.logPhase(request, operationId, 'get_trade');
      latest = await this.stablefxExecutionService.getTrade(tradeId);
      const status = this.evidence.resolveStatus(latest);
      const settlementHash = this.evidence.extractSettlementHash(latest);
      if (
        settlementHash ||
        ['complete', 'completed', 'settled'].includes(status.toLowerCase())
      ) {
        return latest;
      }
      if (this.evidence.isFailureStatus(status)) {
        throw this.stablefxFailure(
          `StableFX payroll trade failed during settlement with status ${status}.`,
        );
      }
      await this.delay(3_000);
    }

    if (latest) return latest;
    throw this.stablefxFailure(
      'StableFX payroll trade status was not available after funding.',
    );
  }

  private getPermit2ApprovalTarget(typedData: Record<string, unknown>): string {
    const target = this.validAddressOrNull(
      this.evidence.getString(typedData, ['domain', 'verifyingContract']),
    );
    if (!target) {
      throw this.stablefxFailure(
        'StableFX payroll quote typedData did not include a valid Permit2 verifyingContract approval target.',
      );
    }
    return target;
  }

  private resolveStablefxTradeId(raw: unknown): string {
    const tradeId =
      this.evidence.getString(raw, ['id']) ??
      this.evidence.getString(raw, ['tradeId']) ??
      this.evidence.getString(raw, ['data', 'id']) ??
      this.evidence.getString(raw, ['data', 'tradeId']);
    if (!tradeId) {
      throw this.stablefxFailure(
        'StableFX create_trade did not return a trade identifier.',
      );
    }
    return tradeId;
  }

  private resolveStablefxContractTradeId(raw: unknown): string | null {
    return this.evidence.resolveContractTradeId(raw);
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

  private resolveTokenAddress(token: string): string {
    const address = TOKEN_ADDRESS_MAP[token.trim().toUpperCase()];
    if (!address) {
      throw new BadGatewayException({
        code: 'PAYROLL_FX_SETTLEMENT_EXECUTION_FAILED',
        message: `Unsupported token "${token}" for payroll FX settlement.`,
      });
    }
    return address;
  }

  private buildProviderIdempotencyKey(referenceId: string): string {
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

  private logPhase(
    request: PayrollFxStablefxLifecycleRequest,
    operationId: string | undefined,
    phase: string,
  ): void {
    this.logger.log(
      `[payroll-fx-settlement] provider=stablefx ` +
        `sourceToken=${request.sourceToken} targetToken=${request.targetToken} ` +
        `sourceAmount=${request.sourceAmount} referenceId=${request.referenceId} ` +
        `operationId=${operationId ?? 'unpersisted-test-context'} phase=${phase}`,
    );
  }

  private stablefxFailure(message: string): BadGatewayException {
    return new BadGatewayException({
      code: 'PAYROLL_FX_SETTLEMENT_STABLEFX_FAILED',
      message,
    });
  }

  private validAddressOrNull(value: unknown): string | null {
    return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)
      ? value
      : null;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
