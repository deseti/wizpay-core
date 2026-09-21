export type WalletMode = "external";

export const DEFAULT_WALLET_MODE: WalletMode = "external";
export const WALLET_MODE_STORAGE_KEY = "wizpay.wallet.mode";

export function parseWalletMode(value: string | null | undefined): WalletMode {
  return "external";
}

export function getWalletModeLabel(mode: WalletMode): string {
  return "External Wallet";
}

export function getWalletModeDescription(mode: WalletMode): string {
  return "External wallet such as Rabby, MetaMask, Coinbase Wallet, Safe, or a WalletConnect mobile wallet";
}
