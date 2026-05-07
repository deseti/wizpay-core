import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  namehash,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem';
import {
  ARC_REGISTRY_ABI,
  ARC_REGISTRY_ADDRESS_CONFIG_KEY,
  ARC_RPC_URL_CONFIG_KEY,
  DEFAULT_ARC_RPC_URL,
  DEFAULT_ARC_REGISTRY_ADDRESS,
  NEXT_PUBLIC_ANS_REGISTRY_CONFIG_KEY,
  NEXT_PUBLIC_ARC_TESTNET_RPC_URL_CONFIG_KEY,
  NEXT_PUBLIC_RPC_URL_CONFIG_KEY,
  PUBLIC_RESOLVER_ABI,
  RPC_URL_CONFIG_KEY,
} from './ans.constants';
import {
  type AnsDomainResolution,
  type ParsedAnsDomain,
  SUPPORTED_ANS_NAMESPACES,
} from './ans.types';

/**
 * AnsService resolves Arc Name Service domains into EVM addresses and text metadata.
 */
@Injectable()
export class AnsService {
  private readonly logger = new Logger(AnsService.name);
  private readonly registryAddress: Address;
  private readonly publicClient: PublicClient;

  constructor(private readonly configService: ConfigService) {
    const rpcUrl = this.readConfiguredRpcUrl();
    const configuredRegistryAddress = this.readConfiguredRegistryAddress();

    this.registryAddress = getAddress(configuredRegistryAddress);
    this.publicClient = createPublicClient({
      transport: http(rpcUrl),
    });
  }

  /**
   * Resolves an ANS domain into an EVM address.
   *
   * @param domain Fully-qualified ANS domain such as `worker.arc` or `ops.wizpay`.
   * @returns The resolved checksum EVM address, or `null` when no resolver or address record exists.
   */
  async resolveAddress(domain: string): Promise<string | null> {
    const resolution = await this.inspectDomain(domain);
    return resolution?.resolutionStatus === 'resolved'
      ? resolution.resolvedAddress
      : null;
  }

