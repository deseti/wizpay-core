"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { type Address, type Hex } from "viem"
import { useQuery } from "@tanstack/react-query"
import { usePublicClient } from "wagmi"

import { ERC20_ABI } from "@/constants/erc20"
import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress"
import { useToast } from "@/hooks/use-toast"
import {
  useTransactionExecutor,
  type ExecuteTransactionResult,
} from "@/hooks/useTransactionExecutor"
import { arcTestnet } from "@/lib/wagmi"

import {
  ANS_NAMESPACE_REGISTRAR_ABI,
  ANS_NAMESPACE_CONTROLLER_ABI,
} from "../contracts/abis"
import { getAnsContractsConfig } from "../services/ans-config"
import {
  isTransientAnsRpcError,
  runAnsRpcRead,
} from "../services/ans-rpc"
import {
  executeAnsFlowOnce,
  executeAnsStepOnce,
} from "../services/ans-registration-flow"
import { assertSuccessfulAnsReceipt } from "../services/ans-registration-confirmation"
import {
  toAnsRegistrationError,
  type AnsRegistrationStage,
} from "../services/ans-registration-errors"
import { recordAnsRegistrationActivity } from "../utils/storage"
import type {
  AnsDomainLookup,
  AnsRegistrationConfirmation,
} from "../types/ans"

type RegistrationStep = "idle" | "approving" | "registering" | "success" | "error"

const MAX_CONFIRMATION_POLLS = 20
const POLL_INTERVAL_MS = 1_500
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
const ARC_MULTICALL3_ADDRESS =
  "0xca11bde05977b3631167028862be2a173976ca11" as Address

const ERC20_APPROVAL_EVENT = {
  type: "event",
  name: "Approval",
  inputs: [
    { indexed: true, name: "owner", type: "address" },
    { indexed: true, name: "spender", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
  anonymous: false,
} as const

const ERC721_TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: true, name: "tokenId", type: "uint256" },
  ],
  anonymous: false,
} as const

