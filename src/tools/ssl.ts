import type { ProviderRegistry } from '../registry.js';
import { assertSsl } from './guards.js';

export async function handleListCertificates(input: { domain: string; provider?: string }, registry: ProviderRegistry) {
  const provider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  assertSsl(provider.name(), (f) => provider.supports(f));
  const certificates = await provider.listCertificates(input.domain);
  return { certificates };
}

export async function handleCreateCertificate(input: { domain: string; provider?: string }, registry: ProviderRegistry) {
  const provider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  assertSsl(provider.name(), (f) => provider.supports(f));
  return provider.createCertificate(input.domain);
}

export async function handleGetCertificateStatus(input: { certId: string; provider: string }, registry: ProviderRegistry) {
  const provider = registry.get(input.provider);
  assertSsl(provider.name(), (f) => provider.supports(f));
  return provider.getCertificateStatus(input.certId);
}
