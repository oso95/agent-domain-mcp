/**
 * Edge case tests for provider-specific behaviors not covered by other tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Feature } from '../../src/providers/types.js';

// ─── Cloudflare supports() feature flags ──────────────────────────────────

describe('CloudflareProvider.supports()', () => {
  it('returns false for WhoisContact (not supported via API)', async () => {
    const { CloudflareProvider } = await import('../../src/providers/cloudflare/provider.js');
    const provider = new CloudflareProvider({ apiToken: 'tok' });
    expect(provider.supports(Feature.WhoisContact)).toBe(false);
  });

  it('returns false for Registration, Renewal, Transfer, Pricing', async () => {
    const { CloudflareProvider } = await import('../../src/providers/cloudflare/provider.js');
    const provider = new CloudflareProvider({ apiToken: 'tok' });
    expect(provider.supports(Feature.Registration)).toBe(false);
    expect(provider.supports(Feature.Renewal)).toBe(false);
    expect(provider.supports(Feature.Transfer)).toBe(false);
    expect(provider.supports(Feature.Pricing)).toBe(false);
  });

  it('returns true for DnsWrite and SSL', async () => {
    const { CloudflareProvider } = await import('../../src/providers/cloudflare/provider.js');
    const provider = new CloudflareProvider({ apiToken: 'tok' });
    expect(provider.supports(Feature.DnsWrite)).toBe(true);
    expect(provider.supports(Feature.SSL)).toBe(true);
  });
});

// ─── GoDaddy deleteDNSRecord ID parsing ────────────────────────────────────

describe('GoDaddyProvider.deleteDNSRecord ID parsing', () => {
  it('throws INVALID_RECORD_ID when recordId has no dash', async () => {
    const { GoDaddyProvider } = await import('../../src/providers/godaddy/provider.js');
    const provider = new GoDaddyProvider({ apiKey: 'k', apiSecret: 's' });

    await expect(provider.deleteDNSRecord('example.com', 'NOTYPE'))
      .rejects.toMatchObject({ code: 'INVALID_RECORD_ID' });
  });

  it('correctly splits hyphenated subdomain names from recordId', async () => {
    const { GoDaddyProvider } = await import('../../src/providers/godaddy/provider.js');
    const provider = new GoDaddyProvider({ apiKey: 'k', apiSecret: 's' });
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.deleteDNSRecord = deleteSpy;

    // recordId = "A-multi-part-name" → type="A", name="multi-part-name"
    await provider.deleteDNSRecord('example.com', 'A-multi-part-name');
    expect(deleteSpy).toHaveBeenCalledWith('example.com', 'A', 'multi-part-name');
  });

  it('handles root record "@" in recordId', async () => {
    const { GoDaddyProvider } = await import('../../src/providers/godaddy/provider.js');
    const provider = new GoDaddyProvider({ apiKey: 'k', apiSecret: 's' });
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.deleteDNSRecord = deleteSpy;

    await provider.deleteDNSRecord('example.com', 'TXT-@');
    expect(deleteSpy).toHaveBeenCalledWith('example.com', 'TXT', '@');
  });
});

// ─── availability.ts Feature.Pricing guard ─────────────────────────────────

describe('handleCheckAvailability Feature.Pricing guard', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
    // Mock RDAP to return domain available (404)
    vi.mocked(global.fetch).mockResolvedValue({
      status: 404, ok: false, json: async () => ({}), text: async () => '',
    } as Response);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('skips pricing enrichment when provider does not support Pricing', async () => {
    const checkAvailabilitySpy = vi.fn();
    const getPricingTableSpy = vi.fn();
    const mockProvider = {
      name: () => 'mock',
      supports: () => false, // doesn't support Pricing
      checkAvailability: checkAvailabilitySpy,
      getPricingTable: getPricingTableSpy,
    };
    const registry = {
      names: () => ['mock'],
      get: () => mockProvider,
    };

    const { handleCheckAvailability } = await import('../../src/tools/availability.js');
    const result = await handleCheckAvailability(
      { domain: 'testdomain.com', provider: 'mock' },
      registry as never,
    );

    // Neither checkAvailability nor getPricingTable should be called for pricing
    expect(checkAvailabilitySpy).not.toHaveBeenCalled();
    expect(getPricingTableSpy).not.toHaveBeenCalled();
    // Result should still have domain availability (from RDAP)
    expect(result.results).toHaveLength(1);
    expect(result.results[0].domain).toBe('testdomain.com');
    // No pricing enrichment
    expect(result.results[0].price).toBeUndefined();
  });

  it('includes pricing when provider supports Pricing', async () => {
    const getPricingTableSpy = vi.fn().mockResolvedValue({
      com: { registration: 9.99, renewal: 9.99, currency: 'USD' },
    });
    const mockProvider = {
      name: () => 'mock',
      supports: () => true, // supports Pricing
      checkAvailability: vi.fn(),
      getPricingTable: getPricingTableSpy,
    };
    const registry = {
      names: () => ['mock'],
      get: () => mockProvider,
    };

    const { handleCheckAvailability } = await import('../../src/tools/availability.js');
    const result = await handleCheckAvailability(
      { domain: 'testdomain.com', provider: 'mock' },
      registry as never,
    );

    expect(getPricingTableSpy).toHaveBeenCalledTimes(1);
    expect(result.results[0].price?.registration).toBe(9.99);
  });
});

// ─── GoDaddy createDNSRecord appends (read-modify-write) ──────────────────

describe('GoDaddyClient.createDNSRecord appends existing records', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('GETs existing records then PATCHes with all including the new one', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      const path = String(url).replace('https://api.godaddy.com', '');
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, path, body });

      if (method === 'GET') {
        // Return 1 existing MX record
        const body = JSON.stringify([{ type: 'MX', name: '@', data: 'mx1.example.com', ttl: 300, priority: 10 }]);
        return { ok: true, status: 200, text: async () => body } as Response;
      }
      // PATCH succeeds
      return { ok: true, status: 200, text: async () => '{}' } as Response;
    });

    const { GoDaddyClient } = await import('../../src/providers/godaddy/client.js');
    const client = new GoDaddyClient({ apiKey: 'k', apiSecret: 's' });
    await client.createDNSRecord('example.com', { type: 'MX', name: '@', data: 'mx2.example.com', ttl: 300, priority: 20 });

    const get = calls.find((c) => c.method === 'GET');
    const patch = calls.find((c) => c.method === 'PATCH');

    expect(get).toBeDefined();
    expect(patch).toBeDefined();
    // PATCH body should contain both the existing and the new record
    expect(patch?.body).toHaveLength(2);
    expect((patch?.body as Array<{data: string}>).map((r) => r.data)).toContain('mx1.example.com');
    expect((patch?.body as Array<{data: string}>).map((r) => r.data)).toContain('mx2.example.com');
  });

  it('propagates all GET errors (403 auth failure, 404 domain-not-found) without swallowing', async () => {
    // GoDaddy returns 200+empty-array when a record type doesn't exist, NOT 404.
    // A 404 on GET means the domain itself is missing from the account — must propagate.
    global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      if (method === 'GET') {
        return { ok: false, status: 403, text: async () => JSON.stringify({ code: 'ACCESS_DENIED', message: 'Permission denied' }) } as Response;
      }
      return { ok: true, status: 200, text: async () => '{}' } as Response;
    });

    const { GoDaddyClient } = await import('../../src/providers/godaddy/client.js');
    const client = new GoDaddyClient({ apiKey: 'k', apiSecret: 's' });
    await expect(client.createDNSRecord('example.com', { type: 'A', name: 'www', data: '1.2.3.4', ttl: 300 }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('propagates 404 on GET as DOMAIN_NOT_FOUND (not silently swallowed)', async () => {
    // Before fix: 404 was swallowed and PATCH was attempted with wrong data.
    // After fix: 404 propagates — domain must exist for DNS record creation.
    global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      if (method === 'GET') {
        return { ok: false, status: 404, text: async () => JSON.stringify({ code: 'NOT_FOUND', message: 'Not found' }) } as Response;
      }
      return { ok: true, status: 200, text: async () => '{}' } as Response;
    });

    const { GoDaddyClient } = await import('../../src/providers/godaddy/client.js');
    const client = new GoDaddyClient({ apiKey: 'k', apiSecret: 's' });
    await expect(client.createDNSRecord('example.com', { type: 'A', name: 'www', data: '1.2.3.4', ttl: 300 }))
      .rejects.toMatchObject({ code: 'DOMAIN_NOT_FOUND' });
  });

  it('creates single record when GET returns empty array (no existing records)', async () => {
    // GoDaddy returns 200+[] for missing record types — verify we correctly append.
    const calls: { method: string; body?: unknown }[] = [];
    global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, body });
      if (method === 'GET') {
        return { ok: true, status: 200, text: async () => '[]' } as Response;
      }
      return { ok: true, status: 200, text: async () => '{}' } as Response;
    });

    const { GoDaddyClient } = await import('../../src/providers/godaddy/client.js');
    const client = new GoDaddyClient({ apiKey: 'k', apiSecret: 's' });
    await client.createDNSRecord('example.com', { type: 'A', name: 'www', data: '1.2.3.4', ttl: 300 });

    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toHaveLength(1);
    expect((patch?.body as Array<{data: string}>)[0].data).toBe('1.2.3.4');
  });
});

// ─── Namecheap getPricingTable ─────────────────────────────────────────────

describe('NamecheapProvider.getPricingTable', () => {
  it('is exposed from provider', async () => {
    const { NamecheapProvider } = await import('../../src/providers/namecheap/provider.js');
    const provider = new NamecheapProvider({ apiKey: 'k', apiUser: 'user', clientIp: '1.2.3.4' });
    expect(typeof provider.getPricingTable).toBe('function');
  });
});

// ─── Namecheap updateDNSRecord HostId-based matching ──────────────────────

describe('NamecheapProvider.updateDNSRecord HostId matching', () => {
  it('uses HostId to find the exact record when available', async () => {
    const { NamecheapProvider } = await import('../../src/providers/namecheap/provider.js');
    const provider = new NamecheapProvider({ apiKey: 'k', apiUser: 'user', clientIp: '1.2.3.4' });

    const existingRecords = [
      { '@_Type': 'A', '@_Name': 'sub', '@_Address': '1.1.1.1', '@_TTL': 300, '@_HostId': '101' },
      { '@_Type': 'A', '@_Name': 'sub', '@_Address': '2.2.2.2', '@_TTL': 300, '@_HostId': '102' },
    ];
    const setRecordsSpy = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.getDNSRecords = vi.fn().mockResolvedValue(existingRecords);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.setDNSRecords = setRecordsSpy;

    // Update the second record (HostId 102) by passing id=A-sub-102
    await provider.updateDNSRecord('example.com', {
      id: 'A-sub-102',
      type: 'A',
      name: 'sub',
      content: '3.3.3.3',
      ttl: 300,
    });

    // Verify setDNSRecords was called with the correct updated records
    expect(setRecordsSpy).toHaveBeenCalledTimes(1);
    const [, , updatedRecords] = setRecordsSpy.mock.calls[0];
    // First record (HostId 101) should remain unchanged at '1.1.1.1'
    expect(updatedRecords[0]['@_Address']).toBe('1.1.1.1');
    // Second record (HostId 102) should be updated to '3.3.3.3'
    expect(updatedRecords[1]['@_Address']).toBe('3.3.3.3');
  });

  it('falls back to type+name match when HostId is "0"', async () => {
    const { NamecheapProvider } = await import('../../src/providers/namecheap/provider.js');
    const provider = new NamecheapProvider({ apiKey: 'k', apiUser: 'user', clientIp: '1.2.3.4' });

    const existingRecords = [
      { '@_Type': 'TXT', '@_Name': '@', '@_Address': 'old-txt', '@_TTL': 300, '@_HostId': '200' },
    ];
    const setRecordsSpy = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.getDNSRecords = vi.fn().mockResolvedValue(existingRecords);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.setDNSRecords = setRecordsSpy;

    // id with hostId=0 — should fall back to type+name match
    await provider.updateDNSRecord('example.com', {
      id: 'TXT-@-0',
      type: 'TXT',
      name: '@',
      content: 'new-txt',
      ttl: 300,
    });

    const [, , updatedRecords] = setRecordsSpy.mock.calls[0];
    expect(updatedRecords[0]['@_Address']).toBe('new-txt');
  });

  it('throws RECORD_NOT_FOUND when no matching record', async () => {
    const { NamecheapProvider } = await import('../../src/providers/namecheap/provider.js');
    const provider = new NamecheapProvider({ apiKey: 'k', apiUser: 'user', clientIp: '1.2.3.4' });

    const existingRecords = [
      { '@_Type': 'A', '@_Name': 'other', '@_Address': '1.2.3.4', '@_TTL': 300, '@_HostId': '100' },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.getDNSRecords = vi.fn().mockResolvedValue(existingRecords);

    await expect(provider.updateDNSRecord('example.com', {
      id: 'TXT-sub-999',
      type: 'TXT',
      name: 'sub',
      content: 'val',
      ttl: 300,
    })).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND' });
  });

  it('returns updated record with refreshed HostId after re-fetch', async () => {
    const { NamecheapProvider } = await import('../../src/providers/namecheap/provider.js');
    const provider = new NamecheapProvider({ apiKey: 'k', apiUser: 'user', clientIp: '1.2.3.4' });

    const beforeRecords = [
      { '@_Type': 'TXT', '@_Name': '@', '@_Address': 'old-value', '@_TTL': 300, '@_HostId': '500' },
    ];
    // After write, Namecheap reassigns HostId (e.g., 500 → 501)
    const afterRecords = [
      { '@_Type': 'TXT', '@_Name': '@', '@_Address': 'new-value', '@_TTL': 300, '@_HostId': '501' },
    ];
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.getDNSRecords = vi.fn().mockImplementation(() => {
      return callCount++ === 0 ? beforeRecords : afterRecords;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.setDNSRecords = vi.fn().mockResolvedValue(undefined);

    const result = await provider.updateDNSRecord('example.com', {
      id: 'TXT-@-500',
      type: 'TXT',
      name: '@',
      content: 'new-value',
      ttl: 300,
    });

    // Should return the record with the new HostId (501) from the re-fetch
    expect(result.id).toBe('TXT-@-501');
    expect(result.content).toBe('new-value');
  });
});

// ─── Porkbun getTransferStatus FEATURE_NOT_SUPPORTED ──────────────────────

describe('PorkbunProvider.getTransferStatus', () => {
  it('throws FEATURE_NOT_SUPPORTED (no Porkbun v3 status endpoint)', async () => {
    const { PorkbunProvider } = await import('../../src/providers/porkbun/provider.js');
    const provider = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });
    await expect(provider.getTransferStatus('example.com'))
      .rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' });
  });
});

// ─── Porkbun getCertificateStatus CERT_NOT_FOUND ───────────────────────────

describe('PorkbunProvider.getCertificateStatus CERT_NOT_FOUND', () => {
  it('throws CERT_NOT_FOUND instead of returning fake pending when cert not found', async () => {
    const { PorkbunProvider } = await import('../../src/providers/porkbun/provider.js');
    const provider = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });

    // Mock listCertificates to return empty list
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.listCertificates = vi.fn().mockResolvedValue([]);

    await expect(provider.getCertificateStatus('porkbun-ssl-example.com'))
      .rejects.toMatchObject({ code: 'CERT_NOT_FOUND' });
  });
});

// ─── Cloudflare listDNSRecords pagination ──────────────────────────────────

describe('CloudflareClient.listDNSRecords pagination', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('paginates when total_pages > 1', async () => {
    const calls: string[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(url);
      const page = new URL(url).searchParams.get('page');
      const isPage1 = page === '1';
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          result: isPage1
            ? [{ id: 'r1', type: 'A', name: 'www', content: '1.1.1.1', ttl: 300, modified_on: '' }]
            : [{ id: 'r2', type: 'A', name: 'api', content: '2.2.2.2', ttl: 300, modified_on: '' }],
          result_info: { total_pages: 2 },
        }),
      } as Response;
    });

    const { CloudflareClient } = await import('../../src/providers/cloudflare/client.js');
    const client = new CloudflareClient({ apiToken: 'tok' });
    const records = await client.listDNSRecords('zone123');

    expect(records).toHaveLength(2);
    expect(records[0].id).toBe('r1');
    expect(records[1].id).toBe('r2');
    expect(calls).toHaveLength(2);
  });
});

// ─── GoDaddy transfer fails fast without fake fallback email ───────────────

describe('GoDaddyProvider.initiateTransfer', () => {
  it('throws MISSING_CONTACT_EMAIL when domain has no registrant email', async () => {
    const { GoDaddyProvider } = await import('../../src/providers/godaddy/provider.js');
    const provider = new GoDaddyProvider({ apiKey: 'k', apiSecret: 's' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.getDomain = vi.fn().mockResolvedValue({
      domain: 'example.com', status: 'ACTIVE', expires: '', renewAuto: false, locked: false, nameServers: [],
      contactRegistrant: undefined,
    });

    await expect(provider.initiateTransfer('example.com', 'AUTH123'))
      .rejects.toMatchObject({ code: 'MISSING_CONTACT_EMAIL' });
  });

  it('uses registrant email from account for agreedBy', async () => {
    const { GoDaddyProvider } = await import('../../src/providers/godaddy/provider.js');
    const provider = new GoDaddyProvider({ apiKey: 'k', apiSecret: 's' });
    const transferSpy = vi.fn().mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.getDomain = vi.fn().mockResolvedValue({
      domain: 'example.com', status: 'ACTIVE', expires: '', renewAuto: false, locked: false, nameServers: [],
      contactRegistrant: { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', phone: '', addressMailing: { address1: '', city: '', state: '', postalCode: '', country: '' } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.initiateTransfer = transferSpy;

    await provider.initiateTransfer('example.com', 'AUTH123');
    expect(transferSpy).toHaveBeenCalledWith('example.com', 'AUTH123', 'jane@example.com');
  });
});

// ─── GoDaddy listCertificates throws FEATURE_NOT_SUPPORTED ────────────────

describe('GoDaddyProvider.listCertificates', () => {
  it('throws FEATURE_NOT_SUPPORTED (GoDaddy has no SSL API)', async () => {
    const { GoDaddyProvider } = await import('../../src/providers/godaddy/provider.js');
    const provider = new GoDaddyProvider({ apiKey: 'k', apiSecret: 's' });
    await expect(provider.listCertificates('example.com'))
      .rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' });
  });
});

// ─── Porkbun createCertificate surfaces certificate material ──────────────

describe('PorkbunProvider.createCertificate', () => {
  it('includes certificateChain and privateKey in the response when present', async () => {
    const { PorkbunProvider } = await import('../../src/providers/porkbun/provider.js');
    const provider = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.createCertificate = vi.fn().mockResolvedValue({
      id: 'porkbun-ssl-example.com',
      domain: 'example.com',
      status: 'active',
      certificate: '-----BEGIN CERTIFICATE-----\nMIIBaz...\n-----END CERTIFICATE-----',
      privatekey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEo...\n-----END RSA PRIVATE KEY-----',
    });

    const cert = await provider.createCertificate('example.com');
    expect(cert.status).toBe('active');
    expect(cert.certificateChain).toContain('BEGIN CERTIFICATE');
    expect(cert.privateKey).toContain('BEGIN RSA PRIVATE KEY');
  });

  it('does not include certificateChain or privateKey when absent', async () => {
    const { PorkbunProvider } = await import('../../src/providers/porkbun/provider.js');
    const provider = new PorkbunProvider({ apiKey: 'k', secretApiKey: 's' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.createCertificate = vi.fn().mockResolvedValue({
      id: 'porkbun-ssl-example.com',
      domain: 'example.com',
      status: 'pending',
    });

    const cert = await provider.createCertificate('example.com');
    expect(cert.status).toBe('pending');
    expect(cert.certificateChain).toBeUndefined();
    expect(cert.privateKey).toBeUndefined();
  });
});
