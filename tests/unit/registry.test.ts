import { describe, it, expect } from 'vitest';
import { ProviderRegistry } from '../../src/registry.js';
import { AgentError } from '../../src/errors.js';
import type { Provider } from '../../src/providers/types.js';
import { Feature } from '../../src/providers/types.js';

function makeStubProvider(name: string, domains: string[] = []): Provider {
  return {
    name: () => name,
    supports: () => true,
    checkAvailability: async (d) => ({ domain: d, available: true, premium: false, availabilitySource: name }),
    listDomains: async () => domains.map((d) => ({
      name: d, provider: name, status: 'active' as const,
      expiresAt: '', autoRenew: false, locked: false, nameservers: [],
    })),
    getDomain: async (d) => ({ name: d, provider: name, status: 'active' as const, expiresAt: '', autoRenew: false, locked: false, nameservers: [] }),
    registerDomain: async (req) => ({ name: req.domain, provider: name, status: 'pending' as const, expiresAt: '', autoRenew: false, locked: false, nameservers: [] }),
    renewDomain: async () => {},
    listDNSRecords: async () => [],
    createDNSRecord: async (_d, r) => r,
    updateDNSRecord: async (_d, r) => r,
    deleteDNSRecord: async () => {},
    listCertificates: async () => [],
    createCertificate: async (d) => ({ id: `cert-${d}`, domain: d, status: 'pending' as const }),
    getCertificateStatus: async (id) => ({ id, domain: '', status: 'pending' as const }),
    initiateTransfer: async (d) => ({ domain: d, status: 'pending' as const }),
    getTransferStatus: async (d) => ({ domain: d, status: 'pending' as const }),
    getWhoisContact: async () => ({ firstName: '', lastName: '', email: '', phone: '', address1: '', city: '', state: '', postalCode: '', country: '' }),
    updateWhoisContact: async () => {},
  };
}

describe('ProviderRegistry', () => {
  it('registers and retrieves a provider', () => {
    const registry = new ProviderRegistry();
    const provider = makeStubProvider('porkbun');
    registry.register(provider);
    expect(registry.get('porkbun')).toBe(provider);
  });

  it('throws PROVIDER_NOT_CONFIGURED for unknown provider', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.get('unknown')).toThrow(AgentError);
    expect(() => registry.get('unknown')).toThrowError(expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED' }));
  });

  it('has() returns true for registered provider', () => {
    const registry = new ProviderRegistry();
    registry.register(makeStubProvider('cloudflare'));
    expect(registry.has('cloudflare')).toBe(true);
    expect(registry.has('porkbun')).toBe(false);
  });

  it('getAll() returns all registered providers', () => {
    const registry = new ProviderRegistry();
    registry.register(makeStubProvider('porkbun'));
    registry.register(makeStubProvider('cloudflare'));
    expect(registry.getAll()).toHaveLength(2);
  });

  it('resolveProviderForDomain finds domain owner', async () => {
    const registry = new ProviderRegistry();
    registry.register(makeStubProvider('porkbun', ['example.com', 'test.com']));
    registry.register(makeStubProvider('cloudflare', ['other.com']));

    const provider = await registry.resolveProviderForDomain('example.com');
    expect(provider.name()).toBe('porkbun');
  });

  it('resolveProviderForDomain throws when domain not found', async () => {
    const registry = new ProviderRegistry();
    // Register two providers so the registry fans out and checks domain ownership
    registry.register(makeStubProvider('porkbun', ['example.com']));
    registry.register(makeStubProvider('cloudflare', ['other.com']));

    await expect(registry.resolveProviderForDomain('notfound.com')).rejects.toBeInstanceOf(AgentError);
    await expect(registry.resolveProviderForDomain('notfound.com')).rejects.toMatchObject({ code: 'DOMAIN_NOT_FOUND' });
  });

  it('throws NO_PROVIDERS_CONFIGURED when no providers registered', async () => {
    const registry = new ProviderRegistry();
    await expect(registry.resolveProviderForDomain('example.com')).rejects.toBeInstanceOf(AgentError);
    await expect(registry.resolveProviderForDomain('example.com')).rejects.toMatchObject({ code: 'NO_PROVIDERS_CONFIGURED' });
  });

  it('returns only provider when only one registered', async () => {
    const registry = new ProviderRegistry();
    const provider = makeStubProvider('porkbun');
    registry.register(provider);
    const resolved = await registry.resolveProviderForDomain('anything.com');
    expect(resolved).toBe(provider);
  });

  it('surfaces provider errors when all providers fail during fan-out', async () => {
    const registry = new ProviderRegistry();
    const failingProvider = makeStubProvider('porkbun', []);
    const authError = new AgentError('AUTH_FAILED', 'Bad credentials', 'Check your API key', 'porkbun');
    Object.assign(failingProvider, { listDomains: async () => { throw authError; } });
    const failingProvider2 = makeStubProvider('cloudflare', []);
    Object.assign(failingProvider2, { listDomains: async () => { throw new Error('network error'); } });
    registry.register(failingProvider);
    registry.register(failingProvider2);

    await expect(registry.resolveProviderForDomain('example.com'))
      .rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});
