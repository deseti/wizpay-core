import { randomUUID } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import type {
  Blockchain,
  CircleDeveloperControlledWalletsClient,
  CreateTransferTransactionInput,
  FeeLevel,
  TokenBlockchain,
  Transaction,
  Wallet,
} from "@circle-fin/developer-controlled-wallets";
import { env } from "../config/env.js";

export interface CircleTransferWalletBalance {
  amount: string;
  symbol: string | null;
  tokenAddress: string;
  updatedAt: string;
}

export interface CircleTransferWallet {
  walletSetId: string | null;
  walletId: string | null;
  walletAddress: string;
  blockchain: string;
  tokenAddress: string;
  balance: CircleTransferWalletBalance | null;
}

export interface BootstrapCircleTransferWalletInput {
  walletSetId?: string;
  walletSetName?: string;
  walletName?: string;
  refId?: string;
}

export interface CreateCircleTransferInput {
  destinationAddress: string;
  amount: string;
  referenceId?: string;
  tokenAddress?: string;
  walletId?: string;
  walletAddress?: string;
  blockchain?: string;
}

export interface CircleTransferRecord {
  transferId: string;
  status: "pending" | "processing" | "settled" | "failed";
  rawStatus: string;
  txHash: string | null;
  walletId: string | null;
  walletAddress: string | null;
  sourceAddress: string | null;
  destinationAddress: string | null;
  amount: string;
  tokenAddress: string;
  blockchain: string;
  referenceId: string;
  createdAt: string;
  updatedAt: string;
  errorReason: string | null;
}

interface ResolvedWalletConfig {
  walletSetId: string | null;
  walletId: string | null;
  walletAddress: string;
  blockchain: string;
}

interface StoredTransferMetadata {
  amount: string;
  blockchain: string;
  destinationAddress: string;
  referenceId: string;
  tokenAddress: string;
  walletAddress: string;
  walletId: string | null;
}

export class CircleTransferError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details?: string
  ) {
    super(message);
    this.name = "CircleTransferError";
  }
}

const transferMetadata = new Map<string, StoredTransferMetadata>();
let circleWalletClient: CircleDeveloperControlledWalletsClient | null = null;

const DEFAULT_WALLET_SET_NAME = "WizPay ARC Transfer Wallet Set";
const DEFAULT_WALLET_NAME = "WizPay ARC Treasury Wallet";

export async function getTransferWallet(): Promise<CircleTransferWallet> {
  const resolvedWallet = await resolveWalletConfig();

  return {
    walletSetId: resolvedWallet.walletSetId,
    walletId: resolvedWallet.walletId,
    walletAddress: resolvedWallet.walletAddress,
    blockchain: resolvedWallet.blockchain,
    tokenAddress: env.circleTransferTokenAddress,
    balance: await getWalletBalance(resolvedWallet.walletId),
  };
}

export async function bootstrapTransferWallet(
  input: BootstrapCircleTransferWalletInput = {}
): Promise<CircleTransferWallet> {
  const client = getCircleWalletClient();
  const blockchain = env.circleTransferBlockchain as Blockchain;

  const walletSetId =
    input.walletSetId || env.circleWalletSetId || (await createWalletSet(client, input.walletSetName));

  const walletResponse = await wrapCircleCall(
    async () =>
      client.createWallets({
        blockchains: [blockchain],
        count: 1,
        walletSetId,
        metadata: [
          {
            name: input.walletName || DEFAULT_WALLET_NAME,
            refId: input.refId,
          },
        ],
        xRequestId: randomUUID(),
      }),
    "Failed to create an ARC developer-controlled wallet."
  );

  const wallet = walletResponse.data?.wallets?.[0];

  if (!wallet) {
    throw new CircleTransferError(
      "Circle did not return the created wallet.",
      502,
      "CIRCLE_EMPTY_WALLET_RESPONSE"
    );
  }

  return {
    walletSetId,
    walletId: wallet.id,
    walletAddress: wallet.address,
    blockchain: String(wallet.blockchain),
    tokenAddress: env.circleTransferTokenAddress,
    balance: await getWalletBalance(wallet.id),
  };
}

