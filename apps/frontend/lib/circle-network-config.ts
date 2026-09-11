import { parseArcNetworkKey } from "@wizpay/arc-network";

export type FrontendCircleEnvironment = Record<string, string | undefined>;

export function circleRuntimeNamespace(selector: unknown) {
  return `wizpay.${parseArcNetworkKey(selector)}.circle`;
}

export function resolveFrontendCircleApplicationId(
  selector: unknown,
  environment: FrontendCircleEnvironment,
) {
  const network = parseArcNetworkKey(selector);
  if (environment.NEXT_PUBLIC_CIRCLE_APP_ID !== undefined) {
    throw new Error(
      "NEXT_PUBLIC_CIRCLE_APP_ID is ambiguous; use a network-scoped Circle App ID.",
    );
  }
  const testnetAppId = environment.NEXT_PUBLIC_CIRCLE_TESTNET_APP_ID;
  const mainnetAppId = environment.NEXT_PUBLIC_CIRCLE_MAINNET_APP_ID;
  if (testnetAppId && mainnetAppId && testnetAppId === mainnetAppId) {
    throw new Error("Circle Testnet and Mainnet App IDs must be distinct.");
  }
  const selectedKey =
    network === "arc-testnet"
      ? "NEXT_PUBLIC_CIRCLE_TESTNET_APP_ID"
      : "NEXT_PUBLIC_CIRCLE_MAINNET_APP_ID";
  const selected = environment[selectedKey];
  if (
    selected !== undefined &&
    selected !== "" &&
    selected !== selected.trim()
  ) {
    throw new Error(
      "The selected Circle App ID must be a non-empty exact value.",
    );
  }
  // Arc Mainnet has no verified Circle blockchain identifier, so browser
  // wallet initialization remains unavailable regardless of an App ID value.
  return network === "arc-testnet" ? (selected ?? "") : "";
}
