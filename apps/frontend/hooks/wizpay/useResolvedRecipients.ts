"use client";

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { getAddress, isAddress, type Address } from "viem";

import { type PreparedRecipient } from "@/lib/types";
import { BackendApiError } from "@/lib/backend-api";
import { classifyRecipientInput } from "@/lib/recipient-resolution";
import { parseAmountToUnits, type RecipientDraft } from "@/lib/wizpay";
import { resolveAnsDomainViaBackend } from "@/src/features/ans/services/ans-backend";

type ResolutionLookup = {
  normalizedAddress: Address | null;
  resolutionError: string | null;
  resolutionState: "loading" | "resolved" | "error";
};

function formatBackendResolutionError(error: unknown) {
  if (error instanceof BackendApiError) {
    if (error.code === "ANS_RESOLVER_UNAVAILABLE") {
      return "Resolver unavailable.";
    }

    return error.message;
  }

  return "Resolver unavailable.";
}

export function useResolvedRecipients(recipients: RecipientDraft[]) {
  const classifications = useMemo(
    () =>
      recipients.map((recipient) => ({
        recipientId: recipient.id,
        result: classifyRecipientInput(recipient.address),
      })),
    [recipients],
  );

  const candidateDomains = useMemo(
    () =>
      Array.from(
        new Set(
          classifications
            .map(({ result }) => result)
            .filter((result) => result.kind === "ans" && result.normalizedDomain)
            .map((result) => result.normalizedDomain as string),
        ),
      ),
    [classifications],
  );

  const resolutionQueries = useQueries({
    queries: candidateDomains.map((domain) => ({
      queryKey: ["recipient-ans-resolution", domain],
      queryFn: () => resolveAnsDomainViaBackend(domain),
      staleTime: 30_000,
      retry: false,
    })),
  });

  const resolutionMap = useMemo(() => {
    const nextMap = new Map<string, ResolutionLookup>();

    candidateDomains.forEach((domain, index) => {
      const query = resolutionQueries[index];

      if (!query || query.isLoading || query.isFetching) {
        nextMap.set(domain, {
          normalizedAddress: null,
          resolutionError: null,
          resolutionState: "loading",
        });
        return;
      }

      if (query.error) {
        nextMap.set(domain, {
          normalizedAddress: null,
          resolutionError: formatBackendResolutionError(query.error),
          resolutionState: "error",
        });
        return;
      }

      if (!query.data) {
        nextMap.set(domain, {
          normalizedAddress: null,
          resolutionError: "Name not found.",
          resolutionState: "error",
        });
        return;
      }

      if (query.data.resolutionStatus === "resolver_unavailable") {
        nextMap.set(domain, {
          normalizedAddress: null,
          resolutionError: "Resolver unavailable.",
          resolutionState: "error",
        });
        return;
      }

      if (query.data.resolutionStatus === "name_not_found") {
        nextMap.set(domain, {
          normalizedAddress: null,
          resolutionError: "Name not found.",
          resolutionState: "error",
        });
        return;
      }

      if (query.data.resolutionStatus === "unsupported_namespace") {
        nextMap.set(domain, {
          normalizedAddress: null,
          resolutionError:
            "Unsupported ANS namespace. Only .arc and .wizpay are supported.",
          resolutionState: "error",
        });
        return;
      }

      const resolvedAddress = query.data.resolvedAddress;
      if (!resolvedAddress || !isAddress(resolvedAddress)) {
        nextMap.set(domain, {
          normalizedAddress: null,
          resolutionError: "Name not found.",
          resolutionState: "error",
        });
        return;
      }

      nextMap.set(domain, {
        normalizedAddress: getAddress(resolvedAddress),
        resolutionError: null,
        resolutionState: "resolved",
      });
    });

    return nextMap;
  }, [candidateDomains, resolutionQueries]);

  return useMemo<PreparedRecipient[]>(() => {
    return recipients.map((recipient) => {
      const classification = classifyRecipientInput(recipient.address);
      const amountUnits = parseAmountToUnits(recipient.amount, 6);

      if (classification.kind === "address") {
        return {
          ...recipient,
          address: classification.trimmedInput,
          amountUnits,
          validAddress: true,
          normalizedAddress: classification.normalizedAddress,
          ansDomain: null,
          recipientInputType: "address",
          resolutionState: "resolved",
          resolutionError: null,
        };
      }

      if (classification.kind === "ans" && classification.normalizedDomain) {
        const lookup = resolutionMap.get(classification.normalizedDomain);

        return {
          ...recipient,
          address: classification.trimmedInput,
          amountUnits,
          validAddress: Boolean(lookup?.normalizedAddress),
          normalizedAddress: lookup?.normalizedAddress ?? null,
          ansDomain: classification.normalizedDomain,
          recipientInputType: "ans",
          resolutionState: lookup?.resolutionState ?? "loading",
          resolutionError: lookup?.resolutionError ?? null,
        };
      }

      return {
        ...recipient,
        address: classification.trimmedInput,
        amountUnits,
        validAddress: false,
        normalizedAddress: null,
        ansDomain: classification.normalizedDomain,
        recipientInputType:
          classification.kind === "invalid-address" || classification.kind === "empty"
            ? "invalid"
            : "ans",
        resolutionState: classification.kind === "empty" ? "idle" : "error",
        resolutionError: classification.errorMessage,
      };
    });
  }, [recipients, resolutionMap]);
}