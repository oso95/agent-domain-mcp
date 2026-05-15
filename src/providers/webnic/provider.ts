import type {
  Provider, Domain, DNSRecord, AvailabilityResult, Certificate,
  Transfer, Contact, RegisterRequest, DnssecDS, DnssecStatus,
} from '../types.js';
import { Feature as FeatureEnum } from '../types.js';
import { AgentError } from '../../errors.js';
import {
  WebnicClient,
  type WebnicConfig,
  type WebnicDomainInfo,
  type WebnicRecord,
  type WebnicTransferStatus,
  type WebnicDsData,
  type WebnicZoneDnssecDnskey,
  type WebnicSSLOrderSummary,
  type WebnicSSLOrderStatus,
  type WebnicSSLCertStatus,
} from './client.js';

const DEFAULT_NAMESERVERS = ['ns1.web.cc', 'ns2.web.cc'];
// Webnic's documented endpoint /dns/v2/zone/record-types lists only
// A/AAAA/CNAME/MX/SRV/TXT, but the save/list/delete endpoints accept a much
// wider catalog in practice (verified live on both a basic and a Premium DNS
// zone, 2026-05). The Premium subscription does NOT change the accepted type
// list — basic and Premium zones share the same backend.
//
// Exceptions:
//   - NS: explicitly rejected ("NS records are not supported for this action") —
//     nameserver delegation is a registrar-level operation (update_nameservers).
//   - DNSKEY: rejected ("DNSSEC records are not allowed") — DNSSEC keys are
//     managed via the dedicated /dns/v2/zone/{zone}/dnssec endpoints.
//   - ANAME, HINFO, OPENPGPKEY: not implemented by WebNIC's zone backend.
const SUPPORTED_DNS_TYPES = new Set([
  // Documented basics
  'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV',
  // Security policy (CAA verified live on both basic and Premium zones)
  'CAA',
  // Apex CNAME alternative
  'ALIAS',
  // Modern service binding (RFC 9460)
  'HTTPS', 'SVCB',
  // DANE / DNSSEC delegation
  'TLSA', 'SMIMEA', 'DS', 'CDS', 'CDNSKEY',
  // Misc
  'PTR', 'SSHFP', 'NAPTR', 'SOA', 'CERT', 'LOC', 'URI',
]);

export class WebnicProvider implements Provider {
  private readonly client: WebnicClient;
  private readonly defaultContactId?: string;
  private readonly defaultRegistrantUserId?: string;
  private readonly defaultNameservers: string[];

  constructor(config: WebnicConfig) {
    this.client = new WebnicClient(config);
    this.defaultContactId = config.defaultContactId;
    this.defaultRegistrantUserId = config.defaultRegistrantUserId;
    this.defaultNameservers = config.defaultNameservers && config.defaultNameservers.length >= 2
      ? config.defaultNameservers
      : DEFAULT_NAMESERVERS;
  }

  name(): string {
    return 'webnic';
  }

  supports(feature: FeatureEnum): boolean {
    switch (feature) {
      case FeatureEnum.Registration:
      case FeatureEnum.Renewal:
      case FeatureEnum.DnsWrite:
      case FeatureEnum.NameserverWrite:
      case FeatureEnum.Transfer:
      case FeatureEnum.WhoisContact:
      case FeatureEnum.Pricing:
      case FeatureEnum.Dnssec:
      case FeatureEnum.SSL:
        return true;
      default:
        return false;
    }
  }

  async checkAvailability(domain: string): Promise<AvailabilityResult> {
    const result = await this.client.queryDomain(domain);

    const out: AvailabilityResult = {
      domain,
      available: result.available,
      premium: result.premium,
      availabilitySource: 'webnic',
    };

    if (result.available && result.premium && result.premiumInfo) {
      out.price = {
        registration: result.premiumInfo.registerPrice,
        renewal: result.premiumInfo.renewPrice,
        currency: result.premiumInfo.currency,
      };
      out.priceSource = 'webnic';
    } else if (result.available) {
      const tld = domain.split('.').slice(1).join('.');
      try {
        const items = await this.client.getExtensionPricing([tld], ['register', 'renewal']);
        const tldItem = items.find((i) => i.productKey === tld);
        const reg1 = tldItem?.productPricing?.price?.register?.ascii?.['1'];
        const ren1 = tldItem?.productPricing?.price?.renewal?.ascii?.['1'];
        if (reg1 !== undefined && ren1 !== undefined) {
          out.price = { registration: reg1, renewal: ren1, currency: 'USD' };
          out.priceSource = 'webnic';
        }
      } catch (err) {
        // Pricing enrichment is best-effort — surface the cause on stderr (stdout is the stdio MCP channel).
        console.error('[webnic] pricing enrichment failed:', err instanceof Error ? err.message : err);
      }
    }

    return out;
  }