export async function createCircleTransfer(
  input: CreateCircleTransferInput
): Promise<CircleTransferRecord> {
  const client = getCircleWalletClient();
  const normalizedAmount = normalizeAmount(input.amount);
  const walletBlockchain =
    (input.blockchain || env.circleTransferBlockchain) as Blockchain;
  const transferBlockchain =
    (input.blockchain || env.circleTransferBlockchain) as TokenBlockchain;
  const feeLevel = env.circleTransferFeeLevel as FeeLevel;
  const tokenAddress = input.tokenAddress || env.circleTransferTokenAddress;
  const resolvedWallet = await resolveWalletConfig({
    walletId: input.walletId,
    walletAddress: input.walletAddress,
    blockchain: String(walletBlockchain),
  });
  const requestId = randomUUID();

  const request: CreateTransferTransactionInput = resolvedWallet.walletId
    ? {
        walletId: resolvedWallet.walletId,
        tokenAddress,
        amount: [normalizedAmount],
        destinationAddress: input.destinationAddress,
        refId: input.referenceId,
        fee: {
          type: "level",
          config: {
            feeLevel,
          },
        },
        xRequestId: requestId,
      }
    : {
        walletAddress: resolvedWallet.walletAddress,
        blockchain: transferBlockchain,
        tokenAddress,
        amount: [normalizedAmount],
        destinationAddress: input.destinationAddress,
        refId: input.referenceId,
        fee: {
          type: "level",
          config: {
            feeLevel,
          },
        },
        xRequestId: requestId,
      };

  const response = await wrapCircleCall(
    async () => client.createTransaction(request),
    "Failed to create the Circle transfer transaction."
  );

  const createdTransfer = response.data;

  if (!createdTransfer?.id || !createdTransfer.state) {
    throw new CircleTransferError(
      "Circle did not return a transfer identifier.",
      502,
      "CIRCLE_EMPTY_TRANSFER_RESPONSE"
    );
  }

  const timestamp = new Date().toISOString();

  transferMetadata.set(createdTransfer.id, {
    amount: normalizedAmount,
    blockchain: String(transferBlockchain),
    destinationAddress: input.destinationAddress,
    referenceId: input.referenceId || "",
    tokenAddress,
    walletAddress: resolvedWallet.walletAddress,
    walletId: resolvedWallet.walletId,
  });

  return {
    transferId: createdTransfer.id,
    status: normalizeTransactionState(createdTransfer.state),
    rawStatus: createdTransfer.state,
    txHash: null,
    walletId: resolvedWallet.walletId,
    walletAddress: resolvedWallet.walletAddress,
    sourceAddress: resolvedWallet.walletAddress,
    destinationAddress: input.destinationAddress,
    amount: normalizedAmount,
    tokenAddress,
    blockchain: String(transferBlockchain),
    referenceId: input.referenceId || "",
    createdAt: timestamp,
    updatedAt: timestamp,
    errorReason: null,
  };
}

export async function getCircleTransferStatus(
  transferId: string
): Promise<CircleTransferRecord> {
  const client = getCircleWalletClient();
  const response = await wrapCircleCall(
    async () =>
      client.getTransaction({
        id: transferId,
        xRequestId: randomUUID(),
      }),
    `Failed to load Circle transfer ${transferId}.`
  );

  const transaction = response.data?.transaction;

  if (!transaction) {
    throw new CircleTransferError(
      `Circle transfer ${transferId} was not found.`,
      404,
      "CIRCLE_TRANSFER_NOT_FOUND"
    );
  }

  return mapTransactionToTransferRecord(transaction);
}

