import type {
  Provider, Domain, DNSRecord, AvailabilityResult, Certificate,
  Transfer, Contact, RegisterRequest,
} from '../types.js';
import { Feature } from '../types.js';
import { AgentError } from '../../errors.js';
import { CloudflareClient, type CloudflareZone, type CloudflareDNSRecord, type CloudflareCertificate } from './client.js';

interface CloudflareConfig {
  apiToken: string;
  accountId?: string;
}

export class CloudflareProvider implements Provider {
  private client: CloudflareClient;

  constructor(config: CloudflareConfig) {
    this.client = new CloudflareClient(config);
  }

  name(): string {
    return 'cloudflare';
  }

  supports(feature: Feature): boolean {
    // Cloudflare does NOT support registration, pricing, or WHOIS contacts via API (Enterprise only)
    const unsupported = [Feature.Registration, Feature.Renewal, Feature.Transfer, Feature.Pricing, Feature.WhoisContact];
    return !unsupported.includes(feature);
  }

  async checkAvailability(domain: string): Promise<AvailabilityResult> {
    // Cloudflare does not offer domain availability or pricing queries via API.
    // This method is unreachable in normal flow because Feature.Pricing is unsupported,
    // but is implemented to satisfy the Provider interface.
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      `Cloudflare does not support domain availability checks. Use check_availability without specifying a provider.`,
      'Omit the provider parameter to use RDAP-based availability checking instead.',
      'cloudflare',
    );
  }

  async listDomains(): Promise<Domain[]> {
    const zones = await this.client.listZones();
    return zones.map((z) => this.mapZone(z));
  }

  async getDomain(domain: string): Promise<Domain> {
    const zone = await this.client.getZone(domain);
    return this.mapZone(zone);
  }

  async registerDomain(_req: RegisterRequest): Promise<Domain> {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      'Domain registration is not available via API for Cloudflare accounts on non-Enterprise plans.',
      'To register this domain, use Porkbun or Namecheap instead, then point nameservers to Cloudflare for DNS management.',
      'cloudflare',
    );
  }

  async renewDomain(_domain: string, _years: number): Promise<void> {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      'Domain renewal is not available via API for Cloudflare accounts on non-Enterprise plans.',
      'Renew this domain with your original registrar (e.g., Porkbun or Namecheap).',
      'cloudflare',
    );
  }

  async listDNSRecords(domain: string): Promise<DNSRecord[]> {
    const zone = await this.client.getZone(domain);
    const records = await this.client.listDNSRecords(zone.id);
    return records.map((r) => this.mapDNSRecord(r));
  }

  async createDNSRecord(domain: string, record: DNSRecord): Promise<DNSRecord> {
    const zone = await this.client.getZone(domain);
    const created = await this.client.createDNSRecord(zone.id, record);
    return this.mapDNSRecord(created);
  }

  async updateDNSRecord(domain: string, record: DNSRecord): Promise<DNSRecord> {
    if (!record.id) {
      throw new AgentError(
        'MISSING_RECORD_ID',
        'DNS record update requires a record ID.',
        'Fetch the record list first using list_dns_records to get the record ID.',
        'cloudflare',
      );
    }
    const zone = await this.client.getZone(domain);
    const updated = await this.client.updateDNSRecord(zone.id, record.id, record);
    return this.mapDNSRecord(updated);
  }

  async deleteDNSRecord(domain: string, recordId: string): Promise<void> {
    const zone = await this.client.getZone(domain);
    await this.client.deleteDNSRecord(zone.id, recordId);
  }

  async listCertificates(domain: string): Promise<Certificate[]> {
    const zone = await this.client.getZone(domain);
    const certs = await this.client.listCertificates(zone.id);
    return certs.map((c) => this.mapCertificate(c, domain, zone.id));
  }

  async createCertificate(domain: string): Promise<Certificate> {
    const zone = await this.client.getZone(domain);
    const cert = await this.client.orderCertificate(zone.id, [domain, `*.${domain}`]);
    return this.mapCertificate(cert, domain, zone.id);
  }

  async getCertificateStatus(certId: string): Promise<Certificate> {
    // certId format: "zoneId:certId" — split on first colon only
    const sep = certId.indexOf(':');
    const zoneId = sep !== -1 ? certId.substring(0, sep) : '';
    const actualCertId = sep !== -1 ? certId.substring(sep + 1) : '';
    if (!zoneId || !actualCertId) {
      throw new AgentError(
        'INVALID_CERT_ID',
        `Invalid certificate ID format: '${certId}'. Expected format: 'zoneId:certId'.`,
        'Use list_certificates to get valid certificate IDs.',
        'cloudflare',
      );
    }
    const cert = await this.client.getCertificateStatus(zoneId, actualCertId);
    return this.mapCertificate(cert, '', zoneId);
  }

  async initiateTransfer(_domain: string, _authCode: string): Promise<Transfer> {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      'Domain transfer to Cloudflare is not available via API for non-Enterprise accounts.',
      'Transfer the domain to Porkbun or Namecheap, then point nameservers to Cloudflare.',
      'cloudflare',
    );
  }

  async getTransferStatus(_domain: string): Promise<Transfer> {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      'Transfer status is not available in Cloudflare for non-Enterprise accounts.',
      'Check transfer status with your original registrar.',
      'cloudflare',
    );
  }

  async getWhoisContact(_domain: string): Promise<Contact> {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      'WHOIS contact management is not available via the Cloudflare API for non-Enterprise accounts.',
      'Manage WHOIS contacts through the Cloudflare dashboard or with your original registrar.',
      'cloudflare',
    );
  }

  async updateWhoisContact(_domain: string, _contact: Contact): Promise<void> {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      'WHOIS contact management is not available via the Cloudflare API for non-Enterprise accounts.',
      'Manage WHOIS contacts through the Cloudflare dashboard or with your original registrar.',
      'cloudflare',
    );
  }

  private mapZone(z: CloudflareZone): Domain {
    return {
      name: z.name,
      provider: 'cloudflare',
      status: z.status === 'active' ? 'active' : 'pending',
      expiresAt: '',
      autoRenew: false,
      locked: false,
      nameservers: z.name_servers ?? [],
    };
  }

  private mapDNSRecord(r: CloudflareDNSRecord): DNSRecord {
    return {
      id: r.id,
      type: r.type as DNSRecord['type'],
      name: r.name,
      content: r.content,
      ttl: r.ttl,
      priority: r.priority,
    };
  }

  private mapCertificate(c: CloudflareCertificate, domain: string, zoneId?: string): Certificate {
    return {
      id: zoneId ? `${zoneId}:${c.id}` : c.id,
      domain: c.hosts?.[0] ?? domain,
      status: this.mapCertStatus(c.status),
      expiresAt: c.expires_on,
      issuedAt: c.issued_on,
    };
  }

  private mapCertStatus(status: string): Certificate['status'] {
    switch (status?.toLowerCase()) {
      case 'active': return 'active';
      case 'expired': return 'expired';
      case 'failed': case 'error': return 'failed';
      default: return 'pending';
    }
  }
}
