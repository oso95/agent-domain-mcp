import { describe, it, expect, vi } from 'vitest';
import { handleListDomains, handleGetDomain, handleRegisterDomain, handleRenewDomain } from '../../src/tools/domains.js';
import type { ProviderRegistry } from '../../src/registry.js';
import type { Provider, Domain, Contact } from '../../src/providers/types.js';

const SAMPLE_DOMAIN: Domain = {
  name: 'example.com',
  provider: 'mock',
  status: 'active',
  expiresAt: '2026-01-01T00:00:00.000Z',
  autoRenew: true,
  locked: false,
  nameservers: ['ns1.example.com'],
};

function makeProvider(name: string, overrides: Partial<Provider> = {}): Provider {
  return {
    name: () => name,
    supports: () => true,
    listDomains: async () => [SAMPLE_DOMAIN],
    getDomain: async () => SAMPLE_DOMAIN,
    registerDomain: async () => SAMPLE_DOMAIN,
    renewDomain: async () => {},
    ...overrides,
  } as unknown as Provider;
}

function makeRegistry(providers: Provider[]): ProviderRegistry {
  return {
    get: (name: string) => providers.find((p) => p.name() === name)!,
    getAll: () => providers,
    resolveProviderForDomain: async () => providers[0],
  } as unknown as ProviderRegistry;
}

describe('handleListDomains', () => {
  it('returns domains from all configured providers', async () => {
    const p1 = makeProvider('porkbun');
    const p2 = makeProvider('cloudflare');
    const registry = makeRegistry([p1, p2]);
    const result = await handleListDomains({}, registry);
    expect(result.domains).toHaveLength(2);
    expect('errors' in result).toBe(false);
  });

  it('returns partial results with errors when a provider fails', async () => {
    const p1 = makeProvider('porkbun');
    const p2 = makeProvider('cloudflare', {
      listDomains: async () => { throw new Error('auth failed'); },
    });
    const registry = makeRegistry([p1, p2]);
    const result = await handleListDomains({}, registry);
    expect(result.domains).toHaveLength(1); // only porkbun succeeded
    expect((result as { errors?: unknown[] }).errors).toHaveLength(1);
    expect((result as { errors?: Array<{ provider: string }> }).errors?.[0].provider).toBe('cloudflare');
    // Errors should be objects (not double-encoded JSON strings)
    const err = (result as { errors?: Array<{ provider: string; error: unknown }> }).errors?.[0].error;
    expect(typeof err).toBe('object');
    expect((err as { code: string }).code).toBe('ERROR');
  });

  it('filters to specific provider when provider is specified', async () => {
    const p1 = makeProvider('porkbun');
    const p2 = makeProvider('cloudflare');
    const registry = makeRegistry([p1, p2]);
    const result = await handleListDomains({ provider: 'porkbun' }, registry);
    expect(result.domains).toHaveLength(1);
  });

  it('throws NO_PROVIDERS_CONFIGURED when no providers are registered', async () => {
    const registry = makeRegistry([]);
    await expect(handleListDomains({}, registry)).rejects.toMatchObject({ code: 'NO_PROVIDERS_CONFIGURED' });
  });
});

describe('handleGetDomain', () => {
  it('returns the domain from the provider', async () => {
    const provider = makeProvider('porkbun');
    const registry = makeRegistry([provider]);
    const result = await handleGetDomain({ domain: 'example.com' }, registry);
    expect(result.name).toBe('example.com');
  });
});

describe('handleRegisterDomain feature guard', () => {
  it('rejects with FEATURE_NOT_SUPPORTED when provider does not support Registration', async () => {
    const provider = makeProvider('cloudflare', { supports: () => false });
    const registry = makeRegistry([provider]);
    const contact: Contact = {
      firstName: 'John', lastName: 'Doe', email: 'john@example.com',
      phone: '+1.5555555555', address1: '123 Main St', city: 'Anytown',
      state: 'CA', postalCode: '90210', country: 'US',
    };
    await expect(handleRegisterDomain({ domain: 'example.com', years: 1, provider: 'cloudflare', contact, autoRenew: false, privacyProtection: true }, registry))
      .rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' });
  });
});

describe('handleRegisterDomain', () => {
  it('calls registerDomain with correct parameters', async () => {
    const registerSpy = vi.fn().mockResolvedValue(SAMPLE_DOMAIN);
    const provider = makeProvider('porkbun', { registerDomain: registerSpy });
    const registry = makeRegistry([provider]);
    const contact: Contact = {
      firstName: 'John', lastName: 'Doe', email: 'john@example.com',
      phone: '+1.5555555555', address1: '123 Main St', city: 'Anytown',
      state: 'CA', postalCode: '90210', country: 'US',
    };
    await handleRegisterDomain({ domain: 'example.com', years: 2, provider: 'porkbun', contact, autoRenew: false, privacyProtection: true }, registry);
    expect(registerSpy).toHaveBeenCalledWith({
      domain: 'example.com', years: 2, contact, autoRenew: false, privacyProtection: true,
    });
  });
});

describe('handleRenewDomain', () => {
  it('returns success result with domain and years', async () => {
    const renewSpy = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider('porkbun', { renewDomain: renewSpy });
    const registry = makeRegistry([provider]);
    const result = await handleRenewDomain({ domain: 'example.com', years: 1 }, registry);
    expect(result.success).toBe(true);
    expect(result.domain).toBe('example.com');
    expect(result.years).toBe(1);
    expect(renewSpy).toHaveBeenCalledWith('example.com', 1);
  });
});
