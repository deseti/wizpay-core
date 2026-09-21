import { getAddress, isAddress } from "viem";
import { backendFetch } from "@/lib/backend-api";

const USER_ID_KEY_PREFIX = "wizpay.external-user-id.v1:";

function storage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

function readStoredUserId(address: string): string | null {
  const value = storage()?.getItem(
    `${USER_ID_KEY_PREFIX}${address.toLowerCase()}`,
  );
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function writeStoredUserId(address: string, userId: string) {
  storage()?.setItem(`${USER_ID_KEY_PREFIX}${address.toLowerCase()}`, userId);
}

export type RegisteredExternalWallet = {
  address: `0x${string}`;
  userId: string;
};

/**
 * Ensure the connected external wallet is registered for backend-scoped
 * features (merchant invoices, payment links, activity sync).
 *
 * Self-custodial address binding only: the backend stores the address for
 * ownership scoping and never holds keys. The userId is a stable
 * caller-provided identifier persisted per wallet on this device.
 */
export async function ensureExternalWalletRegistered(
  rawAddress: string,
): Promise<RegisteredExternalWallet> {
  if (!isAddress(rawAddress)) {
    throw new Error("Connect an external wallet before continuing.");
  }
  const address = getAddress(rawAddress);
  const existing = readStoredUserId(address);
  const userId = existing ?? crypto.randomUUID();
  const registered = await backendFetch<{ address: string; userId: string }>(
    "/wallets/register-external",
    {
      method: "POST",
      body: JSON.stringify({ userId, address }),
    },
  );
  if (registered.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error("Wallet registration returned a different address.");
  }
  writeStoredUserId(address, registered.userId);
  return { address, userId: registered.userId };
}