  async listDomains(): Promise<Domain[]> {
    const zones = await this.client.listZones({ zoneType: 'inzone', limit: 100 });
    // Returning zones with minimal metadata. getDomain() fetches full detail per-domain on demand.
    return zones.map((z) => ({
      name: z.zone,
      provider: 'webnic',
      status: 'active' as const,
      expiresAt: '',
      autoRenew: false,
      locked: false,
      nameservers: [],
    }));
  }

  async getDomain(domain: string): Promise<Domain> {
    const info = await this.client.getDomainInfo(domain);
    return this.mapDomain(info);
  }

  async registerDomain(req: RegisterRequest): Promise<Domain> {
    const { contactId, registrantUserId } = this.requireRegistrationPrereqs();
    const result = await this.client.registerDomain({
      domainName: req.domain,
      term: req.years,
      nameservers: this.defaultNameservers,
      registrantContactId: contactId,
      administratorContactId: contactId,
      technicalContactId: contactId,
      billingContactId: contactId,
      registrantUserId,
      whoisPrivacy: req.privacyProtection,
    });

    return {
      name: req.domain,
      provider: 'webnic',
      status: result.pendingOrder ? 'pending' : 'active',
      expiresAt: this.normalizeDate(result.dtexpire),
      autoRenew: req.autoRenew,
      locked: false,
      nameservers: this.defaultNameservers,
    };
  }

  async renewDomain(domain: string, years: number): Promise<void> {
    await this.client.renewDomain(domain, years);
  }

  async updateNameservers(domain: string, nameservers: string[]): Promise<void> {
    // Nameserver updates are blocked at the registry when the domain is in
    // name_protected (or transfer_protected, depending on registry). Briefly
    // unlock, perform the write, then restore (or force-set per config).
    await this.withActiveStatus(domain, () => this.client.updateNameservers(domain, nameservers));
  }

  async listDNSRecords(domain: string): Promise<DNSRecord[]> {
    const { records } = await this.client.listRecords(domain);
    return records.flatMap((r) => this.flattenRecord(r));
  }

  async createDNSRecord(domain: string, record: DNSRecord): Promise<DNSRecord> {
    this.assertSupportedType(record.type);
    const value = this.encodeValue(record);

    // WebNIC's save endpoint REPLACES the entire record set for (type, name).
    // Merge with existing rdatas to preserve siblings, mirroring GoDaddy behaviour.
    const existing = await this.findRecordSet(domain, record.type, record.name);

    if (existing) {
      // Idempotence: if an rdata with the exact same encoded value already
      // exists in the set, return it without re-saving. Avoids polluting the
      // zone with duplicate entries (Webnic accepts identical rdatas otherwise).
      const duplicateIndex = existing.rdatas.findIndex((rd) => rd.value === value);
      if (duplicateIndex !== -1) {
        return {
          ...record,
          ttl: existing.ttl ?? record.ttl,
          id: this.makeRecordId(record.type, record.name, duplicateIndex),
        };
      }
    }

    const rdatas = existing
      ? [...existing.rdatas, { value }]
      : [{ value }];

    const saved = await this.client.saveRecord(domain, {
      name: this.encodeName(record.name),
      type: record.type,
      ttl: record.ttl,
      rdatas,
    });

    const index = rdatas.length - 1;
    return {
      ...record,
      ttl: saved.ttl ?? record.ttl,
      id: this.makeRecordId(record.type, record.name, index),
    };
  }

