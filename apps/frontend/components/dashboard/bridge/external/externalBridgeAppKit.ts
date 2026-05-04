import { AppKit, type ChainDefinition } from "@circle-fin/app-kit";
import {
  ArcTestnet,
  EthereumSepolia,
  SolanaDevnet,
} from "@circle-fin/app-kit/chains";
import type { CircleTransferBlockchain } from "@/lib/transfer-service";

export const APP_KIT_CHAIN_BY_BRIDGE_CHAIN: Record<
  CircleTransferBlockchain,
  ChainDefinition
> = {
  "ARC-TESTNET": ArcTestnet,
  "ETH-SEPOLIA": EthereumSepolia,
  "SOLANA-DEVNET": SolanaDevnet,
};

const externalBridgeAppKit = new AppKit();

export function getExternalBridgeAppKitChain(
  chain: CircleTransferBlockchain
): ChainDefinition {
  return APP_KIT_CHAIN_BY_BRIDGE_CHAIN[chain];
}

export function getExternalBridgeAppKit() {
  return externalBridgeAppKit;
}
