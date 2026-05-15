import { describe, it, expect, vi } from 'vitest';
import { WebnicProvider } from '../../src/providers/webnic/provider.js';
import { Feature } from '../../src/providers/types.js';

const baseConfig = {
  username: 'u',
  password: 'p',
  sandbox: true,
  defaultContactId: 'WN1234T',
  defaultRegistrantUserId: 'REG100015',
};

function mockProvider(overrides: Record<string, unknown> = {}) {
  const provider = new WebnicProvider(baseConfig);
  Object.assign((provider as unknown as { client: Record<string, unknown> }).client, overrides);
  return provider;
}

describe('WebnicProvider supports(Feature.Dnssec)', () => {
  it('reports true', () => {
    const p = new WebnicProvider(baseConfig);
    expect(p.supports(Feature.Dnssec)).toBe(true);
  });
});

describe('WebnicProvider.getDnssec()', () => {
  it('reports scope=both when registry DS + zone signing are active', async () => {
    const p = mockProvider({
      getDnssecInfo: async () => ({ dsDatas: [{ keyTag: '268', algorithm: '13', digestType: '2', digest: 'ABCD1234' }] }),
      getZoneDnssecInfo: async () => ({ enabled: true, type: 'dynamic', algorithm: 'ECDSAP256SHA256' }),
      getZoneDnssecDnskey: async () => ({
        type: 'DNSKEY',
        ttl: 3600,
        rdatas: [{ value: '256 3 13 SOMEPUBKEY==' }],
      }),
    });
    const status = await p.getDnssec('foo.com');
    expect(status.enabled).toBe(true);
    expect(status.scope).toBe('both');
    expect(status.dsRecords).toEqual([{ keyTag: 268, algorithm: 13, digestType: 2, digest: 'ABCD1234' }]);
    expect(status.dnsKey).toEqual({ flags: 256, protocol: 3, algorithm: 13, publicKey: 'SOMEPUBKEY==' });
  });

  it('reports scope=registry when only DS are published (zone hosted elsewhere)', async () => {
    const p = mockProvider({
      getDnssecInfo: async () => ({ dsDatas: [{ keyTag: '5', algorithm: '8', digestType: '2', digest: 'AB' }] }),
      getZoneDnssecInfo: async () => ({ enabled: false }),
    });
    const status = await p.getDnssec('foo.com');
    expect(status.scope).toBe('registry');
    expect(status.enabled).toBe(true);
    expect(status.dnsKey).toBeUndefined();
  });

  it('reports scope=zone when only zone is signed', async () => {
    const p = mockProvider({
      getDnssecInfo: async () => ({ dsDatas: [] }),
      getZoneDnssecInfo: async () => ({ enabled: true }),
      getZoneDnssecDnskey: async () => ({ type: 'DNSKEY', ttl: 3600, rdatas: [] }),
    });
    const status = await p.getDnssec('foo.com');
    expect(status.scope).toBe('zone');
    expect(status.dsRecords).toBeUndefined();
    expect(status.dnsKey).toBeUndefined();
  });

  it('reports scope=none and is tolerant of registry/zone errors', async () => {
    const p = mockProvider({
      getDnssecInfo: async () => { throw new Error('lookup failed'); },
      getZoneDnssecInfo: async () => { throw new Error('zone not hosted here'); },
    });
    const status = await p.getDnssec('foo.com');
    expect(status.enabled).toBe(false);
    expect(status.scope).toBe('none');
  });
});

describe('WebnicProvider.enableDnssec()', () => {
  it('publishes provided DS records at the registry when dsRecords supplied', async () => {
    const updateDnssec = vi.fn(async () => undefined);
    const enableZoneDnssec = vi.fn(async () => ({ enabled: true }));
    const p = mockProvider({
      updateDnssec,
      enableZoneDnssec,
      getDnssecInfo: async () => ({ dsDatas: [{ keyTag: '268', algorithm: '7', digestType: '2', digest: 'FF' }] }),
      getZoneDnssecInfo: async () => ({ enabled: false }),
    });
    await p.enableDnssec('foo.com', { dsRecords: [{ keyTag: 268, algorithm: 7, digestType: 2, digest: 'FF' }] });
    expect(updateDnssec).toHaveBeenCalledWith('foo.com', [{ keyTag: '268', algorithm: '7', digestType: '2', digest: 'FF' }]);
    expect(enableZoneDnssec).not.toHaveBeenCalled();
  });

  it('activates zone-side DNSSEC when no dsRecords supplied', async () => {
    const updateDnssec = vi.fn(async () => undefined);
    const enableZoneDnssec = vi.fn(async () => ({ enabled: true }));
    const p = mockProvider({
      updateDnssec,
      enableZoneDnssec,
      getDnssecInfo: async () => ({ dsDatas: [] }),
      getZoneDnssecInfo: async () => ({ enabled: true }),
      getZoneDnssecDnskey: async () => ({ type: 'DNSKEY', ttl: 3600, rdatas: [{ value: '257 3 13 PK==' }] }),
    });
    const status = await p.enableDnssec('foo.com');
    expect(enableZoneDnssec).toHaveBeenCalledWith('foo.com');
    expect(updateDnssec).not.toHaveBeenCalled();
    expect(status.scope).toBe('zone');
  });
});

describe('WebnicProvider.disableDnssec()', () => {
  it('calls both delete + disable when both layers active', async () => {
    const deleteDnssec = vi.fn(async () => undefined);
    const disableZoneDnssec = vi.fn(async () => ({ enabled: false }));
    const p = mockProvider({
      getDnssecInfo: async () => ({ dsDatas: [{ keyTag: '1', algorithm: '8', digestType: '2', digest: 'AA' }] }),
      getZoneDnssecInfo: async () => ({ enabled: true }),
      deleteDnssec,
      disableZoneDnssec,
    });
    await p.disableDnssec('foo.com');
    expect(deleteDnssec).toHaveBeenCalledWith('foo.com');
    expect(disableZoneDnssec).toHaveBeenCalledWith('foo.com');
  });

  it('is idempotent: skips calls when nothing is active', async () => {
    const deleteDnssec = vi.fn(async () => undefined);
    const disableZoneDnssec = vi.fn(async () => ({ enabled: false }));
    const p = mockProvider({
      getDnssecInfo: async () => ({ dsDatas: [] }),
      getZoneDnssecInfo: async () => ({ enabled: false }),
      deleteDnssec,
      disableZoneDnssec,
    });
    await expect(p.disableDnssec('foo.com')).resolves.toBeUndefined();
    expect(deleteDnssec).not.toHaveBeenCalled();
    expect(disableZoneDnssec).not.toHaveBeenCalled();
  });

  it('only disables zone layer when registry has no DS', async () => {
    const deleteDnssec = vi.fn(async () => undefined);
    const disableZoneDnssec = vi.fn(async () => ({ enabled: false }));
    const p = mockProvider({
      getDnssecInfo: async () => ({ dsDatas: [] }),
      getZoneDnssecInfo: async () => ({ enabled: true }),
      deleteDnssec,
      disableZoneDnssec,
    });
    await p.disableDnssec('foo.com');
    expect(deleteDnssec).not.toHaveBeenCalled();
    expect(disableZoneDnssec).toHaveBeenCalled();
  });
});
