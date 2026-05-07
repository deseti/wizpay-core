"use client"

import { useEffect, useMemo, useState } from "react"
import { type Address, type Hex } from "viem"

import type { UnifiedHistoryItem } from "@/lib/types"

import { getAnsContractsConfig } from "../services/ans-config"
import {
  ANS_ACTIVITY_UPDATED_EVENT,
  readAnsRegistrationActivity,
} from "../utils/storage"

function isHexTransactionHash(value: string | null | undefined): value is Hex {
  return /^0x[a-fA-F0-9]{64}$/.test(value ?? "")
}

export function useAnsActivityHistory(walletAddress?: Address) {
  const [items, setItems] = useState(readAnsRegistrationActivity)
  const usdcAddress = getAnsContractsConfig().usdc

  useEffect(() => {
    const syncItems = () => {
      setItems(readAnsRegistrationActivity())
    }

    syncItems()

    window.addEventListener(ANS_ACTIVITY_UPDATED_EVENT, syncItems)
    window.addEventListener("storage", syncItems)

    return () => {
      window.removeEventListener(ANS_ACTIVITY_UPDATED_EVENT, syncItems)
      window.removeEventListener("storage", syncItems)
    }
  }, [])

  return useMemo<UnifiedHistoryItem[]>(() => {
    const normalizedWalletAddress = walletAddress?.toLowerCase()

    return items
      .filter((item) => {
        if (!normalizedWalletAddress) {
          return true
        }

        return (
          !item.walletAddress ||
          item.walletAddress.toLowerCase() === normalizedWalletAddress
        )
      })
      .map((item) => ({
        type: "ans" as const,
        txHash: isHexTransactionHash(item.txHash)
          ? item.txHash
          : ("0x" as Hex),
        blockNumber: 0n,
        timestampMs: item.timestampMs,
        tokenIn: usdcAddress,
        totalAmountIn: BigInt(item.amount),
        referenceId: item.domain,
        ansDomain: item.domain,
        ansDurationYears: item.durationYears,
      }))
      .sort((left, right) => right.timestampMs - left.timestampMs)
  }, [items, usdcAddress, walletAddress])
}