import {
  createFrontendBuildSafeArcNetworkConfiguration,
  validateFrontendArcNetworkOverrides,
} from "@/lib/arc-network";

export const ACTIVE_ARC_NETWORK =
  createFrontendBuildSafeArcNetworkConfiguration(
    process.env.NEXT_PUBLIC_WIZPAY_ARC_NETWORK,
  );

validateFrontendArcNetworkOverrides(ACTIVE_ARC_NETWORK, process.env);