  async updateDNSRecord(domain: string, record: DNSRecord): Promise<DNSRecord> {
    this.assertSupportedType(record.type);
    if (!record.id) {
      throw new AgentError(
        'MISSING_RECORD_ID',
        'DNS record update requires a record ID.',
        'Fetch the record list first using list_dns_records to get the record ID.',
        'webnic',
      );
    }

    const parsed = this.parseRecordId(record.id);
    const existing = await this.findRecordSet(domain, parsed.type, parsed.name);
    if (!existing) {
      throw new AgentError(
        'NOT_FOUND',
        `No DNS record set found for type ${parsed.type} and name '${parsed.name}' on '${domain}'.`,
        'Use list_dns_records to verify the record exists.',
        'webnic',
      );
    }
    if (parsed.index >= existing.rdatas.length) {
      throw new AgentError(
        'NOT_FOUND',
        `DNS record index ${parsed.index} out of range (set has ${existing.rdatas.length} entries).`,
        'Use list_dns_records to refresh record IDs before updating.',
        'webnic',
      );
    }

    const newValue = this.encodeValue(record);
    const rdatas = existing.rdatas.map((rd, i) => i === parsed.index ? { value: newValue } : rd);

    await this.client.saveRecord(domain, {
      name: this.encodeName(record.name),
      type: record.type,
      ttl: record.ttl,
      rdatas,
    });

    return { ...record, id: this.makeRecordId(record.type, record.name, parsed.index) };
  }

  async deleteDNSRecord(domain: string, recordId: string): Promise<void> {
    const parsed = this.parseRecordId(recordId);
    const existing = await this.findRecordSet(domain, parsed.type, parsed.name);
    if (!existing) {
      throw new AgentError(
        'NOT_FOUND',
        `No DNS record set found for type ${parsed.type} and name '${parsed.name}' on '${domain}'.`,
        'Use list_dns_records to verify the record exists.',
        'webnic',
      );
    }

    if (existing.rdatas.length <= 1) {
      await this.client.deleteRecord(domain, parsed.type, this.encodeName(parsed.name));
      return;
    }

    // Multi-rdata set: keep the others, save without the targeted index.
    if (parsed.index >= existing.rdatas.length) {
      throw new AgentError(
        'NOT_FOUND',
        `DNS record index ${parsed.index} out of range (set has ${existing.rdatas.length} entries).`,
        'Use list_dns_records to refresh record IDs before deleting.',
        'webnic',
      );
    }
    const remaining = existing.rdatas.filter((_, i) => i !== parsed.index);
    await this.client.saveRecord(domain, {
      name: this.encodeName(parsed.name),
      type: parsed.type,
      ttl: existing.ttl,
      rdatas: remaining,
    });
  }

  async listCertificates(domain: string): Promise<Certificate[]> {
    const orders = await this.client.searchSSLOrders({ commonName: domain });
    // searchSSLOrders uses LIKE matching — filter to certs whose CN strictly equals
    // the requested domain (or is the wildcard form *.domain).
    const exact = orders.filter((o) => this.cnMatchesDomain(o.commonName, domain));
    return exact.map((o) => this.mapOrderToCertificate(o));
  }

  async createCertificate(domain: string): Promise<Certificate> {
    if (!this.defaultContactId) {
      throw new AgentError(
        'SSL_PREREQUISITES_NOT_MET',
        'Webnic SSL order placement requires a pre-created administrator contact handle.',
        'Set WEBNIC_DEFAULT_CONTACT_ID (e.g. WN964984T) in your environment, or create one via the WebNIC portal.',
        'webnic',
      );
    }

    // Pick the cheapest DV SSL product as the default (createCertificate does not
    // expose product/term/CSR knobs through the Provider interface).
    const products = await this.client.listSSLProducts();
    const dv = products.filter((p) => p.certType === 'DV');
    if (dv.length === 0) {
      throw new AgentError(
        'NO_SSL_PRODUCT',
        'No DV SSL product was returned by the WebNIC catalog.',
        'Check WebNIC product availability for your reseller account, or place the order via the WebNIC portal.',
        'webnic',
      );
    }
    const product = dv.reduce((cheapest, p) => (p.price < cheapest.price ? p : cheapest));

    // Without a CSR injection path through the MCP interface, the agent cannot
    // currently complete the order: WebNIC requires a CSR at place-order time
    // (the `Generate CSR` endpoint requires the same context). Surface this as
    // an actionable error rather than failing silently with an empty CSR.
    throw new AgentError(
      'SSL_CSR_REQUIRED',
      `Webnic SSL order placement requires a CSR upfront. The MCP createCertificate tool does not currently accept a CSR. Selected product: ${product.productKey} (${product.certType}, $${product.price} USD).`,
      'Generate a CSR (e.g. via WebNIC\'s /ssl/v2/generate-csr or openssl), then place the order via the WebNIC portal at https://portal.webnic.cc. After issuance, list_certificates and get_certificate_status will surface it.',
      'webnic',
    );
  }

