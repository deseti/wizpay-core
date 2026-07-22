import {
  BadGatewayException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BlockchainService } from '../adapters/blockchain.service';
import {
  CircleContractExecutionInput,
  CircleContractExecutionResult,
  CircleService,
  CircleTransactionStatusResult,
  CircleTransferInput,
  CircleTransferResult,
  CircleTypedDataSignatureInput,
  CircleWalletBalance,
} from '../adapters/circle.service';
import { W3sAuthService } from '../modules/wallet/w3s-auth.service';
import { describeAppWalletSwapPayloadShape } from './app-wallet-swap-payload-sanitizer';
import { validTransactionHashOrNull } from './app-wallet-swap-provider-reference';
import { APP_WALLET_SWAP_ERROR_CODES } from './app-wallet-swap.types';

export interface AppWalletSwapCircleAdapterExecutionInput {
  amountIn: string;
  preparedRaw: unknown;
  preparedTransaction: unknown;
  tokenInAddress: `0x${string}`;
  treasuryAddress: string;
}

export interface AppWalletSwapCircleAllowanceInput {
  approvalTarget: string;
  contractAddress: string;
  idempotencyKey: string;
  network: string;
  refId: string;
  requiredAllowance: bigint;
  treasuryAddress: string;
  walletId: string;
}

export interface AppWalletSwapCircleAllowanceResult {
  allowanceAfter: string;
  allowanceBefore: string;
  approvalTxHash?: string | null;
}

@Injectable()
export class AppWalletSwapCircleExecutorService {
  constructor(
    private readonly circleService: CircleService,
    private readonly w3sAuthService: W3sAuthService,
    @Optional()
    private readonly blockchainService?: BlockchainService,
  ) {}

  submitTransfer(input: CircleTransferInput): Promise<CircleTransferResult> {
    return this.circleService.transfer(input);
  }

  submitContractExecution(
    input: CircleContractExecutionInput,
  ): Promise<CircleContractExecutionResult> {
    return this.circleService.executeContract(input);
  }

  signTypedData(
    input: CircleTypedDataSignatureInput,
  ): Promise<{ signature: string; raw: unknown }> {
    return this.circleService.signTypedData(input);
  }

  getTransactionStatus(
    transactionId: string,
  ): Promise<CircleTransactionStatusResult> {
    return this.circleService.getTransactionStatus(transactionId);
  }

  getWalletBalance(
    walletId: string,
    tokenAddress?: string,
  ): Promise<CircleWalletBalance[]> {
    return this.circleService.getWalletBalance(walletId, tokenAddress);
  }

  getW3sTransaction(transactionId: string): Promise<Record<string, unknown>> {
    return this.w3sAuthService.getTransaction(transactionId);
  }

  listW3sTransactions(params: {
    blockchain?: string;
    destinationAddress?: string;
    walletIds?: string;
  }): Promise<Record<string, unknown>> {
    return this.w3sAuthService.listTransactions(params);
  }

  buildDirectContractExecution(prepared: {
    transaction: { to?: unknown; data?: unknown };
  }): { contractAddress: string; callData: `0x${string}` } | null {
    const contractAddress = this.validContractAddressOrNull(
      prepared.transaction.to,
    );
    const callData = this.validCallDataOrNull(prepared.transaction.data);

    return contractAddress && callData ? { contractAddress, callData } : null;
  }

  async ensureTokenAllowance(
    input: AppWalletSwapCircleAllowanceInput,
  ): Promise<AppWalletSwapCircleAllowanceResult> {
    if (!this.blockchainService) {
      throw new ServiceUnavailableException({
        code: APP_WALLET_SWAP_ERROR_CODES.TREASURY_NOT_CONFIGURED,
        message:
          'App Wallet StableFX Treasury approval requires BlockchainService.',
      });
    }

    const allowanceBefore = (
      await this.blockchainService.getAllowance(
        input.treasuryAddress,
        input.approvalTarget,
        input.contractAddress,
      )
    ).allowance;

    if (BigInt(allowanceBefore) >= input.requiredAllowance) {
      return { allowanceBefore, allowanceAfter: allowanceBefore };
    }

    const approval = await this.circleService.executeContract({
      walletId: input.walletId,
      contractAddress: input.contractAddress,
      callData: this.blockchainService.buildERC20ApproveData(
        input.approvalTarget,
        input.requiredAllowance,
      ) as `0x${string}`,
      network: input.network,
      idempotencyKey: input.idempotencyKey,
      refId: input.refId,
    });
    const completed = await this.circleService.waitForTransactionComplete(
      approval.txId,
    );
    const allowanceAfter = (
      await this.blockchainService.getAllowance(
        input.treasuryAddress,
        input.approvalTarget,
        input.contractAddress,
      )
    ).allowance;

    if (BigInt(allowanceAfter) < input.requiredAllowance) {
      throw new BadGatewayException({
        code: APP_WALLET_SWAP_ERROR_CODES.STABLEFX_TREASURY_EXECUTION_FAILED,
        message:
          'StableFX Treasury token approval completed but allowance is still insufficient.',
      });
    }

    return {
      allowanceBefore,
      allowanceAfter,
      approvalTxHash: completed.txHash ?? approval.txHash ?? null,
    };
  }

