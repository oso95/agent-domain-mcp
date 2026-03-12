import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('RDAP availability', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws RDAP_TIMEOUT AgentError on timeout', async () => {
    const timeoutErr = new Error('signal timed out');
    timeoutErr.name = 'TimeoutError';
    vi.mocked(global.fetch).mockRejectedValue(timeoutErr);

    const { checkAvailabilityRDAP } = await import('../../src/lookup/rdap.js');
    await expect(checkAvailabilityRDAP('example.com')).rejects.toMatchObject({
      code: 'RDAP_TIMEOUT',
    });
  });

  it('propagates non-timeout errors', async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error('network failure'));

    const { checkAvailabilityRDAP } = await import('../../src/lookup/rdap.js');
    await expect(checkAvailabilityRDAP('example.com')).rejects.toThrow('network failure');
  });

  it('throws on unexpected non-404/200 status', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      status: 503, ok: false, json: async () => ({}), text: async () => '',
    } as Response);

    const { checkAvailabilityRDAP } = await import('../../src/lookup/rdap.js');
    await expect(checkAvailabilityRDAP('example.com')).rejects.toThrow(/503/);
  });
});

describe('WHOIS availability', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns available=true when status includes "available"', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      status: 200, ok: true,
      json: async () => ({ status: 'Domain available for registration', domain: 'newdomain.io' }),
    } as Response);

    const { checkAvailabilityWhois } = await import('../../src/lookup/whois.js');
    const result = await checkAvailabilityWhois('newdomain.io');
    expect(result.available).toBe(true);
    expect(result.availabilitySource).toBe('whois');
  });

  it('returns available=false when status indicates taken', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      status: 200, ok: true,
      json: async () => ({ status: 'registered', domain: 'taken.com' }),
    } as Response);

    const { checkAvailabilityWhois } = await import('../../src/lookup/whois.js');
    const result = await checkAvailabilityWhois('taken.com');
    expect(result.available).toBe(false);
  });

  it('returns available=true when no status field present (not registered)', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      status: 200, ok: true,
      json: async () => ({ domain: 'unknown.xyz' }),
    } as Response);

    const { checkAvailabilityWhois } = await import('../../src/lookup/whois.js');
    const result = await checkAvailabilityWhois('unknown.xyz');
    expect(result.available).toBe(true);
  });

  it('throws on non-ok response', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      status: 429, ok: false,
      json: async () => ({}),
    } as Response);

    const { checkAvailabilityWhois } = await import('../../src/lookup/whois.js');
    await expect(checkAvailabilityWhois('example.com')).rejects.toThrow(/429/);
  });
});

describe('handleCheckAvailability pricing enrichment', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
    // Mock RDAP to return 404 (domain available) for all calls
    vi.mocked(global.fetch).mockResolvedValue({
      status: 404, ok: false, json: async () => ({}), text: async () => '',
    } as Response);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('uses getPricingTable when provider implements it', async () => {
    const pricingTableSpy = vi.fn().mockResolvedValue({
      com: { registration: 12.00, renewal: 12.00, currency: 'USD' },
      io: { registration: 35.00, renewal: 35.00, currency: 'USD' },
    });
    const mockProvider = {
      name: () => 'mock',
      supports: () => true,
      checkAvailability: vi.fn(),
      getPricingTable: pricingTableSpy,
    };
    const registry = {
      names: () => ['mock'],
      get: () => mockProvider,
    };

    const { handleCheckAvailability } = await import('../../src/tools/availability.js');
    const result = await handleCheckAvailability(
      { domain: 'newapp', tlds: ['com', 'io'], provider: 'mock' },
      registry as never,
    );

    expect(pricingTableSpy).toHaveBeenCalledTimes(1); // one batch call, not per-domain
    expect(result.results).toHaveLength(2);
    const comResult = result.results.find((r) => r.domain === 'newapp.com');
    expect(comResult?.price?.registration).toBe(12.00);
    // priceSource is now hoisted to top-level (not repeated per domain)
    expect((result as Record<string, unknown>).priceSource).toBe('mock');
  });

  it('falls back to per-domain checkAvailability when getPricingTable absent', async () => {
    const checkSpy = vi.fn().mockResolvedValue({
      domain: 'newapp.com',
      available: true,
      premium: false,
      availabilitySource: 'mock',
      price: { registration: 10.00, renewal: 10.00, currency: 'USD' },
      priceSource: 'mock',
    });
    const mockProvider = {
      name: () => 'mock',
      supports: () => true,
      checkAvailability: checkSpy,
      // No getPricingTable
    };
    const registry = {
      names: () => ['mock'],
      get: () => mockProvider,
    };

    const { handleCheckAvailability } = await import('../../src/tools/availability.js');
    const result = await handleCheckAvailability(
      { domain: 'newapp.com', provider: 'mock' },
      registry as never,
    );

    expect(checkSpy).toHaveBeenCalledTimes(1); // per-domain
    expect(result.results[0].price?.registration).toBe(10.00);
  });
});
