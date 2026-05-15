import { describe, it, expect } from 'vitest';
import { WebnicProvider } from '../../src/providers/webnic/provider.js';
import type { WebnicSSLOrderInfo, WebnicSSLOrderSummary, WebnicSSLProduct } from '../../src/providers/webnic/client.js';

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

function summary(partial: Partial<WebnicSSLOrderSummary> & { commonName: string; orderId: string }): WebnicSSLOrderSummary {
  return {
    orderStatus: 'COMPLETED',
    certStatus: 'ACTIVE',
    ...partial,
  };
}

describe('WebnicProvider.listCertificates', () => {
  it('returns only certs whose common name matches the domain (exact or wildcard)', async () => {
    const captured: { commonName?: string } = {};
    const p = mockProvider({
      searchSSLOrders: async (opts: { commonName?: string }) => {
        captured.commonName = opts.commonName;
        return [
          summary({ orderId: '1', commonName: 'example.com', dtcertexpire: '2027-08-15T12:34:56' }),
          summary({ orderId: '2', commonName: '*.example.com', dtcertexpire: '2027-08-15T12:34:56' }),
          // LIKE may return other subdomains the agent didn't ask about — filtered out.
          summary({ orderId: '3', commonName: 'unrelated-example.com' }),
        ];
      },
    });

    const certs = await p.listCertificates('example.com');
    expect(captured.commonName).toBe('example.com');
    expect(certs).toHaveLength(2);
    expect(certs[0]).toMatchObject({
      id: 'webnic-ssl-1',
      domain: 'example.com',
      status: 'active',
      expiresAt: '2027-08-15T12:34:56.000Z',
    });
    expect(certs[1].id).toBe('webnic-ssl-2');
    expect(certs[1].domain).toBe('*.example.com');
  });

  it('returns [] when no order matches', async () => {
    const p = mockProvider({
      searchSSLOrders: async () => [],
    });
    expect(await p.listCertificates('nothing.com')).toEqual([]);
  });

  it('does not leak certificateChain or privateKey from the summary endpoint', async () => {
    const p = mockProvider({
      searchSSLOrders: async () => [summary({ orderId: '1', commonName: 'example.com' })],
    });
    const [cert] = await p.listCertificates('example.com');
    expect(cert.certificateChain).toBeUndefined();
    expect(cert.privateKey).toBeUndefined();
  });
});

describe('WebnicProvider.getCertificateStatus', () => {
  it('resolves a webnic-ssl-<orderId> ID to a Certificate', async () => {
    const info: WebnicSSLOrderInfo = {
      orderId: '42',
      commonName: 'example.com',
      orderStatus: 'COMPLETED',
      certStatus: 'ACTIVE',
      dtsettle: '2026-05-01T00:00:00',
      dtcertexpire: '2027-05-01T00:00:00',
    };
    let captured: string | null = null;
    const p = mockProvider({
      getSSLOrderInfo: async (orderId: string) => {
        captured = orderId;
        return info;
      },
    });

    const cert = await p.getCertificateStatus('webnic-ssl-42');
    expect(captured).toBe('42');
    expect(cert).toEqual({
      id: 'webnic-ssl-42',
      domain: 'example.com',
      status: 'active',
      expiresAt: '2027-05-01T00:00:00.000Z',
      issuedAt: '2026-05-01T00:00:00.000Z',
    });
  });

  it('rejects an ID without the webnic-ssl- prefix', async () => {
    const p = mockProvider({});
    await expect(p.getCertificateStatus('porkbun-ssl-foo')).rejects.toMatchObject({ code: 'INVALID_CERT_ID' });
    await expect(p.getCertificateStatus('webnic-ssl-')).rejects.toMatchObject({ code: 'INVALID_CERT_ID' });
  });
});

describe('WebnicProvider SSL status mapping', () => {
  const cases: Array<{ name: string; in: { orderStatus: WebnicSSLOrderSummary['orderStatus']; certStatus: WebnicSSLOrderSummary['certStatus'] }; out: string }> = [
    { name: 'pending issuance', in: { orderStatus: 'PENDING', certStatus: 'INITIAL' }, out: 'pending' },
    { name: 'in process', in: { orderStatus: 'IN_PROCESS', certStatus: 'INITIAL' }, out: 'pending' },
    { name: 'processed → pending', in: { orderStatus: 'PROCESSED', certStatus: 'INITIAL' }, out: 'pending' },
    { name: 'completed → active', in: { orderStatus: 'COMPLETED', certStatus: 'ACTIVE' }, out: 'active' },
    { name: 'expired order', in: { orderStatus: 'EXPIRED', certStatus: 'EXPIRED' }, out: 'expired' },
    { name: 'rejected order', in: { orderStatus: 'REJECTED', certStatus: 'FAILED' }, out: 'failed' },
    { name: 'revoked cert', in: { orderStatus: 'COMPLETED', certStatus: 'REVOKED' }, out: 'failed' },
    { name: 'cancelled order', in: { orderStatus: 'CANCELLED', certStatus: 'CANCELLED' }, out: 'failed' },
    { name: 'refunded order', in: { orderStatus: 'REFUNDED', certStatus: 'CANCELLED' }, out: 'failed' },
    { name: 'pending reissue', in: { orderStatus: 'PENDING_REISSUE', certStatus: 'PENDING_REISSUE' }, out: 'pending' },
  ];

  for (const c of cases) {
    it(`maps ${c.name} (${c.in.orderStatus}/${c.in.certStatus}) → '${c.out}'`, async () => {
      const p = mockProvider({
        searchSSLOrders: async () => [summary({ orderId: '1', commonName: 'x.com', orderStatus: c.in.orderStatus, certStatus: c.in.certStatus })],
      });
      const [cert] = await p.listCertificates('x.com');
      expect(cert.status).toBe(c.out);
    });
  }
});

describe('WebnicProvider.createCertificate', () => {
  function product(p: Partial<WebnicSSLProduct> & { productKey: string; price: number }): WebnicSSLProduct {
    return { certType: 'DV', ...p };
  }

  it('picks the cheapest DV product and surfaces SSL_CSR_REQUIRED with that product info', async () => {
    let called = false;
    const p = mockProvider({
      listSSLProducts: async () => {
        called = true;
        return [
          product({ productKey: 'alphassl', price: 23.6 }),
          product({ productKey: 'sectigo-ssl', price: 20 }),
          product({ productKey: 'sectigo-ev', price: 50, certType: 'EV' }),
        ];
      },
    });

    await expect(p.createCertificate('example.com')).rejects.toMatchObject({
      code: 'SSL_CSR_REQUIRED',
      message: expect.stringContaining('sectigo-ssl'),
    });
    expect(called).toBe(true);
  });

  it('fails with SSL_PREREQUISITES_NOT_MET when defaultContactId is missing', async () => {
    const p = new WebnicProvider({ username: 'u', password: 'p' });
    await expect(p.createCertificate('example.com')).rejects.toMatchObject({ code: 'SSL_PREREQUISITES_NOT_MET' });
  });

  it('fails with NO_SSL_PRODUCT when catalog has no DV products', async () => {
    const p = mockProvider({
      listSSLProducts: async () => [
        { productKey: 'sectigo-ev', price: 50, certType: 'EV' } as WebnicSSLProduct,
      ],
    });
    await expect(p.createCertificate('example.com')).rejects.toMatchObject({ code: 'NO_SSL_PRODUCT' });
  });
});
