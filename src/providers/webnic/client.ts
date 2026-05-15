import Bottleneck from 'bottleneck';
import { AgentError } from '../../errors.js';

const WEBNIC_BASE = 'https://api.webnic.cc';
const WEBNIC_SANDBOX_BASE = 'https://oteapi.webnic.cc';

export type WebnicDomainStatusLevel = 'active' | 'transfer_protected' | 'name_protected';

export interface WebnicConfig {
  username: string;
  password: string;
  sandbox?: boolean;
  /** Pre-existing contact handle reused for all four roles (registrant/admin/tech/billing) at register/transfer time. */
  defaultContactId?: string;
  /** Pre-existing registrant account id (e.g. "REG100015") required by register/transfer endpoints. */
  defaultRegistrantUserId?: string;
  /** Pre-registered nameservers (host objects on WebNIC) used as defaults when register_domain doesn't carry them. Min 2. */
  defaultNameservers?: string[];
}

export interface WebnicTokenCache {
  token: string;
  /** ms epoch */
  expiresAt: number;
}

export interface WebnicEnvelope<T> {
  code: string;
  message: string;
  data?: T;
  error?: { subCode?: string; message?: string };
  fieldErrors?: Array<{ field: string; messages?: string[]; message?: string }>;
  validationErrors?: Array<{ field: string; message: string }>;
}

export interface WebnicDomainInfo {
  domainName: string;
  status: string;
  nameservers: string[];
  dtexpire: string;
  verified?: boolean;
  whoisPrivacy?: boolean;
  contactId?: { registrant: string; admin: string; technical: string; billing: string };
  userId?: string;
}

export interface WebnicQueryResult {
  available: boolean;
  premium: boolean;
  online?: boolean;
  landrush?: boolean;
  idn?: boolean;
  punyCodeDomainName?: string;
  premiumInfo?: { currency: string; registerPrice: number; renewPrice: number; transferPrice: number; restorePrice: number };
}

export interface WebnicZone {
  zone: string;
  zoneType: 'inzone' | 'outzone';
  subscription: string | null;
  subscriptionId: string | null;
  dtcreate: string;
  dtmodify: string;
}

export interface WebnicRdata {
  value: string;
  attributes?: Record<string, unknown>;
}

export interface WebnicRecord {
  name: string | null;
  type: string;
  ttl: number;
  rdatas: WebnicRdata[];
}

export interface WebnicContactDetails {
  firstName: string;
  lastName: string;
  company?: string;
  email: string;
  phoneNumber: string;
  address1: string;
  address2?: string | null;
  city: string;
  state: string;
  zip: string;
  countryCode: string;
  category?: 'individual' | 'organization';
}

/** Raw DS record from WebNIC's domain-level DNSSEC API. Fields are stringified ints. */
export interface WebnicDsData {
  keyTag: string;
  algorithm: string;
  digestType: string;
  digest: string;
}

/** Zone-level DNSSEC status (WebNIC-hosted zone). */
export interface WebnicZoneDnssecInfo {
  enabled: boolean;
  type?: string;
  algorithm?: string;
}

/** DNSKEY record returned by the zone DNSSEC endpoint. */
export interface WebnicZoneDnssecDnskey {
  type: string;
  name?: string;
  ttl: number;
  rdatas: WebnicRdata[];
}

export interface WebnicTransferStatus {
  id: number;
  domain: string;
  ext: string;
  status: 'pending' | 'approve' | 'reject' | 'cancel' | 'insert_fail' | 'complete';
  remark?: string;
  dtcreate?: string;
  pendingOrder?: boolean;
}

/** Order-level lifecycle (SSL Restful v2). */
export type WebnicSSLOrderStatus =
  | 'REJECTED'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'PENDING'
  | 'PENDING_REISSUE'
  | 'PROCESSED'
  | 'IN_PROCESS'
  | 'REVOKED'
  | 'INITIAL'
  | 'REFUNDED';

/** Certificate-level status (SSL Restful v2). */
export type WebnicSSLCertStatus =
  | 'ACTIVE'
  | 'EXPIRED'
  | 'REVOKED'
  | 'CANCELLED'
  | 'PENDING_REISSUE'
  | 'INITIAL'
  | 'COMPLETED'
  | 'FAILED';

