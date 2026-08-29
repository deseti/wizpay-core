import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Circle startup architecture", () => {
  const initializer = readFileSync(resolve(process.cwd(), "components/providers/circle/useSdkInitializer.ts"), "utf8");
  const loader = readFileSync(resolve(process.cwd(), "components/providers/circle/useWalletLoader.ts"), "utf8");
  const provider = readFileSync(resolve(process.cwd(), "components/providers/CircleWalletProvider.tsx"), "utf8");
  const appProviders = readFileSync(resolve(process.cwd(), "app/providers.tsx"), "utf8");

  it("does not wait for window.load and keeps forced initialization deduplicated", () => {
    expect(initializer).not.toContain('addEventListener("load"');
    expect(initializer).toContain("if (initInFlightRef.current)");
    expect(initializer).toContain("CIRCLE_SDK_IMPORT_TIMEOUT_MS");
  });

  it("deduplicates wallet hydration and bounds SDK callback completion", () => {
    expect(loader).toContain("walletLoadInFlightRef.current");
    expect(loader).toContain("walletInitializationInFlightRef.current");
    expect(loader).toContain("CIRCLE_EXECUTE_TIMEOUT_MS");
    expect(provider).toContain('document.visibilityState === "hidden"');
  });

  it("does not provision or wait for Solana during Arc startup", () => {
    expect(loader).not.toMatch(/ensureBackendWallet|SOLANA-DEVNET|Creating your Solana|1500/);
    expect(loader).toContain("loadWalletsForArcStartup");
    expect(provider).not.toContain("SOLANA-DEVNET");
    expect(appProviders).not.toContain("SolanaWalletProvider");
  });
});
