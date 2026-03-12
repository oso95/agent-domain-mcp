import { describe, it, expect, vi } from 'vitest';
import { handleListCertificates, handleCreateCertificate, handleGetCertificateStatus } from '../../src/tools/ssl.js';
import { handleTransferDomainIn, handleGetTransferStatus } from '../../src/tools/transfer.js';
import { handleGetWhoisContact, handleUpdateWhoisContact } from '../../src/tools/contacts.js';
import { handleListProviders } from '../../src/tools/providers.js';
import type { ProviderRegistry } from '../../src/registry.js';
import type { Provider, Certificate, Transfer, Contact } from '../../src/providers/types.js';
import { Feature } from '../../src/providers/types.js';
import type { ProviderConfig } from '../../src/config.js';

const CERT: Certificate = { id: 'cert-1', domain: 'example.com', status: 'active' };
const TRANSFER: Transfer = { domain: 'example.com', status: 'pending', initiatedAt: '2025-01-01T00:00:00.000Z' };
const CONTACT: Contact = {
  firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com',
  phone: '+1.5555555', address1: '123 Main', city: 'Anytown',
  state: 'CA', postalCode: '90210', country: 'US',
};

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    name: () => 'mock',
    supports: (f) => f !== Feature.Registration,
    listCertificates: async () => [CERT],
    createCertificate: async () => CERT,
    getCertificateStatus: async () => CERT,
    initiateTransfer: async () => TRANSFER,
    getTransferStatus: async () => ({ domain: 'example.com', status: 'pending' } as Transfer),
    getWhoisContact: async () => CONTACT,
    updateWhoisContact: async () => {},
    ...overrides,
  } as unknown as Provider;
}

function makeRegistry(provider: Provider): ProviderRegistry {
  return {
    get: () => provider,
    getAll: () => [provider],
    resolveProviderForDomain: async () => provider,
  } as unknown as ProviderRegistry;
}

// ─── SSL ────────────────────────────────────────────────────────────────────

describe('handleListCertificates', () => {
  it('returns certificates array from provider', async () => {
    const registry = makeRegistry(makeProvider());
    const result = await handleListCertificates({ domain: 'example.com', provider: 'mock' }, registry);
    expect(result.certificates).toHaveLength(1);
    expect(result.certificates[0].id).toBe('cert-1');
  });

  it('uses resolveProviderForDomain when no provider given', async () => {
    const provider = makeProvider();
    const resolveSpy = vi.fn().mockResolvedValue(provider);
    const registry = { resolveProviderForDomain: resolveSpy } as unknown as ProviderRegistry;
    await handleListCertificates({ domain: 'example.com' }, registry);
    expect(resolveSpy).toHaveBeenCalledWith('example.com');
  });

  it('rejects with FEATURE_NOT_SUPPORTED when provider does not support SSL', async () => {
    const provider = makeProvider({ supports: () => false });
    const registry = makeRegistry(provider);
    await expect(handleListCertificates({ domain: 'example.com', provider: 'mock' }, registry))
      .rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' });
  });
});

describe('handleCreateCertificate', () => {
  it('returns certificate from provider.createCertificate', async () => {
    const registry = makeRegistry(makeProvider());
    const result = await handleCreateCertificate({ domain: 'example.com', provider: 'mock' }, registry);
    expect(result.id).toBe('cert-1');
    expect(result.status).toBe('active');
  });

  it('rejects with FEATURE_NOT_SUPPORTED when provider does not support SSL', async () => {
    const provider = makeProvider({ supports: () => false });
    const registry = makeRegistry(provider);
    await expect(handleCreateCertificate({ domain: 'example.com', provider: 'mock' }, registry))
      .rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' });
  });
});

describe('handleGetCertificateStatus', () => {
  it('calls provider.getCertificateStatus with certId', async () => {
    const statusSpy = vi.fn().mockResolvedValue(CERT);
    const provider = makeProvider({ getCertificateStatus: statusSpy });
    const registry = makeRegistry(provider);
    await handleGetCertificateStatus({ certId: 'zone123:cert-1', provider: 'mock' }, registry);
    expect(statusSpy).toHaveBeenCalledWith('zone123:cert-1');
  });
});

// ─── Transfer ─────────────────────────────────────────────────────────────

describe('handleTransferDomainIn feature guard', () => {
  it('rejects with FEATURE_NOT_SUPPORTED when provider does not support Transfer', async () => {
    const provider = makeProvider({ supports: () => false });
    const registry = makeRegistry(provider);
    await expect(handleTransferDomainIn({ domain: 'example.com', authCode: 'ABC', provider: 'mock' }, registry))
      .rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' });
  });
});

describe('handleTransferDomainIn', () => {
  it('calls initiateTransfer with domain and authCode', async () => {
    const initSpy = vi.fn().mockResolvedValue(TRANSFER);
    const provider = makeProvider({ initiateTransfer: initSpy });
    const registry = makeRegistry(provider);
    await handleTransferDomainIn({ domain: 'example.com', authCode: 'ABC123', provider: 'mock' }, registry);
    expect(initSpy).toHaveBeenCalledWith('example.com', 'ABC123');
  });

  it('returns transfer result', async () => {
    const registry = makeRegistry(makeProvider());
    const result = await handleTransferDomainIn({ domain: 'example.com', authCode: 'ABC', provider: 'mock' }, registry);
    expect(result.status).toBe('pending');
    expect(result.domain).toBe('example.com');
  });
});

