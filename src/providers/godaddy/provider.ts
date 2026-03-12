import type {
  Provider, Domain, DNSRecord, AvailabilityResult, Certificate,
  Transfer, Contact, RegisterRequest,
} from '../types.js';
import { Feature } from '../types.js';
import { AgentError } from '../../errors.js';
import { GoDaddyClient, type GoDaddyDomain, type GoDaddyDNSRecord, type GoDaddyContact } from './client.js';

interface GoDaddyConfig {
  apiKey: string;
  apiSecret: string;
  sandbox?: boolean;
}

export class GoDaddyProvider implements Provider {
  private client: GoDaddyClient;

  constructor(config: GoDaddyConfig) {
    this.client = new GoDaddyClient(config);
  }

  name(): string {
    return 'godaddy';
  }

  supports(feature: Feature): boolean {
    // GoDaddy SSL requires purchasing a certificate product via the GoDaddy dashboard;
    // the API does not support provisioning SSL certificates directly.
    const unsupported: Feature[] = [Feature.SSL];
    return !unsupported.includes(feature);
  }

  async checkAvailability(domain: string): Promise<AvailabilityResult> {
    const result = await this.client.checkAvailability(domain);
    return {
      domain,
      available: result.available,
      premium: result.premium ?? false,
      availabilitySource: 'godaddy',
      ...(result.price ? {
        // GoDaddy v1 /domains/available returns price in micro-units (millionths of currency)
        price: { registration: result.price / 1000000, renewal: result.price / 1000000, currency: result.currency ?? 'USD' },
        priceSource: 'godaddy',
      } : {}),
    };
  }

  async listDomains(): Promise<Domain[]> {
    const domains = await this.client.listDomains();
    return domains.map((d) => this.mapDomain(d));
  }

  async getDomain(domain: string): Promise<Domain> {
    const d = await this.client.getDomain(domain);
    return this.mapDomain(d);
  }

  async registerDomain(req: RegisterRequest): Promise<Domain> {
    await this.client.registerDomain({
      domain: req.domain,
      years: req.years,
      contact: {
        firstName: req.contact.firstName,
        lastName: req.contact.lastName,
        email: req.contact.email,
        phone: req.contact.phone,
        address1: req.contact.address1,
        city: req.contact.city,
        state: req.contact.state,
        postalCode: req.contact.postalCode,
        country: req.contact.country,
      },
      autoRenew: req.autoRenew,
      privacy: req.privacyProtection,
    });
    return {
      name: req.domain,
      provider: 'godaddy',
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
    const records = await this.client.listDNSRecords(domain);
    return records.map((r) => this.mapDNSRecord(r));
  }

  async createDNSRecord(domain: string, record: DNSRecord): Promise<DNSRecord> {
    await this.client.createDNSRecord(domain, {
      type: record.type,
      name: record.name,
      data: record.content,
      ttl: record.ttl,
      priority: record.priority,
    });
    return { ...record, id: `${record.type}-${record.name}` };
  }

  async updateDNSRecord(domain: string, record: DNSRecord): Promise<DNSRecord> {
    // GoDaddy v1 PUT replaces the entire type+name record set.
    // For multi-value records (round-robin A), all existing sibling records
    // will be replaced by this single updated record — a known API limitation.
    await this.client.updateDNSRecord(domain, {
      type: record.type,
      name: record.name,
      data: record.content,
      ttl: record.ttl,
      priority: record.priority,
    });
    return record;
  }

  async deleteDNSRecord(domain: string, recordId: string): Promise<void> {
    // GoDaddy v1 DELETE removes all records for a type+name set (API limitation).
    // The recordId format is "TYPE-name".
    const dashIdx = recordId.indexOf('-');
    if (dashIdx === -1) {
      throw new AgentError(
        'INVALID_RECORD_ID',
        `Invalid record ID format: '${recordId}'. Expected 'TYPE-name'.`,
        'Use list_dns_records to get valid record IDs.',
        'godaddy',
      );
    }
    const type = recordId.substring(0, dashIdx);
    const name = recordId.substring(dashIdx + 1);
    await this.client.deleteDNSRecord(domain, type, name);
  }

  async listCertificates(_domain: string): Promise<Certificate[]> {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      'GoDaddy does not expose an SSL certificate management API.',
      'Manage SSL certificates via the GoDaddy dashboard.',
      'godaddy',
    );
  }

