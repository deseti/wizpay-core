import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
  type CreateContractExecutionTransactionInput,
  type CreateTransferTransactionInput,
  type FeeLevel,
  type TokenBlockchain,
} from '@circle-fin/developer-controlled-wallets';
import {
  CIRCLE_CONFIGURATION_ERROR_CODES,
  CircleConfigurationError,
  resolveCircleConfigurationFromService,
} from '../config/circle-execution.config';
import type { BackendArcNetworkConfiguration } from '../config/arc-network.config';
import { getAddress, isAddressEqual } from 'viem';

// ─── Types ──────────────────────────────────────────────────────────

export interface CircleTransferInput {
  /** Destination wallet address (0x...) */
  toAddress: string;
  /** Human-readable amount (e.g. "100.50") */
  amount: string;
  /** Token symbol (USDC, EURC) — mapped to on-chain tokenAddress internally */
  token: string;
  /** Target network. If present, it must match the selected Arc network. */
  network?: string;
  /** Circle wallet ID to send from. If present, it must match selected configuration. */
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

export interface CircleContractExecutionInput {
  walletId?: string;
  contractAddress: string;
  callData: `0x${string}`;
  network?: string;
  amount?: string;
  refId?: string;
  idempotencyKey?: string;
}

export interface CircleContractExecutionResult {
  txId: string;
  status: CircleTransactionStatus;
  txHash: string | null;
  raw: unknown;
}

export interface CircleTypedDataSignatureInput {
  walletId?: string;
  walletAddress?: string;
  blockchain?: string;
  typedData: Record<string, unknown>;
  memo?: string;
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
  blockchain: string | null;
  sourceAddress: string | null;
  destinationAddress: string | null;
  tokenAddress: string | null;
  amount: string | null;
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

type CircleTransferPayloadWithTokenBlockchain = Omit<
  CreateTransferTransactionInput,
  'blockchain'
> & {
  blockchain: TokenBlockchain;
};

export class CircleApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'CircleApiError';
  }
}

// ─── Constants ──────────────────────────────────────────────────────

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
 *     (`@circle-fin/developer-controlled-wallets`) with the selected network's
 *     scoped API credential and entity secret to sign and submit transfers from a
 *     backend-controlled treasury wallet.
 *  2. **StableFX** — REST calls for FX quotes and trades.
 *
 * API keys are held exclusively on the backend via ConfigService.
 */
@Injectable()
export class CircleService {
  private readonly logger = new Logger(CircleService.name);
  private walletClient: CircleDeveloperControlledWalletsClient | null = null;
  private readonly walletAddressCache = new Map<string, string>();

  constructor(private readonly configService: ConfigService) {}

  private get circleConfig() {
    return resolveCircleConfigurationFromService(
      this.configService,
      'developer-controlled',
    );
  }

  private get baseUrl() {
    return this.circleConfig.apiBaseUrl;
  }

  private get blockchain() {
    return this.circleConfig.blockchain;
  }

  // ── Config accessors ─────────────────────────────────────────────

  private get apiKey(): string {
    return this.circleConfig.apiKey;
  }

  private get entitySecret(): string {
    return this.circleConfig.entitySecret!;
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
    const wallet = response.data?.wallet;

    if (
      !walletAddress ||
      wallet?.blockchain !== this.blockchain ||
      wallet?.walletSetId !== this.circleConfig.walletSetId
    ) {
      throw new CircleConfigurationError(
        CIRCLE_CONFIGURATION_ERROR_CODES.WALLET_BLOCKCHAIN_MISMATCH,
        'Circle returned a wallet outside the selected network or wallet set.',
      );
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
        if (this.blockchain === 'ARC-TESTNET') return 'ARC-TESTNET';
        break;
      default:
        break;
    }
    throw new CircleConfigurationError(
      CIRCLE_CONFIGURATION_ERROR_CODES.CREDENTIAL_ENVIRONMENT_MISMATCH,
      'The requested Circle network does not match the selected Arc network.',
    );
  }

  // ── Idempotency key helpers ──────────────────────────────────────

