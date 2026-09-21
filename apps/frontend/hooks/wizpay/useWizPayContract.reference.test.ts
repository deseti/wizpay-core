import { describe, expect, it } from "vitest";

import { buildPayrollApprovalReference } from "./useWizPayContract";

describe("payroll approval business reference", () => {
  it("builds a short stable reference from PAY-260921-HZMV", () => {
    const ref = buildPayrollApprovalReference("PAY-260921-HZMV");
    expect(ref).toBe("PAY-260921-HZMV:approval");
    expect(ref.length).toBeLessThanOrEqual(160);
  });

  it("keeps group-suffixed references stable and short", () => {
    const ref = buildPayrollApprovalReference("PAY-260921-HZMV-USDC");
    expect(ref).toBe("PAY-260921-HZMV-USDC:approval");
    expect(ref.length).toBeLessThanOrEqual(160);
  });

  it("separate runs do not collide", () => {
    const a = buildPayrollApprovalReference("PAY-260921-HZMV");
    const b = buildPayrollApprovalReference("PAY-260921-AAAA");
    expect(a).not.toBe(b);
  });

  it("rejects empty references instead of producing ephemeral intents", () => {
    expect(() => buildPayrollApprovalReference("")).toThrow(
      "Reference ID is required",
    );
    expect(() => buildPayrollApprovalReference("   ")).toThrow(
      "Reference ID is required",
    );
  });
});
