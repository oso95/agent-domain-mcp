import { describe, it, expect, vi } from 'vitest';
import { WebnicProvider } from '../../src/providers/webnic/provider.js';
import { translateWebnicError } from '../../src/providers/webnic/client.js';
import { AgentError } from '../../src/errors.js';
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

describe('WebnicProvider supports()', () => {
  it('reports the right feature matrix', () => {
    const p = new WebnicProvider(baseConfig);
    expect(p.supports(Feature.Registration)).toBe(true);
    expect(p.supports(Feature.Renewal)).toBe(true);
    expect(p.supports(Feature.DnsWrite)).toBe(true);
    expect(p.supports(Feature.Transfer)).toBe(true);
    expect(p.supports(Feature.WhoisContact)).toBe(true);
    expect(p.supports(Feature.Pricing)).toBe(true);
    expect(p.supports(Feature.SSL)).toBe(true);
  });
});

describe('WebnicProvider availability', () => {
  it('maps a regular available domain', async () => {
    const p = mockProvider({
      queryDomain: async () => ({ available: true, premium: false }),
      getExtensionPricing: async () => [],
    });
    const r = await p.checkAvailability('foo.com');
    expect(r.available).toBe(true);
    expect(r.premium).toBe(false);
    expect(r.availabilitySource).toBe('webnic');
  });

  it('attaches premium pricing when present', async () => {
    const p = mockProvider({
      queryDomain: async () => ({
        available: true,
        premium: true,
        premiumInfo: { currency: 'MYR', registerPrice: 2859.98, renewPrice: 2859.98, transferPrice: 2859.98, restorePrice: 2859.98 },
      }),
    });
    const r = await p.checkAvailability('git.my');
    expect(r.price).toEqual({ registration: 2859.98, renewal: 2859.98, currency: 'MYR' });
    expect(r.priceSource).toBe('webnic');
  });

  it('enriches with extension pricing when domain is available and not premium', async () => {
    const p = mockProvider({
      queryDomain: async () => ({ available: true, premium: false }),
      getExtensionPricing: async () => [{
        productKey: 'com',
        productPricing: { price: { register: { ascii: { '1': 20 } }, renewal: { ascii: { '1': 10.99 } } } },
      }],
    });
    const r = await p.checkAvailability('example.com');
    expect(r.price).toEqual({ registration: 20, renewal: 10.99, currency: 'USD' });
  });
});

describe('WebnicProvider listDomains / getDomain', () => {
  it('lists inzone domains with minimal metadata', async () => {
    const p = mockProvider({
      listZones: async () => ([
        { zone: 'a.com', zoneType: 'inzone', subscription: null, subscriptionId: null, dtcreate: '2024-01-01', dtmodify: '2024-01-01' },
        { zone: 'b.io', zoneType: 'inzone', subscription: null, subscriptionId: null, dtcreate: '2024-01-01', dtmodify: '2024-01-01' },
      ]),
    });
    const domains = await p.listDomains();
    expect(domains).toHaveLength(2);
    expect(domains[0].name).toBe('a.com');
    expect(domains[0].provider).toBe('webnic');
    expect(domains[0].status).toBe('active');
  });

  it('maps getDomain dtexpire (no TZ) to ISO UTC', async () => {
    const p = mockProvider({
      getDomainInfo: async () => ({
        domainName: 'x.com',
        status: 'active',
        nameservers: ['ns1.web.cc', 'ns2.web.cc'],
        dtexpire: '2027-03-15T09:05:13',
      }),
    });
    const d = await p.getDomain('x.com');
    expect(d.expiresAt).toBe('2027-03-15T09:05:13.000Z');
    expect(d.nameservers).toEqual(['ns1.web.cc', 'ns2.web.cc']);
    expect(d.status).toBe('active');
  });

  it('keeps original TZ when explicit offset is present', async () => {
    const p = mockProvider({
      getDomainInfo: async () => ({
        domainName: 'x.com',
        status: 'active',
        nameservers: [],
        dtexpire: '2023-05-16T17:47:38+08:00',
      }),
    });
    const d = await p.getDomain('x.com');
    expect(new Date(d.expiresAt).toISOString()).toBe('2023-05-16T09:47:38.000Z');
  });
});

