import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  arcMainnetNetwork,
  arcTestnetNetwork,
  readReownProjectConfiguration,
  resolveReownProjectId,
} from "@/lib/wagmi";

const root = resolve(process.cwd());
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Reown AppKit wallet architecture", () => {
  const providers = read("app/providers.tsx");
  const appKit = read("lib/reown-appkit.ts");
  const wagmi = read("lib/wagmi.ts");
  const packageJson = read("package.json");
  const invoiceCheckout = read("components/invoices/PublicInvoiceCheckout.tsx");
  const invoiceShared = read("components/invoices/InvoiceShared.tsx");
  const connectCard = read("components/dashboard/ConnectWalletCard.tsx");

  it("initializes the official Reown Wagmi adapter without RainbowKit", () => {
    expect(wagmi).toContain('from "@reown/appkit-adapter-wagmi"');
    expect(appKit).toContain("createAppKit");
    expect(providers).toContain('import "@/lib/reown-appkit"');
    expect(packageJson).not.toContain("@rainbow-me/rainbowkit");
    expect(`${providers}\n${appKit}\n${wagmi}`).not.toMatch(
      /RainbowKit|rainbowkit/,
    );
  });

  it("fails closed when the Reown project ID is missing or inexact", () => {
    expect(readReownProjectConfiguration(undefined)).toMatchObject({
      projectId: null,
      error: expect.stringContaining(
        "NEXT_PUBLIC_REOWN_PROJECT_ID is required",
      ),
    });
    expect(() => resolveReownProjectId(" value ")).toThrow(
      "must not contain surrounding whitespace",
    );
    expect(resolveReownProjectId("test-only-project-id")).toBe(
      "test-only-project-id",
    );
    expect(providers).toContain("Wallet configuration unavailable");
  });

  it("defines both Arc chains exactly", () => {
    expect(arcMainnetNetwork.id).toBe(5_042);
    expect(arcMainnetNetwork.testnet).toBe(false);
    expect(arcTestnetNetwork.id).toBe(5_042_002);
    expect(arcTestnetNetwork.testnet).toBe(true);
  });

  it("configures external-wallet-only AppKit features", () => {
    for (const feature of [
      "analytics",
      "email",
      "history",
      "onramp",
      "pay",
      "receive",
      "reownAuthentication",
      "send",
      "smartSessions",
      "swaps",
    ]) {
      expect(appKit).toContain(`${feature}: false`);
    }
    expect(appKit).toContain("socials: false");
    expect(appKit).toContain('defaultAccountTypes: { eip155: "eoa" }');
    expect(appKit).toContain('coinbasePreference: "eoaOnly"');
    expect(appKit).toContain("enableInjected: true");
    expect(wagmi).toContain("safe({ shimDisconnect: true })");
    expect(wagmi).toContain("coinbaseWallet");
  });

  it("keeps Circle controls and initialization unavailable on Mainnet", () => {
    expect(providers).toContain(
      'enabled={ACTIVE_ARC_NETWORK.key === "arc-testnet"}',
    );
    expect(
      providers.match(/enabled=\{ACTIVE_ARC_NETWORK\.key === "arc-testnet"\}/g),
    ).toHaveLength(2);
    expect(invoiceCheckout).toContain("mainnetExternalOnly");
    expect(invoiceCheckout).toContain("!mainnetExternalOnly");
    expect(invoiceShared).toContain("mainnetExternalOnly ? null");
    expect(invoiceShared).toContain("will not fall back to Testnet");
    expect(connectCard).toContain(
      "Arc Mainnet uses connected external wallets only",
    );
  });
});
