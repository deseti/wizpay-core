import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("invoice navigation regression", () => {
  it("adds Invoices to desktop and mobile actions without removing established destinations", () => {
    const sidebar = readFileSync(
      `${process.cwd()}/components/dashboard/DashboardSidebar.tsx`,
      "utf8",
    );
    const actions = readFileSync(
      `${process.cwd()}/components/dashboard/QuickActionSheet.tsx`,
      "utf8",
    );
    for (const label of [
      "Send",
      "Payroll",
      "Swap",
      "Assets",
      "Profile",
      "ANS",
      "Invoices",
    ])
      expect(sidebar).toContain(`label: "${label}"`);
    for (const label of [
      "Send",
      "Payroll",
      "Invoices",
      "Receive QR",
      "Scan QR",
    ])
      expect(actions).toContain(label);
  });

  it("replaces the smartphone home Faucet slot with one Invoices card while preserving the three-card layout", () => {
    const home = readFileSync(`${process.cwd()}/app/page.tsx`, "utf8");
    const quickActions = home.slice(
      home.indexOf("const QUICK_ACTIONS"),
      home.indexOf("const COLOR_MAP"),
    );

    expect(quickActions).toContain('href: "/send"');
    expect(quickActions).toContain('label: "ANS"');
    expect(quickActions).toContain('href: "/invoices"');
    expect(quickActions).toContain('label: "Invoices"');
    expect(quickActions.match(/label:/g)).toHaveLength(3);
    expect(quickActions.match(/label: "Invoices"/g)).toHaveLength(1);
    expect(home).toContain("grid grid-cols-3 gap-2 sm:gap-3");
  });

  it("contains no user-facing Faucet action or external Circle Faucet URL", () => {
    for (const file of [
      "app/page.tsx",
      "app/assets/page.tsx",
      "components/dashboard/DashboardSidebar.tsx",
      "components/dashboard/QuickActionSheet.tsx",
      "src/features/profile/ProfileHubPage.tsx",
    ]) {
      const source = readFileSync(`${process.cwd()}/${file}`, "utf8");
      expect(source).not.toMatch(/faucet/i);
    }
  });
});
