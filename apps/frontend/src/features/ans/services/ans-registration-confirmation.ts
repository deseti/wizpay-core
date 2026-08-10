import type { Hex, PublicClient } from "viem"

export const ANS_ARC_TESTNET_CHAIN_ID = 5_042_002
export const ANS_ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.io"
const DEFAULT_RECEIPT_POLL_ATTEMPTS = 20
const DEFAULT_RECEIPT_POLL_INTERVAL_MS = 1_500

export function normalizeAnsTransactionHash(value: unknown): Hex | null {
  if (typeof value !== "string") {
    return null
  }

  const normalized = value.trim()
  return /^0x[a-fA-F0-9]{64}$/.test(normalized)
    ? (normalized as Hex)
    : null
}

export function requireAnsTransactionHash(
  value: unknown,
  action: "approval" | "registration"
): Hex {
  const hash = normalizeAnsTransactionHash(value)

  if (!hash) {
    throw new Error(
      `ANS ${action} did not return a valid 32-byte EVM transaction hash.`
    )
  }

  return hash
}

export function assertAnsArcTestnetChain(chainId: number) {
  if (chainId !== ANS_ARC_TESTNET_CHAIN_ID) {
    throw new Error(
      `ANS External Wallet requires Arc Testnet (chain ${ANS_ARC_TESTNET_CHAIN_ID}); received chain ${chainId}.`
    )
  }
}

export function assertAnsRpcUrl(rpcUrl: string) {
  if (rpcUrl.trim() !== ANS_ARC_TESTNET_RPC_URL) {
    throw new Error(
      `ANS External Wallet requires ${ANS_ARC_TESTNET_RPC_URL}; received ${rpcUrl}.`
    )
  }
}

function isReceiptUnavailableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "")
  const normalized = message.toLowerCase()

  return (
    normalized.includes("not found") ||
    normalized.includes("could not be found") ||
    normalized.includes("receipt") &&
      (normalized.includes("pending") || normalized.includes("unavailable")) ||
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("request limit") ||
    normalized.includes("rate limit") ||
    normalized.includes("temporarily unavailable")
  )
}

export async function waitForAnsTransactionReceipt({
  action,
  expectedContract,
  hash,
  maxAttempts = DEFAULT_RECEIPT_POLL_ATTEMPTS,
  pollIntervalMs = DEFAULT_RECEIPT_POLL_INTERVAL_MS,
  publicClient,
}: {
  action: "approval" | "registration"
  expectedContract: `0x${string}`
  hash: unknown
  maxAttempts?: number
  pollIntervalMs?: number
  publicClient: Pick<PublicClient, "getChainId" | "getTransactionReceipt">
}) {
  const txHash = requireAnsTransactionHash(hash, action)
  assertAnsArcTestnetChain(await publicClient.getChainId())

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash })

      if (
        !receipt.to ||
        receipt.to.toLowerCase() !== expectedContract.toLowerCase()
      ) {
        throw new Error(
          `ANS ${action} transaction ${txHash} targeted ${receipt.to ?? "no contract"}, expected ${expectedContract}.`
        )
      }

      assertSuccessfulAnsReceipt(action, txHash, receipt.status)
      return receipt
    } catch (error) {
      if (!isReceiptUnavailableError(error)) {
        throw error
      }

      if (attempt === maxAttempts) {
        throw new Error(
          `ANS ${action} transaction ${txHash} receipt was not available after ${maxAttempts} polling attempts.`,
          { cause: error }
        )
      }
    }

    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  throw new Error(
    `ANS ${action} transaction ${txHash} receipt was not available after ${maxAttempts} polling attempts.`
  )
}

export function assertSuccessfulAnsReceipt(
  action: "approval" | "registration",
  txHash: Hex,
  status: "success" | "reverted"
) {
  if (status === "reverted") {
    throw new Error(`ANS ${action} transaction ${txHash} reverted on-chain.`)
  }
}
