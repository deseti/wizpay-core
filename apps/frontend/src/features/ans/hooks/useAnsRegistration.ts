"use client"

import { useCallback, useMemo, useState } from "react"
import { type Address, type Hex } from "viem"
import { usePublicClient, useReadContract } from "wagmi"

import { ERC20_ABI } from "@/constants/erc20"
import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress"
import { useToast } from "@/hooks/use-toast"
import { useTransactionExecutor } from "@/hooks/useTransactionExecutor"
import { arcTestnet } from "@/lib/wagmi"

import {
  ANS_NAMESPACE_REGISTRAR_ABI,
  ANS_NAMESPACE_CONTROLLER_ABI,
} from "../contracts/abis"
import { getAnsContractsConfig } from "../services/ans-config"
import { recordAnsRegistrationActivity } from "../utils/storage"
import type {
  AnsDomainLookup,
  AnsRegistrationConfirmation,
} from "../types/ans"

type RegistrationStep = "idle" | "approving" | "registering" | "success" | "error"

const MAX_CONFIRMATION_POLLS = 20
const POLL_INTERVAL_MS = 1_500
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

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

function getReadableErrorMessage(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const shortMessage = Reflect.get(error, "shortMessage")
    if (typeof shortMessage === "string") {
      return shortMessage
    }

    const message = Reflect.get(error, "message")
    if (typeof message === "string") {
      return message
    }
  }

  return "Transaction rejected or failed."
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

  const requiredAmount = lookup?.rentPrice ?? 0n

  const { data: allowanceData, refetch: refetchAllowance } = useReadContract({
    address: contracts.usdc,
    abi: ERC20_ABI,
    chainId: arcTestnet.id,
    functionName: "allowance",
    args: walletAddress && lookup ? [walletAddress, lookup.namespaceSnapshot.controller] : undefined,
    query: {
      enabled: Boolean(walletAddress && lookup),
      staleTime: 5_000,
    },
  })

  const { data: balanceData, refetch: refetchBalance } = useReadContract({
    address: contracts.usdc,
    abi: ERC20_ABI,
    chainId: arcTestnet.id,
    functionName: "balanceOf",
    args: walletAddress ? [walletAddress] : undefined,
    query: {
      enabled: Boolean(walletAddress),
      staleTime: 5_000,
    },
  })

  const allowance = allowanceData ?? 0n
  const balance = balanceData ?? 0n
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
  }, [])

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
        const logs = await publicClient.getLogs({
          address: contracts.usdc,
          event: ERC20_APPROVAL_EVENT,
          args: {
            owner: ownerAddress,
            spender: spenderAddress,
          },
          fromBlock: startBlock,
        })

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
        const logs = await publicClient.getLogs({
          address: registrarAddress,
          event: ERC721_TRANSFER_EVENT,
          args: {
            to: ownerAddress,
            tokenId,
          },
          fromBlock: startBlock,
        })

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
          await publicClient.waitForTransactionReceipt({
            hash: txHash,
            confirmations: 1,
          })
        } catch {
          // Keep polling allowance even when the receipt read is unavailable.
        }
      }

      for (let attempt = 0; attempt < MAX_CONFIRMATION_POLLS; attempt += 1) {
        const result = await refetchAllowance()
        if ((result.data ?? 0n) >= minimumAllowance) {
          if (!txHash && recoveryContext) {
            return recoverApprovalTransactionHash({
              minimumAllowance,
              ownerAddress: recoveryContext.ownerAddress,
              spenderAddress: recoveryContext.spenderAddress,
              startBlock: recoveryContext.startBlock,
            })
          }

          return txHash
        }

        if (attempt < MAX_CONFIRMATION_POLLS - 1) {
          await waitFor(POLL_INTERVAL_MS)
        }
      }

      throw new Error(
        "Approval completed, but the USDC allowance did not refresh before the timeout window ended."
      )
    },
    [publicClient, recoverApprovalTransactionHash, refetchAllowance]
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
          await publicClient.waitForTransactionReceipt({
            hash: txHash,
            confirmations: 1,
          })
        } catch {
          // Fall through to polling the registrar state directly.
        }
      }

      const expectedOwner = ownerAddress.toLowerCase()

      for (let attempt = 0; attempt < MAX_CONFIRMATION_POLLS; attempt += 1) {
        const expiresAt = await publicClient.readContract({
          address: nextLookup.namespaceSnapshot.registrar,
          abi: ANS_NAMESPACE_REGISTRAR_ABI,
          functionName: "nameExpires",
          args: [nextLookup.tokenId],
        })

        let owner: Address | null = null
        try {
          owner = await publicClient.readContract({
            address: nextLookup.namespaceSnapshot.registrar,
            abi: ANS_NAMESPACE_REGISTRAR_ABI,
            functionName: "ownerOf",
            args: [nextLookup.tokenId],
          })
        } catch {
          owner = null
        }

        if (
          owner?.toLowerCase() === expectedOwner &&
          expiresAt > BigInt(Math.floor(Date.now() / 1000))
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
            ownerAddress: owner,
            expiresAt,
            txHash: resolvedTxHash,
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
    [publicClient, recoverRegistrationTransactionHash]
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
      const result = await executeTransaction({
        abi: ERC20_ABI,
        args: [lookup.namespaceSnapshot.controller, lookup.rentPrice],
        chainId: arcTestnet.id,
        contractAddress: contracts.usdc,
        functionName: "approve",
        refId: `ANS-APPROVE-${lookup.target.domain}-${Date.now()}`,
      })

      const nextApprovalHash = result.txHash ?? result.hash

      setApprovalHash(nextApprovalHash)
      setSubmissionHash(nextApprovalHash)
      const resolvedApprovalHash = await waitForAllowanceUpdate(result.txHash, lookup.rentPrice, {
        ownerAddress: walletAddress,
        spenderAddress: lookup.namespaceSnapshot.controller,
        startBlock: result.startBlock,
      })

      if (resolvedApprovalHash && resolvedApprovalHash !== nextApprovalHash) {
        setApprovalHash(resolvedApprovalHash)
        setSubmissionHash(resolvedApprovalHash)
      }

      await refetchAllowance()
      setStep("idle")

      if (showToast) {
        toast({
          title: "USDC approved",
          description: `${lookup.target.domain} can now be registered from this wallet.`,
        })
      }
    } catch (error) {
      const message = getReadableErrorMessage(error)
      setStep("error")
      setErrorMessage(message)
      throw new Error(message)
    }
  }, [
    contracts.usdc,
    executeTransaction,
    lookup,
    publicClient,
    refetchAllowance,
    toast,
    waitForAllowanceUpdate,
    walletAddress,
  ])

  const approve = useCallback(async () => {
    await performApproval({ showToast: true })
  }, [performApproval])

  const performRegistration = useCallback(async () => {
    if (!lookup) {
      throw new Error("Search for an available ANS name before registering.")
    }

    if (!walletAddress) {
      throw new Error("Connect the active wallet before registering.")
    }

    if (!lookup.available) {
      throw new Error("This name is no longer available.")
    }

    if (insufficientBalance) {
      throw new Error("The active wallet does not have enough USDC for this registration.")
    }

    setStep("registering")
    setErrorMessage(null)

    try {
      const resolverAddress = lookup.namespaceSnapshot.defaultResolver || contracts.resolver
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
        refId: `ANS-REGISTER-${lookup.target.domain}-${Date.now()}`,
      })

      const nextRegistrationHash = result.txHash ?? result.hash

      setRegistrationHash(nextRegistrationHash)
      setSubmissionHash(nextRegistrationHash)

      const nextConfirmation = await waitForOwnershipUpdate(
        result.txHash,
        lookup,
        walletAddress,
        result.startBlock
      )

      const resolvedRegistrationHash = nextConfirmation.txHash ?? nextRegistrationHash

      if (resolvedRegistrationHash !== nextRegistrationHash) {
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
      await Promise.all([refetchAllowance(), refetchBalance()])
      setStep("success")

      toast({
        title: "Registration submitted",
        description: `${lookup.target.domain} now resolves to the active wallet via the current default resolver.`,
      })

      onRegistered?.(lookup.target.domain)

      return nextConfirmation
    } catch (error) {
      const message = getReadableErrorMessage(error)
      setStep("error")
      setErrorMessage(message)
      throw new Error(message)
    }
  }, [
    contracts.resolver,
    executeTransaction,
    insufficientBalance,
    lookup,
    onRegistered,
    refetchAllowance,
    refetchBalance,
    toast,
    waitForOwnershipUpdate,
    walletAddress,
  ])

  const register = useCallback(async () => {
    if (needsApproval) {
      throw new Error("Approve USDC first, then submit the registration.")
    }

    return performRegistration()
  }, [needsApproval, performRegistration])

  const submit = useCallback(async () => {
    if (needsApproval) {
      await performApproval({ showToast: false })
    }

    return performRegistration()
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