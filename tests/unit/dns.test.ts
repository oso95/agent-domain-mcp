import { describe, it, expect, vi } from 'vitest';
import { handleListDnsRecords, handleCreateDnsRecord, handleUpdateDnsRecord, handleDeleteDnsRecord } from '../../src/tools/dns.js';
import type { ProviderRegistry } from '../../src/registry.js';
import type { DNSRecord, Provider } from '../../src/providers/types.js';

const RECORDS: DNSRecord[] = [
  { id: 'A-@-1', type: 'A', name: '@', content: '1.2.3.4', ttl: 300 },
  { id: 'TXT-@-2', type: 'TXT', name: '@', content: 'v=spf1 ~all', ttl: 300 },
  { id: 'MX-@-3', type: 'MX', name: '@', content: 'mail.example.com', ttl: 300, priority: 10 },
];

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    name: () => 'mock',
    supports: () => true,
    listDNSRecords: async () => RECORDS,
    createDNSRecord: async (_, r) => ({ ...r, id: 'new-1' }),
    updateDNSRecord: async (_, r) => r,
    deleteDNSRecord: async () => {},
    ...overrides,
  } as unknown as Provider;
}

function makeRegistry(provider: Provider): ProviderRegistry {
  return {
    get: () => provider,
    resolveProviderForDomain: async () => provider,
  } as unknown as ProviderRegistry;
}

describe('handleListDnsRecords', () => {
  it('returns all records with id, priority stripped when absent', async () => {
    const provider = makeProvider();
    const registry = makeRegistry(provider);
    const result = await handleListDnsRecords({ domain: 'example.com', provider: 'mock' }, registry);
    expect(result.records).toHaveLength(3);
    // MX record should include priority
    const mx = result.records.find((r) => r.type === 'MX');
    expect(mx?.priority).toBe(10);
    // All records have id because RECORDS has ids
    expect(result.records.every((r) => 'id' in r)).toBe(true);
  });

  it('omits id field when record has no id', async () => {
    const provider = makeProvider({
      listDNSRecords: async () => [{ type: 'A', name: '@', content: '1.2.3.4', ttl: 300 }],
    });
    const registry = makeRegistry(provider);
    const result = await handleListDnsRecords({ domain: 'example.com', provider: 'mock' }, registry);
    expect('id' in result.records[0]).toBe(false);
  });

  it('uses registry.resolveProviderForDomain when no provider specified', async () => {
    const provider = makeProvider();
    const resolveSpy = vi.fn().mockResolvedValue(provider);
    const registry = { resolveProviderForDomain: resolveSpy } as unknown as ProviderRegistry;
    await handleListDnsRecords({ domain: 'example.com' }, registry);
    expect(resolveSpy).toHaveBeenCalledWith('example.com');
  });
});

describe('handleCreateDnsRecord', () => {
  it('passes correct fields to provider.createDNSRecord', async () => {
    const createSpy = vi.fn().mockResolvedValue({ id: 'new', type: 'A', name: 'sub', content: '5.6.7.8', ttl: 300 });
    const provider = makeProvider({ createDNSRecord: createSpy });
    const registry = makeRegistry(provider);
    await handleCreateDnsRecord({ domain: 'example.com', provider: 'mock', type: 'A', name: 'sub', content: '5.6.7.8', ttl: 300 }, registry);
    const [, record] = createSpy.mock.calls[0];
    expect(record).toMatchObject({ type: 'A', name: 'sub', content: '5.6.7.8', ttl: 300 });
    // provider input field should not leak into the DNSRecord
    expect('provider' in record).toBe(false);
    expect('domain' in record).toBe(false);
  });
});

describe('handleUpdateDnsRecord', () => {
  it('passes id and fields to provider.updateDNSRecord', async () => {
    const updateSpy = vi.fn().mockResolvedValue({ id: 'A-@-1', type: 'A', name: '@', content: '9.9.9.9', ttl: 600 });
    const provider = makeProvider({ updateDNSRecord: updateSpy });
    const registry = makeRegistry(provider);
    await handleUpdateDnsRecord({ domain: 'example.com', provider: 'mock', id: 'A-@-1', type: 'A', name: '@', content: '9.9.9.9', ttl: 600 }, registry);
    const [, record] = updateSpy.mock.calls[0];
    expect(record.id).toBe('A-@-1');
    expect(record.content).toBe('9.9.9.9');
  });
});

describe('handleDeleteDnsRecord', () => {
  it('calls provider.deleteDNSRecord with domain and id', async () => {
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider({ deleteDNSRecord: deleteSpy });
    const registry = makeRegistry(provider);
    await handleDeleteDnsRecord({ domain: 'example.com', id: 'A-@-1', provider: 'mock' }, registry);
    expect(deleteSpy).toHaveBeenCalledWith('example.com', 'A-@-1');
  });
});

describe('DnsWrite feature guard', () => {
  function makeNoWriteProvider(): Provider {
    return makeProvider({ supports: () => false });
  }

  it('handleCreateDnsRecord rejects with FEATURE_NOT_SUPPORTED when provider lacks DnsWrite', async () => {
    const provider = makeNoWriteProvider();
    const registry = makeRegistry(provider);
    await expect(
      handleCreateDnsRecord({ domain: 'example.com', provider: 'mock', type: 'A', name: '@', content: '1.2.3.4', ttl: 300 }, registry),
    ).rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' });
  });

  it('handleUpdateDnsRecord rejects with FEATURE_NOT_SUPPORTED when provider lacks DnsWrite', async () => {
    const provider = makeNoWriteProvider();
    const registry = makeRegistry(provider);
    await expect(
      handleUpdateDnsRecord({ domain: 'example.com', provider: 'mock', id: 'rec1', type: 'A', name: '@', content: '1.2.3.4', ttl: 300 }, registry),
    ).rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' });
  });

  it('handleDeleteDnsRecord rejects with FEATURE_NOT_SUPPORTED when provider lacks DnsWrite', async () => {
    const provider = makeNoWriteProvider();
    const registry = makeRegistry(provider);
    await expect(
      handleDeleteDnsRecord({ domain: 'example.com', id: 'rec1', provider: 'mock' }, registry),
    ).rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' });
  });
});
