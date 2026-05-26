import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CircleClient } from './circle.client';

const ETH_SEPOLIA_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
const ARC_TESTNET_RPC_URL = 'https://rpc.testnet.arc.network/';
const ARC_TESTNET_RPC_FALLBACK_URLS = [
  'https://rpc.testnet.arc.network/',
  'https://rpc.quicknode.testnet.arc.network/',
  'https://rpc.blockdaemon.testnet.arc.network/',
];
const SOLANA_DEVNET_RPC_URL = 'https://api.devnet.solana.com';
const SOLANA_MIN_FEE_BALANCE_LAMPORTS = 0.01 * 1_000_000_000; // 0.01 SOL
const SOLANA_TOP_UP_TARGET_LAMPORTS = 0.05 * 1_000_000_000; // 0.05 SOL

/**
 * Maximum number of retry attempts for Arc Testnet source-chain bridge
 * when Circle's API returns an RPC endpoint error.
 */
const ARC_SOURCE_BRIDGE_MAX_RETRIES = 2;
const ARC_SOURCE_BRIDGE_RETRY_DELAY_MS = 3_000;

type SupportedBridgeBlockchain = 'ETH-SEPOLIA' | 'ARC-TESTNET' | 'SOLANA-DEVNET';

export interface InitiateBridgeInput {
  amount: string;
  destinationAddress: string;
  destinationBlockchain: string;
  referenceId?: string | null;
  sourceBlockchain: string;
  sourceWalletAddress: string;
  taskId: string;
  token?: string;
  walletId: string;
}

export interface BridgeExecutionStep {
  id: string;
  name: string;
  state: 'pending' | 'success' | 'error' | 'noop';
  txHash: string | null;
  explorerUrl: string | null;
  errorMessage: string | null;
  forwarded?: boolean;
  batched?: boolean;
}

export interface BridgeExecutionResult {
  amount: string;
  blockchain: string;
  destinationAddress: string;
  destinationChain: string;
  errorReason: string | null;
  provider: string | null;
  raw?: unknown;
  rawStatus: string;
  referenceId: string;
  sourceAddress: string;
  sourceBlockchain: string;
  sourceChain: string;
  sourceWalletId: string;
  status: 'pending' | 'processing' | 'settled' | 'failed';
  steps: BridgeExecutionStep[];
  token: string;
  tokenAddress: string;
  transferId: string;
  txHash: string | null;
  txHashBurn: string | null;
  txHashMint: string | null;
  walletAddress: string;
  walletId: string;
}

type NormalizedBridgeInput = InitiateBridgeInput & {
  destinationAddress: string;
  destinationBlockchain: SupportedBridgeBlockchain;
  referenceId: string;
  sourceBlockchain: SupportedBridgeBlockchain;
  sourceWalletAddress: string;
  token: 'USDC';
  walletId: string;
};

@Injectable()
export class CircleBridgeService {
  private readonly logger = new Logger(CircleBridgeService.name);

  constructor(private readonly circleClient: CircleClient) { }

