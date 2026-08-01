import { AppKit, type ChainDefinition } from "@circle-fin/app-kit";
import {
  ArcTestnet,
  EthereumSepolia,
  SolanaDevnet,
} from "@circle-fin/app-kit/chains";
import type { CircleTransferBlockchain } from "@/lib/transfer-service";
import { ARC_TESTNET_RPC_URL } from "@/lib/wagmi";

const circleArcTestnet: ChainDefinition = {
  ...ArcTestnet,
  rpcEndpoints: [ARC_TESTNET_RPC_URL],
};

export const APP_KIT_CHAIN_BY_BRIDGE_CHAIN: Record<
  CircleTransferBlockchain,
  ChainDefinition
> = {
  "ARC-TESTNET": circleArcTestnet,
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
