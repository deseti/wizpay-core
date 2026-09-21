import type {
  ArcCapabilities,
  ArcCapabilityName,
  ArcNetworkKey,
} from "@wizpay/arc-network";
import { backendFetch } from "@/lib/backend-api";

export const CAPABILITY_UNAVAILABLE_MESSAGE =
  "This feature is unavailable on Arc Mainnet.";

export type CapabilityResponse = Readonly<{
  network: ArcNetworkKey;
  capabilities: ArcCapabilities;
}>;

export async function fetchEffectiveCapabilities(): Promise<CapabilityResponse> {
  const response = await backendFetch<CapabilityResponse>("/capabilities");
  if (response.network !== "arc-mainnet") {
    throw new Error(
      "Backend capability network does not match Arc Mainnet.",
    );
  }
  const expected = [
    "send",
    "sameTokenPayroll",
    "invoice",
    "paymentLink",
    "liquidity",
    "bridge",
    "swap",
    "crossTokenPayroll",
    "crossTokenInvoice",
    "nanoAgentApi",
  ] satisfies ArcCapabilityName[];
  const keys = Object.keys(response.capabilities);
  if (
    keys.length !== expected.length ||
    expected.some((key) => typeof response.capabilities[key] !== "boolean") ||
    keys.some((key) => !expected.includes(key as ArcCapabilityName))
  ) {
    throw new Error("Backend capability response is malformed.");
  }
  return Object.freeze(response);
}
