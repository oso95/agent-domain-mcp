import Bottleneck from 'bottleneck';
import { AgentError } from '../../errors.js';

const PORKBUN_BASE = 'https://api.porkbun.com/api/json/v3';

interface PorkbunCredentials {
  apiKey: string;
  secretApiKey: string;
}

export class PorkbunClient {
  private credentials: PorkbunCredentials;
  private baseUrl: string;
  // Porkbun rate limits: ~60 req/min for DNS, ~1 req/10s for domain checks
  private dnsLimiter: Bottleneck;
  private availabilityLimiter: Bottleneck;

  constructor(credentials: PorkbunCredentials) {
    this.credentials = credentials;
    this.baseUrl = PORKBUN_BASE;
    this.dnsLimiter = new Bottleneck({ minTime: 1000, maxConcurrent: 1 });
    this.availabilityLimiter = new Bottleneck({ minTime: 10000, maxConcurrent: 1 });
  }

  private authBody() {
    return {
      apikey: this.credentials.apiKey,
      secretapikey: this.credentials.secretApiKey,
    };
  }

  private async request<T>(
    path: string,
    body: Record<string, unknown> = {},
    useLimiter: 'dns' | 'availability' = 'dns',
  ): Promise<T> {
    const limiter = useLimiter === 'availability' ? this.availabilityLimiter : this.dnsLimiter;

    return limiter.schedule(async () => {
      let lastError: unknown;
      const delays = [2000, 4000, 8000, 16000, 30000];

      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const res = await fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...this.authBody(), ...body }),
            signal: AbortSignal.timeout(30000),
          });

          if (res.status === 429) {
            const retryAfterSec = parseInt(res.headers.get('Retry-After') ?? '', 10);
            const retryAfter = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : null;
            if (attempt < 4) {
              await sleep(retryAfter ?? delays[attempt] ?? 30000);
              continue;
            }
            throw new AgentError(
              'RATE_LIMIT',
              'Porkbun rate limit reached: domain availability checks are limited to approximately 1 per 10 seconds. Retrying automatically — please wait.',
              'Wait a moment and try again. Rate limits reset automatically.',
              'porkbun',
            );
          }

          const data = await res.json() as Record<string, unknown>;

          if (data.status === 'ERROR') {
            throw translatePorkbunError((data.message as string) ?? 'Unknown error');
          }

          return data as T;
        } catch (err) {
          if (err instanceof AgentError) throw err;
          lastError = err;
          if (attempt < 4) {
            await sleep(delays[attempt] ?? 30000);
          }
        }
      }

      throw lastError ?? new AgentError('NETWORK_ERROR', 'Porkbun API request failed after retries.', 'Check your network connection.', 'porkbun');
    });
  }

  async listDomains(): Promise<unknown[]> {
    type Response = { status: string; domains: unknown[] };
    const data = await this.request<Response>('/domain/listAll');
    return data.domains ?? [];
  }

  /** O(N) — Porkbun has no single-domain GET; fetches entire account domain list. */
  async getDomain(domain: string): Promise<unknown> {
    const domains = await this.listDomains() as Array<{ domain: string }>;
    return domains.find((d) => d.domain.toLowerCase() === domain.toLowerCase()) ?? null;
  }

  async registerDomain(params: {
    domain: string;
    years?: number;
    // Note: Porkbun domain/create uses account-level contact info; contact fields are not accepted
    autoRenew?: boolean;
    privacyProtection?: boolean;
    costDollars: number;
  }): Promise<unknown> {
    type Response = { status: string };
    // Porkbun domain/create: `cost` is a dollar-amount confirmation guard (e.g. 12.99),
    // not cents. Domain name goes in the URL path per v3 API.
    return this.request<Response>(`/domain/create/${encodeURIComponent(params.domain)}`, {
      cost: params.costDollars,
      agreeToTerms: 'yes',
      years: params.years ?? 1,
      autorenew: params.autoRenew ? '1' : '0',
      whoisPrivacy: params.privacyProtection ? '1' : '0',
    });
  }

  async renewDomain(domain: string, years: number): Promise<void> {
    await this.request(`/domain/renew/${encodeURIComponent(domain)}`, { years });
  }

  // DNS operations
  async listDNSRecords(domain: string): Promise<unknown[]> {
    type Response = { status: string; records: unknown[] };
    const data = await this.request<Response>(`/dns/retrieve/${encodeURIComponent(domain)}`, {}, 'dns');
    return data.records ?? [];
  }

  async createDNSRecord(domain: string, record: {
    type: string; name: string; content: string; ttl: number; priority?: number;
  }): Promise<unknown> {
    type Response = { status: string; id: number };
    const data = await this.request<Response>(`/dns/create/${encodeURIComponent(domain)}`, {
      type: record.type,
      name: record.name === '@' ? '' : record.name,
      content: record.content,
      ttl: String(record.ttl),
      prio: record.priority !== undefined ? String(record.priority) : undefined,
    }, 'dns');
    return { id: String(data.id), ...record };
  }

  async updateDNSRecord(domain: string, record: {
    id: string; type: string; name: string; content: string; ttl: number; priority?: number;
  }): Promise<unknown> {
    await this.request(`/dns/edit/${encodeURIComponent(domain)}/${encodeURIComponent(record.id)}`, {
      type: record.type,
      name: record.name === '@' ? '' : record.name,
      content: record.content,
      ttl: String(record.ttl),
      prio: record.priority !== undefined ? String(record.priority) : undefined,
    }, 'dns');
    return record;
  }

  async deleteDNSRecord(domain: string, recordId: string): Promise<void> {
    await this.request(`/dns/delete/${encodeURIComponent(domain)}/${encodeURIComponent(recordId)}`, {}, 'dns');
  }

  // SSL operations
  async listCertificates(domain: string): Promise<unknown[]> {
    type Response = { status: string; certificatechain?: string; privatekey?: string; publickey?: string };
    try {
      const data = await this.request<Response>(`/ssl/retrieve/${encodeURIComponent(domain)}`);
      if (data.certificatechain) {
        return [{
          id: `porkbun-ssl-${domain}`,
          domain,
          status: 'active',
          certificate: data.certificatechain,
        }];
      }
    } catch {
      // No cert yet
    }
    return [];
  }

  async createCertificate(domain: string): Promise<unknown> {
    type Response = { status: string; certificatechain?: string; privatekey?: string; publickey?: string };
    const data = await this.request<Response>(`/ssl/retrieve/${encodeURIComponent(domain)}`);
    return {
      id: `porkbun-ssl-${domain}`,
      domain,
      status: data.certificatechain ? 'active' : 'pending',
      certificate: data.certificatechain,
      privatekey: data.privatekey,
    };
  }

  // Transfer operations
  async initiateTransfer(domain: string, authCode: string): Promise<unknown> {
    return this.request(`/domain/transfer/${encodeURIComponent(domain)}`, { authCode });
  }

  // WHOIS contact — Porkbun v3 API does not expose contact management endpoints
  async getWhoisContact(_domain: string): Promise<never> {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      'Porkbun does not provide a WHOIS contact management API.',
      'Manage WHOIS contact information by logging into your Porkbun account at https://porkbun.com.',
      'porkbun',
    );
  }

  async updateWhoisContact(_domain: string, _contact: Record<string, string>): Promise<never> {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      'Porkbun does not provide a WHOIS contact management API.',
      'Manage WHOIS contact information by logging into your Porkbun account at https://porkbun.com.',
      'porkbun',
    );
  }

  // Pricing (for availability enrichment)
  async getPricing(): Promise<Record<string, { registration: string; renewal: string; transfer: string }>> {
    type Response = { status: string; pricing: Record<string, { registration: string; renewal: string; transfer: string }> };
    const data = await this.request<Response>('/pricing/get', {}, 'availability');
    return data.pricing ?? {};
  }
}