export interface WebnicSSLOrderSummary {
  orderId: string;
  commonName: string;
  term?: number;
  orderStatus: WebnicSSLOrderStatus;
  certStatus: WebnicSSLCertStatus;
  product?: string;
  dtcreate?: string;
  dtorderexpire?: string;
  dtcertexpire?: string;
  email?: string;
  company?: string;
}

export interface WebnicSSLOrderInfo extends WebnicSSLOrderSummary {
  resid?: string;
  sanfield?: string[];
  authType?: 'email' | 'dns' | 'file';
  renewal?: boolean;
  reissue?: boolean;
  cancel?: boolean;
  dtmodify?: string;
  dtsettle?: string;
  admid?: string;
  tecid?: string;
  specialInstruction?: string;
  remarks?: string;
}

export interface WebnicSSLProduct {
  productKey: string;
  productName?: string;
  provider?: string;
  /** Price in USD. */
  price: number;
  wildcard?: boolean;
  allowSan?: boolean;
  allowWsan?: boolean;
  certType?: 'DV' | 'OV' | 'EV';
}

export interface WebnicSSLPlaceOrderParams {
  productKey: string;
  term: number;
  csr: string;
  administratorContactId: string;
  authType: 'email' | 'dns' | 'file';
  sanfield?: string[];
  organizationId?: string;
  technicalContactId?: string;
  shipmentContactId?: string;
  approverEmail?: Array<{ domain: string; email: string }>;
  specialInstruction?: string;
}

export interface WebnicSSLPlaceOrderResult {
  orderId: string;
  commonName: {
    name: string;
    authType: 'email' | 'dns' | 'file';
    value?: string;
    path?: string;
    fileName?: string;
    recordType?: string;
    host?: string;
  };
  san?: Array<{
    name: string;
    authType: 'email' | 'dns' | 'file';
    value?: string;
    path?: string;
    fileName?: string;
    recordType?: string;
    host?: string;
  }>;
}

export interface WebnicSSLDcvStatus {
  orderId: string;
  orderStatus: WebnicSSLOrderStatus;
  certStatus: WebnicSSLCertStatus;
}

export class WebnicClient {
  private readonly config: WebnicConfig;
  private readonly baseUrl: string;
  private readonly limiter: Bottleneck;
  private tokenCache: WebnicTokenCache | null = null;
  private inflightToken: Promise<string> | null = null;
  /** Set to a ms epoch when the last auth attempt failed with AUTH_FAILED. While Date.now() < this value,
   *  getToken() short-circuits with the same cached AgentError instead of re-hitting WebNIC. Prevents
   *  spamming the provider (and potentially tripping a brute-force lockout on the reseller account)
   *  when credentials are wrong, the IP is not whitelisted, or the environment is mismatched. */
  private authFailureCooldownUntil: number | null = null;
  private cachedAuthError: AgentError | null = null;
  /** Cooldown window after a failed auth attempt. */
  private static readonly AUTH_FAILURE_COOLDOWN_MS = 30_000;

  constructor(config: WebnicConfig) {
    this.config = config;
    this.baseUrl = config.sandbox ? WEBNIC_SANDBOX_BASE : WEBNIC_BASE;
    // WebNIC enforces 5000/day and 100000/month. ~3.5/sec average sustained.
    // Stay well below with minTime=300ms and concurrency 2.
    this.limiter = new Bottleneck({ minTime: 300, maxConcurrent: 2 });
  }

  /** Exposed for tests. */
  get base(): string {
    return this.baseUrl;
  }

  /** Forces re-auth on next call. Test/debug helper. Clears the auth-failure cooldown too. */
  invalidateToken(): void {
    this.tokenCache = null;
    this.authFailureCooldownUntil = null;
    this.cachedAuthError = null;
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt - 30_000 > now) {
      return this.tokenCache.token;
    }

    // If a previous auth attempt failed recently, fail fast with the same error instead of
    // re-hitting WebNIC (avoids spamming the provider and tripping potential lockouts).
    if (this.authFailureCooldownUntil !== null && now < this.authFailureCooldownUntil && this.cachedAuthError) {
      throw this.cachedAuthError;
    }

    if (this.inflightToken) return this.inflightToken;

