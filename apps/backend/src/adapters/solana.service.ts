import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * SolanaService — Solana-specific blockchain operations.
 *
 * Extracted from BlockchainService to separate Solana concerns from
 * EVM logic. BlockchainService delegates all Solana methods here.
 * Callers that only need Solana operations can inject this directly.
 */
@Injectable()
export class SolanaService {
  private readonly logger = new Logger(SolanaService.name);

  constructor(private readonly configService: ConfigService) {}

  // ── RPC endpoint ─────────────────────────────────────────────────

  getSolanaRpcUrl(): string {
    return (
      this.configService.get<string>('SOLANA_RPC_URL') ||
      'https://api.devnet.solana.com'
    );
  }

  // ── Balance ──────────────────────────────────────────────────────

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

  // ── Transaction broadcast ─────────────────────────────────────────

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

  // ── Transfer intent builder ───────────────────────────────────────

  /**
   * Build an unsigned Solana SPL-token (USDC) transfer payload.
   *
   * The backend cannot sign Solana transactions on behalf of a passkey
   * wallet (the private key lives in the user's hardware). This helper
   * returns the structured intent so the frontend can construct and sign
   * the UserOperation / transaction before calling broadcastSolanaTransaction.
   *
   * @param from        - sender's base58 public key
   * @param to          - recipient's base58 public key
   * @param amount      - human-readable token amount (e.g. "10.5")
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
