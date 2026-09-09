import type {
  ArcCapabilities,
  ArcCapabilityName,
  ArcNetworkKey,
} from "@wizpay/arc-network";
import { backendFetch } from "@/lib/backend-api";

export const CAPABILITY_UNAVAILABLE_MESSAGE =
  "This feature is unavailable on the selected Arc network.";

export type CapabilityResponse = Readonly<{
  network: ArcNetworkKey;
  capabilities: ArcCapabilities;
}>;

export async function fetchEffectiveCapabilities(): Promise<CapabilityResponse> {
  const response = await backendFetch<CapabilityResponse>("/capabilities");
  if (response.network !== process.env.NEXT_PUBLIC_WIZPAY_ARC_NETWORK) {
    throw new Error(
      "Backend capability network does not match the selected Arc network.",
    );
  }
  const expected = [
    "send",
    "sameTokenPayroll",
    "invoice",
    "paymentLink",
    "bridge",
    "swap",
    "crossTokenPayroll",
    "crossTokenInvoice",
    "stableFx",
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
