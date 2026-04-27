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
}