  async executeTreasurySwapWithCircleWalletAdapter(
    input: AppWalletSwapCircleAdapterExecutionInput,
  ): Promise<{ txId: null; txHash: string | null; raw: unknown }> {
    const rawTransaction = this.isRecord(input.preparedTransaction)
      ? (input.preparedTransaction.raw ?? input.preparedTransaction)
      : input.preparedTransaction;

    if (!this.isRecord(rawTransaction)) {
      throw this.createNonExecutableSwapResponseError(
        input.preparedRaw,
        rawTransaction,
      );
    }

    if (!this.isRecord(rawTransaction.executionParams)) {
      throw this.createNonExecutableSwapResponseError(
        input.preparedRaw,
        rawTransaction,
      );
    }

    const signature = this.normalizeHexField(
      rawTransaction.signature,
      'transaction.signature',
    );
    const executeParams = this.buildSwapExecuteParams(
      rawTransaction.executionParams,
    );
    const inputAmount = this.resolvePreparedInputAmount(
      input.preparedRaw,
      input.amountIn,
    );
    const adapter = await this.createCircleWalletsAdapter();
    const ArcTestnet = await this.getArcTestnet();
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

    const context = { chain: ArcTestnet, address: input.treasuryAddress };
    const approval = await adapter.prepareAction(
      'token.approve',
      {
        tokenAddress: input.tokenInAddress,
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
            token: input.tokenInAddress,
            amount: inputAmount,
            permitCalldata: '0x',
          },
        ],
        signature,
        inputAmount,
        tokenInAddress: input.tokenInAddress,
      },
      context,
    );
    const swapTxHash = await swap.execute();

    return {
      txId: null,
      txHash: validTransactionHashOrNull(swapTxHash),
      raw: {
        adapter: 'circle-wallets',
        adapterContract,
        approvalTxHash,
        swapTxHash,
      },
    };
  }

  formatBaseUnits(value: string, decimals: number): string {
    const amount = BigInt(value);
    const scale = 10n ** BigInt(decimals);
    const whole = amount / scale;
    const fraction = amount % scale;

    if (fraction === 0n) {
      return whole.toString();
    }

    return `${whole}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
  }

  validContractAddressOrNull(value: unknown): string | null {
    return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)
      ? value
      : null;
  }

  private async createCircleWalletsAdapter(): Promise<any> {
    const { createCircleWalletsAdapter } =
      await import('@circle-fin/adapter-circle-wallets');

    return createCircleWalletsAdapter({
      apiKey: process.env.CIRCLE_API_KEY ?? '',
      entitySecret: process.env.CIRCLE_ENTITY_SECRET ?? '',
    });
  }

  private async getArcTestnet(): Promise<any> {
    const { ArcTestnet } = await import('@circle-fin/bridge-kit/chains');

    return ArcTestnet;
  }

  buildSwapExecuteParams(executionParams: Record<string, unknown>) {
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
      deadline: this.normalizeBigIntField(executionParams.deadline, 'deadline'),
      metadata: this.normalizeHexField(executionParams.metadata, 'metadata'),
    };
  }

  private createNonExecutableSwapResponseError(
    raw: unknown,
    transaction: unknown,
  ): BadGatewayException {
    const topLevelKeys = describeAppWalletSwapPayloadShape(raw).keys;
    const transactionKeys = describeAppWalletSwapPayloadShape(transaction).keys;

    return new BadGatewayException({
      code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_FAILED,
      message:
        `Circle Stablecoin Kits swap response did not include an executable transaction target. ` +
        `Top-level keys: ${topLevelKeys.join(', ') || 'none'}. ` +
        `Transaction keys: ${transactionKeys.join(', ') || 'none'}.`,
    });
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    if (typeof value !== 'string' || !/^0x(?:[a-fA-F0-9]{2})*$/.test(value)) {
      throw new BadGatewayException({
        code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_FAILED,
        message: `Circle Stablecoin Kits swap response did not include valid ${field}.`,
      });
    }

    return value as `0x${string}`;
  }

  private normalizeBigIntField(value: unknown, field: string): bigint {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return BigInt(value);
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
    if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) {
      return BigInt(value);
    }

    throw new BadGatewayException({
      code: APP_WALLET_SWAP_ERROR_CODES.EXECUTION_FAILED,
      message: `Circle Stablecoin Kits swap response did not include valid ${field}.`,
    });
  }

  private resolvePreparedInputAmount(raw: unknown, fallback: string): bigint {
    const rawAmount = this.findFirst(raw, ['amount']);

    if (
      typeof rawAmount === 'string' ||
      typeof rawAmount === 'number' ||
      typeof rawAmount === 'bigint'
    ) {
      return this.normalizeBigIntField(rawAmount, 'amount');
    }

    return this.normalizeBigIntField(fallback, 'amountIn');
  }

  private findFirst(raw: unknown, paths: string[]): unknown {
    for (const path of paths) {
      const value = path.split('.').reduce<unknown>((current, key) => {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
          return undefined;
        }

        return (current as Record<string, unknown>)[key];
      }, raw);

      if (value !== undefined && value !== null) return value;
    }

    return undefined;
  }
}