  /**
   * Resolves a text metadata record for an ANS domain.
   *
   * @param domain Fully-qualified ANS domain such as `agent.arc` or `ops.wizpay`.
   * @param key Resolver text key such as `webhook`, `pubkey`, or `capability`.
   * @returns The text record value, or `null` when no resolver or text record exists.
   */
  async resolveAgentMetadata(
    domain: string,
    key: string,
  ): Promise<string | null> {
    const parsedDomain = this.parseDomain(domain);
    const normalizedKey = key.trim();
    if (!parsedDomain?.isSupportedNamespace || normalizedKey.length === 0) {
      return null;
    }

    const { normalizedDomain } = parsedDomain;

    const node = namehash(normalizedDomain);

    try {
      const resolverAddress = await this.getResolverAddress(node, normalizedDomain);
      if (!resolverAddress) {
        return null;
      }

      const value = await this.publicClient.readContract({
        address: resolverAddress,
        abi: PUBLIC_RESOLVER_ABI,
        functionName: 'text',
        args: [node, normalizedKey],
      });

      return value.length > 0 ? value : null;
    } catch (error: unknown) {
      this.logger.error(
        `Failed to resolve text record "${normalizedKey}" for ANS domain "${normalizedDomain}".`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }

  getSupportedNamespaces() {
    return SUPPORTED_ANS_NAMESPACES.map((namespace) => ({
      label: namespace,
      suffix: `.${namespace}`,
    }));
  }

  parseDomain(domain: string): ParsedAnsDomain | null {
    const normalizedDomain = domain.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (normalizedDomain.length === 0) {
      return null;
    }

    const parts = normalizedDomain.split('.').filter(Boolean);
    const namespace = parts.length >= 2 ? parts[parts.length - 1] : null;
    const label = parts.length >= 2 ? parts.slice(0, -1).join('.') : parts[0] ?? '';
    const isSupportedNamespace = namespace
      ? SUPPORTED_ANS_NAMESPACES.includes(namespace as (typeof SUPPORTED_ANS_NAMESPACES)[number])
      : false;

    return {
      normalizedDomain,
      label,
      namespace,
      isSupportedNamespace,
    };
  }

  async inspectDomain(domain: string): Promise<AnsDomainResolution | null> {
    const parsedDomain = this.parseDomain(domain);
    if (!parsedDomain) {
      return null;
    }

    if (!parsedDomain.isSupportedNamespace) {
      return {
        ...parsedDomain,
        resolvedAddress: null,
        resolutionStatus: 'unsupported_namespace',
      };
    }

    const { normalizedDomain } = parsedDomain;
    const node = namehash(normalizedDomain);

    try {
      const resolverAddress = await this.getResolverAddress(node, normalizedDomain);
      if (!resolverAddress) {
        return {
          ...parsedDomain,
          resolvedAddress: null,
          resolutionStatus: 'resolver_unavailable',
        };
      }

      const resolvedAddress = await this.publicClient.readContract({
        address: resolverAddress,
        abi: PUBLIC_RESOLVER_ABI,
        functionName: 'addr',
        args: [node],
      });

      if (!resolvedAddress || resolvedAddress === zeroAddress) {
        return {
          ...parsedDomain,
          resolvedAddress: null,
          resolutionStatus: 'name_not_found',
        };
      }

      return {
        ...parsedDomain,
        resolvedAddress: getAddress(resolvedAddress),
        resolutionStatus: 'resolved',
      };
    } catch (error: unknown) {
      this.logger.error(
        `Failed to inspect ANS domain "${normalizedDomain}".`,
        error instanceof Error ? error.stack : undefined,
      );

      return {
        ...parsedDomain,
        resolvedAddress: null,
        resolutionStatus: 'resolver_unavailable',
      };
    }
  }

  private async getResolverAddress(
    node: `0x${string}`,
    domain: string,
  ): Promise<Address | null> {
    try {
      const resolverAddress = await this.publicClient.readContract({
        address: this.registryAddress,
        abi: ARC_REGISTRY_ABI,
        functionName: 'resolver',
        args: [node],
      });

      if (!resolverAddress || resolverAddress === zeroAddress) {
        return null;
      }

      if (!isAddress(resolverAddress)) {
        this.logger.warn(
          `ANS registry returned an invalid resolver address for domain "${domain}".`,
        );
        return null;
      }

      return getAddress(resolverAddress);
    } catch (error: unknown) {
      this.logger.error(
        `Failed to fetch resolver for ANS domain "${domain}".`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }

  private readConfiguredRegistryAddress(): string {
    const configuredRegistryAddress = this.configService
      .get<string>(ARC_REGISTRY_ADDRESS_CONFIG_KEY)
      ?.trim();

    if (configuredRegistryAddress) {
      return configuredRegistryAddress;
    }

    const sharedFrontendAddress = this.configService
      .get<string>(NEXT_PUBLIC_ANS_REGISTRY_CONFIG_KEY)
      ?.trim();

    if (sharedFrontendAddress) {
      return sharedFrontendAddress;
    }

    return DEFAULT_ARC_REGISTRY_ADDRESS;
  }

  private readConfiguredRpcUrl(): string {
    const configuredRpcUrl = this.configService
      .get<string>(ARC_RPC_URL_CONFIG_KEY)
      ?.trim();

    if (configuredRpcUrl) {
      return configuredRpcUrl;
    }

    const legacyRpcUrl = this.configService
      .get<string>(RPC_URL_CONFIG_KEY)
      ?.trim();

    if (legacyRpcUrl) {
      return legacyRpcUrl;
    }

    const sharedFrontendRpcUrl = this.configService
      .get<string>(NEXT_PUBLIC_ARC_TESTNET_RPC_URL_CONFIG_KEY)
      ?.trim();

    if (sharedFrontendRpcUrl) {
      return sharedFrontendRpcUrl;
    }

    const genericFrontendRpcUrl = this.configService
      .get<string>(NEXT_PUBLIC_RPC_URL_CONFIG_KEY)
      ?.trim();

    if (genericFrontendRpcUrl) {
      return genericFrontendRpcUrl;
    }

    this.logger.warn(
      `ANS RPC URL is not configured via ${ARC_RPC_URL_CONFIG_KEY}, ${RPC_URL_CONFIG_KEY}, ${NEXT_PUBLIC_ARC_TESTNET_RPC_URL_CONFIG_KEY}, or ${NEXT_PUBLIC_RPC_URL_CONFIG_KEY}. Falling back to ${DEFAULT_ARC_RPC_URL}.`,
    );

    return DEFAULT_ARC_RPC_URL;
  }
}