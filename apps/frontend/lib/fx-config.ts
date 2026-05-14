/**
 * FX Mode Configuration
 *
 * Controls whether WizPay uses the legacy custom StableFXAdapter
 * or the official Circle StableFX + Permit2 + FxEscrow architecture.
 *
 * Set via environment variable:
 *   NEXT_PUBLIC_USE_REAL_STABLEFX=false  -> Legacy adapter mode for isolated testing
 *   any other value / omitted            -> Circle StableFX mode
 */

import {
  STABLE_FX_ADAPTER_V2_ADDRESS,
  FX_ESCROW_ADDRESS,
  PERMIT2_ADDRESS,
} from "@/constants/addresses";

export type FxMode = "legacy" | "stablefx";

/**
 * Active FX mode, derived from the environment variable.
 * Defaults to the official Circle StableFX flow. The legacy adapter must be
 * explicitly enabled for isolated non-production testing.
 */
export const fxMode: FxMode =
  process.env.NEXT_PUBLIC_USE_REAL_STABLEFX === "false" ? "legacy" : "stablefx";

/** True when using the official Circle StableFX RFQ flow */
export const isStableFxMode = fxMode === "stablefx";

/** True when using the legacy custom adapter vault */
export const isLegacyMode = fxMode === "legacy";

/**
 * The on-chain address that holds FX liquidity for the active mode.
 * - Legacy: StableFXAdapter_V2 (custom vault)
 * - StableFX: FxEscrow (Circle's settlement contract)
 */
export const activeFxEngineAddress = isStableFxMode
  ? FX_ESCROW_ADDRESS
  : STABLE_FX_ADAPTER_V2_ADDRESS;

/**
 * Permit2 contract address. Only relevant in StableFX mode.
 * In legacy mode, standard ERC-20 approve() is used instead.
 */
export const permit2Address = PERMIT2_ADDRESS;

/** Human-readable label for the active FX provider */
export const fxProviderLabel = isStableFxMode
  ? "Circle StableFX"
  : "StableFX Adapter V2";
