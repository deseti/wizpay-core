import type { Hex } from "viem"

export function assertSuccessfulAnsReceipt(
  action: "approval" | "registration",
  txHash: Hex,
  status: "success" | "reverted"
) {
  if (status === "reverted") {
    throw new Error(`ANS ${action} transaction ${txHash} reverted on-chain.`)
  }
}