describe('WebnicProvider updateNameservers auto-unlock', () => {
  function trackerProvider(initialStatus: string, override: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const status = { v: initialStatus };
    const provider = new WebnicProvider(baseConfig);
    Object.assign((provider as unknown as { client: Record<string, unknown> }).client, {
      getDomainInfo: async () => ({ domainName: 'x.com', status: status.v, nameservers: [], dtexpire: '2027-01-01T00:00:00' }),
      updateDomainStatus: async (d: string, s: string) => { calls.push(`status=${s}`); status.v = s; },
      updateNameservers: async (_d: string, ns: string[]) => { calls.push(`ns=${ns.join('|')}`); },
      ...override,
    });
    return { provider, calls, status };
  }

  it('unlocks name_protected, writes NS, re-locks to name_protected', async () => {
    const { provider, calls, status } = trackerProvider('name_protected');
    await provider.updateNameservers('x.com', ['ns1.x.cc', 'ns2.x.cc']);
    expect(calls).toEqual(['status=active', 'ns=ns1.x.cc|ns2.x.cc', 'status=name_protected']);
    expect(status.v).toBe('name_protected');
  });

  it('unlocks transfer_protected, writes NS, locks DOWN to name_protected (strictest)', async () => {
    const { calls, status, provider } = trackerProvider('transfer_protected');
    await provider.updateNameservers('x.com', ['a', 'b']);
    expect(calls).toEqual(['status=active', 'ns=a|b', 'status=name_protected']);
    expect(status.v).toBe('name_protected');
  });

  it('skips the unlock dance entirely when domain is already active', async () => {
    const { calls, provider } = trackerProvider('active');
    await provider.updateNameservers('x.com', ['a', 'b']);
    expect(calls).toEqual(['ns=a|b']);
  });

  it('still locks to name_protected in finally even if updateNameservers throws', async () => {
    const boom = new Error('boom');
    const { calls, status, provider } = trackerProvider('name_protected', {
      updateNameservers: async () => { throw boom; },
    });
    await expect(provider.updateNameservers('x.com', ['a', 'b'])).rejects.toBe(boom);
    expect(calls).toEqual(['status=active', 'status=name_protected']);
    expect(status.v).toBe('name_protected');
  });

  it('does not mask the op error if status restore fails (logs to stderr)', async () => {
    const opErr = new Error('op-fail');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { calls, provider } = trackerProvider('name_protected', {
      updateNameservers: async () => { throw opErr; },
      updateDomainStatus: async (_d: string, s: string) => {
        calls.push(`status=${s}`);
        if (s === 'name_protected') throw new Error('restore-fail');
      },
    });
    await expect(provider.updateNameservers('x.com', ['a', 'b'])).rejects.toBe(opErr);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("failed to restore protection on 'x.com'"), expect.any(String));
    errSpy.mockRestore();
  });
});

describe('WebnicProvider registration prerequisites', () => {
  it('throws REGISTRATION_PREREQUISITES_NOT_MET when contact id is missing', async () => {
    const p = new WebnicProvider({ username: 'u', password: 'p' });
    await expect(p.registerDomain({
      domain: 'x.com', years: 1, autoRenew: false, privacyProtection: false,
      contact: { firstName: 'F', lastName: 'L', email: 'e@e.com', phone: '+33.1', address1: 'A', city: 'C', state: 'S', postalCode: 'Z', country: 'FR' },
    })).rejects.toMatchObject({ code: 'REGISTRATION_PREREQUISITES_NOT_MET' });
  });

  it('calls register with the configured contact and registrant ids', async () => {
    let captured: Record<string, unknown> | null = null;
    const p = mockProvider({
      registerDomain: async (params: Record<string, unknown>) => {
        captured = params;
        return { pendingOrder: false, dtexpire: '2027-01-01T00:00:00' };
      },
    });
    await p.registerDomain({
      domain: 'foo.com', years: 2, autoRenew: false, privacyProtection: true,
      contact: { firstName: 'F', lastName: 'L', email: 'e@e.com', phone: '+33.1', address1: 'A', city: 'C', state: 'S', postalCode: 'Z', country: 'FR' },
    });
    expect(captured).toMatchObject({
      domainName: 'foo.com',
      term: 2,
      registrantContactId: 'WN1234T',
      administratorContactId: 'WN1234T',
      technicalContactId: 'WN1234T',
      billingContactId: 'WN1234T',
      registrantUserId: 'REG100015',
      whoisPrivacy: true,
    });
  });
});

