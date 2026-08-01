import { describe, expect, it, vi } from "vitest"

import {
  executeAnsFlowOnce,
  executeAnsStepOnce,
} from "./ans-registration-flow"
import { toAnsRegistrationError } from "./ans-registration-errors"
import { assertSuccessfulAnsReceipt } from "./ans-registration-confirmation"

type Submission = {
  hash: string
  txHash: `0x${string}` | null
}

describe("ANS registration execution", () => {
  it("runs App Wallet approval and registration when allowance is insufficient", async () => {
    const approvalPending = { current: null as Submission | null }
    const registrationPending = { current: null as Submission | null }
    const submitApproval = vi.fn(async () => ({ hash: "approval-challenge", txHash: null }))
    const submitRegistration = vi.fn(async () => ({ hash: "registration-challenge", txHash: null }))
    const confirmApproval = vi.fn(async () => true)
    const confirmRegistration = vi.fn(async () => ({ owner: "app-wallet" }))

    await executeAnsStepOnce({
      pendingSubmission: approvalPending,
      checkCompleted: async () => null,
      submit: submitApproval,
      confirm: confirmApproval,
    })
    const confirmation = await executeAnsStepOnce({
      pendingSubmission: registrationPending,
      checkCompleted: async () => null,
      submit: submitRegistration,
      confirm: confirmRegistration,
    })

    expect(submitApproval).toHaveBeenCalledOnce()
    expect(confirmApproval).toHaveBeenCalledWith({
      hash: "approval-challenge",
      txHash: null,
    })
    expect(submitRegistration).toHaveBeenCalledOnce()
    expect(confirmation).toEqual({ owner: "app-wallet" })
  })

  it("skips External Wallet approval when allowance is already sufficient", async () => {
    const pending = { current: null as Submission | null }
    const submitApproval = vi.fn(async () => ({ hash: "unused", txHash: null }))

    const confirmation = await executeAnsStepOnce({
      pendingSubmission: pending,
      checkCompleted: async () => true,
      submit: submitApproval,
      confirm: async () => false,
    })

    expect(confirmation).toBe(true)
    expect(submitApproval).not.toHaveBeenCalled()
  })

  it("runs External Wallet approval before registration when allowance is insufficient", async () => {
    const approvalTxHash = `0x${"3".repeat(64)}` as const
    const registrationTxHash = `0x${"4".repeat(64)}` as const
    const submitApproval = vi.fn(async () => ({
      hash: approvalTxHash,
      txHash: approvalTxHash,
    }))
    const submitRegistration = vi.fn(async () => ({
      hash: registrationTxHash,
      txHash: registrationTxHash,
    }))

    await executeAnsStepOnce({
      pendingSubmission: { current: null as Submission | null },
      checkCompleted: async () => null,
      submit: submitApproval,
      confirm: async (submission) => submission.txHash,
    })
    const registration = await executeAnsStepOnce({
      pendingSubmission: { current: null as Submission | null },
      checkCompleted: async () => null,
      submit: submitRegistration,
      confirm: async (submission) => submission.txHash,
    })

    expect(submitApproval).toHaveBeenCalledOnce()
    expect(submitRegistration).toHaveBeenCalledOnce()
    expect(registration).toBe(registrationTxHash)
  })

  it("submits and confirms an External Wallet registration transaction", async () => {
    const txHash = `0x${"1".repeat(64)}` as const
    const pending = { current: null as Submission | null }
    const submit = vi.fn(async () => ({ hash: txHash, txHash }))
    const confirm = vi.fn(async (submission: Submission) => ({
      owner: "external-wallet",
      txHash: submission.txHash,
    }))

    const result = await executeAnsStepOnce({
      pendingSubmission: pending,
      checkCompleted: async () => null,
      submit,
      confirm,
    })

    expect(result).toEqual({ owner: "external-wallet", txHash })
    expect(submit).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledOnce()
  })

  it("reconciles a submitted registration instead of submitting it again after confirmation fails", async () => {
    const submission = { hash: "circle-challenge", txHash: null }
    const pending = { current: null as Submission | null }
    const submit = vi.fn(async () => submission)
    const firstConfirmation = vi.fn(async () => {
      throw Object.assign(new Error("RPC Request failed."), {
        code: -32011,
        details: "request limit reached",
      })
    })

    await expect(
      executeAnsStepOnce({
        pendingSubmission: pending,
        checkCompleted: async () => null,
        submit,
        confirm: firstConfirmation,
      })
    ).rejects.toThrow("RPC Request failed")

    const reconciled = await executeAnsStepOnce({
      pendingSubmission: pending,
      checkCompleted: async () => ({ owner: "app-wallet" }),
      submit,
      confirm: async () => ({ owner: "unused" }),
    })

    expect(reconciled).toEqual({ owner: "app-wallet" })
    expect(submit).toHaveBeenCalledOnce()
    expect(pending.current).toBeNull()
  })

  it("deduplicates concurrent approval and registration flows", async () => {
    const inFlight = { current: null as Promise<string> | null }
    let release!: (value: string) => void
    const flow = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    )

    const first = executeAnsFlowOnce(inFlight, flow)
    const second = executeAnsFlowOnce(inFlight, flow)
    release("confirmed")

    await expect(first).resolves.toBe("confirmed")
    await expect(second).resolves.toBe("confirmed")
    expect(first).toBe(second)
    expect(flow).toHaveBeenCalledOnce()
  })

  it("preserves sanitized Arc RPC and provider error details", () => {
    const rpcError = toAnsRegistrationError(
      Object.assign(new Error("HTTP request failed."), {
        code: -32011,
        details: "request limit reached",
      }),
      "registration_confirmation"
    )
    const providerError = toAnsRegistrationError(
      Object.assign(new Error("Contract execution rejected by policy."), {
        code: 155903,
        status: 400,
      }),
      "registration"
    )

    expect(rpcError.message).toContain("request limit reached")
    expect(rpcError.message).toContain("code -32011")
    expect(providerError.message).toBe(
      "Contract execution rejected by policy. (code 155903)"
    )
    expect(providerError.status).toBe(400)
  })

  it("accepts successful receipts and rejects reverted approval or registration receipts", () => {
    const txHash = `0x${"2".repeat(64)}` as const

    expect(() =>
      assertSuccessfulAnsReceipt("registration", txHash, "success")
    ).not.toThrow()
    expect(() =>
      assertSuccessfulAnsReceipt("approval", txHash, "reverted")
    ).toThrow(`ANS approval transaction ${txHash} reverted on-chain.`)
  })
})
