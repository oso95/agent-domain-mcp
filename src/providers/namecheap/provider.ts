import type {
  Provider, Domain, DNSRecord, AvailabilityResult, Certificate,
  Transfer, Contact, RegisterRequest,
} from '../types.js';
import { Feature } from '../types.js';
import { AgentError } from '../../errors.js';
import { NamecheapClient, type NamecheapDomainItem, type NamecheapHostRecord } from './client.js';

interface NamecheapConfig {
  apiKey: string;
  apiUser: string;
  clientIp?: string;
  sandbox?: boolean;
}

export class NamecheapProvider implements Provider {
  private client: NamecheapClient;

  constructor(config: NamecheapConfig) {
    this.client = new NamecheapClient(config);
  }

  name(): string {
    return 'namecheap';
  }

  supports(feature: Feature): boolean {
    // All features supported; SSL listing/status works via API but provisioning requires
    // purchasing a cert product via the Namecheap dashboard first.
    return true;
  }

  async checkAvailability(domain: string): Promise<AvailabilityResult> {
    interface Response {
      DomainCheckResult?: {
        '@_Domain': string;
        '@_Available': string;
        '@_IsPremiumName': string;
        '@_PremiumRegistrationPrice'?: string;
        '@_PremiumRenewalPrice'?: string;
      } | Array<{
        '@_Domain': string;
        '@_Available': string;
        '@_IsPremiumName': string;
        '@_PremiumRegistrationPrice'?: string;
        '@_PremiumRenewalPrice'?: string;
      }>;
    }

    const data = await this.client.call<Response>('namecheap.domains.check', {
      DomainList: domain,
    });

    const raw = data.DomainCheckResult;
    const result = Array.isArray(raw) ? raw[0] : raw;

    if (!result) {
      return { domain, available: false, premium: false, availabilitySource: 'namecheap' };
    }

    const available = result['@_Available'] === 'true';
    const premium = result['@_IsPremiumName'] === 'true';
    const regPrice = result['@_PremiumRegistrationPrice'];
    const renewPrice = result['@_PremiumRenewalPrice'] ?? regPrice; // fallback to reg price if renewal not provided

    return {
      domain,
      available,
      premium,
      availabilitySource: 'namecheap',
      ...(regPrice ? {
        price: { registration: parseFloat(regPrice), renewal: parseFloat(renewPrice!), currency: 'USD' },
        priceSource: 'namecheap',
      } : {}),
    };
  }

  async listDomains(): Promise<Domain[]> {
    const domains = await this.client.listDomains();
    return domains.map((d) => this.mapDomain(d));
  }

  async getDomain(domain: string): Promise<Domain> {
    const info = await this.client.getDomainInfo(domain);
    const ns = info.DnsDetails?.Nameserver;
    const nameservers = Array.isArray(ns) ? ns : ns ? [ns] : [];

    const isLocked = info['@_IsLocked'] === 'true';
    return {
      name: info['@_DomainName'],
      provider: 'namecheap',
      status: info['@_Status']?.toLowerCase() === 'ok' ? (isLocked ? 'locked' : 'active') : 'pending',
      expiresAt: info.DomainDetails?.ExpiredDate ? new Date(info.DomainDetails.ExpiredDate).toISOString() : '',
      autoRenew: info.DomainDetails?.AutoRenew === 'true',
      locked: isLocked,
      nameservers,
    };
  }