    this.inflightToken = (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/reseller/v2/api-user/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ username: this.config.username, password: this.config.password }),
          signal: AbortSignal.timeout(30_000),
        });

        const text = await res.text();
        let body: WebnicEnvelope<{ access_token: string; expires_in: number }> = { code: '', message: '' };
        try { body = JSON.parse(text) as typeof body; } catch { /* non-JSON */ }

        if (!res.ok || !body.data?.access_token) {
          const err = translateWebnicError(res.status, body);
          if (err.code === 'AUTH_FAILED') {
            this.authFailureCooldownUntil = Date.now() + WebnicClient.AUTH_FAILURE_COOLDOWN_MS;
            this.cachedAuthError = err;
          }
          throw err;
        }

        const expiresInSec = body.data.expires_in ?? 3600;
        this.tokenCache = {
          token: body.data.access_token,
          expiresAt: Date.now() + expiresInSec * 1000,
        };
        // Successful auth clears any prior cooldown.
        this.authFailureCooldownUntil = null;
        this.cachedAuthError = null;
        return this.tokenCache.token;
      } finally {
        this.inflightToken = null;
      }
    })();

    return this.inflightToken;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<T> {
    return this.limiter.schedule(async () => {
      let token = await this.getToken();
      const url = buildUrl(this.baseUrl, path, opts.query);

      let attempt = 0;
      const delays = [1000, 2000, 4000];

      while (true) {
        const res = await fetch(url, {
          method,
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });

        if (res.status === 429 && attempt < delays.length) {
          const retryAfterSec = parseInt(res.headers.get('Retry-After') ?? '', 10);
          const wait = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : delays[attempt];
          await sleep(wait);
          attempt += 1;
          continue;
        }

        if (res.status === 401) {
          // Token might have been rotated server-side; refresh once and retry.
          if (attempt === 0) {
            this.tokenCache = null;
            token = await this.getToken();
            attempt += 1;
            continue;
          }
        }

        const text = await res.text();
        let body: WebnicEnvelope<T> = { code: '', message: '' };
        if (text) {
          try { body = JSON.parse(text) as WebnicEnvelope<T>; } catch { /* non-JSON */ }
        }

        if (!res.ok) {
          throw translateWebnicError(res.status, body);
        }

        // WebNIC may return business errors with HTTP 200 + code != "1000".
        if (body.code && body.code !== '1000' && body.code !== '0') {
          throw translateWebnicError(200, body);
        }

        return (body.data as T) ?? (undefined as T);
      }
    });
  }

  // --- Domain ----------------------------------------------------------------

  async queryDomain(domainName: string): Promise<WebnicQueryResult> {
    return this.request<WebnicQueryResult>('GET', '/domain/v2/query', { query: { domainName } });
  }

  async getDomainInfo(domainName: string): Promise<WebnicDomainInfo> {
    return this.request<WebnicDomainInfo>('GET', '/domain/v2/info', { query: { domainName } });
  }

  async registerDomain(params: {
    domainName: string;
    term: number;
    nameservers: string[];
    registrantContactId: string;
    administratorContactId: string;
    technicalContactId: string;
    billingContactId: string;
    registrantUserId: string;
    domainType?: 'standard' | 'premium' | 'rereg';
    lang?: string;
    proxy?: boolean;
    whoisPrivacy?: boolean;
  }): Promise<{ pendingOrder: boolean; pendingOrderId?: number; dtexpire: string }> {
    const body: Record<string, unknown> = {
      domainName: params.domainName,
      term: params.term,
      nameservers: params.nameservers,
      registrantContactId: params.registrantContactId,
      administratorContactId: params.administratorContactId,
      technicalContactId: params.technicalContactId,
      billingContactId: params.billingContactId,
      registrantUserId: params.registrantUserId,
    };
    if (params.domainType) body.domainType = params.domainType;
    if (params.lang) body.lang = params.lang;
    if (params.proxy !== undefined || params.whoisPrivacy !== undefined) {
      body.addons = {
        ...(params.proxy !== undefined ? { proxy: params.proxy } : {}),
        ...(params.whoisPrivacy !== undefined ? { whoisPrivacy: params.whoisPrivacy } : {}),
      };
    }
    return this.request('POST', '/domain/v2/register', { body });
  }

  async renewDomain(domainName: string, term: number, domainExpiryDate?: string, domainType?: 'standard' | 'premium'): Promise<{ pendingOrder: boolean; dtexpire: string }> {
    const body: Record<string, unknown> = { domainName, term };
    if (domainExpiryDate) body.domainExpiryDate = domainExpiryDate;
    if (domainType) body.domainType = domainType;
    return this.request('POST', '/domain/v2/renew', { body });
  }

  async updateNameservers(domainName: string, nameservers: string[]): Promise<void> {
    await this.request('PUT', '/domain/v2/dns', { query: { domainName }, body: { nameservers } });
  }

  /**
   * Set the domain registry-side protection level.
   * - 'active': no protection — required for nameserver changes, contact updates, transfers.
   * - 'transfer_protected': blocks unauthorised transfers.
   * - 'name_protected': strictest — blocks transfers, deletion, contact and DNS modifications.
   *
   * Returns void on success; throws AgentError on rejection. Idempotent at the API level.
   */
  async updateDomainStatus(domainName: string, status: WebnicDomainStatusLevel): Promise<void> {
    await this.request('PUT', '/domain/v2/status', { query: { domainName, status } });
  }

  async listZones(opts: { keyword?: string; zoneType?: 'inzone' | 'outzone'; limit?: number } = {}): Promise<WebnicZone[]> {
    return this.request<WebnicZone[]>('GET', '/dns/v2/zones', {
      query: {
        zone: opts.keyword,
        zoneType: opts.zoneType,
        limit: opts.limit ?? 100,
      },
    });
  }

  // --- DNS records -----------------------------------------------------------

  async listRecords(zone: string): Promise<{ records: WebnicRecord[]; sourceFrom: string }> {
    return this.request('GET', `/dns/v2/zone/${encodeURIComponent(zone)}/records`);
  }

  async saveRecord(zone: string, record: { name: string; type: string; ttl: number; rdatas: WebnicRdata[] }): Promise<WebnicRecord> {
    return this.request('POST', `/dns/v2/zone/${encodeURIComponent(zone)}/record`, { body: record });
  }

  async deleteRecord(zone: string, type: string, name: string): Promise<void> {
    await this.request('DELETE', `/dns/v2/zone/${encodeURIComponent(zone)}/record`, { query: { type, name } });
  }

  // --- Transfer --------------------------------------------------------------

  async submitTransferIn(params: {
    domainName: string;
    authInfo: string;
    registrantUserId: string;
    registrantContactId: string;
    administratorContactId: string;
    technicalContactId: string;
    billingContactId: string;
    subscribeProxy?: boolean;
    domainType?: 'standard' | 'premium';
  }): Promise<{ id: number; status: string; pendingOrder: boolean }> {
    return this.request('POST', '/domain/v2/transfer-in', {
      body: { subscribeProxy: false, ...params },
    });
  }

  async getTransferInStatus(domainName: string): Promise<WebnicTransferStatus> {
    return this.request<WebnicTransferStatus>('GET', '/domain/v2/transfer-in/status', { query: { domainName } });
  }

  // --- Contact ---------------------------------------------------------------

  async queryContact(contactId: string): Promise<{ contactId: string; contactType: string; details: WebnicContactDetails }> {
    return this.request('GET', '/domain/v2/contact/query', { query: { contactId } });
  }

  // --- Pricing ---------------------------------------------------------------

  async getExtensionPricing(productKeys: string[], transtype: Array<'register' | 'transfer' | 'renewal' | 'restore'> = ['register', 'renewal']): Promise<Array<{
    productKey: string;
    productPricing: { price: Record<string, { ascii?: Record<string, number>; idn?: Record<string, number> }> };
  }>> {
    type Resp = {
      pageSize: number;
      totalPages: number;
      totalItems: number;
      items: Array<{ productKey: string; productPricing: { price: Record<string, { ascii?: Record<string, number>; idn?: Record<string, number> }> } }>;
    };
    const data = await this.request<Resp>('POST', '/domain/v2/exts/pricing', {
      body: {
        filters: [
          { field: 'productKey', value: productKeys.join(',') },
          { field: 'transtype', value: transtype.join(',') },
        ],
        pagination: { page: 1, pageSize: 100 },
      },
    });
    return data?.items ?? [];
  }

  // --- SSL (Restful v2) ------------------------------------------------------

  /**
   * Search SSL orders. Filters mirror the WebNIC pagination API
   * (`commonName` + `LIKE` matches certs whose common name contains the value).
   */
  async searchSSLOrders(opts: {
    commonName?: string;
    orderStatus?: WebnicSSLOrderStatus;
    page?: number;
    pageSize?: number;
  } = {}): Promise<WebnicSSLOrderSummary[]> {
    type Resp = {
      pageSize: number;
      totalPages: number;
      totalItems: number;
      items: WebnicSSLOrderSummary[];
    };
    const filters: Array<{ field: string; operator: 'EQUAL' | 'LIKE'; value: string }> = [];
    if (opts.commonName) {
      filters.push({ field: 'commonName', operator: 'LIKE', value: opts.commonName });
    }
    if (opts.orderStatus) {
      filters.push({ field: 'orderStatus', operator: 'EQUAL', value: opts.orderStatus });
    }
    const data = await this.request<Resp>('POST', '/ssl/v2/orders/search', {
      body: {
        filters,
        pagination: { page: opts.page ?? 1, pageSize: opts.pageSize ?? 100 },
      },
    });
    return data?.items ?? [];
  }

  /** Full info for one SSL order, including DCV approver/CN auth details. */
  async getSSLOrderInfo(orderId: string): Promise<WebnicSSLOrderInfo> {
    return this.request<WebnicSSLOrderInfo>('GET', '/ssl/v2/orders/info', { query: { orderId } });
  }

  /** DCV-only view, lighter than full order info. Returns just status fields. */
  async getSSLOrderDcvStatus(orderId: string): Promise<WebnicSSLDcvStatus> {
    return this.request<WebnicSSLDcvStatus>('GET', `/ssl/v2/orders/${encodeURIComponent(orderId)}/dcv-status`);
  }

  /** Place an SSL order. Returns the orderId and the DCV instructions for CN + SAN. */
  async placeSSLOrder(params: WebnicSSLPlaceOrderParams): Promise<WebnicSSLPlaceOrderResult> {
    return this.request<WebnicSSLPlaceOrderResult>('POST', '/ssl/v2/orders/new', { body: params });
  }

  /** Cancel an SSL order (only valid while still pending issuance). */
  async cancelSSLOrder(orderId: string): Promise<void> {
    await this.request('POST', `/ssl/v2/orders/${encodeURIComponent(orderId)}/cancel`);
  }

  /**
   * List SSL products with base price (USD).
   * NOTE: WebNIC marks this endpoint deprecated; for now it is the documented way
   * to discover available SSL products with prices and certType (DV/OV/EV).
   */
  async listSSLProducts(): Promise<WebnicSSLProduct[]> {
    return this.request<WebnicSSLProduct[]>('GET', '/ssl/v2/products/list/price');
  }

  // --- DNSSEC (domain / registry side) --------------------------------------

  /** Check whether the TLD/domain supports DNSSEC at the registry. */
  async checkDnssecSupported(domainName: string): Promise<{ dnssecSupported: boolean }> {
    return this.request('GET', '/domain/v2/dnssec/support', { query: { domainName } });
  }

  /** Get DS records currently published at the parent registry for `domainName`. */
  async getDnssecInfo(domainName: string): Promise<{ dsDatas: WebnicDsData[] }> {
    const data = await this.request<{ dsDatas?: WebnicDsData[] }>('GET', '/domain/v2/dnssec', { query: { domainName } });
    return { dsDatas: data?.dsDatas ?? [] };
  }

  /** Publish a new set of DS records at the parent registry (replaces previous set). */
  async updateDnssec(domainName: string, dsDatas: WebnicDsData[]): Promise<void> {
    await this.request('POST', '/domain/v2/dnssec', { query: { domainName }, body: { dsDatas } });
  }

  /** Remove all DS records from the parent registry. */
  async deleteDnssec(domainName: string): Promise<void> {
    await this.request('DELETE', '/domain/v2/dnssec', { query: { domainName } });
  }

  // --- DNSSEC (zone side, WebNIC-hosted authoritative DNS) ------------------

  /** Get the zone-level DNSSEC subscription status. */
  async getZoneDnssecInfo(zone: string): Promise<WebnicZoneDnssecInfo> {
    return this.request('GET', `/dns/v2/zone/${encodeURIComponent(zone)}/subscription/dnssec/info`);
  }

  /** Enable DNSSEC on the WebNIC-hosted zone (signs the zone). */
  async enableZoneDnssec(zone: string): Promise<WebnicZoneDnssecInfo> {
    return this.request('PUT', `/dns/v2/zone/${encodeURIComponent(zone)}/subscription/dnssec/enable`);
  }

  /** Disable DNSSEC on the WebNIC-hosted zone. */
  async disableZoneDnssec(zone: string): Promise<WebnicZoneDnssecInfo> {
    return this.request('PUT', `/dns/v2/zone/${encodeURIComponent(zone)}/subscription/dnssec/disable`);
  }

  /** Get the DNSKEY record generated by the WebNIC-signed zone. */
  async getZoneDnssecDnskey(zone: string): Promise<WebnicZoneDnssecDnskey> {
    return this.request('GET', `/dns/v2/zone/${encodeURIComponent(zone)}/subscription/dnssec/dnskey`);
  }

  /** Get the DS record derived from the WebNIC-signed zone DNSKEY (publish at registry). */
  async getZoneDnssecDs(zone: string): Promise<WebnicDsData> {
    return this.request('GET', `/dns/v2/zone/${encodeURIComponent(zone)}/subscription/dnssec/ds`);
  }
}