  async getCertificateStatus(certId: string): Promise<Certificate> {
    const orderId = this.parseCertId(certId);
    const info = await this.client.getSSLOrderInfo(orderId);
    return this.mapOrderToCertificate(info);
  }

  async initiateTransfer(domain: string, authCode: string): Promise<Transfer> {
    const { contactId, registrantUserId } = this.requireRegistrationPrereqs();
    const result = await this.client.submitTransferIn({
      domainName: domain,
      authInfo: authCode,
      registrantUserId,
      registrantContactId: contactId,
      administratorContactId: contactId,
      technicalContactId: contactId,
      billingContactId: contactId,
      subscribeProxy: false,
    });

    return {
      domain,
      status: this.mapTransferStatus(result.status),
      initiatedAt: new Date().toISOString(),
    };
  }

  async getTransferStatus(domain: string): Promise<Transfer> {
    const result = await this.client.getTransferInStatus(domain);
    return this.mapTransfer(domain, result);
  }

  async getWhoisContact(domain: string): Promise<Contact> {
    const info = await this.client.getDomainInfo(domain);
    const contactId = info.contactId?.registrant;
    if (!contactId) {
      throw new AgentError(
        'NOT_FOUND',
        `No registrant contact ID returned for '${domain}'.`,
        'Verify the domain exists in your WebNIC account.',
        'webnic',
      );
    }
    const { details } = await this.client.queryContact(contactId);
    return {
      firstName: details.firstName,
      lastName: details.lastName,
      email: details.email,
      phone: details.phoneNumber,
      address1: details.address1,
      city: details.city,
      state: details.state,
      postalCode: details.zip,
      country: details.countryCode,
    };
  }

