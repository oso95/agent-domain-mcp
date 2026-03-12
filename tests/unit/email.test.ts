import { describe, it, expect, vi } from 'vitest';
import { handleSetupSpf, handleSetupDkim, handleSetupDmarc, handleSetupMx } from '../../src/tools/email.js';
import { AgentError } from '../../src/errors.js';
import type { ProviderRegistry } from '../../src/registry.js';
import type { DNSRecord } from '../../src/providers/types.js';

function makeRegistry(overrides: {
  createDNSRecord?: (domain: string, record: DNSRecord) => Promise<DNSRecord>;
  updateDNSRecord?: (domain: string, record: DNSRecord) => Promise<DNSRecord>;
  listDNSRecords?: (domain: string) => Promise<DNSRecord[]>;
} = {}): ProviderRegistry {
  const createDNSRecord = overrides.createDNSRecord ?? (async (_, r) => r);
  const updateDNSRecord = overrides.updateDNSRecord ?? (async (_, r) => r);
  const listDNSRecords = overrides.listDNSRecords ?? (async () => []);
  return {
    get: () => ({ name: () => 'mock', supports: () => true, createDNSRecord, updateDNSRecord, listDNSRecords } as never),
    resolveProviderForDomain: async () => ({ name: () => 'mock', supports: () => true, createDNSRecord, updateDNSRecord, listDNSRecords } as never),
  } as ProviderRegistry;
}

describe('handleSetupSpf', () => {
  it('creates TXT record with Google SPF template when no existing SPF', async () => {
    const created: DNSRecord[] = [];
    const registry = makeRegistry({ createDNSRecord: async (_, r) => { created.push(r); return r; } });
    await handleSetupSpf({ domain: 'example.com', provider: 'cloudflare', mailProvider: 'google' }, registry);
    expect(created).toHaveLength(1);
    expect(created[0].type).toBe('TXT');
    expect(created[0].name).toBe('@');
    expect(created[0].content).toContain('_spf.google.com');
  });

  it('creates TXT record with custom SPF policy', async () => {
    const created: DNSRecord[] = [];
    const registry = makeRegistry({ createDNSRecord: async (_, r) => { created.push(r); return r; } });
    const custom = 'v=spf1 ip4:1.2.3.4 ~all';
    await handleSetupSpf({ domain: 'example.com', provider: 'cloudflare', mailProvider: 'custom', customPolicy: custom }, registry);
    expect(created[0].content).toBe(custom);
  });

  it('updates existing SPF record instead of creating a duplicate', async () => {
    const existing: DNSRecord[] = [
      { id: 'TXT-@-1', type: 'TXT', name: '@', content: 'v=spf1 include:old.example.com ~all', ttl: 300 },
    ];
    const updated: DNSRecord[] = [];
    const created: DNSRecord[] = [];
    const registry = makeRegistry({
      listDNSRecords: async () => existing,
      updateDNSRecord: async (_, r) => { updated.push(r); return r; },
      createDNSRecord: async (_, r) => { created.push(r); return r; },
    });
    const result = await handleSetupSpf({ domain: 'example.com', provider: 'cloudflare', mailProvider: 'google' }, registry);
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0].content).toContain('_spf.google.com');
    expect(result.success).toBe(true);
  });

  it('returns existing record unchanged when SPF content is identical', async () => {
    const spfValue = 'v=spf1 include:_spf.google.com ~all';
    const existing: DNSRecord[] = [
      { id: 'TXT-@-1', type: 'TXT', name: '@', content: spfValue, ttl: 300 },
    ];
    const updated: DNSRecord[] = [];
    const created: DNSRecord[] = [];
    const registry = makeRegistry({
      listDNSRecords: async () => existing,
      updateDNSRecord: async (_, r) => { updated.push(r); return r; },
      createDNSRecord: async (_, r) => { created.push(r); return r; },
    });
    const result = await handleSetupSpf({ domain: 'example.com', provider: 'cloudflare', mailProvider: 'google' }, registry);
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
    expect(result.spfValue).toBe(spfValue);
  });

  it('throws MISSING_PARAMETER when custom mailProvider has no customPolicy', async () => {
    const registry = makeRegistry();
    await expect(handleSetupSpf({ domain: 'example.com', provider: 'cloudflare', mailProvider: 'custom' }, registry))
      .rejects.toMatchObject({ code: 'MISSING_PARAMETER' });
  });

  it('throws INVALID_PARAMETER for unknown mailProvider', async () => {
    const registry = makeRegistry();
    await expect(handleSetupSpf({ domain: 'example.com', provider: 'cloudflare', mailProvider: 'unknown_provider' }, registry))
      .rejects.toMatchObject({ code: 'INVALID_PARAMETER' });
  });

  it('throws INVALID_PARAMETER when customPolicy does not start with v=spf1', async () => {
    const registry = makeRegistry();
    await expect(handleSetupSpf({ domain: 'example.com', provider: 'cloudflare', mailProvider: 'custom', customPolicy: 'include:spf.example.com ~all' }, registry))
      .rejects.toMatchObject({ code: 'INVALID_PARAMETER' });
  });

  it('accepts uppercase V=SPF1 custom policy', async () => {
    const created: DNSRecord[] = [];
    const registry = makeRegistry({ createDNSRecord: async (_, r) => { created.push(r); return r; } });
    await handleSetupSpf({ domain: 'example.com', provider: 'cloudflare', mailProvider: 'custom', customPolicy: 'V=SPF1 include:example.com ~all' }, registry);
    expect(created).toHaveLength(1);
    expect(created[0].content).toBe('V=SPF1 include:example.com ~all');
  });

  it('returns previous field when updating existing SPF record', async () => {
    const existing: DNSRecord[] = [
      { id: 'TXT-@-1', type: 'TXT', name: '@', content: 'v=spf1 include:old.example.com ~all', ttl: 300 },
    ];
    const registry = makeRegistry({
      listDNSRecords: async () => existing,
      updateDNSRecord: async (_, r) => r,
    });
    const result = await handleSetupSpf({ domain: 'example.com', provider: 'cloudflare', mailProvider: 'google' }, registry) as { previous?: string };
    expect(result.previous).toBe('v=spf1 include:old.example.com ~all');
  });
});

