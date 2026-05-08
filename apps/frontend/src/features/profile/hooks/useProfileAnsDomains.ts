"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type Address } from "viem";
import { usePublicClient } from "wagmi";

import { arcTestnet } from "@/lib/wagmi";
import { sameAddress } from "@/lib/wizpay";
import {
  fetchAnsDomainLookup,
  fetchAnsNamespaceSnapshot,
} from "@/src/features/ans/resolvers/ans-resolution";
import { getAnsContractsConfig } from "@/src/features/ans/services/ans-config";
import type {
  AnsDomainLookup,
  AnsNamespaceKey,
  AnsNamespaceSnapshot,
  AnsRegistrationActivityRecord,
  TrackedAnsDomain,
} from "@/src/features/ans/types/ans";
import { parseAnsSearchInput } from "@/src/features/ans/utils/domain";
import {
  ANS_ACTIVITY_UPDATED_EVENT,
  readAnsRegistrationActivity,
  readTrackedAnsDomains,
} from "@/src/features/ans/utils/storage";

export function useProfileAnsDomains(ownerAddresses: Address[]) {
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const contracts = getAnsContractsConfig();
  const [trackedDomains, setTrackedDomains] = useState<TrackedAnsDomain[]>([]);
  const [registrationActivity, setRegistrationActivity] = useState<
    AnsRegistrationActivityRecord[]
  >([]);

  useEffect(() => {
    const syncAnsState = () => {
      setTrackedDomains(readTrackedAnsDomains());
      setRegistrationActivity(readAnsRegistrationActivity());
    };

    syncAnsState();

    if (typeof window === "undefined") {
      return;
    }

    window.addEventListener(ANS_ACTIVITY_UPDATED_EVENT, syncAnsState);
    window.addEventListener("storage", syncAnsState);

    return () => {
      window.removeEventListener(ANS_ACTIVITY_UPDATED_EVENT, syncAnsState);
      window.removeEventListener("storage", syncAnsState);
    };
  }, []);

  const normalizedOwnerAddresses = useMemo(
    () =>
      Array.from(
        new Set(
          ownerAddresses
            .filter((address): address is Address => typeof address === "string")
            .map((address) => address.toLowerCase() as Address),
        ),
      ),
    [ownerAddresses],
  );

  const candidateDomains = useMemo(() => {
    const trackedCandidates = trackedDomains
      .filter(
        (entry) =>
          !entry.walletAddress ||
          normalizedOwnerAddresses.length === 0 ||
          normalizedOwnerAddresses.some((address) =>
            sameAddress(address, entry.walletAddress ?? undefined),
          ),
      )
      .map((entry) => entry.domain);

    const registrationCandidates = registrationActivity
      .filter(
        (entry) =>
          !entry.walletAddress ||
          normalizedOwnerAddresses.length === 0 ||
          normalizedOwnerAddresses.some((address) =>
            sameAddress(address, entry.walletAddress ?? undefined),
          ),
      )
      .map((entry) => entry.domain);

    return Array.from(new Set([...trackedCandidates, ...registrationCandidates]));
  }, [normalizedOwnerAddresses, registrationActivity, trackedDomains]);

  const detectedDomainsQuery = useQuery({
    queryKey: ["profile", "ans-domains", candidateDomains, normalizedOwnerAddresses],
    enabled:
      Boolean(publicClient) &&
      candidateDomains.length > 0 &&
      normalizedOwnerAddresses.length > 0,
    queryFn: async () => {
      const namespaceSnapshots = new Map<AnsNamespaceKey, AnsNamespaceSnapshot>();
      const lookups: AnsDomainLookup[] = [];

      for (const domain of candidateDomains) {
        const defaultNamespace = domain.endsWith(".wizpay") ? "wizpay" : "arc";
        const parsed = parseAnsSearchInput(domain, defaultNamespace);

        if (!parsed.target) {
          continue;
        }

        let namespaceSnapshot = namespaceSnapshots.get(parsed.target.namespace);
        if (!namespaceSnapshot) {
          namespaceSnapshot = await fetchAnsNamespaceSnapshot(
            publicClient!,
            contracts,
            parsed.target.namespace,
          );
          namespaceSnapshots.set(parsed.target.namespace, namespaceSnapshot);
        }

        const lookup = await fetchAnsDomainLookup(
          publicClient!,
          contracts,
          parsed.target,
          1,
          namespaceSnapshot,
        );

        lookups.push(lookup);
      }

      return lookups;
    },
    staleTime: 30_000,
  });

  const ownedDomains = useMemo(
    () =>
      (detectedDomainsQuery.data ?? []).filter((lookup) =>
        normalizedOwnerAddresses.some((address) =>
          sameAddress(address, lookup.ownerAddress ?? undefined),
        ),
      ),
    [detectedDomainsQuery.data, normalizedOwnerAddresses],
  );

  return {
    candidateDomains,
    ownedDomains,
    primaryDomain: ownedDomains[0]?.target.domain ?? null,
    errorMessage:
      detectedDomainsQuery.error instanceof Error
        ? detectedDomainsQuery.error.message
        : null,
    isLoading: detectedDomainsQuery.isLoading,
  };
}