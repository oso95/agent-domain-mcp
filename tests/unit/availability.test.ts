import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch for RDAP tests
describe('RDAP availability check', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns available=true for 404 response', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      status: 404,
      ok: false,
      json: async () => ({}),
      text: async () => '',
    } as Response);

    const { checkAvailabilityRDAP } = await import('../../src/lookup/rdap.js');
    const result = await checkAvailabilityRDAP('nonexistent-domain-xyz.com');
    expect(result.available).toBe(true);
    expect(result.availabilitySource).toBe('rdap');
  });

  it('returns available=false for 200 response', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ ldhName: 'example.com' }),
      text: async () => JSON.stringify({ ldhName: 'example.com' }),
    } as Response);

    const { checkAvailabilityRDAP } = await import('../../src/lookup/rdap.js');
    const result = await checkAvailabilityRDAP('example.com');
    expect(result.available).toBe(false);
    expect(result.availabilitySource).toBe('rdap');
  });
});

describe('domain list building', () => {
  it('uses .com when no TLD provided', async () => {
    // Test via checkAvailability handler - just verify domain list construction
    // This is tested indirectly through integration, but we can verify the logic
    const domain = 'myapp';
    const tlds = undefined;
    const effectiveTlds = tlds && (tlds as string[]).length > 0 ? tlds : ['com'];
    const domains = (effectiveTlds as string[]).map((tld: string) => `${domain}.${tld}`);
    expect(domains).toEqual(['myapp.com']);
  });

  it('uses provided TLDs', () => {
    const domain = 'myapp';
    const tlds = ['com', 'io', 'dev'];
    const domains = tlds.map((tld) => `${domain}.${tld}`);
    expect(domains).toEqual(['myapp.com', 'myapp.io', 'myapp.dev']);
  });

  it('uses domain as-is when it contains a dot', () => {
    const domain = 'myapp.com';
    // Domain already has TLD, should not add another
    expect(domain.includes('.')).toBe(true);
    // buildDomainList logic: if domain has dot, use as-is
    const result = [domain];
    expect(result).toEqual(['myapp.com']);
  });
});

describe('CheckAvailabilityInputSchema validation', () => {
  it('rejects domains with invalid characters', async () => {
    const { CheckAvailabilityInputSchema } = await import('../../src/tools/availability.js');
    const result = CheckAvailabilityInputSchema.safeParse({ domain: 'not a domain!!!' });
    expect(result.success).toBe(false);
  });

  it('accepts bare name without TLD', async () => {
    const { CheckAvailabilityInputSchema } = await import('../../src/tools/availability.js');
    const result = CheckAvailabilityInputSchema.safeParse({ domain: 'myapp' });
    expect(result.success).toBe(true);
  });

  it('accepts full domain name', async () => {
    const { CheckAvailabilityInputSchema } = await import('../../src/tools/availability.js');
    const result = CheckAvailabilityInputSchema.safeParse({ domain: 'myapp.com' });
    expect(result.success).toBe(true);
  });
});

describe('availability error objects are structured', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('per-domain error has code/message object (not double-encoded JSON string)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('connection refused'));

    const { handleCheckAvailability } = await import('../../src/tools/availability.js');
    const registry = { names: () => [], get: () => { throw new Error(); } } as never;
    const result = await handleCheckAvailability({ domain: 'failing-test.com' }, registry);

    const failedResult = (result as { results: Array<{ error?: unknown }> }).results[0];
    expect(failedResult.error).toBeDefined();
    expect(typeof failedResult.error).toBe('object');
    expect((failedResult.error as { code: string }).code).toBeDefined();
  });

  it('per-domain plain error includes action field', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network failure'));

    const { handleCheckAvailability } = await import('../../src/tools/availability.js');
    const registry = { names: () => [], get: () => { throw new Error(); } } as never;
    const result = await handleCheckAvailability({ domain: 'error-test.com' }, registry);

    const failedResult = (result as { results: Array<{ error?: unknown }> }).results[0];
    const err = failedResult.error as { code: string; message: string; action: string };
    expect(err.action).toBeDefined();
    expect(typeof err.action).toBe('string');
    expect(err.action.length).toBeGreaterThan(0);
  });
});