  async createCertificate(_domain: string): Promise<Certificate> {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      'GoDaddy does not expose an SSL certificate management API.',
      'Manage SSL certificates via the GoDaddy dashboard.',
      'godaddy',
    );
  }

  async getCertificateStatus(_certId: string): Promise<Certificate> {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      'GoDaddy does not expose an SSL certificate management API.',
      'Manage SSL certificates via the GoDaddy dashboard.',
      'godaddy',
    );
  }

  async initiateTransfer(domain: string, authCode: string): Promise<Transfer> {
    // GoDaddy requires agreedBy to be the registrant's email address for legal consent.
    // Fetch domain info to get the contact email; fail fast if unavailable.
    const domainInfo = await this.client.getDomain(domain);
    const agreedBy = domainInfo.contactRegistrant?.email;
    if (!agreedBy) {
      throw new AgentError(
        'MISSING_CONTACT_EMAIL',
        `Cannot initiate transfer for '${domain}': no registrant email found in GoDaddy account.`,
        'Ensure the domain has a valid registrant email by checking it in the GoDaddy dashboard.',
        'godaddy',
      );
    }
    await this.client.initiateTransfer(domain, authCode, agreedBy);
    return { domain, status: 'pending', initiatedAt: new Date().toISOString() };
  }

  async getTransferStatus(domain: string): Promise<Transfer> {
    const d = await this.client.getDomain(domain);
    const status: Transfer['status'] =
      d.status === 'TRANSFER_IN_COMPLETED' ? 'completed' :
      d.status === 'TRANSFER_IN_PENDING_CUSTOMER' ? 'pending' :
      d.status === 'TRANSFER_IN_REJECTED' ? 'rejected' :
      d.status === 'TRANSFER_IN_CANCELLED' ? 'cancelled' :
      'pending';
    return { domain, status };
  }

  async getWhoisContact(domain: string): Promise<Contact> {
    const raw = await this.client.getWhoisContact(domain);
    return this.mapContact(raw);
  }

  async updateWhoisContact(domain: string, contact: Contact): Promise<void> {
    await this.client.updateWhoisContact(domain, {
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      addressMailing: {
        address1: contact.address1,
        city: contact.city,
        state: contact.state,
        postalCode: contact.postalCode,
        country: contact.country,
      },
    });
  }

  private mapDomain(d: GoDaddyDomain): Domain {
    return {
      name: d.domain,
      provider: 'godaddy',
      status: d.status === 'ACTIVE' ? 'active' : d.status === 'EXPIRED' ? 'expired' : d.status === 'LOCKED' ? 'locked' : 'pending',
      expiresAt: d.expires ? new Date(d.expires).toISOString() : '',
      autoRenew: d.renewAuto ?? false,
      locked: d.locked ?? false,
      nameservers: d.nameServers ?? [],
    };
  }

  private mapDNSRecord(r: GoDaddyDNSRecord): DNSRecord {
    return {
      id: `${r.type}-${r.name}`,
      type: r.type as DNSRecord['type'],
      name: r.name,
      content: r.data,
      ttl: r.ttl,
      priority: r.priority,
    };
  }

  private mapContact(raw: GoDaddyContact): Contact {
    return {
      firstName: raw.firstName ?? '',
      lastName: raw.lastName ?? '',
      email: raw.email ?? '',
      phone: raw.phone ?? '',
      address1: raw.addressMailing?.address1 ?? '',
      city: raw.addressMailing?.city ?? '',
      state: raw.addressMailing?.state ?? '',
      postalCode: raw.addressMailing?.postalCode ?? '',
      country: raw.addressMailing?.country ?? '',
    };
  }
}
