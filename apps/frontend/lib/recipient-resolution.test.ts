import { describe, expect, it } from "vitest";

import { classifyRecipientInput } from "./recipient-resolution";

describe("wallet recipient classification", () => {
  it("accepts and normalizes a plain hex address", () => {
    const result = classifyRecipientInput(
      "  0x1111111111111111111111111111111111111111  ",
    );

    expect(result.kind).toBe("address");
    expect(result.normalizedAddress).toBe(
      "0x1111111111111111111111111111111111111111",
    );
    expect(result.errorMessage).toBeNull();
  });

  it("rejects name-based recipient input without a resolver path", () => {
    const result = classifyRecipientInput("alice.arc");

    expect(result.kind).toBe("invalid-address");
    expect(result.normalizedAddress).toBeNull();
    expect(result.errorMessage).toBe("Invalid wallet address.");
  });
});
