import Bottleneck from 'bottleneck';
import { AgentError } from '../../errors.js';

const CF_BASE = 'https://api.cloudflare.com/client/v4';

interface CloudflareConfig {
  apiToken: string;
  accountId?: string;
}

export class CloudflareClient {
  private config: CloudflareConfig;
  // Cloudflare: 1200 req/5min = 240/min, minTime=250ms
  private limiter: Bottleneck;

  constructor(config: CloudflareConfig) {
    this.config = config;
    this.limiter = new Bottleneck({ minTime: 250, maxConcurrent: 4 });
  }

  private headers() {
    return {
      'Authorization': `Bearer ${this.config.apiToken}`,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return this.limiter.schedule(async () => {
      const res = await fetch(`${CF_BASE}${path}`, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10) * 1000;
        await sleep(retryAfter);
        // Retry once
        const retry = await fetch(`${CF_BASE}${path}`, {
          method,
          headers: this.headers(),
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30000),
        });
        if (retry.status === 429) {
          throw new AgentError('RATE_LIMIT', 'Cloudflare API rate limit reached.', 'Wait a moment and try again.', 'cloudflare');
        }
        const retryText = await retry.text();
        let retryData: CloudflareResponse<T>;
        try {
          retryData = JSON.parse(retryText) as CloudflareResponse<T>;
        } catch {
          throw new AgentError(
            'CLOUDFLARE_ERROR',
            `Cloudflare API returned non-JSON response (status ${retry.status}).`,
            'Check Cloudflare API status at https://www.cloudflarestatus.com/',
            'cloudflare',
            retryText.substring(0, 200),
          );
        }
        if (!retryData.success) throw translateCloudflareError(retryData.errors ?? []);
        return retryData.result as T;
      }

      const text = await res.text();
      let data: CloudflareResponse<T>;
      try {
        data = JSON.parse(text) as CloudflareResponse<T>;
      } catch {
        throw new AgentError(
          'CLOUDFLARE_ERROR',
          `Cloudflare API returned non-JSON response (status ${res.status}).`,
          'Check Cloudflare API status at https://www.cloudflarestatus.com/',
          'cloudflare',
          text.substring(0, 200),
        );
      }
      if (!data.success) throw translateCloudflareError(data.errors ?? []);
      return data.result as T;
    });
  }

  /** GET a URL through the limiter with one 429 retry (matches the pattern in request()). */
  private async getPage(url: string): Promise<string> {
    return this.limiter.schedule(async () => {
      const res = await fetch(url, { method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(30000) });
      if (res.status !== 429) return res.text();

      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10) * 1000;
      await sleep(retryAfter);
      const retry = await fetch(url, { method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(30000) });
      if (retry.status === 429) {
        throw new AgentError('RATE_LIMIT', 'Cloudflare API rate limit reached.', 'Wait a moment and try again.', 'cloudflare');
      }
      return retry.text();
    });
  }

  async listZones(accountId?: string): Promise<CloudflareZone[]> {
    const all: CloudflareZone[] = [];
    let page = 1;
    const perPage = 100; // Cloudflare API max; reduces API calls for large accounts
    while (true) {
      const accountParam = accountId ? `account.id=${accountId}&` : '';
      const text = await this.getPage(`${CF_BASE}/zones?${accountParam}per_page=${perPage}&page=${page}`);
      let data: CloudflareResponse<CloudflareZone[]> & { result_info?: { total_pages?: number } };
      try {
        data = JSON.parse(text) as CloudflareResponse<CloudflareZone[]> & { result_info?: { total_pages?: number } };
      } catch {
        throw new AgentError('CLOUDFLARE_ERROR', `Cloudflare API returned non-JSON response while listing zones.`, 'Check Cloudflare API status.', 'cloudflare', text.substring(0, 200));
      }
      if (!data.success) throw translateCloudflareError(data.errors ?? []);
      const batch = data.result ?? [];
      all.push(...batch);
      const totalPages = data.result_info?.total_pages ?? 1;
      if (page >= totalPages) break;
      page++;
    }
    return all;
  }

  async getZone(domain: string): Promise<CloudflareZone> {
    const zones = await this.listZones(this.config.accountId);
    const zone = zones.find((z) => z.name.toLowerCase() === domain.toLowerCase());
    if (!zone) {
      throw new AgentError(
        'DOMAIN_NOT_FOUND',
        `Domain '${domain}' was not found in your Cloudflare account. Verify the domain is added to this account and that your API token has Zone Read permission.`,
        'Add the domain to your Cloudflare account or check your API token permissions.',
        'cloudflare',
      );
    }
    return zone;
  }

  async listDNSRecords(zoneId: string): Promise<CloudflareDNSRecord[]> {
    const all: CloudflareDNSRecord[] = [];
    let page = 1;
    const perPage = 100; // Cloudflare API max; reduces API calls for large zones
    while (true) {
      const text = await this.getPage(`${CF_BASE}/zones/${zoneId}/dns_records?per_page=${perPage}&page=${page}`);
      let data: CloudflareResponse<CloudflareDNSRecord[]> & { result_info?: { total_pages?: number } };
      try {
        data = JSON.parse(text) as CloudflareResponse<CloudflareDNSRecord[]> & { result_info?: { total_pages?: number } };
      } catch {
        throw new AgentError('CLOUDFLARE_ERROR', 'Cloudflare API returned non-JSON response while listing DNS records.', 'Check Cloudflare API status.', 'cloudflare', text.substring(0, 200));
      }
      if (!data.success) throw translateCloudflareError(data.errors ?? []);
      const batch = data.result ?? [];
      all.push(...batch);
      const totalPages = data.result_info?.total_pages ?? 1;
      if (page >= totalPages) break;
      page++;
    }
    return all;
  }

  async createDNSRecord(zoneId: string, record: {
    type: string; name: string; content: string; ttl: number; priority?: number;
  }): Promise<CloudflareDNSRecord> {
    return this.request<CloudflareDNSRecord>('POST', `/zones/${zoneId}/dns_records`, {
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl,
      priority: record.priority,
    });
  }

  async updateDNSRecord(zoneId: string, recordId: string, record: {
    type: string; name: string; content: string; ttl: number; priority?: number;
  }): Promise<CloudflareDNSRecord> {
    return this.request<CloudflareDNSRecord>('PUT', `/zones/${zoneId}/dns_records/${recordId}`, {
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl,
      priority: record.priority,
    });
  }

  async deleteDNSRecord(zoneId: string, recordId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
  }

  async listCertificates(zoneId: string): Promise<CloudflareCertificate[]> {
    return this.request<CloudflareCertificate[]>('GET', `/zones/${zoneId}/ssl/certificate_packs`);
  }

  async orderCertificate(zoneId: string, hosts: string[]): Promise<CloudflareCertificate> {
    return this.request<CloudflareCertificate>('POST', `/zones/${zoneId}/ssl/certificate_packs/order`, {
      type: 'advanced',
      hosts,
      validation_method: 'txt',
      validity_days: 365,
      certificate_authority: 'lets_encrypt',
    });
  }

  async getCertificateStatus(zoneId: string, certId: string): Promise<CloudflareCertificate> {
    return this.request<CloudflareCertificate>('GET', `/zones/${zoneId}/ssl/certificate_packs/${certId}`);
  }
}

