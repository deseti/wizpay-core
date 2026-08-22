export interface PayrollOutputAllocationInput {
  id: string;
  sourceAmount: string;
}

function readPositiveBaseUnits(value: string, label: string) {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${label} must be positive integer base units.`);
  }
  return BigInt(value);
}

export function allocateVerifiedPayrollOutput(
  verifiedActualOutput: string,
  recipients: PayrollOutputAllocationInput[],
) {
  const totalOutput = readPositiveBaseUnits(
    verifiedActualOutput,
    "Verified XyloNet output",
  );
  if (recipients.length === 0) {
    throw new Error("XyloNet output has no Payroll recipients.");
  }

  const weights = recipients.map((recipient) =>
    readPositiveBaseUnits(recipient.sourceAmount, "Recipient source amount"),
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  let allocated = 0n;
  const result = new Map<string, string>();

  recipients.forEach((recipient, index) => {
    const amount =
      index === recipients.length - 1
        ? totalOutput - allocated
        : (totalOutput * weights[index]) / totalWeight;
    if (amount <= 0n) {
      throw new Error(
        "Verified XyloNet output is below the safe distributable amount.",
      );
    }
    allocated += amount;
    result.set(recipient.id, amount.toString());
  });

  if (allocated !== totalOutput) {
    throw new Error("Verified XyloNet output allocation is inconsistent.");
  }
  return result;
}
