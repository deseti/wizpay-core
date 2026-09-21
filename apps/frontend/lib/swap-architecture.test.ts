import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const screen = readFileSync(
  resolve(root, "components/dashboard/SwapScreen.tsx"),
  "utf8",
);

describe("canonical swap signing boundaries", () => {
  it("keeps External Wallet signing in the browser", () => {
    expect(screen).toContain("walletClient.writeContract");
    expect(screen).toContain('functionName: "executeSwap"');
    expect(screen).toContain("connected external wallet signs approval");
  });

  it("contains no swap-provider fallback or legacy provider import", () => {
    expect(screen.toLowerCase()).not.toContain("stable" + "fx");
    expect(screen.toLowerCase()).not.toContain("swapkit");
    expect(screen.toLowerCase()).not.toContain("treasury");
    expect(screen.toLowerCase()).not.toContain("xylo" + "net");
    expect(screen.toLowerCase()).not.toContain("circle");
    expect(screen).not.toContain("circle-swap-kit");
  });

  it("keeps Arc Mainnet Swap Executor routing only", () => {
    expect(screen).toContain("WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS");
    expect(screen).toContain("executeMainnetSwap");
    expect(screen).toContain("quoteUserSwap");
    expect(screen).toContain("USER_SWAP_CHAIN");
    expect(screen).not.toContain("ARC_MAINNET_UNISWAP_V4_UNAVAILABLE_MESSAGE");
    expect(screen).not.toContain("WIZPAY_SWAP_EXECUTOR_V2_ADDRESS");
  });

  it("removes legacy wallet modes from swap controls", () => {
    expect(screen).not.toContain('"circle"');
    expect(screen).not.toContain("setWalletMode");
    expect(screen).not.toContain("HybridWallet");
    expect(screen).not.toContain("WalletModeToggle");
  });
});