function getCircleWalletClient(): CircleDeveloperControlledWalletsClient {
  if (circleWalletClient) {
    return circleWalletClient;
  }

  if (!env.circleApiKey) {
    throw new CircleTransferError(
      "CIRCLE_API_KEY is not configured for Circle developer-controlled wallets.",
      503,
      "CIRCLE_API_KEY_MISSING"
    );
  }

  if (!env.circleEntitySecret) {
    throw new CircleTransferError(
      "CIRCLE_ENTITY_SECRET is not configured for Circle developer-controlled wallets.",
      503,
      "CIRCLE_ENTITY_SECRET_MISSING"
    );
  }

  circleWalletClient = initiateDeveloperControlledWalletsClient({
    apiKey: env.circleApiKey,
    entitySecret: env.circleEntitySecret,
    baseUrl: env.circleWalletsBaseUrl,
  });

  return circleWalletClient;
}

async function createWalletSet(
  client: CircleDeveloperControlledWalletsClient,
  walletSetName?: string
): Promise<string> {
  const response = await wrapCircleCall(
    async () =>
      client.createWalletSet({
        name: walletSetName || DEFAULT_WALLET_SET_NAME,
        xRequestId: randomUUID(),
      }),
    "Failed to create a Circle wallet set."
  );

  const walletSetId = response.data?.walletSet?.id;

  if (!walletSetId) {
    throw new CircleTransferError(
      "Circle did not return the created wallet set identifier.",
      502,
      "CIRCLE_EMPTY_WALLET_SET_RESPONSE"
    );
  }

  return walletSetId;
}

async function resolveWalletConfig(
  overrides: {
    walletId?: string;
    walletAddress?: string;
    blockchain?: string;
  } = {}
): Promise<ResolvedWalletConfig> {
  const client = getCircleWalletClient();
  const requestedWalletId = overrides.walletId || env.circleWalletId;
  const requestedWalletAddress = overrides.walletAddress || env.circleWalletAddress;
  const blockchain = overrides.blockchain || env.circleTransferBlockchain;

  if (requestedWalletId) {
    const wallet = await getWalletById(client, requestedWalletId);

    return {
      walletSetId: wallet.walletSetId,
      walletId: wallet.id,
      walletAddress: wallet.address,
      blockchain: String(wallet.blockchain),
    };
  }

  if (env.circleWalletSetId) {
    const wallet = await getFirstWalletInSet(client, env.circleWalletSetId, blockchain);

    if (wallet) {
      return {
        walletSetId: wallet.walletSetId,
        walletId: wallet.id,
        walletAddress: wallet.address,
        blockchain: String(wallet.blockchain),
      };
    }

    throw new CircleTransferError(
      "No ARC transfer wallet was found inside the configured Circle wallet set. Call POST /api/transfers/wallet/bootstrap to create one and then fund it.",
      503,
      "CIRCLE_WALLET_NOT_FOUND"
    );
  }

  if (requestedWalletAddress) {
    return {
      walletSetId: null,
      walletId: null,
      walletAddress: requestedWalletAddress,
      blockchain,
    };
  }

  throw new CircleTransferError(
    "Circle transfer wallet is not configured. Set CIRCLE_WALLET_ID or CIRCLE_WALLET_ADDRESS, or call POST /api/transfers/wallet/bootstrap after configuring Circle credentials.",
    503,
    "CIRCLE_WALLET_CONFIG_MISSING"
  );
}

async function getWalletById(
  client: CircleDeveloperControlledWalletsClient,
  walletId: string
): Promise<Wallet> {
  const response = await wrapCircleCall(
    async () =>
      client.getWallet({
        id: walletId,
        xRequestId: randomUUID(),
      }),
    `Failed to load Circle wallet ${walletId}.`
  );

  const wallet = response.data?.wallet;

  if (!wallet) {
    throw new CircleTransferError(
      `Circle wallet ${walletId} was not found.`,
      404,
      "CIRCLE_WALLET_NOT_FOUND"
    );
  }

  return wallet;
}

async function getFirstWalletInSet(
  client: CircleDeveloperControlledWalletsClient,
  walletSetId: string,
  blockchain: string
): Promise<Wallet | null> {
  const response = await wrapCircleCall(
    async () =>
      client.listWallets({
        walletSetId,
        blockchain: blockchain as Blockchain,
        xRequestId: randomUUID(),
      }),
    `Failed to list wallets for Circle wallet set ${walletSetId}.`
  );

  return response.data?.wallets?.[0] ?? null;
}

