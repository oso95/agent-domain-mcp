import Bottleneck from 'bottleneck';
import { AgentError } from '../../errors.js';

interface GoDaddyConfig {
  apiKey: string;
  apiSecret: string;
  sandbox?: boolean;
}

const GODADDY_BASE = 'https://api.godaddy.com';
const GODADDY_SANDBOX_BASE = 'https://api.ote-godaddy.com';

export class GoDaddyClient {
  private config: GoDaddyConfig;
  private baseUrl: string;
  // 60 req/min = minTime 1000ms
  private limiter: Bottleneck;

  constructor(config: GoDaddyConfig) {
    this.config = config;
    this.baseUrl = config.sandbox ? GODADDY_SANDBOX_BASE : GODADDY_BASE;
    this.limiter = new Bottleneck({ minTime: 1000, maxConcurrent: 1 });
  }

  private headers() {
    return {
      'Authorization': `sso-key ${this.config.apiKey}:${this.config.apiSecret}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return this.limiter.schedule(async () => {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });

      if (res.status === 429) {
        const retryAfterSec = parseInt(res.headers.get('Retry-After') ?? '', 10);
        const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 10000;
        await sleep(waitMs);
        const retry = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: this.headers(),
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30000),
        });
        if (retry.status === 429) {
          throw new AgentError('RATE_LIMIT', 'GoDaddy API rate limit reached.', 'Wait a moment and try again.', 'godaddy');
        }
        if (!retry.ok) {
          const retryText = await retry.text();
          let retryData: GoDaddyError = {};
          try { retryData = JSON.parse(retryText) as GoDaddyError; } catch { /* non-JSON */ }
          throw translateGoDaddyError(retry.status, retryData);
        }
        if (retry.status === 204) return undefined as T;
        return retry.json() as T;
      }

      if (!res.ok) {
        const errorText = await res.text();
        let errorData: GoDaddyError = {};
        try { errorData = JSON.parse(errorText) as GoDaddyError; } catch { /* non-JSON */ }
        throw translateGoDaddyError(res.status, errorData);
      }

      if (res.status === 204) return undefined as T;

      const text = await res.text();
      return text ? JSON.parse(text) as T : undefined as T;
    });
  }

  async listDomains(): Promise<GoDaddyDomain[]> {
    // GoDaddy v1 /domains has no pagination — max limit is 1000. Accounts with 1000+
    // domains will be silently truncated; this is an API limitation with no workaround.
    return this.request<GoDaddyDomain[]>('GET', '/v1/domains?limit=1000&statuses=ACTIVE,EXPIRED,LOCKED');
  }

  async getDomain(domain: string): Promise<GoDaddyDomain> {
    return this.request<GoDaddyDomain>('GET', `/v1/domains/${encodeURIComponent(domain)}`);
  }

  async checkAvailability(domain: string): Promise<{ available: boolean; price?: number; currency?: string; premium?: boolean }> {
    interface Response {
      available: boolean;
      price?: number;
      currency?: string;
      premium?: boolean;
      definitive: boolean;
    }
    return this.request<Response>('GET', `/v1/domains/available?domain=${encodeURIComponent(domain)}&checkType=FAST`);
  }

  async registerDomain(params: {
    domain: string; years: number;
    contact: { firstName: string; lastName: string; email: string; phone: string; address1: string; city: string; state: string; postalCode: string; country: string };
    autoRenew: boolean; privacy: boolean;
  }): Promise<void> {
    await this.request('POST', '/v1/domains/purchase', {
      domain: params.domain,
      period: params.years,
      autoRenew: params.autoRenew,
      privacy: params.privacy,
      registrant: {
        firstName: params.contact.firstName,
        lastName: params.contact.lastName,
        email: params.contact.email,
        phone: params.contact.phone,
        addressMailing: {
          address1: params.contact.address1,
          city: params.contact.city,
          state: params.contact.state,
          postalCode: params.contact.postalCode,
          country: params.contact.country,
        },
      },
      admin: {
        firstName: params.contact.firstName,
        lastName: params.contact.lastName,
        email: params.contact.email,
        phone: params.contact.phone,
        addressMailing: {
          address1: params.contact.address1,
          city: params.contact.city,
          state: params.contact.state,
          postalCode: params.contact.postalCode,
          country: params.contact.country,
        },
      },
      tech: {
        firstName: params.contact.firstName,
        lastName: params.contact.lastName,
        email: params.contact.email,
        phone: params.contact.phone,
        addressMailing: {
          address1: params.contact.address1,
          city: params.contact.city,
          state: params.contact.state,
          postalCode: params.contact.postalCode,
          country: params.contact.country,
        },
      },
      billing: {
        firstName: params.contact.firstName,
        lastName: params.contact.lastName,
        email: params.contact.email,
        phone: params.contact.phone,
        addressMailing: {
          address1: params.contact.address1,
          city: params.contact.city,
          state: params.contact.state,
          postalCode: params.contact.postalCode,
          country: params.contact.country,
        },
      },
      consent: {
        agreedAt: new Date().toISOString(),
        agreedBy: params.contact.email,
        agreementKeys: ['DNRA'],
      },
    });
  }

  async renewDomain(domain: string, years: number): Promise<void> {
    await this.request('POST', `/v1/domains/${encodeURIComponent(domain)}/renew`, { period: years });
  }

  async listDNSRecords(domain: string): Promise<GoDaddyDNSRecord[]> {
    return this.request<GoDaddyDNSRecord[]>('GET', `/v1/domains/${encodeURIComponent(domain)}/records`);
  }

  async createDNSRecord(domain: string, record: { type: string; name: string; data: string; ttl: number; priority?: number }): Promise<void> {
    // GoDaddy v1 PATCH /records/{type}/{name} REPLACES all records of that type+name.
    // To append without losing siblings (e.g., multiple MX records), read existing first.
    // GoDaddy returns 200 + empty array when no records of that type+name exist (not 404).
    // Do NOT catch errors here — a 404 means the domain is not in the account, not that
    // records are absent, and silently swallowing it produces a confusing downstream error.
    const existing = await this.request<GoDaddyDNSRecord[]>(
      'GET', `/v1/domains/${encodeURIComponent(domain)}/records/${record.type}/${encodeURIComponent(record.name)}`,
    );
    const payload = [
      ...existing.map((r) => ({ data: r.data, ttl: r.ttl, priority: r.priority })),
      { data: record.data, ttl: record.ttl, priority: record.priority },
    ];
    await this.request('PATCH', `/v1/domains/${encodeURIComponent(domain)}/records/${record.type}/${encodeURIComponent(record.name)}`, payload);
  }

  async updateDNSRecord(domain: string, record: { type: string; name: string; data: string; ttl: number; priority?: number }): Promise<void> {
    // GoDaddy v1 PUT body elements accept only data/ttl/priority — name comes from the URL path
    await this.request('PUT', `/v1/domains/${encodeURIComponent(domain)}/records/${record.type}/${encodeURIComponent(record.name)}`, [
      { data: record.data, ttl: record.ttl, priority: record.priority },
    ]);
  }

  async deleteDNSRecord(domain: string, type: string, name: string): Promise<void> {
    await this.request('DELETE', `/v1/domains/${encodeURIComponent(domain)}/records/${type}/${encodeURIComponent(name)}`);
  }

  async getWhoisContact(domain: string): Promise<GoDaddyContact> {
    const d = await this.getDomain(domain);
    return d.contactRegistrant ?? {} as GoDaddyContact;
  }

  async updateWhoisContact(domain: string, contact: GoDaddyContact): Promise<void> {
    await this.request('PATCH', `/v1/domains/${encodeURIComponent(domain)}`, {
      contactRegistrant: contact,
      contactAdmin: contact,
      contactTech: contact,
      contactBilling: contact,
    });
  }

  async initiateTransfer(domain: string, authCode: string, agreedBy: string): Promise<void> {
    await this.request('POST', `/v1/domains/${encodeURIComponent(domain)}/transfer`, {
      authCode,
      period: 1,
      consent: {
        agreedAt: new Date().toISOString(),
        agreedBy,
        agreementKeys: ['DNTA'],
      },
    });
  }
}

export interface GoDaddyDomain {
  domain: string;
  status: string;
  expires: string;
  renewAuto: boolean;
  locked: boolean;
  nameServers: string[];
  contactRegistrant?: GoDaddyContact;
}

export interface GoDaddyDNSRecord {
  type: string;
  name: string;
  data: string;
  ttl: number;
  priority?: number;
}

export interface GoDaddyContact {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  addressMailing: {
    address1: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
}

interface GoDaddyError {
  code?: string;
  message?: string;
  fields?: Array<{ code: string; message: string; path: string }>;
}

function translateGoDaddyError(status: number, error: GoDaddyError): AgentError {
  const msg = error.message ?? '';
  const code = error.code ?? '';

  if (status === 401 || code === 'UNABLE_TO_AUTHENTICATE') {
    return new AgentError(
      'AUTH_FAILED',
      'GoDaddy authentication failed. Check that GODADDY_API_KEY and GODADDY_API_SECRET are correct and that your API key has not expired.',
      'Verify your API credentials at https://developer.godaddy.com/keys',
      'godaddy',
      msg,
    );
  }

  if (status === 403) {
    return new AgentError(
      'PERMISSION_DENIED',
      'GoDaddy DNS management API requires your account to have 10 or more domains, or an active Domain Pro plan. Your account currently does not meet this requirement.',
      'Upgrade to the Domain Pro plan at https://www.godaddy.com/domain/api-access or add more domains to your account.',
      'godaddy',
      msg,
    );
  }

  if (status === 404 || code === 'UNABLE_TO_FIND_DOMAIN') {
    return new AgentError(
      'DOMAIN_NOT_FOUND',
      `Domain not found in your GoDaddy account: ${msg}`,
      'Verify the domain is registered in your GoDaddy account.',
      'godaddy',
      msg,
    );
  }

  if (status === 422 || code === 'DUPLICATE_RECORD') {
    return new AgentError(
      'DUPLICATE_RECORD',
      `DNS record already exists: ${msg}`,
      'Delete the existing record first, then create the new one.',
      'godaddy',
      msg,
    );
  }

  return new AgentError(
    'GODADDY_ERROR',
    `GoDaddy API error [${status}] ${code}: ${msg}`,
    'Check the GoDaddy API documentation or verify your account permissions.',
    'godaddy',
    msg,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
