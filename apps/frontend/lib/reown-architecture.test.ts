import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  activeArcChain,
  arcMainnetNetwork,
  readReownProjectConfiguration,
  resolveReownProjectId,
  SUPPORTED_CHAIN_IDS,
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

  it("keeps Arc Mainnet as the default chain with CCTP bridge chains for signing", () => {
    expect(arcMainnetNetwork.id).toBe(5_042);
    expect(arcMainnetNetwork.testnet).toBe(false);
    expect(activeArcChain.id).toBe(5_042);
    expect(SUPPORTED_CHAIN_IDS.has(5_042)).toBe(true);
    // Bridge counterparty chains exist only so the external wallet can sign
    // official CCTP legs; Arc stays the default application runtime.
    for (const chainId of [1, 10, 137, 8453, 42161, 43114]) {
      expect(SUPPORTED_CHAIN_IDS.has(chainId)).toBe(true);
    }
    expect(SUPPORTED_CHAIN_IDS.has(9_999)).toBe(false);
    expect(wagmi).not.toContain("9_999");
    expect(wagmi).toContain("activeArcChain");
    expect(appKit).toContain("defaultNetwork: activeArcChain");
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

  it("keeps legacy controls unavailable on Mainnet", () => {
    // Arc Mainnet mounts a dedicated external-only provider tree: no legacy
    // SDK provider and no legacy API proxy may appear on that branch.
    // Merchant invoices use an opaque session from a signed wallet challenge.
    expect(providers).toContain("ExternalWalletProvider");
    expect(providers.toLowerCase()).not.toContain("circle");
    expect(invoiceCheckout).toContain("mainnetExternalOnly");
    expect(invoiceCheckout).toContain("!mainnetExternalOnly");
    expect(invoiceShared).toContain("useMerchantInvoiceSession");
    expect(invoiceShared).toContain("useWalletAuth");
    expect(invoiceShared).not.toContain("ensureExternalWalletRegistered");
    expect(invoiceShared.toLowerCase()).not.toContain("circle");
    expect(connectCard).toContain(
      "Arc Mainnet uses connected external wallets only",
    );
  });
});