function waitFor(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function isHexTransactionHash(value: string | null | undefined): value is Hex {
  return /^0x[a-fA-F0-9]{64}$/.test(value ?? "")
}

export function useAnsRegistration({
  lookup,
  onRegistered,
}: {
  lookup: AnsDomainLookup | null | undefined
  onRegistered?: (domain: string) => void
}) {
  const contracts = getAnsContractsConfig()
  const { walletAddress } = useActiveWalletAddress()
  const { executeTransaction } = useTransactionExecutor()
  const { toast } = useToast()
  const publicClient = usePublicClient({ chainId: arcTestnet.id })

  const [step, setStep] = useState<RegistrationStep>("idle")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [approvalHash, setApprovalHash] = useState<string | null>(null)
  const [registrationHash, setRegistrationHash] = useState<string | null>(null)
  const [submissionHash, setSubmissionHash] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<AnsRegistrationConfirmation | null>(null)
  const approvalSubmissionRef = useRef<ExecuteTransactionResult | null>(null)
  const registrationSubmissionRef = useRef<ExecuteTransactionResult | null>(null)
  const approvalInFlightRef = useRef<Promise<void> | null>(null)
  const submitInFlightRef = useRef<Promise<AnsRegistrationConfirmation> | null>(null)
  const idempotencyKeysRef = useRef(new Map<string, string>())

  const requiredAmount = lookup?.rentPrice ?? 0n

  const { data: tokenState, refetch: refetchTokenState } = useQuery({
    queryKey: [
      "ans",
      "registration-token-state",
      contracts.usdc,
      walletAddress,
      lookup?.namespaceSnapshot.controller,
    ],
    enabled: Boolean(publicClient && walletAddress && lookup),
    queryFn: () => {
      const controller = lookup!.namespaceSnapshot.controller
      const requestKey = [
        "registration-token-state",
        arcTestnet.id,
        contracts.usdc.toLowerCase(),
        walletAddress!.toLowerCase(),
        controller.toLowerCase(),
      ].join(":")

      return runAnsRpcRead(requestKey, async () => {
        const [allowance, balance] = await publicClient!.multicall({
          allowFailure: false,
          contracts: [
            {
              address: contracts.usdc,
              abi: ERC20_ABI,
              functionName: "allowance",
              args: [walletAddress!, controller],
            },
            {
              address: contracts.usdc,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [walletAddress!],
            },
          ],
          multicallAddress: ARC_MULTICALL3_ADDRESS,
        })

        return { allowance, balance }
      })
    },
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 5_000,
  })

  const allowance = tokenState?.allowance ?? 0n
  const balance = tokenState?.balance ?? 0n
  const needsApproval = requiredAmount > 0n && allowance < requiredAmount
  const insufficientBalance = requiredAmount > balance

  const canRegister = useMemo(
    () =>
      Boolean(publicClient) &&
      Boolean(walletAddress) &&
      Boolean(lookup) &&
      lookup?.available === true &&
      !needsApproval &&
      !insufficientBalance,
    [insufficientBalance, lookup, needsApproval, publicClient, walletAddress]
  )

  const resetFeedback = useCallback(() => {
    setStep("idle")
    setErrorMessage(null)
    setApprovalHash(null)
    setRegistrationHash(null)
    setSubmissionHash(null)
    setConfirmation(null)
    approvalSubmissionRef.current = null
    registrationSubmissionRef.current = null
    approvalInFlightRef.current = null
    submitInFlightRef.current = null
    idempotencyKeysRef.current.clear()
  }, [])

  const getIdempotencyKey = useCallback(
    (action: "approve" | "register") => {
      const key = `${action}:${lookup?.target.domain ?? "unknown"}:${walletAddress ?? "unknown"}`
      const existing = idempotencyKeysRef.current.get(key)

      if (existing) {
        return existing
      }

      const created = crypto.randomUUID()
      idempotencyKeysRef.current.set(key, created)
      return created
    },
    [lookup?.target.domain, walletAddress]
  )

  const handleRegistrationError = useCallback(
    (error: unknown, stage: AnsRegistrationStage) => {
      const nextError = toAnsRegistrationError(error, stage)
      setStep("error")
      setErrorMessage(nextError.message)
      return nextError
    },
    []
  )

  const readCurrentAllowance = useCallback(async () => {
    if (!publicClient || !lookup || !walletAddress) {
      throw new Error("ANS allowance state is not ready yet.")
    }

    return runAnsRpcRead(
      [
        "registration-allowance-preflight",
        walletAddress.toLowerCase(),
        lookup.namespaceSnapshot.controller.toLowerCase(),
      ].join(":"),
      () =>
        publicClient.readContract({
          address: contracts.usdc,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [walletAddress, lookup.namespaceSnapshot.controller],
        })
    )
  }, [contracts.usdc, lookup, publicClient, walletAddress])

  const readRegistrationState = useCallback(async () => {
    if (!publicClient || !lookup || !walletAddress) {
      throw new Error("ANS registration state is not ready yet.")
    }

    const [ownerResult, expiryResult, availableResult] = await runAnsRpcRead(
      [
        "registration-preflight",
        lookup.target.domain,
        walletAddress.toLowerCase(),
      ].join(":"),
      () =>
        publicClient.multicall({
          allowFailure: true,
          multicallAddress: ARC_MULTICALL3_ADDRESS,
          contracts: [
            {
              address: lookup.namespaceSnapshot.registrar,
              abi: ANS_NAMESPACE_REGISTRAR_ABI,
              functionName: "ownerOf",
              args: [lookup.tokenId],
            },
            {
              address: lookup.namespaceSnapshot.registrar,
              abi: ANS_NAMESPACE_REGISTRAR_ABI,
              functionName: "nameExpires",
              args: [lookup.tokenId],
            },
            {
              address: lookup.namespaceSnapshot.controller,
              abi: ANS_NAMESPACE_CONTROLLER_ABI,
              functionName: "available",
              args: [lookup.target.label],
            },
          ],
        })
    )

    const owner =
      ownerResult.status === "success" ? (ownerResult.result as Address) : null

    if (expiryResult.status === "failure") {
      throw expiryResult.error
    }

    if (availableResult.status === "failure") {
      throw availableResult.error
    }

    const expiresAt = expiryResult.result as bigint
    const available = availableResult.result === true

    return { available, expiresAt, owner }
  }, [lookup, publicClient, walletAddress])

  const recoverApprovalTransactionHash = useCallback(
    async ({
      minimumAllowance,
      ownerAddress,
      spenderAddress,
      startBlock,
    }: {
      minimumAllowance: bigint
      ownerAddress: Address
      spenderAddress: Address
      startBlock: bigint
    }) => {
      if (!publicClient) {
        return null
      }

      for (let attempt = 0; attempt < MAX_CONFIRMATION_POLLS; attempt += 1) {
        let logs
        try {
          logs = await runAnsRpcRead(
            `approval-log:${ownerAddress}:${spenderAddress}:${startBlock}:${attempt}`,
            () =>
              publicClient.getLogs({
                address: contracts.usdc,
                event: ERC20_APPROVAL_EVENT,
                args: {
                  owner: ownerAddress,
                  spender: spenderAddress,
                },
                fromBlock: startBlock,
              })
          )
        } catch (error) {
          if (isTransientAnsRpcError(error)) {
            return null
          }
          throw error
        }

        const matchedLog = [...logs]
          .reverse()
          .find(
            (log) =>
              isHexTransactionHash(log.transactionHash ?? null) &&
              typeof log.args.value === "bigint" &&
              log.args.value >= minimumAllowance
          )

        if (matchedLog?.transactionHash && isHexTransactionHash(matchedLog.transactionHash)) {
          return matchedLog.transactionHash
        }

        if (attempt < MAX_CONFIRMATION_POLLS - 1) {
          await waitFor(POLL_INTERVAL_MS)
        }
      }

      return null
    },
    [contracts.usdc, publicClient]
  )

  const recoverRegistrationTransactionHash = useCallback(
    async ({
      ownerAddress,
      registrarAddress,
      startBlock,
      tokenId,
    }: {
      ownerAddress: Address
      registrarAddress: Address
      startBlock: bigint
      tokenId: bigint
    }) => {
      if (!publicClient) {
        return null
      }

      for (let attempt = 0; attempt < MAX_CONFIRMATION_POLLS; attempt += 1) {
        let logs
        try {
          logs = await runAnsRpcRead(
            `registration-log:${ownerAddress}:${tokenId}:${startBlock}:${attempt}`,
            () =>
              publicClient.getLogs({
                address: registrarAddress,
                event: ERC721_TRANSFER_EVENT,
                args: {
                  to: ownerAddress,
                  tokenId,
                },
                fromBlock: startBlock,
              })
          )
        } catch (error) {
          if (isTransientAnsRpcError(error)) {
            return null
          }
          throw error
        }

        const matchedLog = [...logs]
          .reverse()
          .find(
            (log) =>
              isHexTransactionHash(log.transactionHash ?? null) &&
              typeof log.args.from === "string" &&
              log.args.from.toLowerCase() === ZERO_ADDRESS
          )

        if (matchedLog?.transactionHash && isHexTransactionHash(matchedLog.transactionHash)) {
          return matchedLog.transactionHash
        }

        if (attempt < MAX_CONFIRMATION_POLLS - 1) {
          await waitFor(POLL_INTERVAL_MS)
        }
      }

      return null
    },
    [publicClient]
  )

  const waitForAllowanceUpdate = useCallback(
    async (
      txHash: Hex | null,
      minimumAllowance: bigint,
      recoveryContext?: {
        ownerAddress: Address
        spenderAddress: Address
        startBlock: bigint
      }
    ) => {
      if (!publicClient) {
        throw new Error("Arc public client is not ready yet.")
      }

      if (txHash) {
        try {
          const receipt = await runAnsRpcRead(`approval-receipt:${txHash}`, () =>
            publicClient.getTransactionReceipt({ hash: txHash })
          )
          assertSuccessfulAnsReceipt("approval", txHash, receipt.status)
        } catch (error) {
          if (!isTransientAnsRpcError(error)) {
            const message = error instanceof Error ? error.message : String(error)
            if (!message.toLowerCase().includes("not found")) {
              throw error
            }
          }
        }
      }

      for (let attempt = 0; attempt < MAX_CONFIRMATION_POLLS; attempt += 1) {
        try {
          const currentAllowance = await readCurrentAllowance()
          if (currentAllowance < minimumAllowance) {
            throw new Error("ANS allowance is still pending confirmation.")
          }

          if (!txHash && recoveryContext) {
            return recoverApprovalTransactionHash({
              minimumAllowance,
              ownerAddress: recoveryContext.ownerAddress,
              spenderAddress: recoveryContext.spenderAddress,
              startBlock: recoveryContext.startBlock,
            })
          }

          return txHash
        } catch (error) {
          const isPending =
            error instanceof Error &&
            error.message === "ANS allowance is still pending confirmation."
          if (!isPending && !isTransientAnsRpcError(error)) {
            throw error
          }
        }

        if (attempt < MAX_CONFIRMATION_POLLS - 1) {
          await waitFor(POLL_INTERVAL_MS)
        }
      }

      throw new Error(
        "Approval completed, but the USDC allowance did not refresh before the timeout window ended."
      )
    },
    [publicClient, readCurrentAllowance, recoverApprovalTransactionHash]
  )

  const waitForOwnershipUpdate = useCallback(
    async (
      txHash: Hex | null,
      nextLookup: AnsDomainLookup,
      ownerAddress: Address,
      startBlock: bigint
    ) => {
      if (!publicClient) {
        throw new Error("Arc public client is not ready yet.")
      }

      if (txHash) {
        try {
          const receipt = await runAnsRpcRead(`registration-receipt:${txHash}`, () =>
            publicClient.getTransactionReceipt({ hash: txHash })
          )
          assertSuccessfulAnsReceipt("registration", txHash, receipt.status)
        } catch (error) {
          if (!isTransientAnsRpcError(error)) {
            const message = error instanceof Error ? error.message : String(error)
            if (!message.toLowerCase().includes("not found")) {
              throw error
            }
          }
        }
      }

      const expectedOwner = ownerAddress.toLowerCase()

      for (let attempt = 0; attempt < MAX_CONFIRMATION_POLLS; attempt += 1) {
        try {
          const state = await readRegistrationState()
          if (
            state.owner?.toLowerCase() === expectedOwner &&
            state.expiresAt > BigInt(Math.floor(Date.now() / 1000))
          ) {
            const resolvedTxHash = txHash
              ? txHash
              : await recoverRegistrationTransactionHash({
                  ownerAddress,
                  registrarAddress: nextLookup.namespaceSnapshot.registrar,
                  startBlock,
                  tokenId: nextLookup.tokenId,
                })

            return {
              ownerAddress: state.owner,
              expiresAt: state.expiresAt,
              txHash: resolvedTxHash,
            }
          }

          if (state.owner && !state.available) {
            throw new Error("This ANS name was registered by another wallet.")
          }
        } catch (error) {
          if (!isTransientAnsRpcError(error)) {
            throw error
          }
        }

        if (attempt < MAX_CONFIRMATION_POLLS - 1) {
          await waitFor(POLL_INTERVAL_MS)
        }
      }

      throw new Error(
        "Registration challenge completed, but ownership did not refresh before the timeout window ended."
      )
    },
    [publicClient, readRegistrationState, recoverRegistrationTransactionHash]
  )

  const performApproval = useCallback(async ({ showToast = true }: { showToast?: boolean } = {}) => {
    if (!lookup) {
      throw new Error("Search for a supported ANS name before approving USDC.")
    }

    if (!walletAddress) {
      throw new Error("Connect the active wallet before approving USDC.")
    }

    if (!publicClient) {
      throw new Error("Arc public client is not ready yet.")
    }

    setStep("approving")
    setErrorMessage(null)

    try {
      await executeAnsStepOnce({
        pendingSubmission: approvalSubmissionRef,
        checkCompleted: async () => {
          try {
            return (await readCurrentAllowance()) >= lookup.rentPrice ? true : null
          } catch (error) {
            throw toAnsRegistrationError(error, "approval_preflight")
          }
        },
        submit: async () => {
          try {
            const result = await executeTransaction({
              abi: ERC20_ABI,
              args: [lookup.namespaceSnapshot.controller, lookup.rentPrice],
              chainId: arcTestnet.id,
              contractAddress: contracts.usdc,
              functionName: "approve",
              idempotencyKey: getIdempotencyKey("approve"),
              refId: `ANS-APPROVE-${lookup.target.domain}`,
            })
            const nextApprovalHash = result.txHash ?? result.hash
            setApprovalHash(nextApprovalHash)
            setSubmissionHash(nextApprovalHash)
            return result
          } catch (error) {
            throw toAnsRegistrationError(error, "approval")
          }
        },
        confirm: async (result) => {
          const nextApprovalHash = result.txHash ?? result.hash
          const resolvedApprovalHash = await waitForAllowanceUpdate(
            result.txHash,
            lookup.rentPrice,
            {
              ownerAddress: walletAddress,
              spenderAddress: lookup.namespaceSnapshot.controller,
              startBlock: result.startBlock,
            }
          )

          if (resolvedApprovalHash && resolvedApprovalHash !== nextApprovalHash) {
            setApprovalHash(resolvedApprovalHash)
            setSubmissionHash(resolvedApprovalHash)
          }

          return true
        },
      })
      void refetchTokenState().catch(() => undefined)
      setStep("idle")

      if (showToast) {
        toast({
          title: "USDC approved",
          description: `${lookup.target.domain} can now be registered from this wallet.`,
        })
      }
    } catch (error) {
      throw handleRegistrationError(error, "approval_confirmation")
    }
  }, [
    contracts.usdc,
    executeTransaction,
    getIdempotencyKey,
    handleRegistrationError,
    lookup,
    publicClient,
    readCurrentAllowance,
    refetchTokenState,
    toast,
    waitForAllowanceUpdate,
    walletAddress,
  ])

  const approve = useCallback(async () => {
    await executeAnsFlowOnce(approvalInFlightRef, () =>
      performApproval({ showToast: true })
    )
  }, [performApproval])

  const performRegistration = useCallback(async () => {
    if (!lookup) {
      throw new Error("Search for an available ANS name before registering.")
    }

    if (!walletAddress) {
      throw new Error("Connect the active wallet before registering.")
    }

    if (insufficientBalance) {
      throw new Error("The active wallet does not have enough USDC for this registration.")
    }

    setStep("registering")
    setErrorMessage(null)

    try {
      const resolverAddress = lookup.namespaceSnapshot.defaultResolver || contracts.resolver
      let submittedReference = registrationSubmissionRef.current?.hash ?? null
      const nextConfirmation = await executeAnsStepOnce({
        pendingSubmission: registrationSubmissionRef,
        checkCompleted: async () => {
          let state
          try {
            state = await readRegistrationState()
          } catch (error) {
            throw toAnsRegistrationError(error, "registration_preflight")
          }
          const isCurrentOwner =
            state.owner?.toLowerCase() === walletAddress.toLowerCase() &&
            state.expiresAt > BigInt(Math.floor(Date.now() / 1000))

          if (isCurrentOwner) {
            return {
              ownerAddress: state.owner!,
              expiresAt: state.expiresAt,
              txHash: registrationSubmissionRef.current?.txHash ?? null,
            }
          }

          if (!state.available) {
            throw new Error("This ANS name is no longer available.")
          }

          return null
        },
        submit: async () => {
          try {
            const result = await executeTransaction({
              abi: ANS_NAMESPACE_CONTROLLER_ABI,
              args: [
                lookup.target.label,
                walletAddress,
                lookup.durationSeconds,
                resolverAddress,
                walletAddress,
                [],
                [],
              ],
              chainId: arcTestnet.id,
              contractAddress: lookup.namespaceSnapshot.controller,
              functionName: "register",
              idempotencyKey: getIdempotencyKey("register"),
              refId: `ANS-REGISTER-${lookup.target.domain}`,
            })
            const nextRegistrationHash = result.txHash ?? result.hash
            submittedReference = nextRegistrationHash
            setRegistrationHash(nextRegistrationHash)
            setSubmissionHash(nextRegistrationHash)
            return result
          } catch (error) {
            throw toAnsRegistrationError(error, "registration")
          }
        },
        confirm: (result) =>
          waitForOwnershipUpdate(
            result.txHash,
            lookup,
            walletAddress,
            result.startBlock
          ),
      })

      const resolvedRegistrationHash =
        nextConfirmation.txHash ?? submittedReference

      if (resolvedRegistrationHash) {
        setRegistrationHash(resolvedRegistrationHash)
        setSubmissionHash(resolvedRegistrationHash)
      }

      recordAnsRegistrationActivity({
        amount: lookup.rentPrice,
        domain: lookup.target.domain,
        durationYears: lookup.durationYears,
        txHash: isHexTransactionHash(resolvedRegistrationHash)
          ? resolvedRegistrationHash
          : null,
        walletAddress,
      })

      setConfirmation(nextConfirmation)
      void refetchTokenState().catch(() => undefined)
      setStep("success")

      toast({
        title: "Registration submitted",
        description: `${lookup.target.domain} now resolves to the active wallet via the current default resolver.`,
      })

      onRegistered?.(lookup.target.domain)

      return nextConfirmation
    } catch (error) {
      throw handleRegistrationError(error, "registration_confirmation")
    }
  }, [
    contracts.resolver,
    executeTransaction,
    getIdempotencyKey,
    handleRegistrationError,
    insufficientBalance,
    lookup,
    onRegistered,
    refetchTokenState,
    readRegistrationState,
    toast,
    waitForOwnershipUpdate,
    walletAddress,
  ])

  const register = useCallback(() => {
    return executeAnsFlowOnce(submitInFlightRef, async () => {
      if (needsApproval) {
        throw new Error("Approve USDC first, then submit the registration.")
      }

      return performRegistration()
    })
  }, [needsApproval, performRegistration])

  const submit = useCallback(() => {
    return executeAnsFlowOnce(submitInFlightRef, async () => {
      if (needsApproval) {
        await performApproval({ showToast: false })
      }

      return performRegistration()
    })
  }, [needsApproval, performApproval, performRegistration])

  return {
    allowance,
    approvalHash,
    balance,
    canRegister,
    confirmation,
    errorMessage,
    insufficientBalance,
    needsApproval,
    registrationHash,
    requiredAmount,
    step,
    submissionHash,
    approve,
    register,
    submit,
    resetFeedback,
  }
}
