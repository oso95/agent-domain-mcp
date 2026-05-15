import { describe, it, expect, afterEach, vi } from 'vitest';
import { CloudflareProvider } from '../../src/providers/cloudflare/provider.js';
import { Feature } from '../../src/providers/types.js';

type FetchResp = { status?: number; body: unknown };

function setupFetch(handler: (url: string, init: RequestInit) => FetchResp) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const mock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(body, { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  global.fetch = mock as unknown as typeof fetch;
  return { calls };
}

const ZONE_ID = 'zone-123';
const zoneListBody = {
  success: true,
  result: [{ id: ZONE_ID, name: 'foo.com', status: 'active', name_servers: ['ns1.cf.com'], modified_on: '' }],
  result_info: { total_pages: 1 },
};

describe('CloudflareProvider supports(Feature.Dnssec)', () => {
  it('returns true', () => {
    const p = new CloudflareProvider({ apiToken: 'tok' });
    expect(p.supports(Feature.Dnssec)).toBe(true);
  });
});

describe('CloudflareProvider DNSSEC', () => {
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; vi.restoreAllMocks(); });

  it('getDnssec returns scope=zone with full DS material when active', async () => {
    const { calls } = setupFetch((url) => {
      if (url.includes('/zones?')) return { body: zoneListBody };
      if (url.endsWith(`/zones/${ZONE_ID}/dnssec`)) {
        return {
          body: {
            success: true,
            result: {
              status: 'active',
              algorithm: '13',
              digest_type: '2',
              digest: 'ABCDEF',
              key_tag: 42,
              flags: 257,
              public_key: 'PK==',
            },
          },
        };
      }
      return { body: { success: false, errors: [{ code: 0, message: 'unexpected url ' + url }] } };
    });
    const p = new CloudflareProvider({ apiToken: 'tok' });
    const status = await p.getDnssec('foo.com');
    expect(status.scope).toBe('zone');
    expect(status.enabled).toBe(true);
    expect(status.dsRecords).toEqual([{ keyTag: 42, algorithm: 13, digestType: 2, digest: 'ABCDEF' }]);
    expect(status.dnsKey).toEqual({ flags: 257, protocol: 3, algorithm: 13, publicKey: 'PK==' });
    const dnssecCall = calls.find((c) => c.url.endsWith(`/zones/${ZONE_ID}/dnssec`));
    expect(dnssecCall?.init.method).toBe('GET');
  });

  it('getDnssec returns scope=none when status=disabled', async () => {
    setupFetch((url) => {
      if (url.includes('/zones?')) return { body: zoneListBody };
      return { body: { success: true, result: { status: 'disabled' } } };
    });
    const p = new CloudflareProvider({ apiToken: 'tok' });
    const status = await p.getDnssec('foo.com');
    expect(status.scope).toBe('none');
    expect(status.enabled).toBe(false);
    expect(status.dsRecords).toBeUndefined();
  });

  it('enableDnssec PATCHes status=active and returns the DS material', async () => {
    const { calls } = setupFetch((url, init) => {
      if (url.includes('/zones?')) return { body: zoneListBody };
      if (url.endsWith(`/zones/${ZONE_ID}/dnssec`) && init.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { status: string };
        expect(body.status).toBe('active');
        return {
          body: {
            success: true,
            result: { status: 'active', algorithm: '13', digest_type: '2', digest: 'ABCDEF', key_tag: 42 },
          },
        };
      }
      return { body: { success: false, errors: [{ code: 0, message: 'unexpected url ' + url }] } };
    });
    const p = new CloudflareProvider({ apiToken: 'tok' });
    const status = await p.enableDnssec('foo.com');
    expect(status.scope).toBe('zone');
    expect(status.dsRecords?.length).toBe(1);
    expect(calls.find((c) => c.init.method === 'PATCH')).toBeDefined();
  });

  it('enableDnssec rejects user-supplied dsRecords (Cloudflare-only flow)', async () => {
    setupFetch((url) => {
      if (url.includes('/zones?')) return { body: zoneListBody };
      return { body: { success: true, result: { status: 'disabled' } } };
    });
    const p = new CloudflareProvider({ apiToken: 'tok' });
    await expect(
      p.enableDnssec('foo.com', { dsRecords: [{ keyTag: 1, algorithm: 13, digestType: 2, digest: 'AA' }] }),
    ).rejects.toMatchObject({ code: 'FEATURE_NOT_SUPPORTED' });
  });

  it('disableDnssec PATCHes status=disabled', async () => {
    const { calls } = setupFetch((url, init) => {
      if (url.includes('/zones?')) return { body: zoneListBody };
      if (url.endsWith(`/zones/${ZONE_ID}/dnssec`) && init.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { status: string };
        expect(body.status).toBe('disabled');
        return { body: { success: true, result: { status: 'disabled' } } };
      }
      return { body: { success: false, errors: [{ code: 0, message: 'unexpected url ' + url }] } };
    });
    const p = new CloudflareProvider({ apiToken: 'tok' });
    await p.disableDnssec('foo.com');
    expect(calls.find((c) => c.init.method === 'PATCH')).toBeDefined();
  });
});
