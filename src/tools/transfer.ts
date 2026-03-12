import type { ProviderRegistry } from '../registry.js';
import { assertTransfer } from './guards.js';

export async function handleTransferDomainIn(input: { domain: string; authCode: string; provider: string }, registry: ProviderRegistry) {
  const provider = registry.get(input.provider);
  assertTransfer(provider.name(), (f) => provider.supports(f));
  return provider.initiateTransfer(input.domain, input.authCode);
}

export async function handleGetTransferStatus(input: { domain: string; provider?: string }, registry: ProviderRegistry) {
  const provider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  assertTransfer(provider.name(), (f) => provider.supports(f));
  return provider.getTransferStatus(input.domain);
}
