import { describe, it, expect } from 'vitest';
import { PorkbunProvider } from '../../src/providers/porkbun/provider.js';
import { AgentError } from '../../src/errors.js';

// Access private methods via a test-accessible wrapper
// We test the provider's public interface with mock client responses

describe('PorkbunProvider domain mapping', () => {
  it('maps autorenew string "1" to true', async () => {
    const provider = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });
    // Inject a mock client that returns a domain with string autorenew
    const mockDomains = [
      {
        domain: 'example.com',
        status: 'ACTIVE',
        expireDate: '2027-01-15 00:00:00',
        autorenew: '1',
        securityLock: '1',
        notLocal: '0',
        labels: [],
        ns: ['ns1.porkbun.com', 'ns2.porkbun.com'],
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.listDomains = async () => mockDomains;

    const result = await provider.listDomains();
    expect(result).toHaveLength(1);
    expect(result[0].autoRenew).toBe(true);
    expect(result[0].locked).toBe(true);
    expect(result[0].status).toBe('active');
    expect(result[0].nameservers).toEqual(['ns1.porkbun.com', 'ns2.porkbun.com']);
  });

  it('maps autorenew integer 1 to true', async () => {
    const provider = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });
    const mockDomains = [
      {
        domain: 'example.com',
        status: 'ACTIVE',
        expireDate: '2027-01-15 00:00:00',
        autorenew: 1,
        securityLock: 0,
        notLocal: '0',
        labels: [],
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.listDomains = async () => mockDomains;

    const result = await provider.listDomains();
    expect(result[0].autoRenew).toBe(true);
    expect(result[0].locked).toBe(false);
  });

  it('maps autorenew string "0" to false', async () => {
    const provider = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });
    const mockDomains = [
      {
        domain: 'example.com',
        status: 'ACTIVE',
        expireDate: '2027-01-15 00:00:00',
        autorenew: '0',
        securityLock: '0',
        notLocal: '0',
        labels: [],
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.listDomains = async () => mockDomains;

    const result = await provider.listDomains();
    expect(result[0].autoRenew).toBe(false);
  });

  it('maps domain statuses correctly', async () => {
    const provider = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });
    const statuses = [
      { raw: 'ACTIVE', expected: 'active' },
      { raw: 'EXPIRED', expected: 'expired' },
      { raw: 'LOCKED', expected: 'locked' },
      { raw: 'UNKNOWN', expected: 'pending' },
    ] as const;

    for (const { raw, expected } of statuses) {
      const mockDomains = [
        { domain: 'test.com', status: raw, expireDate: '2027-01-15 00:00:00', autorenew: '0', securityLock: '0', notLocal: '0', labels: [] },
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).client.listDomains = async () => mockDomains;
      const result = await provider.listDomains();
      expect(result[0].status).toBe(expected);
    }
  });

  it('parses expireDate with space (Porkbun format) correctly', async () => {
    const provider = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });
    const mockDomains = [
      {
        domain: 'example.com',
        status: 'ACTIVE',
        expireDate: '2027-06-15 12:30:00',
        autorenew: '0',
        securityLock: '0',
        notLocal: '0',
        labels: [],
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.listDomains = async () => mockDomains;

    const result = await provider.listDomains();
    // Should produce a valid ISO string
    expect(() => new Date(result[0].expiresAt)).not.toThrow();
    expect(new Date(result[0].expiresAt).getFullYear()).toBe(2027);
  });
});

describe('PorkbunProvider DNS record mapping', () => {
  it('maps DNS records with string TTL and priority', async () => {
    const provider = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });
    const mockRecords = [
      { id: '123', name: 'mail', type: 'MX', content: 'mail.example.com', ttl: '3600', prio: '10' },
      { id: '124', name: '', type: 'A', content: '1.2.3.4', ttl: '300' },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.listDNSRecords = async () => mockRecords;

    const result = await provider.listDNSRecords('example.com');
    expect(result).toHaveLength(2);

    const mx = result.find((r) => r.type === 'MX');
    expect(mx?.ttl).toBe(3600);
    expect(mx?.priority).toBe(10);
    expect(mx?.id).toBe('123');
    expect(mx?.name).toBe('mail');

    const a = result.find((r) => r.type === 'A');
    expect(a?.name).toBe('@'); // empty name maps to '@'
    expect(a?.priority).toBeUndefined();
  });

  it('handles missing priority (no prio field)', async () => {
    const provider = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });
    const mockRecords = [
      { id: '125', name: 'sub', type: 'CNAME', content: 'other.example.com', ttl: '300' },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.listDNSRecords = async () => mockRecords;

    const result = await provider.listDNSRecords('example.com');
    expect(result[0].priority).toBeUndefined();
  });
});

describe('PorkbunProvider getDomain', () => {
  it('throws DOMAIN_NOT_FOUND when domain not in account', async () => {
    const provider = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });
    const mockDomains = [
      {
        domain: 'other.com',
        status: 'ACTIVE',
        expireDate: '2027-01-15 00:00:00',
        autorenew: '1',
        securityLock: '0',
        notLocal: '0',
        labels: [],
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.listDomains = async () => mockDomains;

    await expect(provider.getDomain('notfound.com')).rejects.toMatchObject({
      code: 'DOMAIN_NOT_FOUND',
    });
    await expect(provider.getDomain('notfound.com')).rejects.toBeInstanceOf(AgentError);
  });

  it('returns domain when found (case-insensitive)', async () => {
    const provider = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });
    const mockDomains = [
      {
        domain: 'example.com',
        status: 'ACTIVE',
        expireDate: '2027-01-15 00:00:00',
        autorenew: '1',
        securityLock: '0',
        notLocal: '0',
        labels: [],
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.listDomains = async () => mockDomains;

    const result = await provider.getDomain('EXAMPLE.COM');
    expect(result.name).toBe('example.com');
  });
});

describe('PorkbunProvider WHOIS contact — not supported', () => {
  it('getWhoisContact throws FEATURE_NOT_SUPPORTED', async () => {
    const provider = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });
    await expect(provider.getWhoisContact('example.com')).rejects.toMatchObject({
      code: 'FEATURE_NOT_SUPPORTED',
    });
  });

  it('updateWhoisContact throws FEATURE_NOT_SUPPORTED', async () => {
    const provider = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });
    const contact = {
      firstName: 'Jane', lastName: 'Smith', email: 'jane@example.com',
      phone: '+1.5555555555', address1: '1 Main St', city: 'City',
      state: 'CA', postalCode: '90210', country: 'US',
    };
    await expect(provider.updateWhoisContact('example.com', contact)).rejects.toMatchObject({
      code: 'FEATURE_NOT_SUPPORTED',
    });
  });

  it('supports() returns false for WhoisContact', () => {
    const provider = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });
    expect(provider.supports('whois_contact')).toBe(false);
  });
});
