/**
 * batch-csv.ts
 *
 * Pure utility functions and types for CSV import in the batch payroll
 * composer. No React dependencies — safe to use in both client and server
 * contexts (though currently only used on the client).
 */

import { getAddress, isAddress } from "viem";

import {
  createRecipient,
  type RecipientDraft,
  type TokenSymbol,
} from "@/lib/wizpay";

// ── Constants ─────────────────────────────────────────────────────────────────

export const RECIPIENT_PREVIEW_LIMIT = 5;

export const CSV_TEMPLATE_CONTENT = [
  "address,amount,token",
  "0x1111111111111111111111111111111111111111,100,USDC",
  "0x2222222222222222222222222222222222222222,250.50,EURC",
].join("\n");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CsvPreviewRow {
  lineNumber: number;
  address: string;
  amount: string;
  token: string;
  errors: string[];
}

export interface CsvPreviewState {
  fileName: string;
  rows: CsvPreviewRow[];
  validRows: RecipientDraft[];
  invalidCount: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function cleanCsvCell(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, "").trim();
}

/**
 * Parse raw CSV text into a preview state object.
 *
 * Handles:
 * - BOM stripping (UTF-8 with BOM exported from Excel)
 * - Header row detection (address / wallet / recipient keywords)
 * - Comma and semicolon delimiters
 * - Address validation + checksum normalisation via viem
 * - Amount validation (must be > 0)
 * - Token resolution (USDC / EURC, falls back to selectedToken)
 * - Duplicate address detection within a single file
 *
 * Returns `null` if the file is empty.
 */
export function buildCsvPreview(
  fileName: string,
  text: string,
  selectedToken: TokenSymbol,
): CsvPreviewState | null {
  const cleanText = text.replace(/^\uFEFF/, "");
  const lines = cleanText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  const firstLine = lines[0]?.toLowerCase() ?? "";
  const startIndex =
    firstLine.includes("address") ||
    firstLine.includes("wallet") ||
    firstLine.includes("recipient")
      ? 1
      : 0;
  const sampleLine = lines[startIndex] ?? lines[0] ?? "";
  const delimiter = sampleLine.includes(";") ? ";" : ",";
  const rows: CsvPreviewRow[] = [];
  const validRows: RecipientDraft[] = [];
  const seenAddresses = new Set<string>();

  for (let index = startIndex; index < lines.length; index += 1) {
    const [addressRaw = "", amountRaw = "", tokenRaw = ""] = lines[index]
      .split(delimiter)
      .map(cleanCsvCell);
    const errors: string[] = [];
    const normalizedTokenRaw = tokenRaw.toUpperCase();
    const resolvedToken: TokenSymbol =
      normalizedTokenRaw === "EURC"
        ? "EURC"
        : normalizedTokenRaw === "USDC"
          ? "USDC"
          : selectedToken;
    const addressMatch = addressRaw.match(/0x[a-fA-F0-9]{40}/);
    const normalizedAddress =
      addressMatch && isAddress(addressMatch[0])
        ? getAddress(addressMatch[0])
        : null;

    if (!normalizedAddress) {
      errors.push("Wallet address is not valid.");
    }

    if (
      !amountRaw ||
      Number.isNaN(Number(amountRaw)) ||
      Number(amountRaw) <= 0
    ) {
      errors.push("Amount must be greater than 0.");
    }

    if (
      tokenRaw &&
      normalizedTokenRaw !== "USDC" &&
      normalizedTokenRaw !== "EURC"
    ) {
      errors.push("Token must be USDC or EURC.");
    }

    if (normalizedAddress) {
      const dedupeKey = normalizedAddress.toLowerCase();

      if (seenAddresses.has(dedupeKey)) {
        errors.push("Duplicate address found in this file.");
      } else {
        seenAddresses.add(dedupeKey);
      }
    }

    rows.push({
      lineNumber: index + 1,
      address: addressRaw,
      amount: amountRaw,
      token: tokenRaw || resolvedToken,
      errors,
    });

    if (errors.length === 0 && normalizedAddress) {
      validRows.push({
        ...createRecipient(resolvedToken),
        address: normalizedAddress,
        amount: amountRaw,
        targetToken: resolvedToken,
      });
    }
  }

  return {
    fileName,
    rows,
    validRows,
    invalidCount: rows.filter((row) => row.errors.length > 0).length,
  };
}
