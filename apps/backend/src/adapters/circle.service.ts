import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
  type FeeLevel,
  type TokenBlockchain,
} from '@circle-fin/developer-controlled-wallets';

// ─── Types ──────────────────────────────────────────────────────────

export interface CircleTransferInput {
  /** Destination wallet address (0x...) */
  toAddress: string;
  /** Human-readable amount (e.g. "100.50") */
  amount: string;
  /** Token symbol (USDC, EURC) — mapped to on-chain tokenAddress internally */
  token: string;
  /** Target network (e.g. "arc_testnet", "sepolia"). Falls back to env default if omitted. */
  network?: string;
  /** Circle wallet ID to send from. Falls back to env default if omitted. */
  walletId?: string;
  /** Idempotency key. If omitted, a UUID is generated. */
  idempotencyKey?: string;
}

export interface CircleTransferResult {
  /** Circle transaction ID */
  txId: string;
  /** Current status from Circle */
  status: CircleTransactionStatus;
  /** On-chain tx hash (null until confirmed) */
  txHash: string | null;
}

export type CircleTransactionStatus =
  | 'INITIATED'
  | 'QUEUED'
  | 'PENDING_RISK_SCREENING'
  | 'SENT'
  | 'CONFIRMED'
  | 'COMPLETE'
  | 'FAILED'
  | 'CANCELLED'
  | 'DENIED';

export interface CircleTransactionStatusResult {
  txId: string;
  status: CircleTransactionStatus;
  txHash: string | null;
  blockNumber: string | null;
  errorReason: string | null;
}

export interface CircleFxQuoteRequest {
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmount: string;
  recipientAddress?: string;
}

export interface CircleFxQuote {
  quoteId: string;
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmount: string;
  targetAmount: string;
  exchangeRate: string;
  feeAmount: string;
  feeCurrency: string;
  expiresAt: string;
  provider: string;
  typedData?: Record<string, unknown>;
}

export interface CircleFxTradeRequest {
  quoteId: string;
  signature: string;
}

export interface CircleFxTrade {
  tradeId: string;
  quoteId: string;
  status: 'pending' | 'processing' | 'settled' | 'failed';
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmount: string;
  targetAmount: string;
  exchangeRate: string;
  createdAt: string;
  settledAt: string | null;
}

export interface CircleWalletBalance {
  amount: string;
  tokenAddress: string;
}

// ─── Constants ──────────────────────────────────────────────────────

/** On-chain token addresses per blockchain. Extend as new chains are added. */
const TOKEN_ADDRESS_MAP: Record<string, Record<string, string>> = {
  'ARC-TESTNET': {
    USDC: '0x3600000000000000000000000000000000000000',
    EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  },
  'ETH-SEPOLIA': {
    USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    EURC: '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4',
  },
};

const TERMINAL_STATUSES = new Set<string>([
  'COMPLETE',
  'FAILED',
  'CANCELLED',
  'DENIED',
]);

// ─── Service ────────────────────────────────────────────────────────

/**
 * CircleService provides access to Circle APIs for the backend agent layer.
 *
 * All Circle API interactions — transfers, StableFX quotes/trades, wallet
 * management — MUST go through this service. No agent or controller should
 * call the Circle API directly.
 *
 * Two integration modes:
 *  1. **Developer-controlled wallets** (primary) — uses the Circle SDK
 *     (`@circle-fin/developer-controlled-wallets`) with `CIRCLE_API_KEY` +
 *     `CIRCLE_ENTITY_SECRET` to sign and submit transfers from a
 *     backend-controlled treasury wallet.
 *  2. **StableFX** — REST calls for FX quotes and trades.
 *
 * API keys are held exclusively on the backend via ConfigService.
 */
@Injectable()
export class CircleService {
  private readonly logger = new Logger(CircleService.name);
  private readonly baseUrl: string;
  private readonly blockchain: string;
  private walletClient: CircleDeveloperControlledWalletsClient | null = null;
  private readonly walletAddressCache = new Map<string, string>();

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = (
      this.configService.get<string>('CIRCLE_WALLETS_BASE_URL') ||
      this.configService.get<string>('CIRCLE_BASE_URL') ||
      'https://api.circle.com'
    ).replace(/\/v1\/?$/, '').replace(/\/+$/, '');