interface CloudflareResponse<T> {
  success: boolean;
  result?: T;
  errors?: Array<{ code: number; message: string }>;
}

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
  name_servers: string[];
  modified_on: string;
}

export interface CloudflareDNSRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority?: number;
  modified_on: string;
}

export interface CloudflareCertificate {
  id: string;
  hosts: string[];
  status: string;
  expires_on?: string;
  issued_on?: string;
}

function translateCloudflareError(errors: Array<{ code: number; message: string }>): AgentError {
  const first = errors[0];
  if (!first) {
    return new AgentError('CLOUDFLARE_ERROR', 'Cloudflare API error.', 'Check your API token and try again.', 'cloudflare');
  }

  const { code, message } = first;

  if (code === 10000 || message.toLowerCase().includes('authentication')) {
    return new AgentError(
      'AUTH_FAILED',
      'Cloudflare authentication failed. Your API token is invalid or expired.',
      'Check that CLOUDFLARE_API_TOKEN is correct and has the required permissions (Zone:Read, DNS:Edit, SSL and Certificates:Edit).',
      'cloudflare',
      message,
    );
  }

  if (code === 7003 || message.toLowerCase().includes('not authorized')) {
    return new AgentError(
      'PERMISSION_DENIED',
      'Cloudflare domain registration requires an Enterprise account. This domain cannot be registered via API. Use Porkbun or Namecheap instead.',
      'Register this domain with Porkbun or Namecheap, then add it to Cloudflare for DNS management.',
      'cloudflare',
      message,
    );
  }

  if (message.toLowerCase().includes('not found') || code === 1001) {
    return new AgentError(
      'DOMAIN_NOT_FOUND',
      `Domain not found in your Cloudflare account: ${message}. Verify the domain is added to this account and that your API token has Zone Read permission.`,
      'Add the domain to Cloudflare or check API token zone permissions.',
      'cloudflare',
      message,
    );
  }

  return new AgentError(
    'CLOUDFLARE_ERROR',
    `Cloudflare API error [${code}]: ${message}`,
    'Check the Cloudflare API documentation or verify your API token permissions.',
    'cloudflare',
    message,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
