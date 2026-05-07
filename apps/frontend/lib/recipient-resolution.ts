import { getAddress, isAddress, type Address } from "viem";

import { parseAnsSearchInput } from "@/src/features/ans/utils/domain";

export type RecipientInputKind =
  | "empty"
  | "address"
  | "ans"
  | "invalid-address"
  | "invalid-ans"
  | "unsupported-ans";

export interface RecipientInputClassification {
  input: string;
  trimmedInput: string;
  kind: RecipientInputKind;
  normalizedAddress: Address | null;
  normalizedDomain: string | null;
  errorMessage: string | null;
}

export const UNSUPPORTED_ANS_NAMESPACE_MESSAGE =
  "Unsupported ANS namespace. Only .arc and .wizpay are supported.";

function formatAnsParseError(message: string | null) {
  if (!message) {
    return "Invalid ANS format. Only exact second-level .arc and .wizpay names are supported.";
  }

  if (message.includes("Only .arc and .wizpay")) {
    return UNSUPPORTED_ANS_NAMESPACE_MESSAGE;
  }

  return `Invalid ANS format. ${message}`;
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
      normalizedDomain: null,
      errorMessage: null,
    };
  }

  if (isAddress(trimmedInput)) {
    return {
      input,
      trimmedInput,
      kind: "address",
      normalizedAddress: getAddress(trimmedInput),
      normalizedDomain: null,
      errorMessage: null,
    };
  }

  if (!trimmedInput.includes(".")) {
    return {
      input,
      trimmedInput,
      kind: "invalid-address",
      normalizedAddress: null,
      normalizedDomain: null,
      errorMessage: "Invalid wallet address.",
    };
  }

  const parsed = parseAnsSearchInput(trimmedInput, "arc");
  if (!parsed.target) {
    const errorMessage = formatAnsParseError(parsed.error);

    return {
      input,
      trimmedInput,
      kind:
        errorMessage === UNSUPPORTED_ANS_NAMESPACE_MESSAGE
          ? "unsupported-ans"
          : "invalid-ans",
      normalizedAddress: null,
      normalizedDomain: null,
      errorMessage,
    };
  }

  return {
    input,
    trimmedInput,
    kind: "ans",
    normalizedAddress: null,
    normalizedDomain: parsed.target.domain,
    errorMessage: null,
  };
}