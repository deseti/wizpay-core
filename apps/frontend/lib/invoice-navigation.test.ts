import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("payment navigation regression", () => {
  it("keeps navigation destinations and the intended mobile actions", () => {
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
      "Invoices",
    ])
      expect(sidebar).toContain(`label: "${label}"`);
    for (const label of [
      "Send",
      "Payroll",
      "Invoices",
      "Scan QR",
    ])
      expect(actions).toContain(label);
  });

  it("keeps the three primary payment actions on the homepage", () => {
    const home = readFileSync(`${process.cwd()}/app/page.tsx`, "utf8");
    const quickActions = home.slice(
      home.indexOf("const QUICK_ACTIONS"),
      home.indexOf("const COLOR_MAP"),
    );

    expect(quickActions).toContain('href: "/send"');
    expect(quickActions).toContain('href: "/invoices/new"');
    expect(quickActions).toContain('label: "Create Invoice"');
    expect(quickActions).toContain('label: "Receive QR"');
    expect(quickActions.match(/label:/g)).toHaveLength(3);
    expect(quickActions.match(/label: "Create Invoice"/g)).toHaveLength(1);
    expect(home).toContain("grid grid-cols-3 gap-2 sm:gap-3");
    expect(home).toContain("<ReceiveQrModal");
  });

  it("does not duplicate Receive QR in the mobile Actions sheet", () => {
    const actions = readFileSync(
      `${process.cwd()}/components/dashboard/QuickActionSheet.tsx`,
      "utf8",
    );
    expect(actions).toContain("Payroll");
    expect(actions).toContain("Invoices");
    expect(actions).toContain("Scan QR");
    expect(actions).not.toContain("Receive QR");
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