    this.blockchain =
      this.configService.get<string>('CIRCLE_TRANSFER_BLOCKCHAIN') ||
      'ARC-TESTNET';

    // ── Startup env verification ──────────────────────────────────────
    const arcWalletId = this.configService.get<string>('CIRCLE_WALLET_ID_ARC');
    const sepoliaWalletId = this.configService.get<string>('CIRCLE_WALLET_ID_SEPOLIA');
    const apiKey = this.configService.get<string>('CIRCLE_API_KEY');
    const entitySecret = this.configService.get<string>('CIRCLE_ENTITY_SECRET');

    this.logger.log(
      `CircleService init — ` +
      `baseUrl=${this.baseUrl} ` +
      `blockchain=${this.blockchain} ` +
      `apiKeyConfigured=${apiKey ? 'yes' : 'no'} ` +
      `entitySecretConfigured=${entitySecret ? 'yes' : 'no'} ` +
      `arcWalletConfigured=${arcWalletId ? 'yes' : 'no'} ` +
      `sepoliaWalletConfigured=${sepoliaWalletId ? 'yes' : 'no'}`,
    );
  }

  // ── Config accessors ─────────────────────────────────────────────

  private get apiKey(): string {
    const key = this.configService.get<string>('CIRCLE_API_KEY');
    if (!key) {
      throw new Error(
        'CIRCLE_API_KEY is not configured. Set it in the backend environment.',
      );
    }
    return key;
  }

  private get entitySecret(): string {
    const secret = this.configService.get<string>('CIRCLE_ENTITY_SECRET');
    if (!secret) {
      throw new Error(
        'CIRCLE_ENTITY_SECRET is not configured. Set it in the backend environment.',
      );
    }
    return secret;
  }

  private getDefaultWalletId(blockchain: string): string {
    const walletId =
      blockchain === 'ETH-SEPOLIA'
        ? this.configService.get<string>('CIRCLE_WALLET_ID_SEPOLIA') ||
          this.configService.get<string>('CIRCLE_WALLET_ID')
        : this.configService.get<string>('CIRCLE_WALLET_ID_ARC') ||
          this.configService.get<string>('CIRCLE_WALLET_ID');

    if (!walletId) {
      throw new Error(
        `No Circle wallet is configured for ${blockchain}. ` +
          'Set the chain-specific wallet ID in the backend environment.',
      );
    }

    return walletId;
  }

  private get feeLevel(): FeeLevel {
    return (
      this.configService.get<string>('CIRCLE_TRANSFER_FEE_LEVEL') || 'MEDIUM'
    ).toUpperCase() as FeeLevel;
  }

  // ── SDK client (lazy-init, singleton) ────────────────────────────

  private getWalletClient(): CircleDeveloperControlledWalletsClient {
    if (this.walletClient) {
      return this.walletClient;
    }

    this.walletClient = initiateDeveloperControlledWalletsClient({
      apiKey: this.apiKey,
      entitySecret: this.entitySecret,
      baseUrl: this.baseUrl,
    });

    this.logger.log(
      `Circle wallet client initialized — baseUrl=${this.baseUrl} blockchain=${this.blockchain}`,
    );

    return this.walletClient;
  }

  private async getWalletAddress(walletId: string): Promise<string> {
    const cachedAddress = this.walletAddressCache.get(walletId);
    if (cachedAddress) {
      return cachedAddress;
    }

    const client = this.getWalletClient();
    const response = await client.getWallet({ id: walletId });
    const walletAddress = response.data?.wallet?.address;

    if (!walletAddress) {
      throw new Error(`Circle wallet ${walletId} did not return an address.`);
    }

    this.walletAddressCache.set(walletId, walletAddress);
    return walletAddress;
  }

  // ── Blockchain resolution ────────────────────────────────────────

  private resolveBlockchain(network?: string): TokenBlockchain {
    if (!network) {
      return this.blockchain as TokenBlockchain;
    }

    switch (network.toLowerCase()) {
      case 'arc_testnet':
      case 'arc-testnet':
        return 'ARC-TESTNET';
      case 'sepolia':
      case 'eth_sepolia':
      case 'eth-sepolia':
        return 'ETH-SEPOLIA';
      default:
        throw new Error(`Unsupported network: ${network}`);
    }
  }

  // ── Token resolution ─────────────────────────────────────────────

  private resolveTokenAddress(token: string, blockchain?: string): string {
    const chain = blockchain ?? this.blockchain;
    const chainMap = TOKEN_ADDRESS_MAP[chain];
    if (!chainMap) {
      throw new Error(
        `Unsupported blockchain: ${chain}. Add it to TOKEN_ADDRESS_MAP.`,
      );
    }

    const address = chainMap[token.toUpperCase()];
    if (!address) {
      throw new Error(
        `Unsupported token "${token}" on ${chain}. Available: ${Object.keys(chainMap).join(', ')}.`,
      );
    }

    return address;
  }

  // ════════════════════════════════════════════════════════════════════
  //  TRANSFERS — Developer-controlled wallets
  // ════════════════════════════════════════════════════════════════════

  /**
   * Execute a real transfer from the treasury wallet to a destination address.
   *
   * Uses the Circle Programmable Wallets SDK to create a transfer transaction
   * from a developer-controlled wallet. The SDK handles signing via the entity
   * secret — no private key management is needed on our side.
   *
   * Idempotent: if `input.idempotencyKey` is provided, Circle will de-duplicate
   * the request server-side with the same `xRequestId`.
   */
  async transfer(input: CircleTransferInput): Promise<CircleTransferResult> {
    const blockchain = this.resolveBlockchain(input.network);
    const walletId = input.walletId || this.getDefaultWalletId(blockchain);
    const tokenAddress = this.resolveTokenAddress(input.token, blockchain);
    const idempotencyKey = input.idempotencyKey || randomUUID();
    const walletAddress = await this.getWalletAddress(walletId);

    // ── Amount validation: must be a scalar string, never an array ────
    if (Array.isArray(input.amount)) {
      throw new Error(
        `amount must be a string, not an array. Received: ${JSON.stringify(input.amount)}`,
      );
    }
    const amountStr = String(input.amount);

    this.logger.debug(
      `Resolved blockchain: ${blockchain} for network: ${input.network ?? '(default)'}`,
    );

    // NOTE: The Circle SDK's createTransaction expects `amounts: string[]`
    // internally but we pass a single-element array since each transfer
    // targets one recipient. The SDK handles serialisation to the REST API.
    const payload = {
      walletAddress,
      blockchain,
      tokenAddress,
      amount: [amountStr],
      destinationAddress: input.toAddress,
      fee: {
        type: 'level' as const,
        config: { feeLevel: this.feeLevel },
      },
      xRequestId: idempotencyKey,
    };

    this.logger.log(
      `Transfer — wallet=${walletId} to=${input.toAddress} amount=${amountStr} ${input.token} blockchain=${blockchain} tokenAddr=${tokenAddress} idempotencyKey=${idempotencyKey}`,
    );
    this.logger.debug(`Circle payload: ${JSON.stringify(payload)}`);

    const client = this.getWalletClient();

    const response = await client.createTransaction(payload);

    const tx = response.data;

    if (!tx?.id || !tx.state) {
      this.logger.error(
        `Circle createTransaction returned an empty response — wallet=${walletId} to=${input.toAddress}`,
      );
      throw new Error(
        'Circle did not return a transaction identifier. The transfer may not have been created.',
      );
    }

    this.logger.log(
      `Transfer created — txId=${tx.id} state=${tx.state} wallet=${walletId} to=${input.toAddress}`,
    );

    return {
      txId: tx.id,
      status: tx.state as CircleTransactionStatus,
      txHash: (tx as { txHash?: string }).txHash ?? null,
    };
  }

  // ── Transaction status polling ───────────────────────────────────

  /**
   * Get the current status of a Circle transaction.
   *
   * Terminal states: COMPLETE, FAILED, CANCELLED, DENIED
   * Non-terminal: INITIATED, QUEUED, PENDING_RISK_SCREENING, SENT, CONFIRMED
   */
  async getTransactionStatus(
    txId: string,
  ): Promise<CircleTransactionStatusResult> {
    this.logger.debug(`getTransactionStatus — txId=${txId}`);

    const client = this.getWalletClient();

    const response = await client.getTransaction({
      id: txId,
      xRequestId: randomUUID(),
    });

    const tx = response.data?.transaction;

    if (!tx) {
      throw new Error(`Circle transaction ${txId} not found`);
    }

    return {
      txId: tx.id ?? txId,
      status: (tx.state ?? 'INITIATED') as CircleTransactionStatus,
      txHash: (tx as { txHash?: string }).txHash ?? null,
      blockNumber: (tx as { blockHeight?: string }).blockHeight ?? null,
      errorReason: (tx as { errorReason?: string }).errorReason ?? null,
    };
  }

  /**
   * Poll a Circle transaction until it reaches a terminal state.
   *
   * Returns the final status. Throws if the transaction fails or
   * does not complete within the timeout window.
   */
  async waitForTransactionComplete(
    txId: string,
    maxAttempts = 40,
    intervalMs = 2000,
  ): Promise<CircleTransactionStatusResult> {
    this.logger.log(
      `Polling transaction — txId=${txId} maxAttempts=${maxAttempts} intervalMs=${intervalMs}`,
    );

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const status = await this.getTransactionStatus(txId);

      if (TERMINAL_STATUSES.has(status.status)) {
        if (status.status === 'FAILED' || status.status === 'CANCELLED' || status.status === 'DENIED') {
          throw new Error(
            `Circle transaction ${txId} ended with status ${status.status}${status.errorReason ? `: ${status.errorReason}` : ''}`,
          );
        }

        this.logger.log(
          `Transaction complete — txId=${txId} status=${status.status} txHash=${status.txHash}`,
        );
        return status;
      }

      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    throw new Error(
      `Circle transaction ${txId} did not reach a terminal state within ${maxAttempts} polling attempts (${(maxAttempts * intervalMs) / 1000}s)`,
    );
  }

  // ════════════════════════════════════════════════════════════════════
  //  STABLEFX — FX quotes and trades
  // ════════════════════════════════════════════════════════════════════

  // ── Core HTTP helper (for StableFX REST API) ─────────────────────

  private async circleFetch<T = unknown>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...(options.headers as Record<string, string>),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new Error('Circle API request timed out after 15 seconds');
      }
      throw new Error(
        `Network error contacting Circle API: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = await res.text().catch(() => null);
      }

      const upstreamMessage =
        typeof body === 'object' && body !== null && 'message' in body
          ? String((body as Record<string, unknown>).message)
          : `Circle API returned ${res.status}`;

      this.logger.error(
        `Circle API error — status=${res.status} path=${path} message="${upstreamMessage}"`,
      );

      throw new Error(upstreamMessage);
    }

    return res.json() as Promise<T>;
  }

  // ── StableFX Quotes ──────────────────────────────────────────────

  async getQuote(params: CircleFxQuoteRequest): Promise<CircleFxQuote> {
    this.logger.log(
      `FX Quote — ${params.sourceCurrency} → ${params.targetCurrency} amount=${params.sourceAmount}`,
    );

    const isTradable = !!params.recipientAddress;

    const circleRes = await this.circleFetch<{
      id: string;
      rate: number;
      from: { currency: string; amount: string };
      to: { currency: string; amount: string };
      fee: string;
      expiresAt: string;
      createdAt: string;
      typedData?: Record<string, unknown>;
    }>('/v1/exchange/stablefx/quotes', {
      method: 'POST',
      body: JSON.stringify({
        from: { currency: params.sourceCurrency, amount: params.sourceAmount },
        to: { currency: params.targetCurrency },
        tenor: 'instant',
        type: isTradable ? 'tradable' : 'reference',
        ...(isTradable ? { recipientAddress: params.recipientAddress } : {}),
      }),
    });

    return {
      quoteId: circleRes.id,
      sourceCurrency: circleRes.from.currency,
      targetCurrency: circleRes.to.currency,
      sourceAmount: circleRes.from.amount,
      targetAmount: circleRes.to.amount,
      exchangeRate: String(circleRes.rate),
      feeAmount: circleRes.fee,
      feeCurrency: circleRes.to.currency,
      expiresAt: circleRes.expiresAt,
      provider: 'circle-stablefx',
      ...(circleRes.typedData ? { typedData: circleRes.typedData } : {}),
    };
  }

  // ── StableFX Trade Execution ─────────────────────────────────────

  async executeTrade(params: CircleFxTradeRequest): Promise<CircleFxTrade> {
    this.logger.log(`FX Trade — quoteId=${params.quoteId}`);

    const circleRes = await this.circleFetch<{
      id: string;
      quoteId: string;
      status: string;
      from: { currency: string; amount: string };
      to: { currency: string; amount: string };
      rate: number;
      fee: string;
      createdAt: string;
      settledAt?: string | null;
    }>('/v1/exchange/stablefx/trades', {
      method: 'POST',
      body: JSON.stringify({
        quoteId: params.quoteId,
        signature: params.signature,
      }),
    });

    return this.mapTrade(circleRes);
  }

  // ── StableFX Trade Status ────────────────────────────────────────

  async getTradeStatus(tradeId: string): Promise<CircleFxTrade> {
    this.logger.log(`FX Trade Status — tradeId=${tradeId}`);

    const circleRes = await this.circleFetch<{
      id: string;
      quoteId: string;
      status: string;
      from: { currency: string; amount: string };
      to: { currency: string; amount: string };
      rate: number;
      fee: string;
      createdAt: string;
      settledAt?: string | null;
    }>(`/v1/exchange/stablefx/trades/${encodeURIComponent(tradeId)}`);

    return this.mapTrade(circleRes);
  }

  // ── Wallet Balance ───────────────────────────────────────────────

  async getWalletBalance(
    walletId: string,
    tokenAddress?: string,
  ): Promise<CircleWalletBalance[]> {
    this.logger.log(
      `Wallet Balance — walletId=${walletId}${tokenAddress ? ` token=${tokenAddress}` : ''}`,
    );

    const client = this.getWalletClient();

    const response = await client.getWalletTokenBalance({
      id: walletId,
      ...(tokenAddress ? { tokenAddress } : {}),
    });

    const balances: CircleWalletBalance[] =
      ((response.data?.tokenBalances as unknown as CircleWalletBalance[]) ?? []);

    return balances;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private normalizeTradeStatus(
    raw: string,
  ): 'pending' | 'processing' | 'settled' | 'failed' {
    const s = raw.toLowerCase();
    if (s === 'settled' || s === 'complete' || s === 'completed')
      return 'settled';
    if (s === 'failed' || s === 'expired' || s === 'cancelled') return 'failed';
    if (s === 'processing' || s === 'executing') return 'processing';
    return 'pending';
  }

  private mapTrade(raw: {
    id: string;
    quoteId: string;
    status: string;
    from: { currency: string; amount: string };
    to: { currency: string; amount: string };
    rate: number;
    createdAt: string;
    settledAt?: string | null;
  }): CircleFxTrade {
    return {
      tradeId: raw.id,
      quoteId: raw.quoteId,
      status: this.normalizeTradeStatus(raw.status),
      sourceCurrency: raw.from.currency,
      targetCurrency: raw.to.currency,
      sourceAmount: raw.from.amount,
      targetAmount: raw.to.amount,
      exchangeRate: String(raw.rate),
      createdAt: raw.createdAt,
      settledAt: raw.settledAt ?? null,
    };
  }
}