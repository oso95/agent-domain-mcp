import type {
  Provider, Domain, DNSRecord, AvailabilityResult, Certificate,
  Transfer, Contact, RegisterRequest,
} from '../types.js';
import { Feature as FeatureEnum } from '../types.js';
import { AgentError } from '../../errors.js';
import { PorkbunClient } from './client.js';

interface PorkbunConfig {
  apiKey: string;
  secretApiKey: string;
}

interface PorkbunDomain {
  domain: string;
  status: string;
  expireDate: string;
  autorenew: string | number;
  securityLock: string | number;
  notLocal: string | number;
  labels: unknown[];
  ns?: string[];
}

interface PorkbunDNSRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: string;
  prio?: string;
}

export class PorkbunProvider implements Provider {
  private client: PorkbunClient;

  constructor(config: PorkbunConfig) {
    this.client = new PorkbunClient(config);
  }

  name(): string {
    return 'porkbun';
  }

  supports(feature: FeatureEnum): boolean {
    const supported = [
      FeatureEnum.Registration,
      FeatureEnum.Renewal,
      FeatureEnum.DnsWrite,
      FeatureEnum.Transfer,
      FeatureEnum.SSL,
      // WhoisContact NOT supported — Porkbun v3 API has no contact management endpoints
      FeatureEnum.Pricing,
    ];
    return supported.includes(feature);
  }

  async checkAvailability(domain: string): Promise<AvailabilityResult> {
    // Get pricing from Porkbun API
    const parts = domain.split('.');
    const tld = parts.slice(1).join('.');

    try {
      const pricing = await this.client.getPricing();
      const tldPricing = pricing[tld];

      return {
        domain,
        available: true, // Availability is checked via RDAP; this enriches with pricing
        premium: false,
        availabilitySource: 'porkbun',
        ...(tldPricing ? {
          price: {
            registration: parseFloat(tldPricing.registration),
            renewal: parseFloat(tldPricing.renewal),
            currency: 'USD',
          },
          priceSource: 'porkbun',
        } : {}),
      };
    } catch {
      return { domain, available: true, premium: false, availabilitySource: 'porkbun' };
    }
  }

  async getPricingTable(): Promise<Record<string, { registration: number; renewal: number; currency: string }>> {
    const raw = await this.client.getPricing();
    const result: Record<string, { registration: number; renewal: number; currency: string }> = {};
    for (const [tld, p] of Object.entries(raw)) {
      result[tld] = {
        registration: parseFloat(p.registration),
        renewal: parseFloat(p.renewal),
        currency: 'USD',
      };
    }
    return result;
  }

  async listDomains(): Promise<Domain[]> {
    const raw = await this.client.listDomains() as PorkbunDomain[];
    return raw.map((d) => this.mapDomain(d));
  }

  async getDomain(domain: string): Promise<Domain> {
    const domains = await this.listDomains();
    const found = domains.find((d) => d.name.toLowerCase() === domain.toLowerCase());
    if (!found) {
      throw new AgentError(
        'DOMAIN_NOT_FOUND',
        `Domain '${domain}' was not found in your Porkbun account.`,
        'Verify the domain is registered in your Porkbun account.',
        'porkbun',
      );
    }
    return found;
  }

  async registerDomain(req: RegisterRequest): Promise<Domain> {
    // Fetch pricing to pass cost as a confirmation guard to domain/create
    const parts = req.domain.split('.');
    const tld = parts.slice(1).join('.');
    const pricing = await this.client.getPricing();
    const tldPricing = pricing[tld];
    if (!tldPricing) {
      throw new AgentError(
        'TLD_NOT_SUPPORTED',
        `Porkbun does not support registration of '.${tld}' domains.`,
        'Check available TLDs at https://porkbun.com/products/domains or try a different TLD.',
        'porkbun',
      );
    }
    // Porkbun domain/create requires `cost` as a dollar-amount confirmation guard
    // (e.g. 12.99, not 1299). The pricing API returns dollar strings directly.
    const costDollars = parseFloat(tldPricing.registration);

    // Porkbun uses account-level contact info; req.contact is not forwarded
    await this.client.registerDomain({
      domain: req.domain,
      years: req.years,
      autoRenew: req.autoRenew,
      privacyProtection: req.privacyProtection,
      costDollars,
    });
    return {
      name: req.domain,
      provider: 'porkbun',
      status: 'pending',
      expiresAt: new Date(Date.now() + req.years * 365 * 24 * 60 * 60 * 1000).toISOString(),
      autoRenew: req.autoRenew,
      locked: false,
      nameservers: [],
    };
  }

