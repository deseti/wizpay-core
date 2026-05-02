import type { CircleTransfer, CircleTransferBlockchain } from "@/lib/transfer-service";
import {
  TRANSFER_WALLET_STORAGE_KEY,
  ACTIVE_TRANSFER_STORAGE_KEY,
  type StoredTransferWallet,
  type StoredTransferWalletMap,
} from "./bridge-types";
import type { CircleTransferWallet } from "./bridge-types";

// ─── Transfer wallet (source treasury) helpers ──────────────────────────────

export function getStoredTransferWallet(
  blockchain: CircleTransferBlockchain
): StoredTransferWallet | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(TRANSFER_WALLET_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredTransferWalletMap;
    return parsed[blockchain] ?? null;
  } catch {
    return null;
  }
}

export function getStoredTransferWallets(): StoredTransferWalletMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(TRANSFER_WALLET_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredTransferWalletMap) : {};
  } catch {
    return {};
  }
}

export function setStoredTransferWallet(
  blockchain: CircleTransferBlockchain,
  wallet: CircleTransferWallet
) {
  if (typeof window === "undefined") return;
  try {
    const current = getStoredTransferWallets();
    current[blockchain] = {
      walletId: wallet.walletId,
      walletAddress: wallet.walletAddress,
      walletSetId: wallet.walletSetId,
    };
    window.localStorage.setItem(
      TRANSFER_WALLET_STORAGE_KEY,
      JSON.stringify(current)
    );
  } catch {
    // ignore
  }
}

export function clearStoredTransferWallet(blockchain: CircleTransferBlockchain) {
  if (typeof window === "undefined") return;
  try {
    const current = getStoredTransferWallets();
    delete current[blockchain];
    window.localStorage.setItem(
      TRANSFER_WALLET_STORAGE_KEY,
      JSON.stringify(current)
    );
  } catch {
    // ignore
  }
}

// ─── Active transfer helpers ─────────────────────────────────────────────────

export function getStoredActiveTransfer(): CircleTransfer | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_TRANSFER_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CircleTransfer) : null;
  } catch {
    return null;
  }
}

export function setStoredActiveTransfer(transfer: CircleTransfer) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      ACTIVE_TRANSFER_STORAGE_KEY,
      JSON.stringify(transfer)
    );
  } catch {
    // ignore
  }
}

export function clearStoredActiveTransfer() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ACTIVE_TRANSFER_STORAGE_KEY);
  } catch {
    // ignore
  }
}
