import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Test Namecheap listDomains pagination logic by testing the call() layer
// with mocked responses that simulate multi-page results

describe('Namecheap listDomains pagination', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('fetches only one page when total items <= page size', async () => {
    // Simulate a Namecheap response with 2 domains on page 1, total = 2
    const xmlResponse = `<?xml version="1.0"?>
      <ApiResponse Status="OK">
        <CommandResponse Type="namecheap.domains.getList">
          <DomainGetListResult>
            <Domain Name="domain1.com" User="user" Created="2024-01-01" Expires="2025-01-01" IsExpired="false" IsLocked="false" AutoRenew="false" />
            <Domain Name="domain2.com" User="user" Created="2024-01-01" Expires="2025-01-01" IsExpired="false" IsLocked="false" AutoRenew="false" />
          </DomainGetListResult>
          <Paging>
            <TotalItems>2</TotalItems>
            <CurrentPage>1</CurrentPage>
            <PageSize>100</PageSize>
          </Paging>
        </CommandResponse>
      </ApiResponse>`;

    vi.mocked(global.fetch).mockResolvedValue({
      status: 200, ok: true, text: async () => xmlResponse,
    } as Response);

    const { NamecheapClient } = await import('../../src/providers/namecheap/client.js');
    const client = new NamecheapClient({ apiKey: 'key', apiUser: 'user', clientIp: '1.2.3.4' });
    const domains = await client.listDomains();

    expect(domains).toHaveLength(2);
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1); // only 1 API call
  });

  it('fetches multiple pages when page returns exactly PAGE_SIZE items', async () => {
    // Build a full page of 100 domain entries to trigger the multi-page path.
    // The loop continues only when items.length >= PAGE_SIZE AND all.length < totalItems.
    const makeXmlPage = (count: number, prefix: string, total: number, page: number) => {
      const domains = Array.from({ length: count }, (_, i) =>
        `<Domain Name="${prefix}${i + 1}.com" User="user" Created="2024-01-01" Expires="2025-01-01" IsExpired="false" IsLocked="false" AutoRenew="false" />`,
      ).join('\n');
      return `<?xml version="1.0"?>
      <ApiResponse Status="OK">
        <CommandResponse Type="namecheap.domains.getList">
          <DomainGetListResult>${domains}</DomainGetListResult>
          <Paging>
            <TotalItems>${total}</TotalItems>
            <CurrentPage>${page}</CurrentPage>
            <PageSize>100</PageSize>
          </Paging>
        </CommandResponse>
      </ApiResponse>`;
    };

    // Page 1: 100 domains (full page), total 102 → triggers page 2
    // Page 2: 2 domains (less than 100) → stops
    vi.mocked(global.fetch)
      .mockResolvedValueOnce({ status: 200, ok: true, text: async () => makeXmlPage(100, 'p1-', 102, 1) } as Response)
      .mockResolvedValueOnce({ status: 200, ok: true, text: async () => makeXmlPage(2, 'p2-', 102, 2) } as Response);

    const { NamecheapClient } = await import('../../src/providers/namecheap/client.js');
    const client = new NamecheapClient({ apiKey: 'key', apiUser: 'user', clientIp: '1.2.3.4' });
    const domains = await client.listDomains();

    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(2);
    expect(domains).toHaveLength(102);
    expect(domains[0]['@_Name']).toBe('p1-1.com');
    expect(domains[100]['@_Name']).toBe('p2-1.com');
  });
});
