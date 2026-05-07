export const SUPPORTED_ANS_NAMESPACES = ['arc', 'wizpay'] as const;

export type SupportedAnsNamespace = (typeof SUPPORTED_ANS_NAMESPACES)[number];

export interface ParsedAnsDomain {
  normalizedDomain: string;
  label: string;
  namespace: string | null;
  isSupportedNamespace: boolean;
}

export interface AnsDomainResolution extends ParsedAnsDomain {
  resolvedAddress: string | null;
}