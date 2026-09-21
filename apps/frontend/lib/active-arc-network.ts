import {
  createFrontendBuildSafeArcNetworkConfiguration,
  validateFrontendArcNetworkOverrides,
} from "@/lib/arc-network";

function resolveMainnetSelector(value: string | undefined): "arc-mainnet" {
  if (value !== undefined && value !== "" && value !== "arc-mainnet") {
    throw new Error("Only Arc Mainnet is supported.");
  }
  return "arc-mainnet";
}

export const ACTIVE_ARC_NETWORK =
  createFrontendBuildSafeArcNetworkConfiguration(
    resolveMainnetSelector(process.env.NEXT_PUBLIC_WIZPAY_ARC_NETWORK),
  );

validateFrontendArcNetworkOverrides(ACTIVE_ARC_NETWORK, process.env);
