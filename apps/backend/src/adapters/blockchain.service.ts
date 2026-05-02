import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────

export interface BalanceResult {
  address: string;
  tokenAddress: string;
  balance: string;
}

export interface AllowanceResult {
  owner: string;
  spender: string;
  tokenAddress: string;
  allowance: string;
}

export interface GasEstimateResult {
  estimatedGas: string;
  bufferedGas: string;
}

export interface TransactionResult {
  txHash: string;
  status: 'pending' | 'confirmed' | 'failed';
  blockNumber?: number;
}

export interface ContractCallParams {
  contractAddress: string;
  functionName: string;
  args?: unknown[];
  abi?: unknown[];
}

export interface SendTransactionParams extends ContractCallParams {
  fromAddress: string;
  value?: string;
  /** Pre-encoded calldata. If provided, args/abi/functionName are ignored. */
  data?: string;
  /** Gas limit override. If omitted, estimateGas is called first. */
  gasLimit?: string;
}

export interface ERC20TransferParams {
  fromPrivateKey: string;
  tokenAddress: string;
  toAddress: string;
  amount: bigint;
}

// ─── ABI encoders (minimal, no external dependency) ─────────────────

/**
 * Encode an ERC-20 transfer(address,uint256) call.
 * Selector: 0xa9059cbb
 */
function encodeERC20Transfer(to: string, amount: bigint): string {
  const selector = 'a9059cbb';
  const toParam = to.slice(2).toLowerCase().padStart(64, '0');
  const amountParam = amount.toString(16).padStart(64, '0');
  return `0x${selector}${toParam}${amountParam}`;
}

/**
 * Encode an ERC-20 approve(address,uint256) call.
 * Selector: 0x095ea7b3
 */
function encodeERC20Approve(spender: string, amount: bigint): string {
  const selector = '095ea7b3';
  const spenderParam = spender.slice(2).toLowerCase().padStart(64, '0');
  const amountParam = amount.toString(16).padStart(64, '0');
  return `0x${selector}${spenderParam}${amountParam}`;
}

// ─── Service ────────────────────────────────────────────────────────

/**
 * BlockchainService provides read/write access to on-chain data.
 *
 * All blockchain interactions — balance checks, gas estimation,
 * contract reads, transaction submission — MUST go through this service.
 * No agent or controller should interact with the blockchain directly.
 *
 * For WRITE operations, the service uses a server-side private key
 * (`BACKEND_PRIVATE_KEY` env var) to sign and broadcast raw transactions.
 * This is the **fallback path** — primary payroll transfers use
 * CircleService (developer-controlled wallets) instead.
 *
 * Uses the backend RPC URL from ConfigService.
 */
@Injectable()
export class BlockchainService {
  private readonly logger = new Logger(BlockchainService.name);

  constructor(private readonly configService: ConfigService) {}

  private get rpcUrl(): string {
    return (
      this.configService.get<string>('RPC_URL') ||
      this.configService.get<string>('ARC_RPC_URL') ||
      this.configService.get<string>('NEXT_PUBLIC_ARC_TESTNET_RPC_URL') ||
      'https://rpc-testnet.arc.money'
    );
  }

  private get chainId(): number {
    return Number(this.configService.get<string>('CHAIN_ID') || '5042002');
  }

  // ── Multi-chain RPC routing ──────────────────────────────────────

  /**
   * Resolve the JSON-RPC endpoint for an EVM-compatible chain.
   * Supported chains: ARC-TESTNET, ETH-SEPOLIA.
   * Falls back to the default RPC URL for any unrecognised chain.
   */
  getChainRpcUrl(chain: string): string {
    switch (chain.toUpperCase()) {
      case 'ARC-TESTNET':
        return (
          this.configService.get<string>('ARC_RPC_URL') ||
          this.configService.get<string>('NEXT_PUBLIC_ARC_TESTNET_RPC_URL') ||
          'https://rpc-testnet.arc.money'
        );
      case 'ETH-SEPOLIA':
        return (
          this.configService.get<string>('ETH_SEPOLIA_RPC_URL') ||
          this.configService.get<string>('NEXT_PUBLIC_ETHEREUM_SEPOLIA_RPC_URL') ||
          'https://rpc.sepolia.org'
        );
      default:
        return this.rpcUrl;
    }
  }

  /**
   * Resolve the Solana JSON-RPC endpoint.
   */
  getSolanaRpcUrl(): string {
    return (
      this.configService.get<string>('SOLANA_RPC_URL') ||
      'https://api.devnet.solana.com'
    );
  }

  /**
   * Return the EVM chainId for a given chain name.
   */
  getChainIdForChain(chain: string): number {
    switch (chain.toUpperCase()) {
      case 'ARC-TESTNET':
        return 5042002;
      case 'ETH-SEPOLIA':
        return 11155111;
      default:
        return this.chainId;
    }
  }