  private isUuidFormat(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  private deriveUuidFromKey(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex');
    // Format as UUID v4 shape (variant bits set for determinism)
    return [
      hash.slice(0, 8),
      hash.slice(8, 12),
      '4' + hash.slice(13, 16),
      ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
      hash.slice(20, 32),
    ].join('-');
  }

  // ── Token resolution ─────────────────────────────────────────────

  private resolveTokenAddress(token: string, blockchain?: string): string {
    const chain = blockchain ?? this.blockchain;
    if (chain !== this.blockchain) {
      throw new CircleConfigurationError(
        CIRCLE_CONFIGURATION_ERROR_CODES.CREDENTIAL_ENVIRONMENT_MISMATCH,
        'The requested token network does not match the selected Arc network.',
      );
    }
    const arcNetwork =
      this.configService.getOrThrow<BackendArcNetworkConfiguration>(
        'arcNetwork',
      );
    const resource =
      arcNetwork.tokens[token.toUpperCase() as keyof typeof arcNetwork.tokens];
    if (!resource) {
      throw new Error(
        `Unsupported token "${token}" on the selected Arc network.`,
      );
    }
    return resource.address;
  }

  private resolveWalletId(requested?: string): string {
    const selected = this.circleConfig.walletId!;
    if (requested && requested !== selected) {
      throw new CircleConfigurationError(
        CIRCLE_CONFIGURATION_ERROR_CODES.WALLET_SET_MISMATCH,
        'The requested Circle wallet does not match selected configuration.',
      );
    }
    return selected;
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
    const walletId = this.resolveWalletId(input.walletId);
    const tokenAddress = this.resolveTokenAddress(input.token, blockchain);

    // Circle requires UUID v4 format for idempotency keys.
    // If the caller provides a non-UUID key, derive a deterministic UUID from it.
    const rawKey = input.idempotencyKey || randomUUID();
    const idempotencyKey = this.isUuidFormat(rawKey)
      ? rawKey
      : this.deriveUuidFromKey(rawKey);

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

    const payload: CircleTransferPayloadWithTokenBlockchain = {
      walletId,
      tokenAddress,
      blockchain,
      amount: [amountStr],
      destinationAddress: input.toAddress,
      fee: {
        type: 'level' as const,
        config: { feeLevel: this.feeLevel },
      },
      idempotencyKey,
      xRequestId: idempotencyKey,
    };

    this.logger.log(
      `Transfer — wallet=${walletId} to=${input.toAddress} amount=${amountStr} ${input.token} blockchain=${blockchain} tokenAddr=${tokenAddress} idempotencyKey=${idempotencyKey}`,
    );
    this.logger.debug(`Circle payload: ${JSON.stringify(payload)}`);

    const client = this.getWalletClient();

    const response = await client.createTransaction(
      payload as CreateTransferTransactionInput,
    );

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
  async executeContract(
    input: CircleContractExecutionInput,
  ): Promise<CircleContractExecutionResult> {
    const blockchain = this.resolveBlockchain(input.network);
    const walletId = this.resolveWalletId(input.walletId);
    const idempotencyKey = input.idempotencyKey || randomUUID();
    const client = this.getWalletClient();

    const payload: CreateContractExecutionTransactionInput = {
      walletId,
      contractAddress: input.contractAddress,
      callData: input.callData,
      ...(input.amount ? { amount: input.amount } : {}),
      ...(input.refId ? { refId: input.refId } : {}),
      fee: {
        type: 'level' as const,
        config: { feeLevel: this.feeLevel },
      },
      idempotencyKey,
      xRequestId: idempotencyKey,
    };

    this.logger.log(
      `Contract execution - wallet=${walletId} contract=${input.contractAddress} blockchain=${blockchain} idempotencyKey=${idempotencyKey}`,
    );

    const response = await client.createContractExecutionTransaction(payload);
    const tx = response.data;

    if (!tx?.id || !tx.state) {
      this.logger.error(
        `Circle createContractExecutionTransaction returned an empty response - wallet=${walletId} contract=${input.contractAddress}`,
      );
      throw new Error(
        'Circle did not return a transaction identifier. The contract execution may not have been created.',
      );
    }

    return {
      txId: tx.id,
      status: tx.state as CircleTransactionStatus,
      txHash: (tx as { txHash?: string }).txHash ?? null,
      raw: tx,
    };
  }

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
      blockchain: (tx as { blockchain?: string }).blockchain ?? null,
      sourceAddress:
        (tx as { sourceAddress?: string; from?: string }).sourceAddress ??
        (tx as { from?: string }).from ??
        null,
      destinationAddress:
        (tx as { destinationAddress?: string }).destinationAddress ?? null,
      tokenAddress: (tx as { tokenAddress?: string }).tokenAddress ?? null,
      amount: Array.isArray((tx as { amounts?: unknown }).amounts)
        ? String((tx as { amounts: unknown[] }).amounts[0] ?? '') || null
        : ((tx as { amount?: string }).amount ?? null),
    };
  }

  async signTypedData(
    input: CircleTypedDataSignatureInput,
  ): Promise<{ signature: string; raw: unknown }> {
    const circle = this.circleConfig;
    if (input.walletId && input.walletId !== circle.walletId) {
      throw new CircleConfigurationError(
        CIRCLE_CONFIGURATION_ERROR_CODES.WALLET_SET_MISMATCH,
        'The requested Circle wallet does not match selected configuration.',
      );
    }
    if (
      input.walletAddress &&
      (!circle.walletAddress ||
        !isAddressEqual(
          getAddress(input.walletAddress),
          getAddress(circle.walletAddress),
        ))
    ) {
      throw new CircleConfigurationError(
        CIRCLE_CONFIGURATION_ERROR_CODES.WALLET_BLOCKCHAIN_MISMATCH,
        'The requested Circle wallet address does not match selected configuration.',
      );
    }
    const client = this.getWalletClient();
    const blockchain = input.blockchain
      ? this.resolveBlockchain(input.blockchain)
      : undefined;
    const signer = input.walletId
      ? { walletId: input.walletId }
      : input.walletAddress && blockchain
        ? { walletAddress: input.walletAddress, blockchain }
        : null;

    if (!signer) {
      throw new Error(
        'Circle typed-data signing requires walletId or walletAddress plus blockchain.',
      );
    }

    const response = await client.signTypedData({
      ...signer,
      data: JSON.stringify(input.typedData),
      ...(input.memo ? { memo: input.memo } : {}),
    });
    const signature = response.data?.signature;

    if (!signature) {
      throw new Error('Circle did not return a typed-data signature.');
    }

    return {
      signature: signature.startsWith('0x') ? signature : `0x${signature}`,
      raw: response.data,
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
        if (
          status.status === 'FAILED' ||
          status.status === 'CANCELLED' ||
          status.status === 'DENIED'
        ) {
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

      if (res.status === 401 && path.includes('/stablefx/')) {
        throw new CircleApiError(
          res.status,
          'Circle StableFX RFQ is blocked by authorization or product entitlement. Verify the Bearer API key and StableFX access before retrying.',
          body,
        );
      }

      throw new CircleApiError(res.status, upstreamMessage, body);
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
      (response.data?.tokenBalances as unknown as CircleWalletBalance[]) ?? [];

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
