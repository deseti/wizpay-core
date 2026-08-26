import { getAddress, isAddress, type Address } from "viem";

export type RecipientInputKind =
  | "empty"
  | "address"
  | "invalid-address";

export interface RecipientInputClassification {
  input: string;
  trimmedInput: string;
  kind: RecipientInputKind;
  normalizedAddress: Address | null;
  errorMessage: string | null;
}

export function classifyRecipientInput(
  input: string,
): RecipientInputClassification {
  const trimmedInput = input.trim();

  if (!trimmedInput) {
    return {
      input,
      trimmedInput,
      kind: "empty",
      normalizedAddress: null,
      errorMessage: null,
    };
  }

  if (isAddress(trimmedInput)) {
    return {
      input,
      trimmedInput,
      kind: "address",
      normalizedAddress: getAddress(trimmedInput),
      errorMessage: null,
    };
  }

  if (!trimmedInput.includes(".")) {
    return {
      input,
      trimmedInput,
      kind: "invalid-address",
      normalizedAddress: null,
      errorMessage: "Invalid wallet address.",
    };
  }

  return {
    input,
    trimmedInput,
    kind: "invalid-address",
    normalizedAddress: null,
    errorMessage: "Invalid wallet address.",
  };
}