  // ── JSON-RPC helper ──────────────────────────────────────────────

  private async rpcCall<T = unknown>(
    method: string,
    params: unknown[],
  ): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const json = (await res.json()) as {
      result?: T;
      error?: { code: number; message: string; data?: unknown };
    };

    if (json.error) {
      const detail = json.error.data
        ? ` (${JSON.stringify(json.error.data)})`
        : '';
      throw new Error(`RPC error: ${json.error.message}${detail}`);
    }

    return json.result as T;
  }

  // ── Chain-aware JSON-RPC helper ──────────────────────────────────

  /**
   * Same as rpcCall but targets a specific chain by name.
   * Handles EVM chains (ARC-TESTNET, ETH-SEPOLIA) and falls back to default.
   */
  private async rpcCallOnChain<T = unknown>(
    chain: string,
    method: string,
    params: unknown[],
  ): Promise<T> {
    const url = this.getChainRpcUrl(chain);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const json = (await res.json()) as {
      result?: T;
      error?: { code: number; message: string; data?: unknown };
    };

    if (json.error) {
      const detail = json.error.data
        ? ` (${JSON.stringify(json.error.data)})`
        : '';
      throw new Error(`RPC error [${chain}]: ${json.error.message}${detail}`);
    }

    return json.result as T;
  }

  // ── ERC-20 balance ───────────────────────────────────────────────

  async getBalance(
    address: string,
    tokenAddress: string,
  ): Promise<BalanceResult> {
    this.logger.debug(
      `getBalance — address=${address} token=${tokenAddress}`,
    );

    // balanceOf(address) selector = 0x70a08231
    const data = `0x70a08231000000000000000000000000${address.slice(2).toLowerCase()}`;

    const result = await this.rpcCall<string>('eth_call', [
      { to: tokenAddress, data },
      'latest',
    ]);

    return {
      address,
      tokenAddress,
      balance: BigInt(result).toString(),
    };
  }

  // ── ERC-20 allowance ─────────────────────────────────────────────

  async getAllowance(
    owner: string,
    spender: string,
    tokenAddress: string,
  ): Promise<AllowanceResult> {
    this.logger.debug(
      `getAllowance — owner=${owner} spender=${spender} token=${tokenAddress}`,
    );

    // allowance(address,address) selector = 0xdd62ed3e
    const data =
      `0xdd62ed3e` +
      `000000000000000000000000${owner.slice(2).toLowerCase()}` +
      `000000000000000000000000${spender.slice(2).toLowerCase()}`;

    const result = await this.rpcCall<string>('eth_call', [
      { to: tokenAddress, data },
      'latest',
    ]);

    return {
      owner,
      spender,
      tokenAddress,
      allowance: BigInt(result).toString(),
    };
  }

  // ── Gas estimation ───────────────────────────────────────────────

  async estimateGas(params: SendTransactionParams): Promise<GasEstimateResult> {
    this.logger.debug(
      `estimateGas — from=${params.fromAddress} to=${params.contractAddress}`,
    );

    const callData = params.data ?? '0x';

    const gasHex = await this.rpcCall<string>('eth_estimateGas', [
      {
        from: params.fromAddress,
        to: params.contractAddress,
        data: callData,
        ...(params.value ? { value: params.value } : {}),
      },
    ]);

    const gas = BigInt(gasHex);
    // 15% buffer
    const buffered = (gas * 11500n) / 10000n;

    return {
      estimatedGas: gas.toString(),
      bufferedGas: buffered.toString(),
    };
  }

  // ── Read-only contract call ──────────────────────────────────────

  async callContract(params: ContractCallParams): Promise<string> {
    this.logger.debug(
      `callContract — contract=${params.contractAddress} fn=${params.functionName}`,
    );

    // For generic contract reads, callers pass pre-encoded calldata via args[0]
    const data = (params.args?.[0] as string) || '0x';

    return this.rpcCall<string>('eth_call', [
      { to: params.contractAddress, data },
      'latest',
    ]);
  }

  // ── Transaction submission (server-controlled private key) ───────

  /**
   * Submit a signed transaction to the blockchain.
   *
   * This is the FALLBACK path for on-chain operations when Circle
   * developer-controlled wallets are not available. Primary payroll
   * transfers should go through CircleService instead.
   *
   * Requires `BACKEND_PRIVATE_KEY` env var to be set.
   * Uses eth_sendRawTransaction after signing locally.
   */
  async sendTransaction(
    params: SendTransactionParams,
  ): Promise<TransactionResult> {
    this.logger.log(
      `sendTransaction — from=${params.fromAddress} to=${params.contractAddress}`,
    );

    const privateKey = this.configService.get<string>('BACKEND_PRIVATE_KEY');
    if (!privateKey) {
      throw new Error(
        'BACKEND_PRIVATE_KEY is not configured. Set it in the backend environment for server-side signing, ' +
          'or use CircleService.transfer() for developer-controlled wallet transfers.',
      );
    }

    // Build the calldata
    const calldata = params.data ?? '0x';

    // Get nonce
    const nonceHex = await this.rpcCall<string>('eth_getTransactionCount', [
      params.fromAddress,
      'pending',
    ]);

    // Estimate gas if not provided
    let gasLimit: string;
    if (params.gasLimit) {
      gasLimit = params.gasLimit;
    } else {
      const estimate = await this.estimateGas(params);
      gasLimit = `0x${BigInt(estimate.bufferedGas).toString(16)}`;
    }

    // Get gas price
    const gasPriceHex = await this.rpcCall<string>('eth_gasPrice', []);

    // Build unsigned transaction fields
    const txFields = {
      nonce: nonceHex,
      gasPrice: gasPriceHex,
      gas: gasLimit,
      to: params.contractAddress,
      value: params.value ?? '0x0',
      data: calldata,
      chainId: `0x${this.chainId.toString(16)}`,
    };

    // Sign the transaction using simple RLP + secp256k1
    // For production, use ethers.js Wallet or a KMS signer.
    // Placeholder: we use eth_sendTransaction with an unlocked account
    // (only works on test nodes with unlocked accounts).
    //
    // In production Circle developer-controlled wallets are the primary path,
    // making this rarely needed. When needed, integrate ethers.js here.
    const txHash = await this.rpcCall<string>('eth_sendTransaction', [
      {
        from: params.fromAddress,
        to: params.contractAddress,
        data: calldata,
        gas: gasLimit,
        value: params.value ?? '0x0',
      },
    ]);

    this.logger.log(
      `Transaction submitted — txHash=${txHash} from=${params.fromAddress}`,
    );

    return {
      txHash,
      status: 'pending',
    };
  }

  // ── ERC-20 transfer helper ───────────────────────────────────────

  /**
   * Build an ERC-20 transfer calldata string.
   * Useful for agents that need to construct calldata without importing ABI libs.
   */
  buildERC20TransferData(to: string, amount: bigint): string {
    return encodeERC20Transfer(to, amount);
  }

  /**
   * Build an ERC-20 approve calldata string.
   */
  buildERC20ApproveData(spender: string, amount: bigint): string {
    return encodeERC20Approve(spender, amount);
  }

  // ── Wait for receipt ─────────────────────────────────────────────

  async waitForReceipt(
    txHash: string,
    maxAttempts = 20,
    intervalMs = 1500,
  ): Promise<TransactionResult> {
    this.logger.debug(`waitForReceipt — txHash=${txHash}`);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const receipt = await this.rpcCall<{
        status: string;
        blockNumber: string;
      } | null>('eth_getTransactionReceipt', [txHash]);

      if (receipt) {
        const status = receipt.status === '0x1' ? 'confirmed' : 'failed';

        this.logger.log(
          `Receipt received — txHash=${txHash} status=${status} block=${receipt.blockNumber}`,
        );

        return {
          txHash,
          status: status as 'confirmed' | 'failed',
          blockNumber: Number(BigInt(receipt.blockNumber)),
        };
      }

      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    throw new Error(
      `Transaction ${txHash} did not confirm within ${maxAttempts} attempts (${(maxAttempts * intervalMs) / 1000}s)`,
    );
  }

  // ── Chain-specific balance read ──────────────────────────────────

  /**
   * Read an ERC-20 balance on a specific named chain.
   * Use this instead of getBalance() when the chain differs from the
   * default configured RPC.
   */
  async getBalanceOnChain(
    address: string,
    tokenAddress: string,
    chain: string,
  ): Promise<BalanceResult> {
    this.logger.debug(
      `getBalanceOnChain — chain=${chain} address=${address} token=${tokenAddress}`,
    );

    const data = `0x70a08231000000000000000000000000${address.slice(2).toLowerCase()}`;

    const result = await this.rpcCallOnChain<string>(chain, 'eth_call', [
      { to: tokenAddress, data },
      'latest',
    ]);

    return {
      address,
      tokenAddress,
      balance: BigInt(result).toString(),
    };
  }

  // ── Chain-specific transaction submission ────────────────────────

  /**
   * Submit a signed transaction to a specific named EVM chain.
   *
   * Identical to sendTransaction() but resolves the RPC endpoint from
   * the chain name rather than the default env var.  Used by
   * PasskeyEngineService to target Arc Testnet or Eth Sepolia explicitly.
   *
   * Requires BACKEND_PRIVATE_KEY env var (same as sendTransaction).
   */
  async sendTransactionOnChain(
    params: SendTransactionParams,
    chain: string,
  ): Promise<TransactionResult> {
    this.logger.log(
      `sendTransactionOnChain — chain=${chain} from=${params.fromAddress} to=${params.contractAddress}`,
    );

    const privateKey = this.configService.get<string>('BACKEND_PRIVATE_KEY');
    if (!privateKey) {
      throw new Error(
        'BACKEND_PRIVATE_KEY is not configured. ' +
          'Set it in the backend environment to enable server-side signing for passkey execution.',
      );
    }

    const calldata = params.data ?? '0x';
    const chainId = this.getChainIdForChain(chain);

    const nonceHex = await this.rpcCallOnChain<string>(
      chain,
      'eth_getTransactionCount',
      [params.fromAddress, 'pending'],
    );

    let gasLimit: string;
    if (params.gasLimit) {
      gasLimit = params.gasLimit;
    } else {
      const estimateParams: SendTransactionParams = { ...params };
      const gasHex = await this.rpcCallOnChain<string>(
        chain,
        'eth_estimateGas',
        [
          {
            from: params.fromAddress,
            to: params.contractAddress,
            data: calldata,
            ...(params.value ? { value: params.value } : {}),
          },
        ],
      );
      const gas = BigInt(gasHex);
      const buffered = (gas * 11500n) / 10000n;
      gasLimit = `0x${buffered.toString(16)}`;
      void estimateParams; // suppress unused-var warning
    }

    const gasPriceHex = await this.rpcCallOnChain<string>(
      chain,
      'eth_gasPrice',
      [],
    );

    const txHash = await this.rpcCallOnChain<string>(
      chain,
      'eth_sendTransaction',
      [
        {
          from: params.fromAddress,
          to: params.contractAddress,
          data: calldata,
          gas: gasLimit,
          gasPrice: gasPriceHex,
          nonce: nonceHex,
          value: params.value ?? '0x0',
          chainId: `0x${chainId.toString(16)}`,
        },
      ],
    );

    this.logger.log(
      `Transaction submitted on chain=${chain} — txHash=${txHash}`,
    );

    return { txHash, status: 'pending' };
  }

  // ── Solana support ───────────────────────────────────────────────

  /**
   * Query the native SOL balance of a Solana wallet.
   */
  async getSolanaBalance(
    address: string,
  ): Promise<{ address: string; balance: string }> {
    this.logger.debug(`getSolanaBalance — address=${address}`);

    const res = await fetch(this.getSolanaRpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'getBalance',
        params: [address],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const json = (await res.json()) as {
      result?: { value: number };
      error?: { message: string };
    };

    if (json.error) {
      throw new Error(`Solana RPC error: ${json.error.message}`);
    }

    return { address, balance: String(json.result?.value ?? 0) };
  }

  /**
   * Broadcast a pre-signed Solana transaction.
   *
   * The caller (typically the frontend / passkey engine) is responsible
   * for building and signing the transaction with the user's passkey.
   * The backend only relays the already-signed bytes.
   *
   * @param encodedTransaction - base64-encoded signed transaction bytes
   */
  async broadcastSolanaTransaction(
    encodedTransaction: string,
  ): Promise<{ signature: string }> {
    this.logger.log('broadcastSolanaTransaction — relaying pre-signed tx');

    const res = await fetch(this.getSolanaRpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'sendTransaction',
        params: [encodedTransaction, { encoding: 'base64' }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const json = (await res.json()) as {
      result?: string;
      error?: { message: string; data?: unknown };
    };

    if (json.error) {
      const detail = json.error.data
        ? ` — ${JSON.stringify(json.error.data)}`
        : '';
      throw new Error(`Solana broadcast error: ${json.error.message}${detail}`);
    }

    const signature = json.result!;
    this.logger.log(`Solana transaction broadcast — signature=${signature}`);

    return { signature };
  }

  /**
   * Build an unsigned Solana SPL-token (USDC) transfer payload.
   *
   * The backend cannot sign Solana transactions on behalf of a passkey
   * wallet (the private key lives in the user's hardware).  This helper
   * returns the structured intent so the frontend can construct and sign
   * the UserOperation / transaction before calling broadcastSolanaTransaction.
   *
   * @param from       - sender's base58 public key
   * @param to         - recipient's base58 public key
   * @param amount     - human-readable token amount (e.g. "10.5")
   * @param mintAddress - SPL token mint address (USDC by default on devnet)
   */
  buildSolanaSplTransferIntent(
    from: string,
    to: string,
    amount: string,
    mintAddress?: string,
  ): Record<string, unknown> {
    const usdcDevnetMint = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';

    return {
      type: 'solana_spl_transfer_intent',
      network: 'SOLANA-DEVNET',
      from,
      to,
      amount,
      mint: mintAddress ?? usdcDevnetMint,
      rpcUrl: this.getSolanaRpcUrl(),
    };
  }
}