describe('handleSetupDkim', () => {
  it('creates DKIM TXT record with correct name and content', async () => {
    const created: DNSRecord[] = [];
    const registry = makeRegistry({ createDNSRecord: async (_, r) => { created.push(r); return r; } });
    await handleSetupDkim({ domain: 'example.com', provider: 'cloudflare', selector: 'mail', publicKey: 'MIIBI...' }, registry);
    expect(created[0].name).toBe('mail._domainkey');
    expect(created[0].content).toMatch(/^v=DKIM1; k=rsa; p=MIIBI\.\.\./);
    expect(created[0].type).toBe('TXT');
  });

  it('strips PEM headers and whitespace from publicKey', async () => {
    const created: DNSRecord[] = [];
    const registry = makeRegistry({ createDNSRecord: async (_, r) => { created.push(r); return r; } });
    const pemKey = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----';
    await handleSetupDkim({ domain: 'example.com', provider: 'cloudflare', selector: 'mail', publicKey: pemKey }, registry);
    expect(created[0].content).not.toContain('-----BEGIN');
    expect(created[0].content).not.toContain('\n');
    expect(created[0].content).toContain('p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA');
  });

  it('updates existing DKIM record instead of creating a duplicate', async () => {
    const existing: DNSRecord[] = [
      { id: 'TXT-mail._domainkey-1', type: 'TXT', name: 'mail._domainkey', content: 'v=DKIM1; k=rsa; p=OLDKEY', ttl: 300 },
    ];
    const updated: DNSRecord[] = [];
    const created: DNSRecord[] = [];
    const registry = makeRegistry({
      listDNSRecords: async () => existing,
      updateDNSRecord: async (_, r) => { updated.push(r); return r; },
      createDNSRecord: async (_, r) => { created.push(r); return r; },
    });
    await handleSetupDkim({ domain: 'example.com', provider: 'cloudflare', selector: 'mail', publicKey: 'NEWKEY' }, registry);
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0].content).toContain('p=NEWKEY');
  });

  it('uses k=ed25519 when keyType is ed25519', async () => {
    const created: DNSRecord[] = [];
    const registry = makeRegistry({ createDNSRecord: async (_, r) => { created.push(r); return r; } });
    await handleSetupDkim({ domain: 'example.com', provider: 'cloudflare', selector: 'mail', publicKey: 'EDKEY', keyType: 'ed25519' }, registry);
    expect(created[0].content).toBe('v=DKIM1; k=ed25519; p=EDKEY');
  });

  it('defaults to k=rsa when keyType is omitted', async () => {
    const created: DNSRecord[] = [];
    const registry = makeRegistry({ createDNSRecord: async (_, r) => { created.push(r); return r; } });
    await handleSetupDkim({ domain: 'example.com', provider: 'cloudflare', selector: 'mail', publicKey: 'MYKEY' }, registry);
    expect(created[0].content).toContain('k=rsa');
  });

  it('returns previous field when updating existing DKIM record', async () => {
    const existing: DNSRecord[] = [
      { id: 'TXT-mail._domainkey-1', type: 'TXT', name: 'mail._domainkey', content: 'v=DKIM1; k=rsa; p=OLDKEY', ttl: 300 },
    ];
    const registry = makeRegistry({
      listDNSRecords: async () => existing,
      updateDNSRecord: async (_, r) => r,
    });
    const result = await handleSetupDkim({ domain: 'example.com', provider: 'cloudflare', selector: 'mail', publicKey: 'NEWKEY' }, registry) as { previous?: string };
    expect(result.previous).toBe('v=DKIM1; k=rsa; p=OLDKEY');
  });
});