async function getWalletBalance(
  walletId: string | null
): Promise<CircleTransferWalletBalance | null> {
  if (!walletId) {
    return null;
  }

  const client = getCircleWalletClient();
  const response = await wrapCircleCall(
    async () =>
      client.getWalletTokenBalance({
        id: walletId,
        tokenAddresses: [env.circleTransferTokenAddress],
        xRequestId: randomUUID(),
      }),
    `Failed to load the Circle balance for wallet ${walletId}.`
  );

  const balance = response.data?.tokenBalances?.[0];

  if (!balance) {
    return null;
  }

  return {
    amount: balance.amount,
    symbol: balance.token.symbol || null,
    tokenAddress: balance.token.tokenAddress || env.circleTransferTokenAddress,
    updatedAt: balance.updateDate,
  };
}

function mapTransactionToTransferRecord(
  transaction: Transaction
): CircleTransferRecord {
  const metadata = transferMetadata.get(transaction.id);

  return {
    transferId: transaction.id,
    status: normalizeTransactionState(transaction.state),
    rawStatus: transaction.state,
    txHash: transaction.txHash || null,
    walletId: transaction.walletId || metadata?.walletId || null,
    walletAddress: metadata?.walletAddress || transaction.sourceAddress || null,
    sourceAddress: transaction.sourceAddress || metadata?.walletAddress || null,
    destinationAddress:
      transaction.destinationAddress || metadata?.destinationAddress || null,
    amount: transaction.amounts?.[0] || metadata?.amount || "0",
    tokenAddress: metadata?.tokenAddress || env.circleTransferTokenAddress,
    blockchain: String(transaction.blockchain || metadata?.blockchain || env.circleTransferBlockchain),
    referenceId: transaction.refId || metadata?.referenceId || "",
    createdAt: transaction.createDate,
    updatedAt: transaction.updateDate,
    errorReason: transaction.errorReason || transaction.errorDetails || null,
  };
}

function normalizeAmount(amount: string): string {
  const trimmedAmount = amount.trim();
  const numericAmount = Number(trimmedAmount);

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new CircleTransferError(
      "Amount must be a positive decimal string.",
      400,
      "CIRCLE_TRANSFER_INVALID_AMOUNT"
    );
  }

  return trimmedAmount;
}

function normalizeTransactionState(
  state: string
): "pending" | "processing" | "settled" | "failed" {
  const normalizedState = state.toUpperCase();

  if (
    normalizedState === "COMPLETE" ||
    normalizedState === "CONFIRMED" ||
    normalizedState === "CLEARED"
  ) {
    return "settled";
  }

  if (
    normalizedState === "SENT" ||
    normalizedState === "QUEUED"
  ) {
    return "processing";
  }

  if (
    normalizedState === "FAILED" ||
    normalizedState === "DENIED" ||
    normalizedState === "CANCELLED" ||
    normalizedState === "STUCK"
  ) {
    return "failed";
  }

  return "pending";
}

async function wrapCircleCall<T>(
  operation: () => Promise<T>,
  fallbackMessage: string
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toCircleTransferError(error, fallbackMessage);
  }
}

function toCircleTransferError(
  error: unknown,
  fallbackMessage: string
): CircleTransferError {
  if (error instanceof CircleTransferError) {
    return error;
  }

  const message =
    error instanceof Error && error.message ? error.message : fallbackMessage;
  const details = getStringField(error, "details") || getStringField(error, "body");
  const status =
    getNumberField(error, "status") ||
    getNumberField(error, "statusCode") ||
    502;

  return new CircleTransferError(message, status, "CIRCLE_API_ERROR", details);
}

function getStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object" || !(field in value)) {
    return undefined;
  }

  const fieldValue = value[field as keyof typeof value];
  return typeof fieldValue === "string" ? fieldValue : undefined;
}

function getNumberField(value: unknown, field: string): number | undefined {
  if (!value || typeof value !== "object" || !(field in value)) {
    return undefined;
  }

  const fieldValue = value[field as keyof typeof value];
  return typeof fieldValue === "number" ? fieldValue : undefined;
}
