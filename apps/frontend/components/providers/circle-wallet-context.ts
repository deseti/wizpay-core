"use client";

import { createContext } from "react";
import type { CircleWalletContextValue } from "@/services/circle-auth.service";

/**
 * Shared Circle wallet React context.
 *
 * Arc Testnet mounts the full CircleWalletProvider (SDK + auth state).
 * Arc Mainnet mounts CircleDisabledProvider instead: the same context shape
 * with a static inert value, so Mainnet never initializes the Circle SDK or
 * any Circle auth state while direct useCircleWallet consumers still render.
 */
export const CircleWalletContext =
  createContext<CircleWalletContextValue | null>(null);