describe('handleSetupDmarc', () => {
  it('creates DMARC record with policy and pct when none exists', async () => {
    const created: DNSRecord[] = [];
    const registry = makeRegistry({ createDNSRecord: async (_, r) => { created.push(r); return r; } });
    const result = await handleSetupDmarc({ domain: 'example.com', provider: 'cloudflare', policy: 'reject', pct: 100 }, registry);
    expect(created[0].name).toBe('_dmarc');
    expect(created[0].content).toContain('v=DMARC1');
    expect(created[0].content).toContain('p=reject');
    expect(created[0].content).toContain('pct=100');
    expect(result.dmarcValue).toBe(created[0].content);
  });

  it('appends rua when reportEmail is provided', async () => {
    const created: DNSRecord[] = [];
    const registry = makeRegistry({ createDNSRecord: async (_, r) => { created.push(r); return r; } });
    await handleSetupDmarc({ domain: 'example.com', provider: 'cloudflare', policy: 'none', pct: 100, reportEmail: 'dmarc@example.com' }, registry);
    expect(created[0].content).toContain('rua=mailto:dmarc@example.com');
  });

  it('updates existing DMARC record instead of creating a duplicate', async () => {
    const existing: DNSRecord[] = [
      { id: 'TXT-_dmarc-1', type: 'TXT', name: '_dmarc', content: 'v=DMARC1; p=none; pct=0', ttl: 300 },
    ];
    const updated: DNSRecord[] = [];
    const created: DNSRecord[] = [];
    const registry = makeRegistry({
      listDNSRecords: async () => existing,
      updateDNSRecord: async (_, r) => { updated.push(r); return r; },
      createDNSRecord: async (_, r) => { created.push(r); return r; },
    });
    await handleSetupDmarc({ domain: 'example.com', provider: 'cloudflare', policy: 'reject', pct: 100 }, registry);
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0].content).toContain('p=reject');
  });

  it('returns previous field when updating existing DMARC record', async () => {
    const existing: DNSRecord[] = [
      { id: 'TXT-_dmarc-1', type: 'TXT', name: '_dmarc', content: 'v=DMARC1; p=none; pct=0', ttl: 300 },
    ];
    const registry = makeRegistry({
      listDNSRecords: async () => existing,
      updateDNSRecord: async (_, r) => r,
    });
    const result = await handleSetupDmarc({ domain: 'example.com', provider: 'cloudflare', policy: 'reject', pct: 100 }, registry) as { previous?: string };
    expect(result.previous).toBe('v=DMARC1; p=none; pct=0');
  });
});

describe('handleSetupMx', () => {
  it('creates all Google MX records sequentially', async () => {
    const created: DNSRecord[] = [];
    const registry = makeRegistry({ createDNSRecord: async (_, r) => { created.push({ ...r }); return r; } });
    await handleSetupMx({ domain: 'example.com', provider: 'cloudflare', mailProvider: 'google' }, registry);
    expect(created).toHaveLength(5);
    expect(created[0].content).toBe('ASPMX.L.GOOGLE.COM');
    expect(created[0].priority).toBe(1);
    expect(created.every((r) => r.type === 'MX' && r.name === '@')).toBe(true);
  });

  it('skips MX exchanges that already exist (idempotent)', async () => {
    const existing: DNSRecord[] = [
      { id: 'MX-@-1', type: 'MX', name: '@', content: 'ASPMX.L.GOOGLE.COM', ttl: 300, priority: 1 },
    ];
    const created: DNSRecord[] = [];
    const registry = makeRegistry({
      listDNSRecords: async () => existing,
      createDNSRecord: async (_, r) => { created.push({ ...r }); return r; },
    });
    await handleSetupMx({ domain: 'example.com', provider: 'cloudflare', mailProvider: 'google' }, registry);
    // Should create only the 4 missing exchanges, not the already-present one
    expect(created).toHaveLength(4);
    expect(created.every((r) => r.content !== 'ASPMX.L.GOOGLE.COM')).toBe(true);
  });

  it('throws MISSING_PARAMETER when custom has no customRecords', async () => {
    const registry = makeRegistry();
    await expect(handleSetupMx({ domain: 'example.com', provider: 'cloudflare', mailProvider: 'custom' }, registry))
      .rejects.toMatchObject({ code: 'MISSING_PARAMETER' });
  });

  it('throws MISSING_PARAMETER when custom has empty customRecords array', async () => {
    const registry = makeRegistry();
    await expect(handleSetupMx({ domain: 'example.com', provider: 'cloudflare', mailProvider: 'custom', customRecords: [] }, registry))
      .rejects.toMatchObject({ code: 'MISSING_PARAMETER' });
  });

  it('uses customRecords when mailProvider is custom', async () => {
    const created: DNSRecord[] = [];
    const registry = makeRegistry({ createDNSRecord: async (_, r) => { created.push(r); return r; } });
    const customRecords = [{ exchange: 'mail.myhost.com', priority: 5 }];
    await handleSetupMx({ domain: 'example.com', provider: 'cloudflare', mailProvider: 'custom', customRecords }, registry);
    expect(created).toHaveLength(1);
    expect(created[0].content).toBe('mail.myhost.com');
    expect(created[0].priority).toBe(5);
  });
});