function buildUrl(base: string, path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(`${base}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function translateWebnicError<T>(status: number, body: WebnicEnvelope<T>): AgentError {
  const subCode = body.error?.subCode ?? '';
  const message = body.error?.message || body.message || `HTTP ${status}`;
  const code = body.code ?? '';
  const raw = JSON.stringify({ status, code, subCode, message, fieldErrors: body.fieldErrors, validationErrors: body.validationErrors });

  if (status === 401 || /authentication|invalid token|unauthorized/i.test(message)) {
    return new AgentError(
      'AUTH_FAILED',
      `Webnic authentication failed: ${message}`,
      'Check WEBNIC_USERNAME and WEBNIC_PASSWORD. Verify your IP is on the authorized access list, and that you are using the correct environment (production vs OTE sandbox).',
      'webnic',
      raw,
    );
  }

  if (status === 403 || /forbidden|not allowed|under current partner/i.test(message)) {
    return new AgentError(
      'PERMISSION_DENIED',
      `Webnic refused the operation: ${message}`,
      'Verify your reseller account has the required permissions and the domain/zone belongs to your account.',
      'webnic',
      raw,
    );
  }

  if (status === 429) {
    return new AgentError(
      'RATE_LIMIT',
      'Webnic rate limit reached (5000/day, 100000/month).',
      'Wait a moment and retry. If sustained, request a quota increase from your WebNIC account manager.',
      'webnic',
      raw,
    );
  }

  if (/not found|not exist|no record|record not found/i.test(message) && /domain|zone|contact|transfer/i.test(message)) {
    return new AgentError(
      'NOT_FOUND',
      `Webnic resource not found: ${message}`,
      'Verify the domain/zone/contact ID is correct and belongs to your account.',
      'webnic',
      raw,
    );
  }

  if (/unavailable|already registered|not available/i.test(message)) {
    return new AgentError(
      'DOMAIN_UNAVAILABLE',
      `Domain is not available for registration: ${message}`,
      'Choose a different domain or use check_availability first.',
      'webnic',
      raw,
    );
  }

  if (/insufficient|balance|credit/i.test(message)) {
    return new AgentError(
      'INSUFFICIENT_FUNDS',
      'Webnic operation failed: insufficient account balance.',
      'Top up your WebNIC reseller account at https://portal.webnic.cc',
      'webnic',
      raw,
    );
  }

  if (body.fieldErrors?.length || body.validationErrors?.length) {
    const fields = [
      ...(body.fieldErrors ?? []).map((f) => `${f.field}: ${(f.messages ?? [f.message]).filter(Boolean).join(', ')}`),
      ...(body.validationErrors ?? []).map((f) => `${f.field}: ${f.message}`),
    ].join('; ');
    return new AgentError(
      'VALIDATION_ERROR',
      `Webnic rejected the request: ${fields || message}`,
      'Check the request payload against the WebNIC RESTFUL v2 documentation at https://apidoc.webnic.dev.',
      'webnic',
      raw,
    );
  }

  return new AgentError(
    'WEBNIC_ERROR',
    `Webnic API error [${status}] ${code || subCode}: ${message}`,
    'Check https://apidoc.webnic.dev or your reseller portal at https://portal.webnic.cc for more context.',
    'webnic',
    raw,
  );
}
