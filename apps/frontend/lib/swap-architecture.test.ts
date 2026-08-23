import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const screen = readFileSync(
  resolve(root, "components/dashboard/SwapScreen.tsx"),
  "utf8",
);
const appLifecycle = readFileSync(
  resolve(root, "lib/app-wallet-xylonet-lifecycle.ts"),
  "utf8",
);

describe("canonical swap signing boundaries", () => {
  it("keeps App Wallet signing in the Circle User-Controlled challenge lifecycle", () => {
    expect(screen).toContain("executeChallenge");
    expect(appLifecycle).toContain("await executeChallenge(challengeId)");
    expect(screen).toContain(
      "Circle User-Controlled Wallet signs approval and swap challenges",
    );
  });

  it("keeps External Wallet signing in the browser", () => {
    expect(screen).toContain("walletClient.writeContract");
    expect(screen).toContain('functionName: "executeSwap"');
    expect(screen).toContain("connected browser wallet signs approval");
  });

  it("contains no swap-provider fallback or legacy provider import", () => {
    expect(screen.toLowerCase()).not.toContain("stablefx");
    expect(screen.toLowerCase()).not.toContain("swapkit");
    expect(screen.toLowerCase()).not.toContain("treasury");
    expect(screen).not.toContain("circle-swap-kit");
  });
});
