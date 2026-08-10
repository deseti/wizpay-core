import { describe, expect, it, vi } from "vitest"

import {
  ANS_ARC_TESTNET_CHAIN_ID,
  ANS_ARC_TESTNET_RPC_URL,
  assertAnsArcTestnetChain,
  assertAnsRpcUrl,
  normalizeAnsTransactionHash,
  requireAnsTransactionHash,
  waitForAnsTransactionReceipt,
} from "./ans-registration-confirmation"

const HASH = `0x${"1".repeat(64)}` as const
const CONTRACT = "0x201ffB769476976dF29BDbe95064cAB59c6e12c3" as const

function mockClient() {
  return {
    getChainId: vi.fn().mockResolvedValue(ANS_ARC_TESTNET_CHAIN_ID),
    getTransactionReceipt: vi.fn(),
  }
}

function successfulReceipt() {
  return {
    status: "success" as const,
    to: CONTRACT,
    transactionHash: HASH,
  }
}

describe("External Wallet ANS transaction confirmation", () => {
  it("accepts only a valid EVM transaction hash", () => {
    expect(normalizeAnsTransactionHash(HASH)).toBe(HASH)
    expect(normalizeAnsTransactionHash("circle-transaction-id")).toBeNull()
    expect(() => requireAnsTransactionHash("operation-id", "registration"))
      .toThrow("valid 32-byte EVM transaction hash")
  })

  it("polls a pending receipt until it appears", async () => {
    const client = mockClient()
    client.getTransactionReceipt
      .mockRejectedValueOnce(new Error("Transaction receipt could not be found"))
      .mockResolvedValueOnce(successfulReceipt())

    await expect(
      waitForAnsTransactionReceipt({
        action: "registration",
        expectedContract: CONTRACT,
        hash: HASH,
        maxAttempts: 3,
        pollIntervalMs: 0,
        publicClient: client,
      }),
    ).resolves.toMatchObject({ status: "success" })
    expect(client.getTransactionReceipt).toHaveBeenCalledTimes(2)
  })

  it("reports reverted receipts with the hash", async () => {
    const client = mockClient()
    client.getTransactionReceipt.mockResolvedValue({
      ...successfulReceipt(),
      status: "reverted",
    })

    await expect(
      waitForAnsTransactionReceipt({
        action: "registration",
        expectedContract: CONTRACT,
        hash: HASH,
        pollIntervalMs: 0,
        publicClient: client,
      }),
    ).rejects.toThrow(`ANS registration transaction ${HASH} reverted`)
  })

  it("rejects chain mismatches, wrong targets, and exhausted receipt polling", async () => {
    const wrongChain = mockClient()
    wrongChain.getChainId.mockResolvedValue(1)
    await expect(
      waitForAnsTransactionReceipt({
        action: "registration",
        expectedContract: CONTRACT,
        hash: HASH,
        publicClient: wrongChain,
      }),
    ).rejects.toThrow(`requires Arc Testnet (chain ${ANS_ARC_TESTNET_CHAIN_ID})`)

    const wrongTarget = mockClient()
    wrongTarget.getTransactionReceipt.mockResolvedValue({
      ...successfulReceipt(),
      to: "0x3600000000000000000000000000000000000000",
    })
    await expect(
      waitForAnsTransactionReceipt({
        action: "registration",
        expectedContract: CONTRACT,
        hash: HASH,
        pollIntervalMs: 0,
        publicClient: wrongTarget,
      }),
    ).rejects.toThrow("expected")

    const pending = mockClient()
    pending.getTransactionReceipt.mockRejectedValue(
      new Error("Transaction receipt could not be found"),
    )
    await expect(
      waitForAnsTransactionReceipt({
        action: "registration",
        expectedContract: CONTRACT,
        hash: HASH,
        maxAttempts: 2,
        pollIntervalMs: 0,
        publicClient: pending,
      }),
    ).rejects.toThrow("receipt was not available after 2 polling attempts")
  })

  it("rejects stale RPC configuration", () => {
    expect(() => assertAnsArcTestnetChain(1)).toThrow()
    const staleRpcUrl = ANS_ARC_TESTNET_RPC_URL.replace(".io", ".network")
    expect(() => assertAnsRpcUrl(staleRpcUrl)).toThrow()
    expect(() => assertAnsRpcUrl(ANS_ARC_TESTNET_RPC_URL)).not.toThrow()
  })
})
