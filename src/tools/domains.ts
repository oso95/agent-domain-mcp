import type { ProviderRegistry } from '../registry.js';
import type { Contact } from '../providers/types.js';
import { Feature } from '../providers/types.js';
import { errorToObject, AgentError } from '../errors.js';

export async function handleListDomains(input: { provider?: string }, registry: ProviderRegistry) {
  const providers = input.provider ? [registry.get(input.provider)] : registry.getAll();
  if (providers.length === 0) {
    throw new AgentError(
      'NO_PROVIDERS_CONFIGURED',
      'No domain providers are configured.',
      'Set at least one provider API key (NAMECHEAP_API_KEY, GODADDY_API_KEY, PORKBUN_API_KEY, or CLOUDFLARE_API_TOKEN) in the environment.',
      'registry',
    );
  }
  const settled = await Promise.allSettled(providers.map((p) => p.listDomains().then((domains) => ({ provider: p.name(), domains }))));

  const domains = settled.flatMap((r) => r.status === 'fulfilled' ? r.value.domains : []);
  const errors = settled
    .map((r, i) => r.status === 'rejected' ? { provider: providers[i].name(), error: errorToObject(r.reason) } : null)
    .filter(Boolean);

  return errors.length > 0
    ? { domains, errors }
    : { domains };
}

export async function handleGetDomain(input: { domain: string; provider?: string }, registry: ProviderRegistry) {
  const provider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  return provider.getDomain(input.domain);
}

export async function handleRegisterDomain(
  input: { domain: string; years: number; provider: string; contact: Contact; autoRenew: boolean; privacyProtection: boolean },
  registry: ProviderRegistry,
) {
  const provider = registry.get(input.provider);
  if (!provider.supports(Feature.Registration)) {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      `Provider '${provider.name()}' does not support domain registration via API.`,
      'Use Porkbun, Namecheap, or GoDaddy to register domains. Cloudflare registration requires an Enterprise plan.',
      provider.name(),
    );
  }
  return provider.registerDomain({
    domain: input.domain,
    years: input.years,
    contact: input.contact,
    autoRenew: input.autoRenew,
    privacyProtection: input.privacyProtection,
  });
}

export async function handleRenewDomain(input: { domain: string; years: number; provider?: string }, registry: ProviderRegistry) {
  const provider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  if (!provider.supports(Feature.Renewal)) {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      `Provider '${provider.name()}' does not support domain renewal via API.`,
      'Use Porkbun, Namecheap, or GoDaddy to renew domains.',
      provider.name(),
    );
  }
  await provider.renewDomain(input.domain, input.years);
  return { success: true, domain: input.domain, years: input.years };
}

export async function handleUpdateNameservers(
  input: { domain: string; nameservers: string[]; provider?: string },
  registry: ProviderRegistry,
) {
  const provider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  if (!provider.supports(Feature.NameserverWrite)) {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      `Provider '${provider.name()}' does not support changing registrar-level nameservers via API.`,
      'Update nameservers at your original registrar (Porkbun, Namecheap, GoDaddy, or Webnic). Cloudflare is a DNS host, not a registrar — it cannot delegate at the registry parent.',
      provider.name(),
    );
  }
  if (!Array.isArray(input.nameservers) || input.nameservers.length < 2) {
    throw new AgentError(
      'INVALID_NAMESERVERS',
      'At least two nameservers are required by most registries.',
      'Provide an array of at least two FQDN nameservers, e.g. ["ns1.example.com", "ns2.example.com"].',
      provider.name(),
    );
  }
  await provider.updateNameservers(input.domain, input.nameservers);
  return { success: true, domain: input.domain, nameservers: input.nameservers, provider: provider.name() };
}
