/**
 * CCTP V2 constants, ABIs, and helper utilities for the external-wallet
 * bridge flow (Stage 3).
 *
 * Contract addresses sourced from @circle-fin/bridge-kit chains manifest.
 */
import type { Address, Hex } from "viem";
import type { CircleTransferBlockchain } from "@/lib/transfer-service";

// ── CCTP V2 contracts – identical address on Arc Testnet and Ethereum Sepolia ──
export const CCTP_V2_TOKEN_MESSENGER =
  "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as Address;
export const CCTP_V2_MESSAGE_TRANSMITTER =
  "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as Address;

// ── CCTP domain IDs ──
export const CCTP_DOMAIN_BY_CHAIN: Partial<
  Record<CircleTransferBlockchain, number>
> = {
  "ETH-SEPOLIA": 0,
  "ARC-TESTNET": 26,
  "SOLANA-DEVNET": 5,
};

// ── Wagmi chain IDs for each bridge chain ──
export const CHAIN_ID_BY_BRIDGE_CHAIN: Partial<
  Record<CircleTransferBlockchain, number>
> = {
  "ETH-SEPOLIA": 11155111, // sepolia
  "ARC-TESTNET": 5042002,
};

// ── USDC decimals on both supported EVM testnets ──
export const CCTP_USDC_DECIMALS = 6;

// ── Circle CCTP V2 Attestation API (sandbox) ──
export const CCTP_V2_ATTESTATION_API_BASE =
  "https://iris-api-sandbox.circle.com/v2/messages";
const CIRCLE_API_PROXY_ENABLED = ["1", "true", "yes", "on"].includes(
  (process.env.NEXT_PUBLIC_CIRCLE_API_PROXY_ENABLED ?? "")
    .trim()
    .toLowerCase()
);

// ── Attestation polling settings ──
export const CCTP_ATTESTATION_POLL_INTERVAL_MS = 5_000;
export const CCTP_ATTESTATION_MAX_ATTEMPTS = 360; // 30 minutes (sandbox attestation can take 15–30 min)

// ── CCTP V2 TokenMessenger minimal ABI ──
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
    outputs: [{ name: "nonce", type: "uint64" }],
  },
] as const;

// ── CCTP V2 MessageTransmitter minimal ABI ──
export const CCTP_MESSAGE_TRANSMITTER_ABI = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

// ── ERC-20 approve ABI ──
export const CCTP_ERC20_APPROVE_ABI = [
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

// ── keccak256("MessageSent(bytes)") ──
export const MESSAGE_SENT_TOPIC =
  "0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036" as Hex;

// ── Zero bytes32 – no specific destination-caller restriction ──
export const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

// ── minFinalityThreshold: 1000 = FAST confirmation tier ──
export const CCTP_MIN_FINALITY_FAST = 1000;

async function fetchAttestationPayload(url: string): Promise<{
  messages?: Array<{
    status: string;
    attestation: string;
    message: string;
  }>;
} | null> {
  // First try direct call to Iris API.
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (response.ok) {
      return (await response.json()) as {
        messages?: Array<{
          status: string;
          attestation: string;
          message: string;
        }>;
      };
    }
  } catch {
    // Fall through to proxy retry.
  }

  // Fallback via our server proxy to reduce client-side network/CORS flakiness.
  if (!CIRCLE_API_PROXY_ENABLED) {
    return null;
  }

  try {
    const proxied = await fetch("/api/circle/proxy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        method: "GET",
        headers: {
          accept: "application/json",
        },
      }),
      cache: "no-store",
    });

    if (!proxied.ok) {
      return null;
    }

    return (await proxied.json()) as {
      messages?: Array<{
        status: string;
        attestation: string;
        message: string;
      }>;
    };
  } catch {
    return null;
  }
}

/**
 * Pad a 20-byte EVM address to bytes32 (the mintRecipient format required by
 * CCTP depositForBurn).
 */
export function evmAddressToBytes32(address: Address): Hex {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
}

/**
 * Decode the ABI-encoded `bytes` payload from a MessageSent log's data field.
 *
 * MessageSent(bytes message): the log data is abi.encode(bytes) which is
 * [offset=32][length][…data…].  We skip the first 32-byte word (offset
 * pointer) and decode raw hex instead of relying on a full viem dependency
 * cycle here.
 */
export function extractMessageBytesFromLogs(
  logs: readonly { address: string; topics: readonly string[]; data: string }[]
): Hex | null {
  const messageSentLog = logs.find(
    (log) =>
      log.topics[0]?.toLowerCase() === MESSAGE_SENT_TOPIC.toLowerCase() &&
      log.address.toLowerCase() ===
        CCTP_V2_MESSAGE_TRANSMITTER.toLowerCase()
  );

  if (!messageSentLog || !messageSentLog.data || messageSentLog.data === "0x") {
    return null;
  }

  // data = 0x + (32-byte offset) + (32-byte length) + message bytes
  const hex = messageSentLog.data.slice(2); // strip 0x
  if (hex.length < 128) return null;

  const lengthHex = hex.slice(64, 128);
  const byteLength = parseInt(lengthHex, 16);
  if (!byteLength || byteLength <= 0) return null;

  const messageHex = hex.slice(128, 128 + byteLength * 2);
  if (messageHex.length !== byteLength * 2) return null;

  return `0x${messageHex}` as Hex;
}

/**
 * Poll the Circle CCTP V2 attestation API until the attestation is complete.
 * Resolves with `{ message, attestation }` hex strings.
 */
export async function pollCctpV2Attestation(
  sourceDomain: number,
  txHash: Hex,
  onAttempt?: (attempt: number) => void
): Promise<{ message: Hex; attestation: Hex }> {
  const url = `${CCTP_V2_ATTESTATION_API_BASE}/${sourceDomain}?transactionHash=${txHash}`;

  for (
    let attempt = 0;
    attempt < CCTP_ATTESTATION_MAX_ATTEMPTS;
    attempt++
  ) {
    if (attempt > 0) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, CCTP_ATTESTATION_POLL_INTERVAL_MS)
      );
    }

    onAttempt?.(attempt + 1);

    const json = await fetchAttestationPayload(url);
    const first = json?.messages?.[0];

    if (
      first?.status === "complete" &&
      first.attestation &&
      first.message &&
      first.attestation !== "PENDING"
    ) {
      return {
        message: first.message as Hex,
        attestation: first.attestation as Hex,
      };
    }
  }

  throw new Error(
    "CCTP attestation timed out after 30 minutes. The burn was confirmed on-chain but Circle has not issued the attestation yet."
  );
}

/**
 * Build a block-explorer transaction URL for the given chain and tx hash.
 */
export function getCctpExplorerUrl(
  chain: CircleTransferBlockchain,
  txHash: Hex
): string | null {
  if (chain === "ETH-SEPOLIA") {
    return `https://sepolia.etherscan.io/tx/${txHash}`;
  }

  if (chain === "ARC-TESTNET") {
    return `https://testnet.arcscan.app/tx/${txHash}`;
  }

  if (chain === "SOLANA-DEVNET") {
    return `https://solscan.io/tx/${txHash}?cluster=devnet`;
  }

  return null;
}