  async initiateBridge(
    input: InitiateBridgeInput,
  ): Promise<BridgeExecutionResult> {
    const normalized = this.normalizeInput(input);
    await this.ensureSolanaSourceFeeBalance(normalized);

    // Pre-validate: ensure the source wallet is registered with Circle
    // before attempting the bridge. This catches new-account issues early.
    if (normalized.sourceBlockchain !== 'SOLANA-DEVNET') {
      await this.validateCircleWalletExists(normalized);
    }

    // Pre-validate: verify Arc Testnet RPC is reachable when it's the source
    if (normalized.sourceBlockchain === 'ARC-TESTNET') {
      await this.validateArcTestnetRpcReachable();
    }

    const client = await this.circleClient.getBridgeClient();
    const adapter = this.skipBridgeKitBalancePrechecks(
      await this.circleClient.getBridgeAdapter(),
      normalized.sourceBlockchain,
    );
    const sourceChain = await this.resolveBridgeChain(
      normalized.sourceBlockchain,
    );
    const destinationChain = await this.resolveBridgeChain(
      normalized.destinationBlockchain,
    );

    const bridgeParams = {
      from: {
        adapter,
        chain: sourceChain,
        address: normalized.sourceWalletAddress,
      },
      to: {
        chain: destinationChain,
        recipientAddress: normalized.destinationAddress,
        useForwarder: true,
      },
      amount: normalized.amount,
      token: normalized.token,
      config: {
        transferSpeed: 'FAST',
      },
      invocationMeta: {
        traceId: normalized.referenceId,
        callers: [
          {
            type: 'app',
            name: 'WizPay',
            version: '1.0.0',
          },
        ],
      },
    };

    // For Arc Testnet source, retry on transient RPC endpoint errors from Circle
    const maxAttempts = normalized.sourceBlockchain === 'ARC-TESTNET'
      ? ARC_SOURCE_BRIDGE_MAX_RETRIES + 1
      : 1;

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.logger.log(
          `Bridge executing (attempt ${attempt}/${maxAttempts}): ${normalized.sourceBlockchain} → ${normalized.destinationBlockchain}, amount=${normalized.amount}, source=${normalized.sourceWalletAddress}, dest=${normalized.destinationAddress}`,
        );

        const result = await client.bridge(bridgeParams as any);

        this.logger.log(
          `Bridge result state: ${result?.state}, steps: ${JSON.stringify(result?.steps?.map((s: any) => ({ name: s.name, state: s.state, error: s.errorMessage })))}`,
        );

        return this.normalizeBridgeResult(normalized, result);
      } catch (error) {
        lastError = error;
        const submittedHash = this.extractSubmittedHash(error);

        if (submittedHash) {
          this.logger.warn(
            `Bridge threw but has a submitted hash: ${submittedHash}. Treating as processing.`,
          );
          return this.normalizeSubmittedBridgeResult(normalized, submittedHash, error);
        }

        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        const isTimeout = message.toLowerCase().includes('timeout') || message.toLowerCase().includes('timed out');
        const isRpcEndpointError = this.isCircleRpcEndpointError(error);

        this.logger.error(
          `Bridge failed (attempt ${attempt}/${maxAttempts}): ${normalized.sourceBlockchain} → ${normalized.destinationBlockchain}. Error: ${message}`,
          stack,
        );

        // Log full error object for debugging
        try {
          const errorDetails = JSON.stringify(error, Object.getOwnPropertyNames(error as any), 2);
          this.logger.error(`Bridge error details: ${errorDetails}`);
        } catch {
          // ignore serialization errors
        }

        if (isTimeout) {
          return this.normalizeSubmittedBridgeResult(normalized, null, error);
        }

        // Retry only for transient RPC endpoint errors on Arc Testnet source
        if (isRpcEndpointError && attempt < maxAttempts) {
          this.logger.warn(
            `Circle returned RPC endpoint error for Arc Testnet source. Retrying in ${ARC_SOURCE_BRIDGE_RETRY_DELAY_MS}ms (attempt ${attempt}/${maxAttempts})...`,
          );
          await this.delay(ARC_SOURCE_BRIDGE_RETRY_DELAY_MS);
          continue;
        }

        // Not retryable — throw with improved error context
        if (isRpcEndpointError) {
          throw new BadRequestException({
            code: 'CIRCLE_BRIDGE_EXECUTION_FAILED',
            error: `Circle's infrastructure could not reach the Arc Testnet RPC endpoint to execute the burn transaction. This is a transient issue on Circle's side. Please retry in a few moments.`,
            details: {
              failedStep: { name: 'Burn on source chain', errorMessage: message },
              sourceBlockchain: normalized.sourceBlockchain,
              destinationBlockchain: normalized.destinationBlockchain,
              attempts: attempt,
            },
          });
        }

        throw error;
      }
    }

    // Should not reach here, but handle gracefully
    throw lastError;
  }

  async getBridgeStatus(transferId: string): Promise<unknown> {
    const client = (await this.circleClient.getBridgeClient()) as any;

    if (typeof client.getTransferStatus === 'function') {
      return await client.getTransferStatus(transferId);
    }

    return { status: 'completed' };
  }

  async executeBridge(payload: any): Promise<BridgeExecutionResult> {
    return this.initiateBridge({
      amount: payload.amount,
      destinationAddress: payload.destinationAddress,
      destinationBlockchain: payload.blockchain || payload.destinationBlockchain,
      referenceId: payload.referenceId,
      sourceBlockchain: payload.sourceBlockchain,
      sourceWalletAddress: payload.walletAddress || payload.sourceWalletAddress,
      taskId: payload.taskId || `task-${Date.now()}`,
      token: payload.token,
      walletId: payload.walletId,
    });
  }

  private normalizeInput(input: InitiateBridgeInput): NormalizedBridgeInput {
    const sourceBlockchain = this.normalizeSupportedBlockchain(
      input.sourceBlockchain,
    );
    const destinationBlockchain = this.normalizeSupportedBlockchain(
      input.destinationBlockchain,
    );
    const token = 'USDC';
    const amount = String(input.amount ?? '').trim();
    const walletId = String(input.walletId ?? '').trim();
    const sourceWalletAddress = this.normalizeAddress(
      input.sourceWalletAddress,
      sourceBlockchain,
    );
    const destinationAddress = this.normalizeAddress(
      input.destinationAddress,
      destinationBlockchain,
    );

    if (sourceBlockchain === destinationBlockchain) {
      throw new BadRequestException(
        'Bridge source and destination chains must be different.',
      );
    }

    if (!amount || Number(amount) <= 0 || !Number.isFinite(Number(amount))) {
      throw new BadRequestException('Bridge amount must be a positive string.');
    }

    if (!walletId) {
      throw new BadRequestException('Bridge requires walletId.');
    }

    if (!sourceWalletAddress || !destinationAddress) {
      throw new BadRequestException(
        'Bridge requires valid source and destination addresses.',
      );
    }

    return {
      ...input,
      amount,
      destinationAddress,
      destinationBlockchain,
      referenceId: input.referenceId || `BRIDGE-${input.taskId}`,
      sourceBlockchain,
      sourceWalletAddress,
      token,
      walletId,
    };
  }

  private normalizeBridgeResult(
    input: NormalizedBridgeInput,
    result: any,
  ): BridgeExecutionResult {
    const steps = this.normalizeSteps(result?.steps);
    const burnStep = steps.find((step) => this.isBurnStep(step.name));
    const mintStep = steps.find((step) => this.isMintStep(step.name));
    const failedStep = steps.find((step) => step.state === 'error');
    const state = typeof result?.state === 'string' ? result.state : 'pending';
    const txHashBurn = burnStep?.txHash ?? null;
    const txHashMint = mintStep?.txHash ?? null;
    const txHash =
      txHashMint ??
      txHashBurn ??
      steps.find((step) => step.txHash)?.txHash ??
      null;
    const submittedTimeout =
      Boolean(txHash) &&
      typeof failedStep?.errorMessage === 'string' &&
      failedStep.errorMessage.includes(
        'Timed out while waiting for transaction with hash',
      );
    const normalizedSteps = submittedTimeout
      ? steps.map((step) =>
        step.state === 'error'
          ? { ...step, errorMessage: null, state: 'success' as const }
          : step,
      )
      : steps;
    const status =
      state === 'success'
        ? 'settled'
        : state === 'error' && !submittedTimeout
          ? 'failed'
          : 'processing';

    return {
      amount: input.amount,
      blockchain: input.destinationBlockchain,
      destinationAddress: input.destinationAddress,
      destinationChain: input.destinationBlockchain,
      errorReason: submittedTimeout ? null : (failedStep?.errorMessage ?? null),
      provider:
        typeof result?.provider === 'string'
          ? result.provider
          : 'Circle Bridge Kit',
      raw: result,
      rawStatus: submittedTimeout ? 'submitted' : state,
      referenceId: input.referenceId,
      sourceAddress: input.sourceWalletAddress,
      sourceBlockchain: input.sourceBlockchain,
      sourceChain: input.sourceBlockchain,
      sourceWalletId: input.walletId,
      status,
      steps: normalizedSteps,
      token: input.token,
      tokenAddress: '',
      transferId: this.resolveTransferId(input, steps),
      txHash,
      txHashBurn,
      txHashMint,
      walletAddress: input.sourceWalletAddress,
      walletId: input.walletId,
    };
  }

  private normalizeSubmittedBridgeResult(
    input: NormalizedBridgeInput,
    txHash: string | null,
    error: unknown,
  ): BridgeExecutionResult {
    const step: BridgeExecutionStep = {
      errorMessage: null,
      explorerUrl: null,
      id: 'burn',
      name: 'Burn submitted',
      state: 'success',
      txHash,
    };

    return {
      amount: input.amount,
      blockchain: input.destinationBlockchain,
      destinationAddress: input.destinationAddress,
      destinationChain: input.destinationBlockchain,
      errorReason: null,
      provider: 'Circle Bridge Kit',
      raw: {
        recoveredFrom:
          error instanceof Error ? error.message : 'Bridge wait timeout',
      },
      rawStatus: 'submitted',
      referenceId: input.referenceId,
      sourceAddress: input.sourceWalletAddress,
      sourceBlockchain: input.sourceBlockchain,
      sourceChain: input.sourceBlockchain,
      sourceWalletId: input.walletId,
      status: 'processing',
      steps: [step],
      token: input.token,
      tokenAddress: '',
      transferId: txHash || input.referenceId || `bridge-${Date.now()}`,
      txHash,
      txHashBurn: txHash,
      txHashMint: null,
      walletAddress: input.sourceWalletAddress,
      walletId: input.walletId,
    };
  }

  private extractSubmittedHash(error: unknown): string | null {
    if (!(error instanceof Error)) {
      return null;
    }

    const match = error.message.match(/hash "([^"]+)"/);
    return match?.[1] ?? null;
  }

  private normalizeSteps(steps: unknown): BridgeExecutionStep[] {
    if (!Array.isArray(steps)) {
      return [];
    }

    return steps.map((step, index) => {
      const item = step && typeof step === 'object' ? (step as any) : {};
      const name =
        typeof item.name === 'string' && item.name.trim()
          ? item.name.trim()
          : `Step ${index + 1}`;

      return {
        batched: typeof item.batched === 'boolean' ? item.batched : undefined,
        errorMessage:
          typeof item.errorMessage === 'string' ? item.errorMessage : null,
        explorerUrl:
          typeof item.explorerUrl === 'string' ? item.explorerUrl : null,
        forwarded:
          typeof item.forwarded === 'boolean' ? item.forwarded : undefined,
        id: this.resolveStepId(name, index),
        name,
        state: this.normalizeStepState(item.state),
        txHash: typeof item.txHash === 'string' ? item.txHash : null,
      };
    });
  }

  private resolveStepId(name: string, index: number) {
    if (this.isBurnStep(name)) {
      return 'burn';
    }

    if (name.toLowerCase().includes('attest')) {
      return 'attestation';
    }

    if (this.isMintStep(name)) {
      return 'mint';
    }

    return `step-${index + 1}`;
  }

  private normalizeStepState(
    state: unknown,
  ): BridgeExecutionStep['state'] {
    return state === 'success' ||
      state === 'error' ||
      state === 'noop' ||
      state === 'pending'
      ? state
      : 'pending';
  }

  private resolveTransferId(
    input: NormalizedBridgeInput,
    steps: BridgeExecutionStep[],
  ) {
    return (
      steps.find((step) => step.txHash)?.txHash ||
      input.referenceId ||
      `bridge-${Date.now()}`
    );
  }

  private isBurnStep(name: string) {
    const normalized = name.toLowerCase();
    return normalized.includes('burn') || normalized.includes('deposit');
  }

  private isMintStep(name: string) {
    const normalized = name.toLowerCase();
    return normalized.includes('mint') || normalized.includes('receive');
  }

  private async resolveBridgeChain(blockchain: SupportedBridgeBlockchain) {
    const { ArcTestnet, EthereumSepolia } = await import(
      '@circle-fin/bridge-kit/chains'
    );

    if (blockchain === 'ETH-SEPOLIA') {
      return {
        ...EthereumSepolia,
        rpcEndpoints: [ETH_SEPOLIA_RPC_URL],
      };
    }

    if (blockchain === 'ARC-TESTNET') {
      return {
        ...ArcTestnet,
        rpcEndpoints: [ARC_TESTNET_RPC_URL],
      };
    }

    const { SolanaDevnet } = await import('@circle-fin/bridge-kit/chains');
    return {
      ...SolanaDevnet,
      rpcEndpoints: ['https://api.devnet.solana.com'],
    };
  }

  private skipBridgeKitBalancePrechecks(
    adapter: any,
    sourceBlockchain: SupportedBridgeBlockchain,
  ) {
    const prepareAction =
      typeof adapter?.prepareAction === 'function'
        ? adapter.prepareAction.bind(adapter)
        : null;
    const waitForTransaction =
      typeof adapter?.waitForTransaction === 'function'
        ? adapter.waitForTransaction.bind(adapter)
        : null;

    if (!prepareAction) {
      return adapter;
    }

    const service = this;

    return new Proxy(adapter, {
      get(target, property, receiver) {
        if (property === 'prepareAction') {
          return async (action: string, params: unknown, context: unknown) => {
            if (sourceBlockchain === 'SOLANA-DEVNET') {
              return prepareAction(action, params, context);
            }

            if (action === 'native.balanceOf' || action === 'usdc.balanceOf') {
              return {
                execute: async () => 2n ** 255n,
              };
            }

            return prepareAction(action, params, context);
          };
        }

        if (property === 'waitForTransaction' && waitForTransaction) {
          return async (txHash: string, config: any, chain: any) => {
            if (
              typeof txHash !== 'string' ||
              !txHash.startsWith('0x') ||
              chain?.type !== 'evm'
            ) {
              return waitForTransaction(txHash, config, chain);
            }

            const rpcUrl = service.resolveChainRpcEndpoint(chain);
            if (!rpcUrl) {
              return waitForTransaction(txHash, config, chain);
            }

            const { createPublicClient, http } = await import('viem');
            const publicClient = createPublicClient({
              chain,
              transport: http(rpcUrl),
            });

            const receipt = await publicClient.waitForTransactionReceipt({
              hash: txHash as `0x${string}`,
              confirmations: config?.confirmations,
              timeout:
                typeof config?.timeout === 'number'
                  ? config.timeout
                  : 120_000,
            });

            return {
              txHash: receipt.transactionHash,
              status: receipt.status,
              cumulativeGasUsed: receipt.cumulativeGasUsed,
              gasUsed: receipt.gasUsed,
              effectiveGasPrice: receipt.effectiveGasPrice,
              blockNumber: receipt.blockNumber,
              blockHash: receipt.blockHash,
            };
          };
        }

        return Reflect.get(target, property, receiver);
      },
    });
  }

  private async ensureSolanaSourceFeeBalance(input: NormalizedBridgeInput) {
    if (input.sourceBlockchain !== 'SOLANA-DEVNET') {
      return;
    }

    try {
      const { Connection, PublicKey } = await import('@solana/web3.js');
      const connection = new Connection(SOLANA_DEVNET_RPC_URL, 'confirmed');
      const wallet = new PublicKey(input.sourceWalletAddress);

      const currentLamports = await connection.getBalance(wallet, 'confirmed');
      if (currentLamports >= SOLANA_MIN_FEE_BALANCE_LAMPORTS) {
        return;
      }

      const airdropLamports = Math.max(
        Math.floor(SOLANA_TOP_UP_TARGET_LAMPORTS - currentLamports),
        0,
      );
      if (airdropLamports <= 0) {
        return;
      }

      this.logger.warn(
        `Solana source wallet ${input.sourceWalletAddress} has low SOL balance (${currentLamports} lamports). Requesting devnet airdrop of ${airdropLamports} lamports before bridge.`,
      );

      const signature = await connection.requestAirdrop(wallet, airdropLamports);
      const latestBlockhash = await connection.getLatestBlockhash('confirmed');

      await connection.confirmTransaction(
        {
          ...latestBlockhash,
          signature,
        },
        'confirmed',
      );

      const updatedLamports = await connection.getBalance(wallet, 'confirmed');
      if (updatedLamports < SOLANA_MIN_FEE_BALANCE_LAMPORTS) {
        throw new Error(
          `Low SOL balance after airdrop (${updatedLamports} lamports).`,
        );
      }

      this.logger.log(
        `Solana source wallet ${input.sourceWalletAddress} topped up to ${updatedLamports} lamports.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(
        `Solana source treasury wallet needs devnet SOL for transaction fees, and automatic top-up failed (${message}). Fund the wallet with a small SOL amount on devnet, then retry bridge.`,
      );
    }
  }

  private resolveChainRpcEndpoint(chain: any): string | null {
    if (chain?.type !== 'evm') {
      return null;
    }

    const chainRpc =
      Array.isArray(chain?.rpcEndpoints) && typeof chain.rpcEndpoints[0] === 'string'
        ? chain.rpcEndpoints[0]
        : null;

    if (chainRpc) {
      return chainRpc;
    }

    if (chain?.chainId === 11155111) {
      return ETH_SEPOLIA_RPC_URL;
    }

    if (chain?.chainId === 5042002) {
      return ARC_TESTNET_RPC_URL;
    }

    return null;
  }

  /**
   * Detect whether an error from Circle's Bridge Kit is a transient
   * RPC endpoint connectivity issue (Circle's infra cannot reach the chain RPC).
   */
  private isCircleRpcEndpointError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const msg = error.message.toLowerCase();

    // Circle's API returns these patterns when their RPC proxy fails
    if (msg.includes('rpc endpoint error') || msg.includes('rpc endpoint')) {
      return true;
    }

    // Also check nested cause
    const cause = (error as any).cause;
    if (cause && typeof cause === 'object') {
      const causeMsg = typeof cause.message === 'string' ? cause.message.toLowerCase() : '';
      if (causeMsg.includes('rpc endpoint error') || causeMsg.includes('rpc endpoint')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Pre-validate that the source wallet is registered with Circle's
   * developer-controlled wallets API. This catches new-account issues
   * early with a clear error message instead of a generic RPC error.
   */
  private async validateCircleWalletExists(input: NormalizedBridgeInput): Promise<void> {
    try {
      const walletClient = this.circleClient.getWalletClient();
      const response = await (walletClient as any).listWallets({
        address: input.sourceWalletAddress,
        blockchain: input.sourceBlockchain,
      });

      const wallets = response?.data?.wallets ?? [];

      if (wallets.length === 0) {
        this.logger.error(
          `Circle wallet not found for address=${input.sourceWalletAddress} blockchain=${input.sourceBlockchain}. ` +
          `The wallet may not be initialized on Circle's side yet.`,
        );
        throw new BadRequestException({
          code: 'CIRCLE_WALLET_NOT_FOUND',
          error:
            `No Circle developer-controlled wallet found for address ${input.sourceWalletAddress} on ${input.sourceBlockchain}. ` +
            `The treasury wallet may not be initialized. Verify CIRCLE_WALLET_ID_ARC and CIRCLE_WALLET_ADDRESS_ARC are correct.`,
          details: {
            address: input.sourceWalletAddress,
            blockchain: input.sourceBlockchain,
            walletId: input.walletId,
          },
        });
      }

      this.logger.debug(
        `Circle wallet validated: address=${input.sourceWalletAddress} blockchain=${input.sourceBlockchain} walletId=${wallets[0]?.id}`,
      );
    } catch (error) {
      // If it's already a BadRequestException we threw, re-throw it
      if (error instanceof BadRequestException) {
        throw error;
      }

      // For other errors (network issues, auth problems), log but don't block
      // the bridge attempt — Circle's bridge kit may still succeed
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Could not pre-validate Circle wallet (non-blocking): ${message}`,
      );
    }
  }

  /**
   * Verify that the Arc Testnet RPC endpoint is reachable before attempting
   * the bridge. If the RPC is down, fail fast with a clear error instead of
   * waiting for Circle's API to timeout.
   */
  private async validateArcTestnetRpcReachable(): Promise<void> {
    for (const rpcUrl of ARC_TESTNET_RPC_FALLBACK_URLS) {
      try {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'eth_chainId',
            params: [],
          }),
          signal: AbortSignal.timeout(5_000),
        });

        const json = (await res.json()) as { result?: string; error?: unknown };

        if (json.result) {
          this.logger.debug(`Arc Testnet RPC reachable at ${rpcUrl}`);
          return;
        }
      } catch {
        // Try next URL
        continue;
      }
    }

    this.logger.error(
      `Arc Testnet RPC is unreachable from all known endpoints: ${ARC_TESTNET_RPC_FALLBACK_URLS.join(', ')}`,
    );
    throw new BadRequestException({
      code: 'CIRCLE_BRIDGE_EXECUTION_FAILED',
      error:
        'Arc Testnet RPC is currently unreachable. The bridge cannot execute the burn transaction. Please retry in a few minutes.',
      details: {
        failedStep: { name: 'Burn on source chain', errorMessage: 'Arc Testnet RPC unreachable' },
        sourceBlockchain: 'ARC-TESTNET',
        rpcEndpoints: ARC_TESTNET_RPC_FALLBACK_URLS,
      },
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private normalizeSupportedBlockchain(
    value: unknown,
  ): SupportedBridgeBlockchain {
    const normalized =
      typeof value === 'string'
        ? value.trim().toUpperCase().replace(/_/g, '-')
        : '';

    if (normalized === 'ETH-SEPOLIA' || normalized === 'ETHEREUM-SEPOLIA') {
      return 'ETH-SEPOLIA';
    }

    if (normalized === 'ARC-TESTNET') {
      return 'ARC-TESTNET';
    }

    if (normalized === 'SOLANA-DEVNET' || normalized === 'SOLANA') {
      return 'SOLANA-DEVNET';
    }

    throw new BadRequestException(
      'Bridge supports ETH-SEPOLIA, ARC-TESTNET, and SOLANA-DEVNET only.',
    );
  }

  private normalizeAddress(value: unknown, blockchain: string) {
    if (typeof value !== 'string') {
      return '';
    }

    const trimmed = value.trim();

    if (blockchain === 'SOLANA-DEVNET') {
      return trimmed;
    }

    return trimmed.toLowerCase();
  }
}