describe('handleGetTransferStatus', () => {
  it('returns transfer status from provider', async () => {
    const registry = makeRegistry(makeProvider());
    const result = await handleGetTransferStatus({ domain: 'example.com', provider: 'mock' }, registry);
    expect(result.status).toBe('pending');
  });

  it('rejects with FEATURE_NOT_SUPPORTED when provider does not support Transfer', async () => {
    const provider = makeProvider({ supports: () => false });
    const registry = makeRegistry(provider);
    await expect(handleGetTransferStatus({ domain: 'example.com', provider: 'mock' }, registry))
      .rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' });
  });
});

// ─── Contacts ─────────────────────────────────────────────────────────────

describe('handleGetWhoisContact', () => {
  it('returns contact from provider', async () => {
    const registry = makeRegistry(makeProvider());
    const result = await handleGetWhoisContact({ domain: 'example.com', provider: 'mock' }, registry);
    expect(result.firstName).toBe('Jane');
    expect(result.email).toBe('jane@example.com');
  });

  it('rejects with FEATURE_NOT_SUPPORTED when provider does not support WhoisContact', async () => {
    const provider = makeProvider({ supports: () => false });
    const registry = makeRegistry(provider);
    await expect(handleGetWhoisContact({ domain: 'example.com', provider: 'mock' }, registry))
      .rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' });
  });
});

describe('handleUpdateWhoisContact', () => {
  it('calls provider.updateWhoisContact with domain and contact', async () => {
    const updateSpy = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider({ updateWhoisContact: updateSpy });
    const registry = makeRegistry(provider);
    await handleUpdateWhoisContact({ domain: 'example.com', provider: 'mock', contact: CONTACT }, registry);
    expect(updateSpy).toHaveBeenCalledWith('example.com', CONTACT);
  });
});

// ─── Providers ────────────────────────────────────────────────────────────

describe('handleListProviders', () => {
  it('lists configured provider with features', () => {
    const provider = makeProvider({
      name: () => 'porkbun',
      supports: (f) => [Feature.DnsWrite, Feature.SSL, Feature.Registration].includes(f),
    });
    const registry = { getAll: () => [provider] } as unknown as ProviderRegistry;
    const config: ProviderConfig = { porkbun: { apiKey: 'k', secretApiKey: 's' } };
    const result = handleListProviders(registry, config) as { configured: Array<{ name: string; supports: string[] }>; unconfigured: string[] };
    expect(result.configured).toHaveLength(1);
    expect(result.configured[0].name).toBe('porkbun');
    expect(result.configured[0].supports).toContain('dns_write');
    expect(result.unconfigured).toContain('namecheap');
    expect(result.unconfigured).toContain('cloudflare');
    expect(result.unconfigured).toContain('godaddy');
  });

  it('returns empty configured list when no providers set up', () => {
    const registry = { getAll: () => [] } as unknown as ProviderRegistry;
    const config: ProviderConfig = {};
    const result = handleListProviders(registry, config) as { configured: unknown[]; unconfigured: string[] };
    expect(result.configured).toHaveLength(0);
    expect(result.unconfigured).toHaveLength(4);
  });

  it('includes explanatory note for unsupported feature when UNSUPPORTED_NOTES entry exists', () => {
    // GoDaddy with SSL unsupported — UNSUPPORTED_NOTES should add a notes entry
    const provider = makeProvider({
      name: () => 'godaddy',
      supports: (f) => f !== Feature.SSL, // GoDaddy does not support SSL
    });
    const registry = { getAll: () => [provider] } as unknown as ProviderRegistry;
    const config: ProviderConfig = { godaddy: { apiKey: 'k', apiSecret: 's' } };
    const result = handleListProviders(registry, config) as {
      configured: Array<{ name: string; unsupported?: string[]; notes?: string[] }>;
    };
    const godaddy = result.configured[0];
    expect(godaddy.unsupported).toContain('ssl');
    expect(godaddy.notes).toBeDefined();
    expect(godaddy.notes?.some((n) => n.toLowerCase().includes('ssl'))).toBe(true);
  });

  it('includes DnsWrite note for GoDaddy in supported features', () => {
    // GoDaddy supports DnsWrite but requires 10+ domains or Domain Pro plan
    // The note must be in SUPPORTED_NOTES, not UNSUPPORTED_NOTES, since supports() returns true
    const provider = makeProvider({
      name: () => 'godaddy',
      supports: (f) => f !== Feature.SSL,
    });
    const registry = { getAll: () => [provider] } as unknown as ProviderRegistry;
    const config: ProviderConfig = { godaddy: { apiKey: 'k', apiSecret: 's' } };
    const result = handleListProviders(registry, config) as {
      configured: Array<{ name: string; supports?: string[]; notes?: string[] }>;
    };
    const godaddy = result.configured[0];
    expect(godaddy.supports).toContain('dns_write');
    expect(godaddy.notes?.some((n) => n.toLowerCase().includes('domain pro'))).toBe(true);
  });
});
