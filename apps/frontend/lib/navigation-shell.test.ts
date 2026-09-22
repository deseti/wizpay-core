import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("desktop and mobile navigation shell", () => {
  const sidebar = read("components/dashboard/DashboardSidebar.tsx");
  const navItems = sidebar.slice(
    sidebar.indexOf("const navItems"),
    sidebar.indexOf("function isActivePath"),
  );
  const bottomNav = read("components/dashboard/DashboardBottomNav.tsx");
  const actions = read("components/dashboard/QuickActionSheet.tsx");
  const home = read("app/page.tsx");
  const header = read("components/dashboard/DashboardHeader.tsx");

  it("keeps the desktop sidebar to the five primary destinations", () => {
    expect(navItems.match(/label:/g)).toHaveLength(5);
    for (const label of [
      "Home",
      "Send",
      "Payroll",
      "Invoices",
      "Swap & Bridge",
    ]) {
      expect(navItems).toContain(`label: "${label}"`);
    }
    expect(navItems).toContain('activePaths: ["/swap", "/bridge"]');
    expect(navItems).not.toContain('label: "Assets"');
    expect(navItems).not.toContain('label: "Profile"');
    expect(navItems).not.toContain("/assets");
    expect(navItems).not.toContain("/profile");
  });

  it("keeps Assets reachable from Home and Account in the wallet menu", () => {
    expect(home).toContain('href="/assets"');
    expect(home).toContain("See All");
    expect(header).toContain('href="/profile"');
    expect(header).toContain("Account");
    expect(header).toContain('aria-label="Account and wallet menu"');
    expect(header).toContain("openAppKit");
  });

  it("keeps mobile navigation to Home, Actions, Swap, and Account", () => {
    expect(bottomNav).toContain('label: "Home"');
    expect(bottomNav).toContain('label: "Swap"');
    expect(bottomNav).toContain('label: "Account"');
    expect(bottomNav).toContain('aria-label="Quick actions"');
    expect(bottomNav).toContain("Actions");
    expect(bottomNav).toContain('activePaths: ["/swap", "/bridge"]');
    expect(bottomNav).not.toContain('label: "Profile"');
    expect(bottomNav).not.toContain('label: "Bridge"');
    expect(bottomNav).not.toContain("/assets");
  });

  it("keeps Bridge out of mobile Actions", () => {
    for (const label of ["Send", "Payroll", "Invoices", "Scan QR"]) {
      expect(actions).toContain(label);
    }
    expect(actions).not.toContain("Bridge");
    expect(actions).not.toContain("/bridge");
  });

  it("opens the combined Swap and Bridge shell from both legacy routes", () => {
    const swapPage = read("app/swap/page.tsx");
    const bridgePage = read("app/bridge/page.tsx");
    const workspace = read("components/dashboard/SwapBridgeWorkspace.tsx");
    expect(swapPage).toContain("<SwapBridgeWorkspace />");
    expect(bridgePage).toContain("<SwapBridgeWorkspace />");
    expect(swapPage).not.toContain("SwapScreen");
    expect(bridgePage).not.toContain("BridgeScreen");
    expect(workspace).toContain('from "@/components/dashboard/SwapScreen"');
    expect(workspace).toContain('from "@/components/dashboard/BridgeScreen"');
    expect(workspace).toContain("<SwapScreen />");
    expect(workspace).toContain("<BridgeScreen showHeading={false} />");
    expect(workspace).not.toMatch(
      /quoteUserSwap|createBridgeIntent|executeSwap/,
    );
  });
});