  async renewDomain(domain: string, years: number): Promise<void> {
    await this.client.renewDomain(domain, years);
  }

  async listDNSRecords(domain: string): Promise<DNSRecord[]> {
    const raw = await this.client.listDNSRecords(domain) as PorkbunDNSRecord[];
    return raw.map((r) => this.mapDNSRecord(r));
  }

  async createDNSRecord(domain: string, record: DNSRecord): Promise<DNSRecord> {
    const result = await this.client.createDNSRecord(domain, record) as { id: string } & DNSRecord;
    return { ...record, id: result.id };
  }

  async updateDNSRecord(domain: string, record: DNSRecord): Promise<DNSRecord> {
    if (!record.id) {
      throw new AgentError(
        'MISSING_RECORD_ID',
        'DNS record update requires a record ID.',
        'Fetch the record list first using list_dns_records to get the record ID.',
        'porkbun',
      );
    }
    await this.client.updateDNSRecord(domain, { ...record, id: record.id });
    return record;
  }

  async deleteDNSRecord(domain: string, recordId: string): Promise<void> {
    await this.client.deleteDNSRecord(domain, recordId);
  }

  async listCertificates(domain: string): Promise<Certificate[]> {
    const raw = await this.client.listCertificates(domain) as Array<{ id: string; domain: string; status: string; certificate?: string }>;
    return raw.map((c) => ({
      id: c.id,
      domain: c.domain,
      status: c.status as Certificate['status'],
      ...(c.certificate ? { certificateChain: c.certificate } : {}),
    }));
  }

  async createCertificate(domain: string): Promise<Certificate> {
    const raw = await this.client.createCertificate(domain) as { id: string; domain: string; status: string; certificate?: string; privatekey?: string };
    return {
      id: raw.id,
      domain: raw.domain,
      status: raw.status as Certificate['status'],
      ...(raw.certificate ? { certificateChain: raw.certificate } : {}),
      ...(raw.privatekey ? { privateKey: raw.privatekey } : {}),
    };
  }

  async getCertificateStatus(certId: string): Promise<Certificate> {
    // Porkbun doesn't have a separate cert status endpoint; parse domain from ID
    const domain = certId.replace('porkbun-ssl-', '');
    const certs = await this.listCertificates(domain);
    const cert = certs.find((c) => c.id === certId);
    if (!cert) {
      throw new AgentError(
        'CERT_NOT_FOUND',
        `Certificate '${certId}' not found for domain '${domain}'.`,
        'Use list_certificates to get valid certificate IDs.',
        'porkbun',
      );
    }
    return cert;
  }

  async initiateTransfer(domain: string, authCode: string): Promise<Transfer> {
    await this.client.initiateTransfer(domain, authCode);
    return {
      domain,
      status: 'pending',
      initiatedAt: new Date().toISOString(),
    };
  }

  async getTransferStatus(domain: string): Promise<Transfer> {
    // Porkbun v3 does not expose a transfer status endpoint
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      `Porkbun does not provide a transfer status API for '${domain}'.`,
      'Check transfer status by logging into your Porkbun account at https://porkbun.com or by waiting for the confirmation email.',
      'porkbun',
    );
  }

  async getWhoisContact(domain: string): Promise<Contact> {
    return this.client.getWhoisContact(domain);
  }

  async updateWhoisContact(domain: string, contact: Contact): Promise<void> {
    return this.client.updateWhoisContact(domain, {
      first_name: contact.firstName,
      last_name: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      address1: contact.address1,
      city: contact.city,
      state: contact.state,
      zip: contact.postalCode,
      country: contact.country,
    });
  }

  private mapDomain(d: PorkbunDomain): Domain {
    return {
      name: d.domain,
      provider: 'porkbun',
      status: this.mapStatus(d.status),
      expiresAt: new Date(d.expireDate.replace(' ', 'T') + 'Z').toISOString(),
      autoRenew: d.autorenew === '1' || d.autorenew === 1,
      locked: d.securityLock === '1' || d.securityLock === 1,
      nameservers: d.ns ?? [],
    };
  }

  private mapStatus(status: string): Domain['status'] {
    switch (status?.toUpperCase()) {
      case 'ACTIVE': return 'active';
      case 'EXPIRED': return 'expired';
      case 'LOCKED': return 'locked';
      default: return 'pending';
    }
  }

  private mapDNSRecord(r: PorkbunDNSRecord): DNSRecord {
    return {
      id: r.id,
      type: r.type as DNSRecord['type'],
      name: r.name || '@',
      content: r.content,
      ttl: parseInt(r.ttl, 10) || 300,
      priority: r.prio ? parseInt(r.prio, 10) : undefined,
    };
  }

}
