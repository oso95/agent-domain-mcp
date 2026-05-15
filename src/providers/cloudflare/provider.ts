import type {
  Provider, Domain, DNSRecord, AvailabilityResult, Certificate,
  Transfer, Contact, RegisterRequest, DnssecDS, DnssecStatus,
} from '../types.js';
import { Feature } from '../types.js';
import { AgentError } from '../../errors.js';
import { CloudflareClient, type CloudflareZone, type CloudflareDNSRecord, type CloudflareCertificate, type CloudflareDnssec } from './client.js';

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
    // Cloudflare does NOT support registration, pricing, WHOIS contacts, or registrar-level
    // nameserver delegation via API (Enterprise only). The provider IS the DNS host: change
    // nameservers at the original registrar to point at Cloudflare.
    // It does support native DNSSEC for any zone (no Enterprise plan needed).
    const unsupported = [Feature.Registration, Feature.Renewal, Feature.Transfer, Feature.Pricing, Feature.WhoisContact, Feature.NameserverWrite];
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

  async updateNameservers(_domain: string, _nameservers: string[]): Promise<void> {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      'Cloudflare cannot change registrar-level nameservers — it is a DNS host, not a registrar (outside Enterprise plans). Cloudflare hands you nameservers to set at your original registrar.',
      'Update nameservers via the API of your original registrar (Porkbun, Namecheap, GoDaddy, or Webnic), pointing them at the Cloudflare nameservers shown in the Cloudflare dashboard.',
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

  // --- DNSSEC ---------------------------------------------------------------

  async getDnssec(domain: string): Promise<DnssecStatus> {
    const zone = await this.client.getZone(domain);
    const ds = await this.client.getDnssec(zone.id);
    return this.mapDnssec(domain, ds);
  }

  /**
   * Cloudflare manages DNSSEC entirely zone-side: PATCH dnssec status=active makes
   * Cloudflare sign the zone and exposes the DS material the caller must publish at
   * the parent registry.
   *
   * `opts.dsRecords` is not honoured because Cloudflare does not let third-party DS
   * material be injected — the registry-side step happens at the registrar of the
   * domain, outside Cloudflare's API. Callers who pass dsRecords get a clear error
   * so they don't silently miss a step.
   */
  async enableDnssec(domain: string, opts?: { dsRecords?: DnssecDS[] }): Promise<DnssecStatus> {
    if (opts?.dsRecords && opts.dsRecords.length > 0) {
      throw new AgentError(
        'FEATURE_NOT_SUPPORTED',
        'Cloudflare does not accept externally-supplied DS records via API. Cloudflare signs the zone itself and exposes the DS to be published at the registrar.',
        'Call enable_dnssec without dsRecords. Then publish the returned DS at your registrar (e.g. via Porkbun, Namecheap, GoDaddy or Webnic).',
        'cloudflare',
      );
    }
    const zone = await this.client.getZone(domain);
    const ds = await this.client.patchDnssec(zone.id, 'active');
    return this.mapDnssec(domain, ds);
  }

  async disableDnssec(domain: string): Promise<void> {
    const zone = await this.client.getZone(domain);
    await this.client.patchDnssec(zone.id, 'disabled');
  }

  private mapDnssec(domain: string, ds: CloudflareDnssec): DnssecStatus {
    const active = ds.status === 'active' || ds.status === 'pending';
    const hasMaterial = ds.key_tag !== undefined && ds.algorithm !== undefined && ds.digest_type !== undefined && !!ds.digest;
    const out: DnssecStatus = {
      domain,
      enabled: active,
      scope: active ? 'zone' : 'none',
    };
    if (hasMaterial) {
      out.dsRecords = [{
        keyTag: ds.key_tag as number,
        algorithm: parseInt(String(ds.algorithm), 10),
        digestType: parseInt(String(ds.digest_type), 10),
        digest: String(ds.digest),
      }];
    }
    if (ds.flags !== undefined && ds.algorithm !== undefined && ds.public_key) {
      out.dnsKey = {
        flags: ds.flags,
        // Cloudflare doesn't expose protocol explicitly; DNSSEC uses 3 by RFC 4034.
        protocol: 3,
        algorithm: parseInt(String(ds.algorithm), 10),
        publicKey: ds.public_key,
      };
    }
    return out;
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
