import {
  arbitrum,
  avalanche,
  base,
  mainnet,
  optimism,
  polygon,
  type Chain,
} from "viem/chains";
import { getAddress, pad, type Address, type Hex } from "viem";
import {
  getBridgeChain,
  listBridgeChains,
  CCTP_PRODUCTION,
  type BridgeChain,
} from "@wizpay/bridge-registry";

export const CCTP_STANDARD_FINALITY_THRESHOLD =
  CCTP_PRODUCTION.standardFinalityThreshold;
export const CCTP_FAST_FINALITY_THRESHOLD =
  CCTP_PRODUCTION.fastFinalityThreshold;
export const CCTP_IRIS_API_BASE_URL = CCTP_PRODUCTION.irisApiBaseUrl;
// $10M single-burn limit in 6-decimal USDC base units.
export const CCTP_MAX_BURN_AMOUNT_UNITS = BigInt(
  CCTP_PRODUCTION.maxBurnAmountUnits,
);

const WAGMI_CHAIN_BY_ID: Record<number, Chain> = {
  1: mainnet,
  10: optimism,
  137: polygon,
  8453: base,
  42161: arbitrum,
  43114: avalanche,
};

export function bridgeChains(): readonly BridgeChain[] {
  return listBridgeChains();
}

export function bridgeChain(code: string): BridgeChain {
  return getBridgeChain(code);
}

/**
 * Wagmi/viem chain for a CCTP bridge chain. Arc Mainnet resolves through the
 * app chain definition (custom RPC); all other production routes resolve
 * through viem's built-in chains. Unknown codes throw instead of falling
 * back to another network.
 */
export function wagmiChainForBridge(
  code: string,
  arcChain: Chain,
): Chain {
  const chain = getBridgeChain(code);
  if (chain.chainId === arcChain.id) return arcChain;
  const known = WAGMI_CHAIN_BY_ID[chain.chainId];
  if (!known) {
    throw new Error(`Unsupported bridge chain: ${code}.`);
  }
  return known;
}

export function explorerTxUrl(
  chain: BridgeChain,
  hash: string | null | undefined,
): string | null {
  if (!hash || !/^0x[a-fA-F0-9]{64}$/.test(hash)) return null;
  return `${chain.explorerBaseUrl}/tx/${hash}`;
}

export function addressToBytes32(address: Address): Hex {
  return pad(getAddress(address), { size: 32 });
}

export const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const CCTP_TOKEN_MESSENGER_ABI = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
] as const;

export const CCTP_MESSAGE_TRANSMITTER_ABI = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [],
  },
] as const;