function translatePorkbunError(message: string): AgentError {
  const msg = message.toLowerCase();

  if (msg.includes('authentication') || msg.includes('invalid api') || msg.includes('apikey')) {
    return new AgentError(
      'AUTH_FAILED',
      'Porkbun authentication failed. Your API key or secret is invalid.',
      'Check that PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY are correct in your environment.',
      'porkbun',
      message,
    );
  }

  if (msg.includes('not found') || msg.includes('no domain')) {
    return new AgentError(
      'DOMAIN_NOT_FOUND',
      `Domain not found in your Porkbun account: ${message}`,
      'Verify the domain exists in your Porkbun account.',
      'porkbun',
      message,
    );
  }

  if (msg.includes('credit') || msg.includes('balance') || msg.includes('insufficient')) {
    return new AgentError(
      'INSUFFICIENT_FUNDS',
      'Porkbun domain registration failed: insufficient account credit.',
      'Add funds to your Porkbun account at https://porkbun.com/account/funds',
      'porkbun',
      message,
    );
  }

  if (msg.includes('already registered') || msg.includes('not available')) {
    return new AgentError(
      'DOMAIN_UNAVAILABLE',
      `Domain is not available for registration: ${message}`,
      'Choose a different domain or check availability first using check_availability.',
      'porkbun',
      message,
    );
  }

  if (msg.includes('prerequisite') || msg.includes('verified')) {
    return new AgentError(
      'REGISTRATION_PREREQUISITES_NOT_MET',
      'Porkbun domain registration requires: at least one previously registered domain on your account, a verified email address, a verified phone number, and sufficient account credit.',
      'Complete account verification at https://porkbun.com/account and ensure you have at least one existing domain.',
      'porkbun',
      message,
    );
  }

  return new AgentError(
    'PORKBUN_ERROR',
    `Porkbun API error: ${message}`,
    'Check the Porkbun API documentation or try again.',
    'porkbun',
    message,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
