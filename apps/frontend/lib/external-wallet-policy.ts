import type { Address } from "viem";

import { ACTIVE_ARC_NETWORK } from "@/lib/active-arc-network";

export const SUPPORTED_EXTERNAL_WALLET_CHAIN_IDS = new Set<number>([
  ACTIVE_ARC_NETWORK.chainId,
]);

function walletChainName(chainId: number) {
  if (chainId === ACTIVE_ARC_NETWORK.chainId) return ACTIVE_ARC_NETWORK.name;
  return `chain ${chainId}`;
}

export function assertSupportedExternalWalletChain(chainId: number) {
  if (!SUPPORTED_EXTERNAL_WALLET_CHAIN_IDS.has(chainId)) {
    throw new Error(`Unsupported wallet chain ID: ${chainId}.`);
  }
}

export function assertSelectedArcWalletChain(chainId: number) {
  if (chainId !== ACTIVE_ARC_NETWORK.chainId) {
    throw new Error(
      `The connected wallet must use ${ACTIVE_ARC_NETWORK.name} (chain ${ACTIVE_ARC_NETWORK.chainId}).`,
    );
  }
}

export function assertInitiatingWalletAuthority(input: {
  initiatingWallet: Address;
  connectedWallet: Address | undefined;
  clientAccount: Address | undefined;
}) {
  const expected = input.initiatingWallet.toLowerCase();
  if (
    input.connectedWallet?.toLowerCase() !== expected ||
    input.clientAccount?.toLowerCase() !== expected
  ) {
    throw new Error(
      "The connected external wallet no longer matches the initiating wallet.",
    );
  }
}

export async function requestExternalWalletChain(input: {
  currentChainId: number | undefined;
  targetChainId: number;
  switchChain:
    ((parameters: { chainId: number }) => Promise<unknown>) | undefined;
}) {
  assertSupportedExternalWalletChain(input.targetChainId);
  if (input.currentChainId === input.targetChainId) return;
  if (!input.switchChain) {
    throw new Error(
      `Switch your external wallet to ${walletChainName(input.targetChainId)} to continue.`,
    );
  }
  try {
    await input.switchChain({ chainId: input.targetChainId });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.toLowerCase()
        : String(error).toLowerCase();
    if (message.includes("reject") || message.includes("4001")) {
      throw new Error("Network switch was rejected in your wallet.");
    }
    throw new Error(
      `Failed to switch the external wallet to ${walletChainName(input.targetChainId)}.`,
    );
  }
}
