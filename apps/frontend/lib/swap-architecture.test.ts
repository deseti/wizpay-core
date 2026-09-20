import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const screen = readFileSync(
  resolve(root, "components/dashboard/SwapScreen.tsx"),
  "utf8",
);
const walletProvider = readFileSync(
  resolve(process.cwd(), "components/providers/HybridWalletProvider.tsx"),
  "utf8",
);
const walletToggle = readFileSync(
  resolve(process.cwd(), "components/wallet/WalletModeToggle.tsx"),
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

  it("keeps Arc Mainnet Swap Executor routing without changing Testnet XyloNet", () => {
    expect(screen).toContain("WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS");
    expect(screen).toContain("executeMainnetExecutorSwap");
    expect(screen).toContain("quoteUserSwap");
    expect(screen).toContain("arcTestnet.id");
    expect(screen).not.toContain("ARC_MAINNET_UNISWAP_V4_UNAVAILABLE_MESSAGE");
  });

  it("removes Circle App Wallet from Arc Mainnet wallet controls", () => {
    expect(walletProvider).toContain(
      'ACTIVE_ARC_NETWORK.key === "arc-mainnet" ? "external"',
    );
    expect(walletProvider).toContain('mode !== "external"');
    expect(walletToggle).toContain("mainnetExternalOnly");
    expect(walletToggle).toContain("!mainnetExternalOnly");
  });
});