  async updateWhoisContact(_domain: string, _contact: Contact): Promise<void> {
    // Modifying contact at registry is multi-step (modify-contact + modify-contact-at-registry)
    // and varies by TLD. Not implemented in this MVP — agents should use the WebNIC portal.
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      'Webnic WHOIS contact update is not implemented in this MCP version.',
      'Modify contacts via the WebNIC portal at https://portal.webnic.cc, or use the WebNIC RESTFUL v2 contact endpoints directly. The contact ID can be fetched via get_whois_contact.',
      'webnic',
    );
  }

  async getPricingTable(): Promise<Record<string, { registration: number; renewal: number; currency: string }>> {
    // Without a discovery endpoint for "all TLDs", caller is expected to query specific TLDs.
    // Return an empty table so the registry uses checkAvailability on a per-domain basis.
    return {};
  }

  // --- DNSSEC ---------------------------------------------------------------

  /**
   * Aggregated DNSSEC view combining both layers WebNIC exposes:
   *   - registry: DS records published at the parent (GET /domain/v2/dnssec)
   *   - zone:     WebNIC-hosted authoritative DNS signing the zone
   *
   * Each layer is queried independently and tolerant of errors: a domain may
   * not be a WebNIC-hosted zone (zone lookup will 404), and a domain may not
   * have any DS published yet. We surface what we can find.
   */
  async getDnssec(domain: string): Promise<DnssecStatus> {
    const [registry, zone] = await Promise.allSettled([
      this.client.getDnssecInfo(domain),
      this.client.getZoneDnssecInfo(domain),
    ]);

    const dsRecords: DnssecDS[] = registry.status === 'fulfilled'
      ? registry.value.dsDatas.map((d) => this.mapDsFromWebnic(d))
      : [];

    const zoneEnabled = zone.status === 'fulfilled' ? zone.value.enabled === true : false;

    let dnsKey: DnssecStatus['dnsKey'] | undefined;
    if (zoneEnabled) {
      try {
        const dk = await this.client.getZoneDnssecDnskey(domain);
        dnsKey = this.mapDnskeyFromWebnic(dk);
      } catch {
        // DNSKEY fetch is best-effort
      }
    }

    const registryActive = dsRecords.length > 0;
    const scope: DnssecStatus['scope'] = registryActive && zoneEnabled
      ? 'both'
      : registryActive
        ? 'registry'
        : zoneEnabled
          ? 'zone'
          : 'none';

    const out: DnssecStatus = {
      domain,
      enabled: scope !== 'none',
      scope,
    };
    if (dsRecords.length > 0) out.dsRecords = dsRecords;
    if (dnsKey) out.dnsKey = dnsKey;
    return out;
  }

  /**
   * Enable DNSSEC for `domain`.
   *
   * Behaviour:
   * - If `opts.dsRecords` is provided, publish those DS records at the parent
   *   registry (the caller signs the zone elsewhere; we only anchor the chain).
   * - If `opts.dsRecords` is omitted, enable zone-side DNSSEC on the WebNIC
   *   authoritative DNS. We do NOT auto-publish the DS at the registry — the
   *   caller can fetch the generated DS via getDnssec() and re-call this method
   *   with `dsRecords` once they are ready to propagate.
   */
  async enableDnssec(domain: string, opts?: { dsRecords?: DnssecDS[] }): Promise<DnssecStatus> {
    if (opts?.dsRecords && opts.dsRecords.length > 0) {
      await this.client.updateDnssec(domain, opts.dsRecords.map((d) => this.mapDsToWebnic(d)));
    } else {
      await this.client.enableZoneDnssec(domain);
    }
    return this.getDnssec(domain);
  }

  /** Disable DNSSEC on both layers when applicable. Errors from one layer don't block the other. */
  async disableDnssec(domain: string): Promise<void> {
    const ops: Array<Promise<unknown>> = [];

    // Registry side: only call DELETE if there is something to remove.
    try {
      const info = await this.client.getDnssecInfo(domain);
      if (info.dsDatas.length > 0) {
        ops.push(this.client.deleteDnssec(domain));
      }
    } catch {
      // If registry lookup fails (e.g. unsupported), skip — disable is best-effort.
    }

    // Zone side: only call disable if currently enabled.
    try {
      const zoneInfo = await this.client.getZoneDnssecInfo(domain);
      if (zoneInfo.enabled) {
        ops.push(this.client.disableZoneDnssec(domain));
      }
    } catch {
      // Domain may not be a WebNIC-hosted zone; ignore.
    }

    if (ops.length === 0) {
      // Nothing was active; treat as success (idempotent).
      return;
    }

    const results = await Promise.allSettled(ops);
    const firstFailure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (firstFailure) {
      if (firstFailure.reason instanceof AgentError) throw firstFailure.reason;
      throw new AgentError(
        'WEBNIC_ERROR',
        `Failed to fully disable DNSSEC for '${domain}': ${firstFailure.reason?.message ?? 'unknown error'}`,
        'Retry disable_dnssec, or check the WebNIC portal at https://portal.webnic.cc.',
        'webnic',
      );
    }
  }

  private mapDsFromWebnic(d: WebnicDsData): DnssecDS {
    return {
      keyTag: parseInt(d.keyTag, 10),
      algorithm: parseInt(d.algorithm, 10),
      digestType: parseInt(d.digestType, 10),
      digest: d.digest,
    };
  }

  private mapDsToWebnic(d: DnssecDS): WebnicDsData {
    return {
      keyTag: String(d.keyTag),
      algorithm: String(d.algorithm),
      digestType: String(d.digestType),
      digest: d.digest,
    };
  }

  private mapDnskeyFromWebnic(dk: WebnicZoneDnssecDnskey): DnssecStatus['dnsKey'] {
    // WebNIC returns the DNSKEY rdata as a single string "flags protocol algorithm publicKey".
    const raw = dk.rdatas?.[0]?.value ?? '';
    const m = raw.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) return undefined;
    return {
      flags: parseInt(m[1], 10),
      protocol: parseInt(m[2], 10),
      algorithm: parseInt(m[3], 10),
      publicKey: m[4].trim(),
    };
  }

  // --- helpers ---------------------------------------------------------------

  /**
   * Runs `op` on a domain. WebNIC blocks registry-side writes (nameservers,
   * transfers, contact updates) when status is `name_protected` or
   * `transfer_protected`. We switch the domain to `active` for the call, then
   * restore it to `name_protected` — the strictest level, and the WebNIC default
   * for newly-registered domains — in a `finally` block.
   *
   * The unlock dance is skipped entirely when status is already `active`.
   *
   * Restore happens even if `op` throws — a domain is never left unlocked.
   * Restore failures are logged to stderr (out of band from the MCP stdio
   * channel) and never mask the original error.
   */
  private async withActiveStatus<T>(domain: string, op: () => Promise<T>): Promise<T> {
    const info = await this.client.getDomainInfo(domain);
    const initialIsActive = (info.status ?? '').toLowerCase() === 'active';

    if (initialIsActive) {
      return op();
    }

    await this.client.updateDomainStatus(domain, 'active');
    try {
      return await op();
    } finally {
      try {
        await this.client.updateDomainStatus(domain, 'name_protected');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // stderr only — must not pollute stdio MCP channel
        console.error(`[webnic] failed to restore protection on '${domain}' to 'name_protected':`, msg);
      }
    }
  }

  private requireRegistrationPrereqs(): { contactId: string; registrantUserId: string } {
    if (!this.defaultContactId || !this.defaultRegistrantUserId) {
      throw new AgentError(
        'REGISTRATION_PREREQUISITES_NOT_MET',
        'Webnic requires a pre-created contact handle and a registrant user account ID before any register or transfer.',
        'Set WEBNIC_DEFAULT_CONTACT_ID (e.g. WN964984T) and WEBNIC_DEFAULT_REGISTRANT_USER_ID (e.g. REG100015) in your environment. Create them via the WebNIC portal or via the contact / registrant API endpoints.',
        'webnic',
      );
    }
    return { contactId: this.defaultContactId, registrantUserId: this.defaultRegistrantUserId };
  }

  private mapDomain(info: WebnicDomainInfo): Domain {
    return {
      name: info.domainName,
      provider: 'webnic',
      status: this.mapStatus(info.status),
      expiresAt: this.normalizeDate(info.dtexpire),
      autoRenew: false,
      locked: false,
      nameservers: info.nameservers ?? [],
    };
  }

  private mapStatus(status: string): Domain['status'] {
    const s = status?.toLowerCase() ?? '';
    if (s.includes('active') || s === 'ok') return 'active';
    if (s.includes('expired')) return 'expired';
    if (s.includes('lock')) return 'locked';
    return 'pending';
  }

  private mapTransferStatus(status: string): Transfer['status'] {
    switch (status) {
      case 'approve':
      case 'complete':
        return status === 'complete' ? 'completed' : 'approved';
      case 'reject':
      case 'insert_fail':
        return 'rejected';
      case 'cancel':
        return 'cancelled';
      default:
        return 'pending';
    }
  }

  private mapTransfer(domain: string, t: WebnicTransferStatus): Transfer {
    const transfer: Transfer = {
      domain,
      status: this.mapTransferStatus(t.status),
    };
    if (t.dtcreate) transfer.initiatedAt = this.normalizeDate(t.dtcreate);
    if (t.status === 'complete' && t.dtcreate) transfer.completedAt = this.normalizeDate(t.dtcreate);
    return transfer;
  }

  private normalizeDate(input: string): string {
    if (!input) return '';
    // WebNIC dates can be `2026-08-12T03:13:59` (no TZ) or `2023-05-16T17:47:38+08:00`.
    // Treat naked datetimes as UTC.
    const hasZone = /[Zz]|[+\-]\d{2}:?\d{2}$/.test(input);
    return new Date(hasZone ? input : `${input}Z`).toISOString();
  }

  private assertSupportedType(type: string): void {
    if (!SUPPORTED_DNS_TYPES.has(type)) {
      throw new AgentError(
        'UNSUPPORTED_RECORD_TYPE',
        `Webnic DNS does not support record type '${type}'.`,
        `Supported types: ${Array.from(SUPPORTED_DNS_TYPES).join(', ')}.`,
        'webnic',
      );
    }
  }

  private flattenRecord(r: WebnicRecord): DNSRecord[] {
    const name = r.name ?? '@';
    return r.rdatas.map((rd, idx) => {
      const decoded = this.decodeValue(r.type, rd.value);
      const out: DNSRecord = {
        id: this.makeRecordId(r.type, name, idx),
        type: r.type as DNSRecord['type'],
        name,
        content: decoded.content,
        ttl: r.ttl,
      };
      if (decoded.priority !== undefined) out.priority = decoded.priority;
      return out;
    });
  }

  private encodeValue(record: DNSRecord): string {
    if (record.type === 'MX' && record.priority !== undefined) {
      return `${record.priority} ${record.content}`;
    }
    return record.content;
  }

  private decodeValue(type: string, raw: string): { content: string; priority?: number } {
    if (type === 'MX') {
      const match = raw.match(/^(\d+)\s+(.+)$/);
      if (match) return { content: match[2], priority: parseInt(match[1], 10) };
    }
    // Webnic JSON responses HTML-escape quote characters inside rdata values
    // (notably CAA where the tag value is double-quoted, e.g. `0 issue "letsencrypt.org"`).
    if (raw.includes('&quot;') || raw.includes('&amp;') || raw.includes('&lt;') || raw.includes('&gt;') || raw.includes('&#39;')) {
      return { content: decodeHtmlEntities(raw) };
    }
    return { content: raw };
  }

  private makeRecordId(type: string, name: string, index: number): string {
    return `${type}:${name || '@'}:${index}`;
  }

  private parseRecordId(id: string): { type: string; name: string; index: number } {
    const parts = id.split(':');
    if (parts.length < 3) {
      throw new AgentError(
        'INVALID_RECORD_ID',
        `Invalid Webnic record ID '${id}'.`,
        'Use list_dns_records to fetch valid record IDs.',
        'webnic',
      );
    }
    const index = parseInt(parts[parts.length - 1], 10);
    const type = parts[0];
    const name = parts.slice(1, -1).join(':') || '@';
    if (!Number.isFinite(index)) {
      throw new AgentError(
        'INVALID_RECORD_ID',
        `Invalid Webnic record ID '${id}': index is not a number.`,
        'Use list_dns_records to fetch valid record IDs.',
        'webnic',
      );
    }
    return { type, name, index };
  }

  private encodeName(name: string): string {
    return name === '@' ? '' : name;
  }

  private async findRecordSet(domain: string, type: string, name: string): Promise<WebnicRecord | null> {
    const { records } = await this.client.listRecords(domain);
    const target = name === '@' ? null : name;
    return records.find((r) => r.type === type && (r.name ?? null) === target) ?? null;
  }

  // --- SSL helpers -----------------------------------------------------------

  private static readonly CERT_ID_PREFIX = 'webnic-ssl-';

  private makeCertId(orderId: string): string {
    return `${WebnicProvider.CERT_ID_PREFIX}${orderId}`;
  }

  private parseCertId(certId: string): string {
    if (!certId.startsWith(WebnicProvider.CERT_ID_PREFIX)) {
      throw new AgentError(
        'INVALID_CERT_ID',
        `Invalid Webnic certificate ID '${certId}'. Expected format '${WebnicProvider.CERT_ID_PREFIX}<orderId>'.`,
        'Use list_certificates to fetch valid certificate IDs.',
        'webnic',
      );
    }
    const orderId = certId.slice(WebnicProvider.CERT_ID_PREFIX.length);
    if (!orderId) {
      throw new AgentError(
        'INVALID_CERT_ID',
        `Invalid Webnic certificate ID '${certId}': missing order id.`,
        'Use list_certificates to fetch valid certificate IDs.',
        'webnic',
      );
    }
    return orderId;
  }

  private cnMatchesDomain(commonName: string, domain: string): boolean {
    const cn = commonName.toLowerCase();
    const d = domain.toLowerCase();
    return cn === d || cn === `*.${d}`;
  }

  private mapOrderToCertificate(o: WebnicSSLOrderSummary & { dtsettle?: string }): Certificate {
    const cert: Certificate = {
      id: this.makeCertId(o.orderId),
      domain: o.commonName,
      status: this.mapSslStatus(o.orderStatus, o.certStatus),
    };
    if (o.dtcertexpire) cert.expiresAt = this.normalizeDate(o.dtcertexpire);
    if (o.dtsettle) cert.issuedAt = this.normalizeDate(o.dtsettle);
    else if (o.certStatus === 'ACTIVE' && o.dtcreate) cert.issuedAt = this.normalizeDate(o.dtcreate);
    return cert;
  }

  private mapSslStatus(orderStatus: WebnicSSLOrderStatus, certStatus: WebnicSSLCertStatus): Certificate['status'] {
    // Terminal "failure" states first — order may be done but cert is not usable.
    if (orderStatus === 'REJECTED' || orderStatus === 'CANCELLED' || orderStatus === 'REFUNDED') return 'failed';
    if (certStatus === 'FAILED' || certStatus === 'REVOKED' || certStatus === 'CANCELLED') return 'failed';
    if (orderStatus === 'EXPIRED' || certStatus === 'EXPIRED') return 'expired';
    if (certStatus === 'ACTIVE' || certStatus === 'COMPLETED' || orderStatus === 'COMPLETED') return 'active';
    // INITIAL / PENDING / IN_PROCESS / PROCESSED / PENDING_REISSUE → still in flight
    return 'pending';
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
