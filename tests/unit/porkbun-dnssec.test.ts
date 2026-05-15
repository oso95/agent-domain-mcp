import { describe, it, expect } from 'vitest';
import { PorkbunProvider } from '../../src/providers/porkbun/provider.js';
import { Feature } from '../../src/providers/types.js';
import { AgentError } from '../../src/errors.js';

/**
 * Porkbun DNSSEC tests mock the client layer directly (rather than fetch) so we
 * exercise the provider's mapping/orchestration logic without re-testing the
 * shared retry/limiter wrapper in PorkbunClient.request().
 */

interface ClientStub {
  getDnssecRecords?: (domain: string) => Promise<Array<{ keyTag: number; algorithm: number; digestType: number; digest: string }>>;
  createDnssecRecord?: (domain: string, ds: { keyTag: number; algorithm: number; digestType: number; digest: string }) => Promise<void>;
  deleteDnssecRecord?: (domain: string, keyTag: number) => Promise<void>;
}

function newProvider(stub: ClientStub): PorkbunProvider {
  const p = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Object.assign((p as any).client, stub);
  return p;
}

describe('PorkbunProvider supports(Feature.Dnssec)', () => {
  it('returns true', () => {
    const p = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });
    expect(p.supports(Feature.Dnssec)).toBe(true);
  });
});

describe('PorkbunProvider DNSSEC', () => {
  it('getDnssec returns enabled=false / scope=none when no records', async () => {
    const p = newProvider({
      getDnssecRecords: async () => [],
    });
    const status = await p.getDnssec('foo.com');
    expect(status).toEqual({ domain: 'foo.com', enabled: false, scope: 'none' });
    expect(status.dsRecords).toBeUndefined();
  });

  it('getDnssec returns enabled=true / scope=registry with DS list', async () => {
    const p = newProvider({
      getDnssecRecords: async () => [
        { keyTag: 12345, algorithm: 13, digestType: 2, digest: 'ABCDEF' },
        { keyTag: 54321, algorithm: 13, digestType: 2, digest: '123456' },
      ],
    });
    const status = await p.getDnssec('foo.com');
    expect(status.domain).toBe('foo.com');
    expect(status.enabled).toBe(true);
    expect(status.scope).toBe('registry');
    expect(status.dsRecords).toHaveLength(2);
    expect(status.dsRecords?.[0]).toEqual({ keyTag: 12345, algorithm: 13, digestType: 2, digest: 'ABCDEF' });
  });

  it('enableDnssec without dsRecords throws FEATURE_NOT_SUPPORTED', async () => {
    const p = newProvider({
      getDnssecRecords: async () => [],
    });
    await expect(p.enableDnssec('foo.com')).rejects.toMatchObject({
      code: 'FEATURE_NOT_SUPPORTED',
    });
    await expect(p.enableDnssec('foo.com', { dsRecords: [] })).rejects.toBeInstanceOf(AgentError);
  });

  it('enableDnssec with dsRecords creates each then re-fetches status', async () => {
    const created: Array<{ keyTag: number; algorithm: number; digestType: number; digest: string }> = [];
    const p = newProvider({
      createDnssecRecord: async (_domain, ds) => { created.push(ds); },
      // Simulate read-back after creation
      getDnssecRecords: async () => created.slice(),
    });
    const ds: { keyTag: number; algorithm: number; digestType: number; digest: string }[] = [
      { keyTag: 12345, algorithm: 13, digestType: 2, digest: 'ABCDEF' },
      { keyTag: 54321, algorithm: 13, digestType: 2, digest: '123456' },
    ];
    const status = await p.enableDnssec('foo.com', { dsRecords: ds });
    expect(created).toEqual(ds);
    expect(status.enabled).toBe(true);
    expect(status.scope).toBe('registry');
    expect(status.dsRecords).toHaveLength(2);
  });

  it('disableDnssec lists existing DS records then deletes each by keyTag', async () => {
    const present = [
      { keyTag: 12345, algorithm: 13, digestType: 2, digest: 'ABCDEF' },
      { keyTag: 54321, algorithm: 13, digestType: 2, digest: '123456' },
    ];
    const deletedKeyTags: number[] = [];
    const p = newProvider({
      getDnssecRecords: async () => present,
      deleteDnssecRecord: async (_domain, keyTag) => { deletedKeyTags.push(keyTag); },
    });
    await p.disableDnssec('foo.com');
    expect(deletedKeyTags).toEqual([12345, 54321]);
  });

  it('disableDnssec is a no-op when no DS records exist (idempotent)', async () => {
    let deleteCalls = 0;
    const p = newProvider({
      getDnssecRecords: async () => [],
      deleteDnssecRecord: async () => { deleteCalls += 1; },
    });
    await expect(p.disableDnssec('foo.com')).resolves.toBeUndefined();
    expect(deleteCalls).toBe(0);
  });
});
