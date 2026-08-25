import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const swapScreen = readFileSync(
  resolve(root, "components/dashboard/SwapScreen.tsx"),
  "utf8",
);
const bridgePanel = readFileSync(
  resolve(root, "components/dashboard/ExternalBridgePanel.tsx"),
  "utf8",
);

describe("external-only bridge architecture", () => {
  it("exposes Bridge mode only through the External Wallet branch", () => {
    expect(swapScreen).toContain("const modeSelector = isExternal ?");
    expect(swapScreen).toContain(
      'effectiveScreenMode === "bridge" && isExternal && walletAddress',
    );
    expect(swapScreen).toContain("<ExternalBridgePanel");
  });

  it("keeps every bridge write on the connected browser wallet", () => {
    expect(bridgePanel.match(/signer\.writeContract/g)).toHaveLength(3);
    expect(bridgePanel).toContain('functionName: "approve"');
    expect(bridgePanel).toContain('functionName: "depositForBurn"');
    expect(bridgePanel).toContain('functionName: "receiveMessage"');
    expect(bridgePanel).not.toMatch(/entity.?secret|private.?key|treasury/i);
  });

  it("does not retain the standalone or App Kit bridge implementation", () => {
    expect(existsSync(resolve(root, "app/bridge/page.tsx"))).toBe(false);
    expect(
      existsSync(resolve(root, "components/dashboard/BridgeScreen.tsx")),
    ).toBe(false);
    expect(bridgePanel.toLowerCase()).not.toContain("appkit");
    expect(bridgePanel.toLowerCase()).not.toContain("swapkit");
  });

  it("uses only the direct CCTP destination completion action", () => {
    expect(bridgePanel.toLowerCase()).not.toContain(
      ["resume", "bridge"].join(" "),
    );
    expect(bridgePanel).not.toContain(["handleStartOr", "Resume"].join(""));
    expect(bridgePanel).not.toContain(["MintAnd", "Withdraw"].join(""));
    expect(bridgePanel).toContain("Complete mint on");
  });

  it("has no active dependency on backend bridge lifecycle APIs", () => {
    expect(bridgePanel).not.toContain("@/lib/bridge-api");
    expect(bridgePanel).not.toMatch(
      /bridge\/intents|leaseId|BridgeIntentResponse/,
    );
    expect(bridgePanel).toContain("fetchIrisMessages");
    expect(bridgePanel).toContain("readNonceState");
    expect(bridgePanel).toContain("readDirectBridgeRecovery");
  });

  it("keeps recovery read-only until the precise destination mint action", () => {
    expect(bridgePanel).toContain("Recover existing transfer");
    expect(bridgePanel).toContain("Complete mint on");
    expect(bridgePanel).not.toContain("getBridgeIntent");
    expect(bridgePanel).not.toContain("createBridgeIntent");
  });
});
