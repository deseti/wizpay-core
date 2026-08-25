import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ordinary Send architecture", () => {
  const sendSource = readFileSync(resolve(process.cwd(), "app/send/page.tsx"), "utf8");
  const payrollSource = readFileSync(resolve(process.cwd(), "app/payroll/page.tsx"), "utf8");

  it("keeps Send independent from Payroll components and endpoints", () => {
    expect(sendSource).not.toMatch(/BatchComposer|useWizPay|payrollTask|\/tasks|payroll contract/i);
    expect(sendSource).toContain('functionName: "transfer"');
    expect(sendSource).toContain("verifyErc20Transfer");
  });

  it("uses a duplicate-submit latch and gates success on strict verification", () => {
    expect(sendSource).toContain("submittingRef.current");
    expect(sendSource).toContain("await verifyErc20Transfer");
    expect(sendSource.indexOf("await verifyErc20Transfer")).toBeLessThan(sendSource.indexOf('setStage("completed")'));
    expect(sendSource).toContain('stage === "completed" && Boolean(completed && verifiedHash)');
  });

  it("keeps skeletons out of transaction execution states", () => {
    expect(sendSource).toContain("showInitialSkeleton");
    expect(sendSource).toContain("balancesLoading && wallet.isActiveWalletConnected");
    expect(sendSource).toContain("Transfer in progress");
    expect(sendSource).not.toMatch(/stage[^\n]+Skeleton/);
  });

  it("keeps Payroll independently routed with its existing composer", () => {
    expect(payrollSource).toContain("BatchComposer");
    expect(payrollSource).toContain("useWizPay");
    expect(payrollSource).toContain("PayrollWorkspace");
  });
});
