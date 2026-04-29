import { BackendApiError, backendFetch } from "@/lib/backend-api";

export type BackendWalletChain = "EVM" | "SOLANA";
export type BackendWalletBlockchain =
  | "ARC-TESTNET"
  | "ETH-SEPOLIA"
  | "SOLANA-DEVNET";

type BackendWalletRecord = {
  address: string;
  blockchain: BackendWalletBlockchain;
  chain: BackendWalletChain;
  createdAt: string;
  updatedAt: string;
  userEmail: string | null;
  userId: string;
  walletId: string;
  walletSetId: string | null;
};

type WalletSessionParams = {
  email?: string | null;
  userId?: string | null;
  userToken: string;
};

export type BackendManagedCircleWallet = {
  address: string;
  blockchain: BackendWalletBlockchain;
  chain: BackendWalletChain;
  id: string;
  userId: string;
  walletSetId: string | null;
};

export type BackendWalletInitializeResult = {
  challengeId: string | null;
  userId: string;
};

export type BackendWalletSyncResult = {
  userId: string;
  wallets: BackendManagedCircleWallet[];
};

export type BackendWalletEnsureResult = {
  challengeId: string | null;
  requiresUserApproval: boolean;
  userId: string;
  wallet: BackendManagedCircleWallet | null;
};

type WalletApiError = Error & {
  code?: number | string;
  details?: unknown;
  status?: number;
};

export async function initializeBackendWallets(
  params: WalletSessionParams
): Promise<BackendWalletInitializeResult> {
  try {
    return await backendFetch<BackendWalletInitializeResult>("/wallets/initialize", {
      method: "POST",
      body: JSON.stringify(params),
    });
  } catch (error) {
    throw normalizeWalletApiError(error);
  }
}

export async function syncBackendWallets(
  params: WalletSessionParams
): Promise<BackendWalletSyncResult> {
  try {
    const result = await backendFetch<{
      userId: string;
      wallets: BackendWalletRecord[];
    }>("/wallets/sync", {
      method: "POST",
      body: JSON.stringify(params),
    });

    return {
      userId: result.userId,
      wallets: result.wallets.map(mapBackendWallet),
    };
  } catch (error) {
    throw normalizeWalletApiError(error);
  }
}

export async function ensureBackendWallet(
  params: WalletSessionParams & { chain: BackendWalletChain }
): Promise<BackendWalletEnsureResult> {
  try {
    const result = await backendFetch<{
      challengeId: string | null;
      requiresUserApproval: boolean;
      userId: string;
      wallet: BackendWalletRecord | null;
    }>("/wallets/ensure", {
      method: "POST",
      body: JSON.stringify(params),
    });

    return {
      challengeId: result.challengeId,
      requiresUserApproval: result.requiresUserApproval,
      userId: result.userId,
      wallet: result.wallet ? mapBackendWallet(result.wallet) : null,
    };
  } catch (error) {
    throw normalizeWalletApiError(error);
  }
}

function mapBackendWallet(wallet: BackendWalletRecord): BackendManagedCircleWallet {
  return {
    address: wallet.address,
    blockchain: wallet.blockchain,
    chain: wallet.chain,
    id: wallet.walletId,
    userId: wallet.userId,
    walletSetId: wallet.walletSetId,
  };
}

function normalizeWalletApiError(error: unknown): WalletApiError {
  if (error instanceof BackendApiError) {
    const nextError = new Error(error.message) as WalletApiError;
    nextError.code = parseWalletApiCode(error.code);
    nextError.details = error.details;
    nextError.status = error.status;
    return nextError;
  }

  if (error instanceof Error) {
    return error as WalletApiError;
  }

  return new Error("Unexpected backend wallet error") as WalletApiError;
}

function parseWalletApiCode(code: string | undefined) {
  if (!code) {
    return undefined;
  }

  return /^\d+$/.test(code) ? Number(code) : code;
}