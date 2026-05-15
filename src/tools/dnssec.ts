import type { ProviderRegistry } from '../registry.js';
import type { DnssecDS, DnssecStatus, Provider, Feature } from '../providers/types.js';
import { assertDnssec } from './guards.js';
import { AgentError } from '../errors.js';

function requireDnssecMethods(provider: Provider): {
  getDnssec: NonNullable<Provider['getDnssec']>;
  enableDnssec: NonNullable<Provider['enableDnssec']>;
  disableDnssec: NonNullable<Provider['disableDnssec']>;
} {
  if (!provider.getDnssec || !provider.enableDnssec || !provider.disableDnssec) {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      `Provider '${provider.name()}' advertised DNSSEC support but does not implement all DNSSEC methods.`,
      'This is a provider implementation bug. Report the issue at https://github.com/klodr/domain-suite-mcp.',
      provider.name(),
    );
  }
  return {
    getDnssec: provider.getDnssec.bind(provider),
    enableDnssec: provider.enableDnssec.bind(provider),
    disableDnssec: provider.disableDnssec.bind(provider),
  };
}

export async function handleGetDnssec(
  input: { domain: string; provider?: string },
  registry: ProviderRegistry,
): Promise<DnssecStatus> {
  const provider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  assertDnssec(provider.name(), (f: Feature) => provider.supports(f));
  const { getDnssec } = requireDnssecMethods(provider);
  return getDnssec(input.domain);
}

export async function handleEnableDnssec(
  input: { domain: string; dsRecords?: DnssecDS[]; provider?: string },
  registry: ProviderRegistry,
): Promise<DnssecStatus> {
  const provider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  assertDnssec(provider.name(), (f: Feature) => provider.supports(f));
  const { enableDnssec } = requireDnssecMethods(provider);
  const opts = input.dsRecords ? { dsRecords: input.dsRecords } : undefined;
  return enableDnssec(input.domain, opts);
}

export async function handleDisableDnssec(
  input: { domain: string; provider?: string },
  registry: ProviderRegistry,
): Promise<{ success: true; domain: string }> {
  const provider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  assertDnssec(provider.name(), (f: Feature) => provider.supports(f));
  const { disableDnssec } = requireDnssecMethods(provider);
  await disableDnssec(input.domain);
  return { success: true, domain: input.domain };
}
