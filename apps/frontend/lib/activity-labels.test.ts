import { describe, expect, it } from "vitest";

import { ACTIVITY_LABELS } from "@/lib/activity-labels";

describe("Recent Activity labels", () => {
  it("labels every supported activity type explicitly", () => {
    expect(ACTIVITY_LABELS).toEqual({
      payroll: "Payroll",
      send: "Send",
      receive: "Receive",
      swap: "Swap",
      bridge: "Bridge",
      fx: "FX",
      invoice_payment: "Invoice Payment",
    });
  });

  it("does not present swap or bridge activity as Send", () => {
    expect(ACTIVITY_LABELS.swap).toBe("Swap");
    expect(ACTIVITY_LABELS.bridge).toBe("Bridge");
    expect(ACTIVITY_LABELS.swap).not.toBe(ACTIVITY_LABELS.send);
    expect(ACTIVITY_LABELS.bridge).not.toBe(ACTIVITY_LABELS.send);
  });
});
