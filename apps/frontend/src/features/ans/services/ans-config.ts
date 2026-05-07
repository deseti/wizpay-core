import type { Address } from "viem"

import { USDC_ADDRESS } from "@/constants/addresses"
import { arcTestnet } from "@/lib/wagmi"

import type { AnsContractsConfig } from "../types/ans"

const DEFAULT_ROOT_REGISTRY =
  "0xe180BB11426522cd131118686B4146C9bc58DF04" as Address
const DEFAULT_REGISTRY =
  "0x3885E01e3439fc094B083E834Fb4cD36211BEd84" as Address
const DEFAULT_RESOLVER =
  "0xEe8BA7dDA26e4FD0429cEc79E50179D9e548743f" as Address
const DEFAULT_PLATFORM_VAULT =
  "0x2eBecDBcCff545Ce4A33939D730411Ee7eBbDEDC" as Address
const DEFAULT_ARC_REGISTRAR =
  "0x8704960CC983B4072972f2eb4E4fBd38486c41D8" as Address
const DEFAULT_ARC_CONTROLLER =
  "0x201ffB769476976dF29BDbe95064cAB59c6e12c3" as Address
const DEFAULT_WIZPAY_REGISTRAR =
  "0x7c2da2860024cb10ef74c3ab27396ff57f5d852d" as Address
const DEFAULT_WIZPAY_CONTROLLER =
  "0x9022004b3a28605284c4ec0ebebd806061b7b668" as Address
const DEFAULT_WIZPAY_VAULT =
  "0x2e99c3f927d415d9caa5c4f001ed46f48f2a651b" as Address

let cachedConfig: AnsContractsConfig | null = null

function readAddress(keys: string[], fallback: Address): Address {
  const configured = keys
    .map((key) => process.env[key]?.trim())
    .find((value): value is string => Boolean(value))

  return (configured || fallback) as Address
}

export function getAnsContractsConfig(): AnsContractsConfig {
  if (cachedConfig) {
    return cachedConfig
  }

  cachedConfig = {
    chainId: arcTestnet.id,
    rootRegistry: readAddress(["NEXT_PUBLIC_ANS_ROOT_REGISTRY"], DEFAULT_ROOT_REGISTRY),
    registry: readAddress(["NEXT_PUBLIC_ANS_REGISTRY"], DEFAULT_REGISTRY),
    resolver: readAddress(["NEXT_PUBLIC_ANS_RESOLVER"], DEFAULT_RESOLVER),
    usdc: readAddress(["NEXT_PUBLIC_ARC_USDC", "ARC_USDC"], USDC_ADDRESS),
    namespaces: {
      arc: {
        key: "arc",
        label: "Arc",
        suffix: ".arc",
        registrar: readAddress(["NEXT_PUBLIC_ANS_ARC_REGISTRAR"], DEFAULT_ARC_REGISTRAR),
        controller: readAddress(["NEXT_PUBLIC_ANS_ARC_CONTROLLER"], DEFAULT_ARC_CONTROLLER),
        configuredVault: readAddress(["NEXT_PUBLIC_ANS_PLATFORM_VAULT"], DEFAULT_PLATFORM_VAULT),
      },
      wizpay: {
        key: "wizpay",
        label: "WizPay",
        suffix: ".wizpay",
        registrar: readAddress(["NEXT_PUBLIC_ANS_WIZPAY_REGISTRAR"], DEFAULT_WIZPAY_REGISTRAR),
        controller: readAddress(["NEXT_PUBLIC_ANS_WIZPAY_CONTROLLER"], DEFAULT_WIZPAY_CONTROLLER),
        configuredVault: readAddress(["NEXT_PUBLIC_ANS_WIZPAY_VAULT"], DEFAULT_WIZPAY_VAULT),
      },
    },
  }

  return cachedConfig
}