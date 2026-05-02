import {
  ETHEREUM_SEPOLIA_USDC_ADDRESS,
  USDC_ADDRESS,
} from "@/constants/addresses";
import type {
  CircleTransfer,
  CircleTransferBlockchain,
  CircleTransferWallet,
} from "@/lib/transfer-service";

export type BridgeStepId = "burn" | "attestation" | "mint";

export const STEP_ORDER = ["burn", "attestation", "mint"] as const;

export const TRANSFER_WALLET_STORAGE_KEY = "wizpay-bridge-transfer-wallets";
export const ACTIVE_TRANSFER_STORAGE_KEY = "wizpay-bridge-active-transfer";

export const BRIDGE_POLL_INTERVAL_MS = 4_000;
export const BRIDGE_LONG_RUNNING_MS = 120_000;
/** Transfers stuck in a non-terminal state longer than this are considered abandoned. */
export const BRIDGE_STUCK_TIMEOUT_MS = 15 * 60 * 1_000;

export const DEFAULT_SOURCE_BLOCKCHAIN: CircleTransferBlockchain = "ETH-SEPOLIA";

export const APP_TREASURY_WALLET_TITLE = "Source Treasury Wallet";
export const APP_TREASURY_WALLET_LABEL = "source treasury wallet";
export const BRIDGE_ASSET_SYMBOL = "USDC";

export const BRIDGE_EXTERNAL_ENABLED = ["1", "true", "yes", "on"].includes(
  (process.env.NEXT_PUBLIC_WIZPAY_BRIDGE_EXTERNAL_ENABLED ?? "")
    .trim()
    .toLowerCase()
);

export type StoredTransferWallet = {
  walletId: string | null;
  walletAddress: string;
  walletSetId: string | null;
};

export type StoredTransferWalletMap = Partial<
  Record<CircleTransferBlockchain, StoredTransferWallet>
>;

export type DestinationWalletMap = Partial<
  Record<CircleTransferBlockchain, CircleTransferWallet | null>
>;

export const DESTINATION_OPTIONS: Array<{
  id: CircleTransferBlockchain;
  label: string;
}> = [
  { id: "ARC-TESTNET", label: "Arc Testnet" },
  { id: "ETH-SEPOLIA", label: "Ethereum Sepolia" },
  { id: "SOLANA-DEVNET", label: "Solana Devnet" },
];

export const USDC_ADDRESS_BY_CHAIN: Partial<
  Record<CircleTransferBlockchain, string>
> = {
  "ARC-TESTNET": USDC_ADDRESS,
  "ETH-SEPOLIA": ETHEREUM_SEPOLIA_USDC_ADDRESS,
  // Solana Devnet USDC (Circle official SPL token)
  "SOLANA-DEVNET": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

// Re-export CircleTransfer for use in bridge sub-modules
export type { CircleTransfer, CircleTransferBlockchain, CircleTransferWallet };
