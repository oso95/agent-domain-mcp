import type { ProviderRegistry } from '../registry.js';
import type { Contact } from '../providers/types.js';
import { assertWhoisContact } from './guards.js';

export async function handleGetWhoisContact(input: { domain: string; provider?: string }, registry: ProviderRegistry) {
  const provider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  assertWhoisContact(provider.name(), (f) => provider.supports(f));
  return provider.getWhoisContact(input.domain);
}

export async function handleUpdateWhoisContact(input: { domain: string; provider?: string; contact: Contact }, registry: ProviderRegistry) {
  const provider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  assertWhoisContact(provider.name(), (f) => provider.supports(f));
  await provider.updateWhoisContact(input.domain, input.contact);
}