  async registerDomain(req: RegisterRequest): Promise<Domain> {
    await this.client.registerDomain({
      domain: req.domain,
      years: req.years,
      contact: req.contact,
      autoRenew: req.autoRenew,
      privacyProtection: req.privacyProtection,
    });
    return {
      name: req.domain,
      provider: 'namecheap',
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

  async getPricingTable(): Promise<Record<string, { registration: number; renewal: number; currency: string }>> {
    return this.client.getPricingTable();
  }

  private splitDomain(domain: string): { sld: string; tld: string } {
    const parts = domain.split('.');
    return { sld: parts[0], tld: parts.slice(1).join('.') };
  }

  async listDNSRecords(domain: string): Promise<DNSRecord[]> {
    const { sld, tld } = this.splitDomain(domain);
    const records = await this.client.getDNSRecords(sld, tld);
    return records.map((r) => this.mapDNSRecord(r));
  }

  async createDNSRecord(domain: string, record: DNSRecord): Promise<DNSRecord> {
    const { sld, tld } = this.splitDomain(domain);

    // Read-modify-write: fetch all, add new, write all
    const existing = await this.client.getDNSRecords(sld, tld);
    const newRecord: NamecheapHostRecord = {
      '@_Name': record.name === '@' ? '@' : record.name,
      '@_Type': record.type,
      '@_Address': record.content,
      '@_TTL': record.ttl,
      '@_MXPref': record.priority,
    };

    await this.client.setDNSRecords(sld, tld, [...existing, newRecord]);

    // Re-fetch to get the HostId assigned by Namecheap
    const updated = await this.client.getDNSRecords(sld, tld);
    const created = updated.find(
      (r) => r['@_Type'] === record.type && r['@_Name'] === newRecord['@_Name'] && r['@_Address'] === record.content,
    );
    return created ? this.mapDNSRecord(created) : { ...record, id: `${record.type}-${record.name}-0` };
  }

  async updateDNSRecord(domain: string, record: DNSRecord): Promise<DNSRecord> {
    const { sld, tld } = this.splitDomain(domain);

    // Read-modify-write: find by ID (type-name-hostId pattern) and replace
    const existing = await this.client.getDNSRecords(sld, tld);

    // Parse hostId from record.id (format: "TYPE-name-hostId")
    let idx = -1;
    if (record.id) {
      const idParts = record.id.split('-');
      const hostId = idParts[idParts.length - 1];
      if (hostId && hostId !== '0') {
        // Match by hostId when available (handles multiple records of same type+name)
        idx = existing.findIndex((r) => String(r['@_HostId']) === hostId);
      }
    }

    // Fall back to type+name match if hostId not found
    if (idx === -1) {
      idx = existing.findIndex(
        (r) => r['@_Type'] === record.type && (r['@_Name'] === record.name || (record.name === '@' && r['@_Name'] === '')),
      );
    }

    if (idx === -1) {
      throw new AgentError(
        'RECORD_NOT_FOUND',
        `DNS record of type '${record.type}' with name '${record.name}' not found in domain '${domain}'.`,
        'Use list_dns_records to verify the record exists.',
        'namecheap',
      );
    }

    existing[idx] = {
      '@_Name': record.name === '@' ? '@' : record.name,
      '@_Type': record.type,
      '@_Address': record.content,
      '@_TTL': record.ttl,
      '@_MXPref': record.priority,
    };

    await this.client.setDNSRecords(sld, tld, existing);

    // Re-fetch to get the HostId reassigned by Namecheap (setHosts always reassigns IDs)
    const updated = await this.client.getDNSRecords(sld, tld);
    const newRecord = updated.find(
      (r) => r['@_Type'] === record.type &&
        r['@_Name'] === (record.name === '@' ? '@' : record.name) &&
        r['@_Address'] === record.content,
    );
    return newRecord ? this.mapDNSRecord(newRecord) : record;
  }

  async deleteDNSRecord(domain: string, recordId: string): Promise<void> {
    const { sld, tld } = this.splitDomain(domain);

    // Read-modify-write: filter out the specific record
    const existing = await this.client.getDNSRecords(sld, tld);

    // recordId format: "TYPE-name-hostId" — extract hostId (last segment)
    // and use HostId for exact matching to avoid deleting sibling records
    const parts = recordId.split('-');
    const hostId = parts[parts.length - 1];
    const recType = parts[0];
    const recName = parts.slice(1, -1).join('-');

    let filtered: typeof existing;
    if (hostId && hostId !== '0') {
      // Prefer HostId match — safe when multiple records share type+name
      filtered = existing.filter((r) => String(r['@_HostId']) !== hostId);
    } else {
      // Fallback: match by type+name (may delete multiple if Namecheap didn't return HostIds)
      filtered = existing.filter(
        (r) => !(r['@_Type'] === recType && r['@_Name'] === recName),
      );
    }

    if (filtered.length === existing.length) {
      throw new AgentError(
        'RECORD_NOT_FOUND',
        `DNS record with ID '${recordId}' not found in domain '${domain}'.`,
        'Use list_dns_records to verify the record exists and get its ID.',
        'namecheap',
      );
    }

    await this.client.setDNSRecords(sld, tld, filtered);
  }

  async listCertificates(domain: string): Promise<Certificate[]> {
    // Namecheap SSL certs are account-level; filter by hostname matching the domain
    const certs = await this.client.listSSLCerts() as Array<{
      '@_CertificateID': string;
      '@_HostName': string;
      '@_Status': string;
      '@_ExpireDate'?: string;
    }>;

    return certs
      .filter((c) => c['@_HostName'] === domain || c['@_HostName']?.endsWith('.' + domain))
      .map((c) => ({
        id: String(c['@_CertificateID']),
        domain: c['@_HostName'],
        status: this.mapCertStatus(c['@_Status']),
        expiresAt: c['@_ExpireDate'],
      }));
  }

  async createCertificate(_domain: string): Promise<Certificate> {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      'SSL certificate provisioning via Namecheap API requires purchasing a certificate product first.',
      'Purchase an SSL certificate from the Namecheap dashboard, then manage it via the API.',
      'namecheap',
    );
  }

  async getCertificateStatus(certId: string): Promise<Certificate> {
    interface Response {
      SSLGetInfoResult?: {
        '@_CertificateID': string;
        '@_Status': string;
        '@_HostName': string;
        '@_ExpireDate'?: string;
      };
    }
    const data = await this.client.call<Response>('namecheap.ssl.getInfo', { CertificateID: certId });
    const info = data.SSLGetInfoResult;
    if (!info) throw new AgentError('CERT_NOT_FOUND', `Certificate '${certId}' not found.`, 'Verify the certificate ID.', 'namecheap');

    return {
      id: String(info['@_CertificateID']),
      domain: info['@_HostName'],
      status: this.mapCertStatus(info['@_Status']),
      expiresAt: info['@_ExpireDate'],
    };
  }

  async initiateTransfer(domain: string, authCode: string): Promise<Transfer> {
    const [sld, ...tldParts] = domain.split('.');
    await this.client.call('namecheap.domains.transfer.create', {
      DomainName: domain,
      SLD: sld,
      TLD: tldParts.join('.'),
      EPPCode: authCode,
      Years: '1',
    });
    return { domain, status: 'pending', initiatedAt: new Date().toISOString() };
  }

  async getTransferStatus(domain: string): Promise<Transfer> {
    interface Response {
      TransferGetStatusResult?: { '@_Status': string };
    }
    const data = await this.client.call<Response>('namecheap.domains.transfer.getStatus', { DomainName: domain });
    const status = data.TransferGetStatusResult?.['@_Status'] ?? 'pending';

    return {
      domain,
      status: this.mapTransferStatus(status),
    };
  }

  async getWhoisContact(domain: string): Promise<Contact> {
    const raw = await this.client.getWhoisContact(domain);
    return {
      firstName: raw.FirstName ?? '',
      lastName: raw.LastName ?? '',
      email: raw.EmailAddress ?? '',
      phone: raw.Phone ?? '',
      address1: raw.Address1 ?? '',
      city: raw.City ?? '',
      state: raw.StateProvince ?? '',
      postalCode: raw.PostalCode ?? '',
      country: raw.Country ?? '',
    };
  }

  async updateWhoisContact(domain: string, contact: Contact): Promise<void> {
    await this.client.updateWhoisContact(domain, {
      FirstName: contact.firstName,
      LastName: contact.lastName,
      EmailAddress: contact.email,
      Phone: contact.phone,
      Address1: contact.address1,
      City: contact.city,
      StateProvince: contact.state,
      PostalCode: contact.postalCode,
      Country: contact.country,
    });
  }

  private mapDomain(d: NamecheapDomainItem): Domain {
    return {
      name: d['@_Name'],
      provider: 'namecheap',
      status: d['@_IsExpired'] === 'true' ? 'expired' : d['@_IsLocked'] === 'true' ? 'locked' : 'active',
      expiresAt: d['@_Expires'] ? new Date(d['@_Expires']).toISOString() : '',
      autoRenew: d['@_AutoRenew'] === 'true',
      locked: d['@_IsLocked'] === 'true',
      nameservers: [],
    };
  }

  private mapDNSRecord(r: NamecheapHostRecord): DNSRecord {
    return {
      id: `${r['@_Type']}-${r['@_Name']}-${r['@_HostId'] ?? '0'}`,
      type: r['@_Type'] as DNSRecord['type'],
      name: r['@_Name'] || '@',
      content: r['@_Address'],
      ttl: r['@_TTL'] ?? 300,
      priority: r['@_MXPref'],
    };
  }

  private mapCertStatus(status: string): Certificate['status'] {
    switch (status?.toLowerCase()) {
      case 'active': case 'issued': return 'active';
      case 'expired': return 'expired';
      case 'failed': case 'cancelled': return 'failed';
      default: return 'pending';
    }
  }

  private mapTransferStatus(status: string): Transfer['status'] {
    switch (status?.toLowerCase()) {
      case 'completed': return 'completed';
      case 'approved': return 'approved';
      case 'rejected': case 'refused': return 'rejected';
      case 'cancelled': return 'cancelled';
      default: return 'pending';
    }
  }
}
