import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebnicClient } from '../../src/providers/webnic/client.js';

type FetchResp = {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
};

function setupFetch(responses: FetchResp[] | ((url: string, init: RequestInit) => FetchResp)) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const mock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = typeof responses === 'function' ? responses(url, init) : responses[i++];
    const status = r.status ?? 200;
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json', ...(r.headers ?? {}) },
    });
  });
  global.fetch = mock as unknown as typeof fetch;
  return { calls, mock };
}

describe('WebnicClient auth flow', () => {
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; vi.restoreAllMocks(); });

  it('fetches token once and reuses it for subsequent requests', async () => {
    const { calls } = setupFetch([
      { body: { code: '1000', message: 'ok', data: { access_token: 'jwt-1', expires_in: 3600 } } },
      { body: { code: '1000', message: 'ok', data: { available: true, premium: false } } },
      { body: { code: '1000', message: 'ok', data: { available: true, premium: false } } },
    ]);
    const c = new WebnicClient({ username: 'u', password: 'p', sandbox: true });

    await c.queryDomain('example.com');
    await c.queryDomain('foo.com');

    expect(calls).toHaveLength(3);
    expect(calls[0].url).toContain('/reseller/v2/api-user/token');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[1].url).toContain('oteapi.webnic.cc/domain/v2/query');
    expect(calls[1].url).toContain('domainName=example.com');
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-1');
    expect(calls[2].url).toContain('foo.com');
  });

  it('refreshes the token after a 401', async () => {
    const responses: FetchResp[] = [
      { body: { code: '1000', message: 'ok', data: { access_token: 'jwt-1', expires_in: 3600 } } },
      { status: 401, body: { code: '2401', message: 'Token invalid' } },
      { body: { code: '1000', message: 'ok', data: { access_token: 'jwt-2', expires_in: 3600 } } },
      { body: { code: '1000', message: 'ok', data: { available: true, premium: false } } },
    ];
    const { calls } = setupFetch(responses);
    const c = new WebnicClient({ username: 'u', password: 'p', sandbox: true });

    await c.queryDomain('example.com');
    expect(calls).toHaveLength(4);
    expect((calls[3].init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-2');
  });

  it('throws AUTH_FAILED when token endpoint rejects credentials', async () => {
    setupFetch([
      { status: 401, body: { code: '2401', message: 'Invalid credentials' } },
    ]);
    const c = new WebnicClient({ username: 'u', password: 'p', sandbox: true });
    await expect(c.queryDomain('example.com')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  // LOW-1: prevent token-endpoint spam after a failed auth.
  it('does not retry the token endpoint while the auth-failure cooldown is active', async () => {
    const { calls } = setupFetch([
      // First /token call returns AUTH_FAILED.
      { status: 401, body: { code: '2401', message: 'Invalid credentials' } },
    ]);
    const c = new WebnicClient({ username: 'u', password: 'p', sandbox: true });

    await expect(c.queryDomain('example.com')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(calls).toHaveLength(1);

    // A second call within the cooldown window must NOT hit the network.
    await expect(c.queryDomain('foo.com')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(calls).toHaveLength(1);

    // A third call within the cooldown window must also short-circuit.
    await expect(c.queryDomain('bar.com')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(calls).toHaveLength(1);
  });

  it('clears the auth-failure cooldown on invalidateToken()', async () => {
    const { calls } = setupFetch([
      // 1st token attempt: fail.
      { status: 401, body: { code: '2401', message: 'Invalid credentials' } },
      // 2nd token attempt after invalidateToken: success.
      { body: { code: '1000', message: 'ok', data: { access_token: 'jwt-1', expires_in: 3600 } } },
      // queryDomain response.
      { body: { code: '1000', message: 'ok', data: { available: true, premium: false } } },
    ]);
    const c = new WebnicClient({ username: 'u', password: 'p', sandbox: true });

    await expect(c.queryDomain('example.com')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(calls).toHaveLength(1);

    // Cooldown active — without invalidateToken this would short-circuit.
    c.invalidateToken();

    const result = await c.queryDomain('example.com');
    expect(result.available).toBe(true);
    expect(calls).toHaveLength(3);
  });
});

describe('WebnicClient envelope handling', () => {
  const origFetch = global.fetch;
  beforeEach(() => {
    setupFetch([
      { body: { code: '1000', message: 'ok', data: { access_token: 'jwt-1', expires_in: 3600 } } },
    ]);
  });
  afterEach(() => { global.fetch = origFetch; vi.restoreAllMocks(); });

  it('throws when HTTP 200 carries a non-success code', async () => {
    setupFetch((url) => {
      if (url.includes('/api-user/token')) {
        return { body: { code: '1000', message: 'ok', data: { access_token: 'jwt-1', expires_in: 3600 } } };
      }
      return { body: { code: '2400', message: 'Field validation error.', error: { subCode: 'DOM4000', message: 'Field validation error.' }, validationErrors: [{ field: 'domainName', message: 'required' }] } };
    });
    const c = new WebnicClient({ username: 'u', password: 'p', sandbox: true });
    await expect(c.queryDomain('')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('decodes DNS record DELETE path with composite query', async () => {
    const { calls } = setupFetch((url) => {
      if (url.includes('/api-user/token')) {
        return { body: { code: '1000', message: 'ok', data: { access_token: 'jwt-1', expires_in: 3600 } } };
      }
      return { body: { code: '1000', message: 'ok' } };
    });
    const c = new WebnicClient({ username: 'u', password: 'p', sandbox: true });
    await c.deleteRecord('example.com', 'A', 'www');
    const del = calls[calls.length - 1];
    expect(del.init.method).toBe('DELETE');
    expect(del.url).toMatch(/\/dns\/v2\/zone\/example\.com\/record\?type=A&name=www$/);
  });

  it('points to production URL when sandbox is false', async () => {
    const { calls } = setupFetch([
      { body: { code: '1000', message: 'ok', data: { access_token: 'jwt-1', expires_in: 3600 } } },
      { body: { code: '1000', message: 'ok', data: { available: true, premium: false } } },
    ]);
    const c = new WebnicClient({ username: 'u', password: 'p' });
    await c.queryDomain('example.com');
    expect(calls[0].url.startsWith('https://api.webnic.cc/')).toBe(true);
    expect(calls[1].url.startsWith('https://api.webnic.cc/')).toBe(true);
  });
});
