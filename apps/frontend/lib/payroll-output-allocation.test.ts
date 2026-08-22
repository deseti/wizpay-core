import { describe, expect, it } from "vitest";

import { allocateVerifiedPayrollOutput } from "@/lib/payroll-output-allocation";

describe("verified XyloNet Payroll output allocation", () => {
  it("allocates exact output proportionally with deterministic remainder", () => {
    const result = allocateVerifiedPayrollOutput("1000001", [
      { id: "first", sourceAmount: "1" },
      { id: "second", sourceAmount: "2" },
    ]);
    expect(result.get("first")).toBe("333333");
    expect(result.get("second")).toBe("666668");
    expect([...result.values()].reduce((sum, value) => sum + BigInt(value), 0n)).toBe(1000001n);
  });

  it.each(["0", "", "1.2", "not-a-number"])(
    "fails closed for invalid verified output %s",
    (output) => {
      expect(() => allocateVerifiedPayrollOutput(output, [{ id: "one", sourceAmount: "1" }])).toThrow();
    },
  );

  it("fails when verified output cannot give every recipient a base unit", () => {
    expect(() => allocateVerifiedPayrollOutput("1", [
      { id: "first", sourceAmount: "1" },
      { id: "second", sourceAmount: "1" },
    ])).toThrow("below the safe distributable amount");
  });
});