describe('WebnicProvider DNS flatten / encode', () => {
  it('flattens multi-rdata records with stable ids', async () => {
    const p = mockProvider({
      listRecords: async () => ({
        records: [
          { name: 'mail', type: 'MX', ttl: 3600, rdatas: [{ value: '10 mail.example.com' }, { value: '20 mail2.example.com' }] },
          { name: null, type: 'A', ttl: 300, rdatas: [{ value: '1.2.3.4' }] },
        ],
        sourceFrom: 'basic',
      }),
    });
    const records = await p.listDNSRecords('example.com');
    expect(records).toHaveLength(3);
    const mx = records.filter((r) => r.type === 'MX');
    expect(mx).toHaveLength(2);
    expect(mx[0].priority).toBe(10);
    expect(mx[0].content).toBe('mail.example.com');
    expect(mx[0].id).toBe('MX:mail:0');
    expect(mx[1].id).toBe('MX:mail:1');

    const a = records.find((r) => r.type === 'A');
    expect(a?.name).toBe('@');
    expect(a?.id).toBe('A:@:0');
  });

  it('encodes MX priority+content on create and merges with existing rdatas', async () => {
    let saved: Record<string, unknown> | null = null;
    const p = mockProvider({
      listRecords: async () => ({
        records: [{ name: 'mail', type: 'MX', ttl: 3600, rdatas: [{ value: '10 mail1.example.com' }] }],
        sourceFrom: 'basic',
      }),
      saveRecord: async (_zone: string, record: Record<string, unknown>) => {
        saved = record;
        return { ...record, rdatas: record.rdatas };
      },
    });
    await p.createDNSRecord('example.com', { type: 'MX', name: 'mail', content: 'mail2.example.com', ttl: 3600, priority: 20 });
    expect(saved).not.toBeNull();
    expect((saved as { rdatas: { value: string }[] }).rdatas).toEqual([
      { value: '10 mail1.example.com' },
      { value: '20 mail2.example.com' },
    ]);
  });

  it('is idempotent: creating the same MX rdata twice does not duplicate it', async () => {
    let saveCalls = 0;
    let savedRdatas: { value: string }[] = [{ value: '10 mail1.example.com' }];
    const p = mockProvider({
      listRecords: async () => ({
        records: [{ name: 'mail', type: 'MX', ttl: 3600, rdatas: savedRdatas }],
        sourceFrom: 'basic',
      }),
      saveRecord: async (_zone: string, record: Record<string, unknown>) => {
        saveCalls += 1;
        savedRdatas = record.rdatas as { value: string }[];
        return record;
      },
    });

    // First create: new value, should save.
    const first = await p.createDNSRecord('example.com', {
      type: 'MX', name: 'mail', content: 'mail2.example.com', ttl: 3600, priority: 20,
    });
    expect(saveCalls).toBe(1);
    expect(savedRdatas).toEqual([
      { value: '10 mail1.example.com' },
      { value: '20 mail2.example.com' },
    ]);
    expect(first.id).toBe('MX:mail:1');

    // Second create with identical encoded value: should be a no-op (no save) and
    // return the existing rdata's id.
    const second = await p.createDNSRecord('example.com', {
      type: 'MX', name: 'mail', content: 'mail2.example.com', ttl: 3600, priority: 20,
    });
    expect(saveCalls).toBe(1);
    expect(savedRdatas).toEqual([
      { value: '10 mail1.example.com' },
      { value: '20 mail2.example.com' },
    ]);
    expect(second.id).toBe('MX:mail:1');
  });

  it('is idempotent for non-MX types (A): same content does not duplicate', async () => {
    let saveCalls = 0;
    let savedRdatas: { value: string }[] = [{ value: '1.2.3.4' }];
    const p = mockProvider({
      listRecords: async () => ({
        records: [{ name: 'www', type: 'A', ttl: 300, rdatas: savedRdatas }],
        sourceFrom: 'basic',
      }),
      saveRecord: async (_zone: string, record: Record<string, unknown>) => {
        saveCalls += 1;
        savedRdatas = record.rdatas as { value: string }[];
        return record;
      },
    });

    const r = await p.createDNSRecord('example.com', {
      type: 'A', name: 'www', content: '1.2.3.4', ttl: 300,
    });
    expect(saveCalls).toBe(0);
    expect(r.id).toBe('A:www:0');
  });

  it('rejects unsupported record type (NS)', async () => {
    const p = mockProvider({});
    await expect(p.createDNSRecord('example.com', { type: 'NS' as 'A', name: '@', content: 'ns1.x.com', ttl: 300 }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_RECORD_TYPE' });
  });

  it('accepts the full extended catalog (ALIAS, HTTPS, SVCB, TLSA, DS, SMIMEA, …)', async () => {
    const extended = ['ALIAS', 'HTTPS', 'SVCB', 'TLSA', 'PTR', 'SSHFP', 'NAPTR', 'SOA', 'DS', 'CDS', 'CDNSKEY', 'CERT', 'LOC', 'SMIMEA', 'URI'];
    for (const t of extended) {
      const saves: Record<string, unknown>[] = [];
      const p = mockProvider({
        listRecords: async () => ({ records: [], sourceFrom: 'basic' }),
        saveRecord: async (_zone: string, record: Record<string, unknown>) => {
          saves.push(record);
          return record;
        },
      });
      await p.createDNSRecord('example.com', { type: t as 'A', name: 'x', content: 'data', ttl: 3600 });
      expect(saves).toHaveLength(1);
      expect(saves[0].type).toBe(t);
    }
  });

  it('rejects DNSKEY (managed via zone DNSSEC endpoints, not as a record)', async () => {
    const p = mockProvider({});
    await expect(p.createDNSRecord('example.com', { type: 'DNSKEY' as 'A', name: '@', content: 'key', ttl: 300 }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_RECORD_TYPE' });
  });

  it('accepts CAA records and decodes HTML-escaped quotes from listRecords', async () => {
    let saved: Record<string, unknown> | null = null;
    const p = mockProvider({
      listRecords: async () => ({
        records: [
          { name: null, type: 'CAA', ttl: 3600, rdatas: [{ value: '0 issue &quot;letsencrypt.org&quot;' }] },
        ],
        sourceFrom: 'basic',
      }),
      saveRecord: async (_zone: string, record: Record<string, unknown>) => {
        saved = record;
        return record;
      },
    });
    const records = await p.listDNSRecords('example.com');
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('CAA');
    // HTML entities decoded
    expect(records[0].content).toBe('0 issue "letsencrypt.org"');

    // Create should accept CAA — content passed through unchanged
    await p.createDNSRecord('example.com', { type: 'CAA', name: '@', content: '0 issuewild "letsencrypt.org"', ttl: 3600 });
    expect(saved).not.toBeNull();
    expect((saved as { type: string }).type).toBe('CAA');
  });

  it('deletes the whole record set when only one rdata remains', async () => {
    let deleted: { type?: string; name?: string } = {};
    const p = mockProvider({
      listRecords: async () => ({
        records: [{ name: 'www', type: 'A', ttl: 300, rdatas: [{ value: '1.2.3.4' }] }],
        sourceFrom: 'basic',
      }),
      deleteRecord: async (_zone: string, type: string, name: string) => { deleted = { type, name }; },
    });
    await p.deleteDNSRecord('example.com', 'A:www:0');
    expect(deleted).toEqual({ type: 'A', name: 'www' });
  });

  it('removes a single rdata via saveRecord when multiple remain', async () => {
    let saved: { rdatas?: { value: string }[] } = {};
    const p = mockProvider({
      listRecords: async () => ({
        records: [{ name: 'mail', type: 'MX', ttl: 3600, rdatas: [{ value: '10 a.com' }, { value: '20 b.com' }] }],
        sourceFrom: 'basic',
      }),
      saveRecord: async (_zone: string, record: Record<string, unknown>) => {
        saved = record as { rdatas?: { value: string }[] };
        return record;
      },
    });
    await p.deleteDNSRecord('example.com', 'MX:mail:0');
    expect(saved.rdatas).toEqual([{ value: '20 b.com' }]);
  });

  it('throws NOT_FOUND when delete index is out of range', async () => {
    const p = mockProvider({
      listRecords: async () => ({
        records: [{ name: 'mail', type: 'MX', ttl: 3600, rdatas: [{ value: '10 a.com' }, { value: '20 b.com' }] }],
        sourceFrom: 'basic',
      }),
    });
    await expect(p.deleteDNSRecord('example.com', 'MX:mail:5')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects malformed record IDs', async () => {
    const p = mockProvider({
      listRecords: async () => ({ records: [], sourceFrom: 'basic' }),
    });
    await expect(p.deleteDNSRecord('example.com', 'bogus')).rejects.toMatchObject({ code: 'INVALID_RECORD_ID' });
  });
});

describe('WebnicProvider transfer mapping', () => {
  it('maps "complete" to completed', async () => {
    const p = mockProvider({
      getTransferInStatus: async () => ({ id: 1, domain: 'a', ext: 'com', status: 'complete', dtcreate: '2024-01-01T00:00:00+00:00' }),
    });
    const t = await p.getTransferStatus('a.com');
    expect(t.status).toBe('completed');
    expect(t.completedAt).toBeDefined();
  });

  it('maps "reject" / "insert_fail" to rejected', async () => {
    const p1 = mockProvider({ getTransferInStatus: async () => ({ id: 1, domain: 'a', ext: 'com', status: 'reject' }) });
    expect((await p1.getTransferStatus('a.com')).status).toBe('rejected');

    const p2 = mockProvider({ getTransferInStatus: async () => ({ id: 2, domain: 'a', ext: 'com', status: 'insert_fail' }) });
    expect((await p2.getTransferStatus('a.com')).status).toBe('rejected');
  });
});

describe('WebnicProvider WHOIS', () => {
  it('reads registrant via getDomainInfo + queryContact', async () => {
    const p = mockProvider({
      getDomainInfo: async () => ({
        domainName: 'x.com', status: 'active', nameservers: [], dtexpire: '2027-01-01T00:00:00',
        contactId: { registrant: 'WN9999T', admin: 'WN9999T', technical: 'WN9999T', billing: 'WN9999T' },
      }),
      queryContact: async () => ({
        contactId: 'WN9999T',
        contactType: 'registrant',
        details: {
          firstName: 'Jane', lastName: 'Smith', email: 'jane@example.com', phoneNumber: '+33.1',
          address1: '1 Main St', city: 'Paris', state: 'IDF', zip: '75001', countryCode: 'FR',
        },
      }),
    });
    const c = await p.getWhoisContact('x.com');
    expect(c).toEqual({
      firstName: 'Jane', lastName: 'Smith', email: 'jane@example.com', phone: '+33.1',
      address1: '1 Main St', city: 'Paris', state: 'IDF', postalCode: '75001', country: 'FR',
    });
  });

  it('updateWhoisContact is not implemented in MVP', async () => {
    const p = mockProvider({});
    await expect(p.updateWhoisContact('x.com', {
      firstName: 'J', lastName: 'S', email: 'j@s.com', phone: '+1.1',
      address1: 'a', city: 'b', state: 'c', postalCode: 'd', country: 'US',
    })).rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' });
  });
});

// SSL coverage lives in tests/unit/webnic-ssl.test.ts.

describe('translateWebnicError', () => {
  it('detects auth failures from 401', () => {
    const err = translateWebnicError(401, { code: '2401', message: 'Invalid token' });
    expect(err.code).toBe('AUTH_FAILED');
    expect(err.provider).toBe('webnic');
  });

  it('detects rate limiting from 429', () => {
    const err = translateWebnicError(429, { code: '2429', message: 'Too many requests' });
    expect(err.code).toBe('RATE_LIMIT');
  });

  it('detects domain unavailable from message keywords', () => {
    const err = translateWebnicError(200, { code: '2400', message: 'Domain already registered' });
    expect(err.code).toBe('DOMAIN_UNAVAILABLE');
  });

  it('exposes validation errors with field details', () => {
    const err = translateWebnicError(400, {
      code: '2400',
      message: 'Field validation error.',
      fieldErrors: [{ field: 'technical.customFields.identificationNumber', messages: ['mandatory'] }],
    });
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toContain('identificationNumber');
  });

  it('falls back to generic WEBNIC_ERROR', () => {
    const err = translateWebnicError(500, { code: '5000', message: 'Boom' });
    expect(err.code).toBe('WEBNIC_ERROR');
    expect(err).toBeInstanceOf(AgentError);
  });
});
